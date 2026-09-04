#include <algorithm>
#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

#include <tesseron/tesseron.hpp>

namespace {

using tesseron::ActionContext;
using tesseron::ActionError;
using tesseron::ElicitRequest;
using tesseron::Json;
using tesseron::LogEntry;
using tesseron::ProgressUpdate;
using tesseron::Result;
using tesseron::SampleRequest;
using tesseron::Schema;

std::uint64_t timestamp() {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
          .count());
}

ActionError prompt_not_found() {
  return ActionError::protocol(tesseron::TesseronErrorCode::HandlerError, "Prompt not found",
                               Json{{"kind", "not_found"}});
}

ActionError sampled_text_error(const Json& value) {
  return ActionError::protocol(tesseron::TesseronErrorCode::HandlerError,
                               "The sampling result was not text", Json{{"content", value}});
}

struct Prompt {
  std::string identifier;
  std::string name;
  std::string prompt_template;
  std::vector<std::string> tags;
  std::uint64_t created_at = 0;
  std::optional<std::uint64_t> last_tested_at;
  std::uint64_t times_tested = 0;
};

struct TestResult {
  std::string prompt_identifier;
  std::string prompt_name;
  Json input;
  std::string response;
  std::uint64_t tested_at = 0;
};

Json string_array(const std::vector<std::string>& values) {
  Json payload = Json::array();
  for (const auto& value : values) payload.push_back(value);
  return payload;
}

Json prompt_payload(const Prompt& prompt) {
  Json payload = {
      {"id", prompt.identifier},
      {"name", prompt.name},
      {"template", prompt.prompt_template},
      {"tags", string_array(prompt.tags)},
      {"createdAt", prompt.created_at},
      {"timesTested", prompt.times_tested},
  };
  if (prompt.last_tested_at.has_value()) payload["lastTestedAt"] = *prompt.last_tested_at;
  return payload;
}

Json test_result_payload(const TestResult& result) {
  return {
      {"promptId", result.prompt_identifier},
      {"promptName", result.prompt_name},
      {"input", result.input},
      {"response", result.response},
      {"testedAt", result.tested_at},
  };
}

struct PromptState {
  std::size_t next_identifier = 1;
  std::unordered_map<std::string, Prompt> prompts;
  std::optional<TestResult> last_test;
  std::vector<tesseron::ResourceEmitter> library_subscribers;
  std::vector<tesseron::ResourceEmitter> last_test_subscribers;

  Prompt create(std::string name, std::string prompt_template, std::vector<std::string> tags) {
    Prompt prompt{
        .identifier = "p" + std::to_string(next_identifier++),
        .name = std::move(name),
        .prompt_template = std::move(prompt_template),
        .tags = std::move(tags),
        .created_at = timestamp(),
    };
    prompts.emplace(prompt.identifier, prompt);
    return prompt;
  }

  Json library() const {
    std::vector<const Prompt*> ordered;
    ordered.reserve(prompts.size());
    for (const auto& [identifier, prompt] : prompts) ordered.push_back(&prompt);
    std::sort(ordered.begin(), ordered.end(), [](const Prompt* left, const Prompt* right) {
      return left->identifier < right->identifier;
    });
    Json payload = Json::array();
    for (const auto* prompt : ordered) payload.push_back(prompt_payload(*prompt));
    return payload;
  }

  Json latest_test() const {
    if (!last_test.has_value()) return nullptr;
    return test_result_payload(*last_test);
  }

  void publish_library() {
    const Json payload = library();
    for (const auto& subscriber : library_subscribers) subscriber.emit(payload);
  }

  void publish_last_test() {
    const Json payload = latest_test();
    for (const auto& subscriber : last_test_subscribers) subscriber.emit(payload);
  }
};

std::vector<std::string> optional_string_array(const Json& input, const char* name) {
  if (!input.contains(name)) return {};
  return input.at(name).get<std::vector<std::string>>();
}

Result<std::string> sampled_text(const Json& value) {
  if (!value.is_string()) return sampled_text_error(value);
  return value.get<std::string>();
}

Result<std::string> fill_template(const std::string& prompt_template, const Json& variables) {
  std::string rendered;
  std::string_view remainder = prompt_template;
  while (true) {
    const auto start = remainder.find("{{");
    if (start == std::string_view::npos) {
      rendered.append(remainder);
      return rendered;
    }
    rendered.append(remainder.substr(0, start));
    const auto after_open = remainder.substr(start + 2);
    const auto end = after_open.find("}}");
    if (end == std::string_view::npos) {
      rendered.append(remainder.substr(start));
      return rendered;
    }
    const std::string key(after_open.substr(0, end));
    const auto first = key.find_first_not_of(" \t\n\r");
    const auto last = key.find_last_not_of(" \t\n\r");
    const std::string trimmed = first == std::string::npos ? "" : key.substr(first, last - first + 1);
    if (!variables.contains(trimmed)) {
      return ActionError::handler("Missing variable \"" + trimmed + "\" for prompt template");
    }
    rendered.append(variables.at(trimmed).get<std::string>());
    remainder = after_open.substr(end + 2);
  }
}

Schema prompt_identifier_input_schema() {
  return tesseron::schema::object({
      tesseron::schema::required("id", tesseron::schema::string()),
  });
}

Json prompt_output_schema() {
  return {
      {"type", "object"},
      {"properties",
       {{"id", {{"type", "string"}}}, {"name", {{"type", "string"}}},
        {"template", {{"type", "string"}}}, {"tags", {{"type", "array"}, {"items", {{"type", "string"}}}}},
        {"createdAt", {{"type", "integer"}}}, {"lastTestedAt", {{"type", "integer"}}},
        {"timesTested", {{"type", "integer"}}}}},
      {"required", {"id", "name", "template", "tags", "createdAt", "timesTested"}},
  };
}

Json prompt_list_output_schema() {
  return {{"type", "array"}, {"items", prompt_output_schema()}};
}

boost::asio::awaitable<Result<Json>> delete_prompt(const std::shared_ptr<PromptState>& state, Json input,
                                                    ActionContext context) {
  const std::string identifier = input.at("id").get<std::string>();
  const auto prompt = state->prompts.find(identifier);
  if (prompt == state->prompts.end()) co_return prompt_not_found();
  auto confirmation = co_await context.confirm("Delete prompt \"" + prompt->second.name + "\" (tested " +
                                               std::to_string(prompt->second.times_tested) +
                                               "x)? This cannot be undone.");
  if (!confirmation.ok()) co_return confirmation.error();
  if (!confirmation.value()) {
    co_return Json{{"id", identifier}, {"deleted", false}, {"cancelled", true}};
  }
  state->prompts.erase(identifier);
  state->publish_library();
  co_return Json{{"id", identifier}, {"deleted", true}};
}

boost::asio::awaitable<Result<Json>> test_prompt(const std::shared_ptr<PromptState>& state, Json input,
                                                  ActionContext context) {
  const std::string identifier = input.at("id").get<std::string>();
  const auto prompt = state->prompts.find(identifier);
  if (prompt == state->prompts.end()) co_return prompt_not_found();
  const Json variables = input.value("variables", Json::object());
  const auto filled = fill_template(prompt->second.prompt_template, variables);
  if (!filled.ok()) co_return filled.error();
  context.log(LogEntry::info("Testing prompt " + identifier));
  context.progress(ProgressUpdate().message("asking LLM...").percent(25));
  auto sampled = co_await context.sample(SampleRequest(filled.value()).max_tokens(512));
  if (!sampled.ok()) co_return sampled.error();
  const auto response = sampled_text(sampled.value());
  if (!response.ok()) co_return response.error();
  context.progress(ProgressUpdate().message("storing result...").percent(90));
  auto current = state->prompts.find(identifier);
  if (current == state->prompts.end()) co_return prompt_not_found();
  current->second.last_tested_at = timestamp();
  ++current->second.times_tested;
  state->last_test = TestResult{
      .prompt_identifier = current->second.identifier,
      .prompt_name = current->second.name,
      .input = variables,
      .response = response.value(),
      .tested_at = timestamp(),
  };
  state->publish_library();
  state->publish_last_test();
  co_return Json{{"id", identifier}, {"response", response.value()}, {"timesTested", current->second.times_tested}};
}

boost::asio::awaitable<Result<Json>> refine_prompt(const std::shared_ptr<PromptState>& state, Json input,
                                                    ActionContext context) {
  const std::string identifier = input.at("id").get<std::string>();
  const auto prompt = state->prompts.find(identifier);
  if (prompt == state->prompts.end()) co_return prompt_not_found();
  ElicitRequest request("Refining \"" + prompt->second.name +
                        "\". What should change? (e.g. \"make it more concise\", \"demand JSON output\", "
                        "\"add a role\")");
  request.json_schema({
      {"type", "object"},
      {"properties", {{"instruction", {{"type", "string"}, {"minLength", 1}}}}},
      {"required", {"instruction"}},
  });
  auto elicited = co_await context.elicit(std::move(request));
  if (!elicited.ok()) co_return elicited.error();
  if (!elicited.value().has_value()) {
    co_return Json{{"id", identifier}, {"refined", false}, {"cancelled", true}};
  }
  const Json& answer = *elicited.value();
  if (!answer.is_object() || !answer.contains("instruction") || !answer.at("instruction").is_string() ||
      answer.at("instruction").get<std::string>().empty()) {
    co_return ActionError::handler("The elicitation result was not a refinement instruction");
  }
  const std::string instruction = answer.at("instruction").get<std::string>();
  context.progress(ProgressUpdate().message("applying refinement...").percent(40));
  SampleRequest sample_request("You rewrite prompt templates. Return the new template only, no prose.\n\n"
                               "Original template:\n" +
                               prompt->second.prompt_template + "\n\nInstruction: " + instruction);
  sample_request.max_tokens(800);
  auto sampled = co_await context.sample(std::move(sample_request));
  if (!sampled.ok()) co_return sampled.error();
  const auto rewritten = sampled_text(sampled.value());
  if (!rewritten.ok()) co_return rewritten.error();
  auto current = state->prompts.find(identifier);
  if (current == state->prompts.end()) co_return prompt_not_found();
  const std::string previous_template = current->second.prompt_template;
  current->second.prompt_template = rewritten.value();
  current->second.prompt_template.erase(current->second.prompt_template.find_last_not_of(" \t\n\r") + 1);
  current->second.prompt_template.erase(0, current->second.prompt_template.find_first_not_of(" \t\n\r"));
  state->publish_library();
  co_return Json{{"id", identifier},
                 {"refined", true},
                 {"instruction", instruction},
                 {"previousTemplate", previous_template},
                 {"newTemplate", current->second.prompt_template}};
}

boost::asio::awaitable<Result<Json>> generate_variants(const std::shared_ptr<PromptState>& state, Json input,
                                                        ActionContext context) {
  const std::string identifier = input.at("id").get<std::string>();
  const auto source = state->prompts.find(identifier);
  if (source == state->prompts.end()) co_return prompt_not_found();
  const int count = input.contains("count") ? input.at("count").get<int>() : 3;
  context.progress(ProgressUpdate().message("requesting variants...").percent(10));
  SampleRequest request("Produce exactly " + std::to_string(count) +
                        " distinct variations of the prompt below. Vary the phrasing, tone, or structure, "
                        "but preserve the intent. Return JSON: { variants: string[] }.\n\nPrompt:\n" +
                        source->second.prompt_template);
  request.json_schema({
      {"type", "object"},
      {"properties",
       {{"variants",
         {{"type", "array"},
          {"items", {{"type", "string"}, {"minLength", 10}}},
          {"minItems", count},
          {"maxItems", count}}}}},
      {"required", {"variants"}},
  });
  request.max_tokens(1200);
  auto sampled = co_await context.sample(std::move(request));
  if (!sampled.ok()) co_return sampled.error();
  if (!sampled.value().is_object() || !sampled.value().contains("variants") ||
      !sampled.value().at("variants").is_array()) {
    co_return ActionError::handler("The sampling result was not prompt variants").with_data(
        Json{{"content", sampled.value()}});
  }
  const Prompt source_prompt = source->second;
  Json identifiers = Json::array();
  std::size_t index = 0;
  for (const auto& variant : sampled.value().at("variants")) {
    if (!variant.is_string()) {
      co_return ActionError::handler("The sampling result was not prompt variants").with_data(
          Json{{"content", sampled.value()}});
    }
    auto tags = source_prompt.tags;
    tags.push_back("variant");
    Prompt prompt = state->create(source_prompt.name + " (variant " + std::to_string(index + 1) + ")",
                                  variant.get<std::string>(), std::move(tags));
    identifiers.push_back(prompt.identifier);
    context.progress(ProgressUpdate()
                         .message("variant " + std::to_string(index + 1) + "/" + std::to_string(count) + " stored")
                         .percent(static_cast<int>((index + 1) * 100 / count)));
    ++index;
  }
  state->publish_library();
  co_return Json{{"sourceId", identifier}, {"added", identifiers.size()}, {"ids", identifiers}};
}

void register_actions(tesseron::HostBuilder& builder, const std::shared_ptr<PromptState>& state) {
  builder.action("addPrompt")
      .description("Add a prompt to the library")
      .input(tesseron::schema::object({
          tesseron::schema::required("name", tesseron::schema::string().min_length(1)),
          tesseron::schema::required("template", tesseron::schema::string().min_length(1)),
          tesseron::schema::optional("tags", tesseron::schema::array(tesseron::schema::string())),
      }))
      .output_schema(prompt_output_schema())
      .handler([state](Json input, ActionContext context) -> boost::asio::awaitable<Result<Json>> {
        Prompt prompt = state->create(input.at("name").get<std::string>(), input.at("template").get<std::string>(),
                                      optional_string_array(input, "tags"));
        context.log(LogEntry::info("Added prompt " + prompt.identifier));
        state->publish_library();
        co_return prompt_payload(prompt);
      });

  builder.action("listPrompts")
      .description("List prompts in the library")
      .input(tesseron::schema::object({
          tesseron::schema::optional("tag", tesseron::schema::string()),
      }))
      .output_schema(prompt_list_output_schema())
      .handler([state](Json input, ActionContext) -> boost::asio::awaitable<Result<Json>> {
        const auto tag = input.contains("tag") ? std::optional(input.at("tag").get<std::string>()) : std::nullopt;
        Json listed = Json::array();
        const Json library = state->library();
        for (const auto& prompt : library) {
          if (!tag.has_value() || std::find(prompt.at("tags").begin(), prompt.at("tags").end(), *tag) != prompt.at("tags").end()) {
            listed.push_back(prompt);
          }
        }
        co_return listed;
      });

  builder.action("deletePrompt")
      .description("Delete a prompt after confirmation")
      .input(prompt_identifier_input_schema())
      .output_schema({
          {"type", "object"},
          {"properties", {{"id", {{"type", "string"}}}, {"deleted", {{"type", "boolean"}}}, {"cancelled", {{"type", "boolean"}}}}},
          {"required", {"id", "deleted"}},
      })
      .handler([state](Json input, ActionContext context) { return delete_prompt(state, std::move(input), std::move(context)); });

  builder.action("testPrompt")
      .description("Run a prompt through sampling")
      .input(tesseron::schema::object({
          tesseron::schema::required("id", tesseron::schema::string()),
          tesseron::schema::optional("variables", tesseron::schema::object({})),
      }))
      .output_schema({
          {"type", "object"},
          {"properties", {{"id", {{"type", "string"}}}, {"response", {{"type", "string"}}}, {"timesTested", {{"type", "integer"}}}}},
          {"required", {"id", "response", "timesTested"}},
      })
      .handler([state](Json input, ActionContext context) { return test_prompt(state, std::move(input), std::move(context)); });

  builder.action("refinePrompt")
      .description("Refine a prompt with elicitation and sampling")
      .input(prompt_identifier_input_schema())
      .output_schema({
          {"type", "object"},
          {"properties", {{"id", {{"type", "string"}}}, {"refined", {{"type", "boolean"}}}, {"cancelled", {{"type", "boolean"}}}, {"instruction", {{"type", "string"}}}, {"previousTemplate", {{"type", "string"}}}, {"newTemplate", {{"type", "string"}}}}},
          {"required", {"id", "refined"}},
      })
      .handler([state](Json input, ActionContext context) { return refine_prompt(state, std::move(input), std::move(context)); });

  builder.action("generateVariants")
      .description("Generate prompt variations")
      .input(tesseron::schema::object({
          tesseron::schema::required("id", tesseron::schema::string()),
          tesseron::schema::optional("count", tesseron::schema::integer().minimum(1).maximum(10)),
      }))
      .output_schema({
          {"type", "object"},
          {"properties", {{"sourceId", {{"type", "string"}}}, {"added", {{"type", "integer"}}}, {"ids", {{"type", "array"}, {"items", {{"type", "string"}}}}}}},
          {"required", {"sourceId", "added", "ids"}},
      })
      .handler([state](Json input, ActionContext context) { return generate_variants(state, std::move(input), std::move(context)); });

  builder.action("importPrompts")
      .description("Import several prompts")
      .input(tesseron::schema::object({
          tesseron::schema::required("items", tesseron::schema::array(tesseron::schema::object({
              tesseron::schema::required("name", tesseron::schema::string().min_length(1)),
              tesseron::schema::required("template", tesseron::schema::string().min_length(1)),
              tesseron::schema::optional("tags", tesseron::schema::array(tesseron::schema::string())),
          })).min_items(1).max_items(50)),
      }))
      .output_schema({
          {"type", "object"},
          {"properties", {{"added", {{"type", "integer"}}}, {"ids", {{"type", "array"}, {"items", {{"type", "string"}}}}}}},
          {"required", {"added", "ids"}},
      })
      .handler([state](Json input, ActionContext context) -> boost::asio::awaitable<Result<Json>> {
        const Json& items = input.at("items");
        Json identifiers = Json::array();
        for (std::size_t index = 0; index < items.size(); ++index) {
          const Json& item = items[index];
          Prompt prompt = state->create(item.at("name").get<std::string>(), item.at("template").get<std::string>(),
                                        optional_string_array(item, "tags"));
          identifiers.push_back(prompt.identifier);
          context.progress(ProgressUpdate()
                               .message(std::to_string(index + 1) + "/" + std::to_string(items.size()) + " imported")
                               .percent(static_cast<int>((index + 1) * 100 / items.size())));
        }
        state->publish_library();
        co_return Json{{"added", identifiers.size()}, {"ids", identifiers}};
      });

  builder.action("purgeAll")
      .description("Delete every prompt after confirmation")
      .input(tesseron::schema::object({}))
      .output_schema({
          {"type", "object"},
          {"properties", {{"removed", {{"type", "integer"}}}, {"cancelled", {{"type", "boolean"}}}}},
          {"required", {"removed"}},
      })
      .handler([state](Json, ActionContext context) -> boost::asio::awaitable<Result<Json>> {
        const auto prompt_count = state->prompts.size();
        if (prompt_count == 0) co_return Json{{"removed", 0}};
        ElicitRequest request("Permanently delete ALL " + std::to_string(prompt_count) +
                              " prompts? Type \"DELETE\" to confirm.");
        request.json_schema({
            {"type", "object"},
            {"properties", {{"confirmation", {{"type", "string"}}}}},
            {"required", {"confirmation"}},
        });
        auto elicited = co_await context.elicit(std::move(request));
        if (!elicited.ok()) co_return elicited.error();
        if (!elicited.value().has_value() || !elicited.value()->is_object() ||
            !elicited.value()->contains("confirmation") ||
            elicited.value()->at("confirmation").get<std::string>() != "DELETE") {
          co_return Json{{"removed", 0}, {"cancelled", true}};
        }
        state->prompts.clear();
        state->last_test.reset();
        state->publish_library();
        state->publish_last_test();
        co_return Json{{"removed", prompt_count}};
      });
}

void register_resources(tesseron::HostBuilder& builder, const std::shared_ptr<PromptState>& state) {
  builder.resource("library")
      .description("Live snapshot of every prompt in the library. Pushed on every change.")
      .subscribe([state](tesseron::ResourceEmitter emitter) {
        state->library_subscribers.push_back(std::move(emitter));
        return tesseron::Subscription::without_teardown();
      })
      .reader([state]() -> boost::asio::awaitable<Result<Json>> { co_return state->library(); });

  builder.resource("lastTest")
      .description("The most recent test result from testPrompt, or null if no prompt has been tested.")
      .subscribe([state](tesseron::ResourceEmitter emitter) {
        state->last_test_subscribers.push_back(std::move(emitter));
        return tesseron::Subscription::without_teardown();
      })
      .reader([state]() -> boost::asio::awaitable<Result<Json>> { co_return state->latest_test(); });
}

int run() {
  auto state = std::make_shared<PromptState>();
  auto builder = tesseron::Host::builder();
  builder.application("cpp_prompts", "C++ Prompts");
  builder.on_event([](const tesseron::HostEvent& event) {
    if (event.kind == tesseron::HostEvent::Kind::Welcome && event.welcome.has_value() &&
        event.welcome->claim_code.has_value()) {
      std::cout << "Claim code: " << *event.welcome->claim_code << std::endl;
    }
  });
  register_actions(builder, state);
  register_resources(builder, state);

  auto listening = builder.listen();
  if (!listening.ok()) {
    std::cerr << "tesseron-example-prompts: " << listening.error().message() << "\n";
    return 1;
  }
  auto host = std::move(listening).value();
  for (;;) std::this_thread::sleep_for(std::chrono::hours(24));
}

}  // namespace

int main() { return run(); }
