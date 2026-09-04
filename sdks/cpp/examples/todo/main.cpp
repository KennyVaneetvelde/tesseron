#include <algorithm>
#include <chrono>
#include <iostream>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include <tesseron/tesseron.hpp>

namespace {

using tesseron::ActionContext;
using tesseron::ActionError;
using tesseron::Json;
using tesseron::ProgressUpdate;
using tesseron::Result;
using tesseron::SampleRequest;
using tesseron::Schema;

struct Todo {
  std::string identifier;
  std::string text;
  bool done = false;
  std::optional<std::string> tag;
};

Json todo_payload(const Todo& todo) {
  Json payload = {
      {"id", todo.identifier},
      {"text", todo.text},
      {"done", todo.done},
  };
  if (todo.tag.has_value()) payload["tag"] = *todo.tag;
  return payload;
}

Json todo_list_payload(const std::vector<Todo>& todos) {
  Json payload = Json::array();
  for (const auto& todo : todos) payload.push_back(todo_payload(todo));
  return payload;
}

ActionError todo_not_found() {
  return ActionError::protocol(tesseron::TesseronErrorCode::HandlerError, "Todo not found",
                               Json{{"kind", "not_found"}});
}

struct TodoState {
  std::size_t next_identifier = 1;
  std::vector<Todo> todos;
  std::vector<tesseron::ResourceEmitter> subscribers;

  Todo create(std::string text, std::optional<std::string> tag) {
    Todo todo{
        .identifier = "t" + std::to_string(next_identifier++),
        .text = std::move(text),
        .tag = std::move(tag),
    };
    todos.push_back(todo);
    return todo;
  }

  void publish() {
    const Json payload = todo_list_payload(todos);
    for (const auto& subscriber : subscribers) subscriber.emit(payload);
  }
};

Schema todo_identifier_input_schema() {
  return tesseron::schema::object({
      tesseron::schema::required("id", tesseron::schema::string()),
  });
}

Json todo_output_schema() {
  return {
      {"type", "object"},
      {"properties",
       {
           {"id", {{"type", "string"}}},
           {"text", {{"type", "string"}}},
           {"done", {{"type", "boolean"}}},
           {"tag", {{"type", "string"}}},
       }},
      {"required", {"id", "text", "done"}},
  };
}

Json todo_list_output_schema() {
  return {
      {"type", "array"},
      {"items", todo_output_schema()},
  };
}

Json suggested_todos_output_schema() {
  return {
      {"type", "object"},
      {"properties", {{"items", {{"type", "array"}, {"items", {{"type", "string"}}}}}}},
      {"required", {"items"}},
  };
}

Result<std::optional<std::string>> optional_string(const Json& input, const char* name) {
  if (!input.contains(name)) return std::optional<std::string>{};
  return std::optional<std::string>(input.at(name).get<std::string>());
}

boost::asio::awaitable<Result<Json>> rename_todo(const std::shared_ptr<TodoState>& state, Json input,
                                                  ActionContext context) {
  const std::string identifier = input.at("id").get<std::string>();
  auto todo = std::find_if(state->todos.begin(), state->todos.end(), [&](const Todo& candidate) {
    return candidate.identifier == identifier;
  });
  if (todo == state->todos.end()) co_return todo_not_found();

  tesseron::ElicitRequest request("Rename \"" + todo->text + "\" to?");
  request.json_schema({
      {"type", "object"},
      {"properties", {{"newName", {{"type", "string"}, {"minLength", 1}}}}},
      {"required", {"newName"}},
  });
  auto elicited = co_await context.elicit(std::move(request));
  if (!elicited.ok()) co_return elicited.error();
  if (!elicited.value().has_value()) {
    co_return Json{{"id", identifier}, {"renamed", false}, {"cancelled", true}};
  }

  const Json& answer = *elicited.value();
  if (!answer.is_object() || !answer.contains("newName") || !answer.at("newName").is_string() ||
      answer.at("newName").get<std::string>().empty()) {
    co_return ActionError::protocol(tesseron::TesseronErrorCode::HandlerError,
                                    "The elicitation result was not a new todo name");
  }
  todo->text = answer.at("newName").get<std::string>();
  state->publish();
  co_return Json{{"id", identifier}, {"renamed", true}, {"newName", todo->text}};
}

boost::asio::awaitable<Result<Json>> suggest_todos(const std::shared_ptr<TodoState>& state, Json input,
                                                    ActionContext context) {
  const std::string theme = input.at("theme").get<std::string>();
  const int count = input.contains("count") ? input.at("count").get<int>() : 5;
  context.progress(ProgressUpdate().message("asking LLM...").percent(25));
  SampleRequest request("Produce exactly " + std::to_string(count) +
                        " concrete todo items for the theme \"" + theme +
                        "\". Return JSON matching { items: string[] }. Items should be short, "
                        "imperative, and user-friendly. No numbering.");
  request.json_schema(suggested_todos_output_schema()).max_tokens(400);
  auto sampled = co_await context.sample(std::move(request));
  if (!sampled.ok()) co_return sampled.error();
  if (!sampled.value().is_object() || !sampled.value().contains("items") ||
      !sampled.value().at("items").is_array()) {
    co_return ActionError::protocol(tesseron::TesseronErrorCode::HandlerError,
                                    "The sampling result was not suggested todos",
                                    Json{{"content", sampled.value()}});
  }

  context.progress(ProgressUpdate().message("adding to list...").percent(80));
  Json identifiers = Json::array();
  for (const auto& item : sampled.value().at("items")) {
    if (!item.is_string()) {
      co_return ActionError::protocol(tesseron::TesseronErrorCode::HandlerError,
                                      "The sampling result was not suggested todos",
                                      Json{{"content", sampled.value()}});
    }
    identifiers.push_back(state->create(item.get<std::string>(), theme).identifier);
  }
  state->publish();
  co_return Json{{"theme", theme}, {"added", identifiers.size()}, {"ids", identifiers}};
}

void register_actions(tesseron::HostBuilder& builder, const std::shared_ptr<TodoState>& state) {
  builder.action("addTodo")
      .description("Add one todo")
      .input(tesseron::schema::object({
          tesseron::schema::required("text", tesseron::schema::string().min_length(1)),
          tesseron::schema::optional("tag", tesseron::schema::string()),
      }))
      .output_schema(todo_output_schema())
      .handler([state](Json input, ActionContext) -> boost::asio::awaitable<Result<Json>> {
        const auto tag = optional_string(input, "tag");
        if (!tag.ok()) co_return tag.error();
        Todo todo = state->create(input.at("text").get<std::string>(), tag.value());
        state->publish();
        co_return todo_payload(todo);
      });

  builder.action("toggleTodo")
      .description("Toggle one todo")
      .input(todo_identifier_input_schema())
      .output_schema(todo_output_schema())
      .handler([state](Json input, ActionContext) -> boost::asio::awaitable<Result<Json>> {
        const std::string identifier = input.at("id").get<std::string>();
        auto todo = std::find_if(state->todos.begin(), state->todos.end(), [&](const Todo& candidate) {
          return candidate.identifier == identifier;
        });
        if (todo == state->todos.end()) co_return todo_not_found();
        todo->done = !todo->done;
        state->publish();
        co_return todo_payload(*todo);
      });

  builder.action("deleteTodo")
      .description("Delete one todo")
      .input(todo_identifier_input_schema())
      .output_schema({
          {"type", "object"},
          {"properties", {{"id", {{"type", "string"}}}, {"removed", {{"type", "boolean"}}}}},
          {"required", {"id", "removed"}},
      })
      .handler([state](Json input, ActionContext) -> boost::asio::awaitable<Result<Json>> {
        const std::string identifier = input.at("id").get<std::string>();
        auto todo = std::find_if(state->todos.begin(), state->todos.end(), [&](const Todo& candidate) {
          return candidate.identifier == identifier;
        });
        if (todo == state->todos.end()) co_return todo_not_found();
        state->todos.erase(todo);
        state->publish();
        co_return Json{{"id", identifier}, {"removed", true}};
      });

  builder.action("listTodos")
      .description("List todos")
      .input(tesseron::schema::object({
          tesseron::schema::optional("filter", tesseron::schema::string().allowed_values({"all", "active", "completed"})),
      }))
      .output_schema(todo_list_output_schema())
      .handler([state](Json input, ActionContext) -> boost::asio::awaitable<Result<Json>> {
        const std::string filter = input.value("filter", "all");
        Json listed = Json::array();
        for (const auto& todo : state->todos) {
          if (filter == "all" || (filter == "active" && !todo.done) ||
              (filter == "completed" && todo.done)) {
            listed.push_back(todo_payload(todo));
          }
        }
        co_return listed;
      });

  builder.action("clearCompleted")
      .description("Delete completed todos")
      .input(tesseron::schema::object({}))
      .output_schema({
          {"type", "object"},
          {"properties", {{"removed", {{"type", "integer"}}}}},
          {"required", {"removed"}},
      })
      .handler([state](Json, ActionContext) -> boost::asio::awaitable<Result<Json>> {
        const auto original_size = state->todos.size();
        std::erase_if(state->todos, [](const Todo& todo) { return todo.done; });
        const auto removed = original_size - state->todos.size();
        if (removed > 0) state->publish();
        co_return Json{{"removed", removed}};
      });

  builder.action("renameTodo")
      .description("Rename one todo")
      .input(todo_identifier_input_schema())
      .output_schema({
          {"type", "object"},
          {"properties",
           {{"id", {{"type", "string"}}}, {"renamed", {{"type", "boolean"}}},
            {"cancelled", {{"type", "boolean"}}}, {"newName", {{"type", "string"}}}}},
          {"required", {"id", "renamed"}},
      })
      .handler([state](Json input, ActionContext context) { return rename_todo(state, std::move(input), std::move(context)); });

  builder.action("importTodos")
      .description("Import several todos")
      .input(tesseron::schema::object({
          tesseron::schema::required("items", tesseron::schema::array(tesseron::schema::string()).min_items(1).max_items(50)),
          tesseron::schema::optional("tag", tesseron::schema::string()),
      }))
      .output_schema({
          {"type", "object"},
          {"properties", {{"added", {{"type", "integer"}}}, {"ids", {{"type", "array"}, {"items", {{"type", "string"}}}}}}},
          {"required", {"added", "ids"}},
      })
      .handler([state](Json input, ActionContext context) -> boost::asio::awaitable<Result<Json>> {
        const auto tag = optional_string(input, "tag");
        if (!tag.ok()) co_return tag.error();
        const Json& items = input.at("items");
        Json identifiers = Json::array();
        for (std::size_t index = 0; index < items.size(); ++index) {
          Todo todo = state->create(items[index].get<std::string>(), tag.value());
          identifiers.push_back(todo.identifier);
          context.progress(ProgressUpdate()
                               .message(std::to_string(index + 1) + "/" + std::to_string(items.size()) + " imported")
                               .percent(static_cast<int>((index + 1) * 100 / items.size())));
        }
        state->publish();
        co_return Json{{"added", identifiers.size()}, {"ids", identifiers}};
      });

  builder.action("suggestTodos")
      .description("Suggest todos for a theme")
      .input(tesseron::schema::object({
          tesseron::schema::required("theme", tesseron::schema::string().min_length(1)),
          tesseron::schema::optional("count", tesseron::schema::integer().minimum(1).maximum(10)),
      }))
      .output_schema({
          {"type", "object"},
          {"properties",
           {{"theme", {{"type", "string"}}}, {"added", {{"type", "integer"}}},
            {"ids", {{"type", "array"}, {"items", {{"type", "string"}}}}}}},
          {"required", {"theme", "added", "ids"}},
      })
      .handler([state](Json input, ActionContext context) { return suggest_todos(state, std::move(input), std::move(context)); });
}

void register_resource(tesseron::HostBuilder& builder, const std::shared_ptr<TodoState>& state) {
  builder.resource("todos://all")
      .description("The complete todo list. Pushed on every mutation.")
      .subscribe([state](tesseron::ResourceEmitter emitter) {
        state->subscribers.push_back(std::move(emitter));
        return tesseron::Subscription::without_teardown();
      })
      .reader([state]() -> boost::asio::awaitable<Result<Json>> { co_return todo_list_payload(state->todos); });
}

int run() {
  auto state = std::make_shared<TodoState>();
  auto builder = tesseron::Host::builder();
  builder.application("cpp_todo", "C++ Todo");
  builder.on_event([](const tesseron::HostEvent& event) {
    if (event.kind == tesseron::HostEvent::Kind::Welcome && event.welcome.has_value() &&
        event.welcome->claim_code.has_value()) {
      std::cout << "Claim code: " << *event.welcome->claim_code << std::endl;
    }
  });
  register_actions(builder, state);
  register_resource(builder, state);

  auto listening = builder.listen();
  if (!listening.ok()) {
    std::cerr << "tesseron-example-todo: " << listening.error().message() << "\n";
    return 1;
  }
  auto host = std::move(listening).value();
  for (;;) std::this_thread::sleep_for(std::chrono::hours(24));
}

}  // namespace

int main() { return run(); }
