#include "fixture.hpp"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <initializer_list>
#include <memory>
#include <mutex>
#include <stop_token>
#include <thread>
#include <utility>
#include <vector>

#include "schema_subset.hpp"

namespace conformance {
namespace {

using boost::asio::awaitable;
using tesseron::ActionContext;
using tesseron::ActionError;
using tesseron::ElicitRequest;
using tesseron::HostBuilder;
using tesseron::Json;
using tesseron::ProgressUpdate;
using tesseron::ResourceEmitter;
using tesseron::Result;
using tesseron::Subscription;

/// How far apart queued resource updates are pushed.
///
/// The runner stamps a frame's arrival and compares it with the moment the
/// labeled step finished, so an update written into the same socket flush as
/// the subscription acknowledgement can land too early to satisfy `notBefore`.
/// Spacing the updates out is what a fixture's `afterStep` is asking for.
constexpr std::chrono::milliseconds kUpdateSpacing{25};

const Json* member(const Json& object, const char* key) {
  if (!object.is_object()) return nullptr;
  const auto found = object.find(key);
  return found == object.end() ? nullptr : &*found;
}

std::optional<std::string> unknown_member(const Json& object, const std::string& what,
                                          std::initializer_list<const char*> known) {
  if (!object.is_object()) return what + " must be a JSON object, got " + object.dump();
  for (const auto& entry : object.items()) {
    const bool declared = std::any_of(known.begin(), known.end(), [&entry](const char* name) {
      return entry.key() == name;
    });
    if (!declared) return what + " carries the unsupported key \"" + entry.key() + "\"";
  }
  return std::nullopt;
}

std::string read_text(const Json& object, const char* key) {
  const Json* const found = member(object, key);
  return found != nullptr && found->is_string() ? found->get<std::string>() : std::string();
}

bool read_flag(const Json& object, const char* key) {
  const Json* const found = member(object, key);
  return found != nullptr && found->is_boolean() && found->get<bool>();
}

struct ElicitationScript {
  std::string question;
  /// Handed to the SDK exactly as written, including the shapes the protocol
  /// rejects: these fixtures exist to prove the SDK does the rejecting.
  Json json_schema;
};

/// Everything one action's handler needs, shared across every invocation of it.
struct ActionScript {
  std::string name;
  Json returns;
  bool assert_handler_not_called = false;
  bool blocks_until_cancelled = false;
  /// Kept as raw objects so an entry carrying an explicit `"data": null` stays
  /// distinguishable from one that omits the key.
  std::vector<Json> progress;
  std::optional<std::string> confirms;
  bool returns_confirm_result = false;
  std::optional<ElicitationScript> elicits;
};

ProgressUpdate progress_update(const Json& entry) {
  ProgressUpdate update;
  if (const Json* const percent = member(entry, "percent"); percent != nullptr && percent->is_number()) {
    update.percent(static_cast<int>(std::llround(percent->get<double>())));
  }
  if (const Json* const message = member(entry, "message"); message != nullptr && message->is_string()) {
    update.message(message->get<std::string>());
  }
  if (const Json* const data = member(entry, "data")) update.data(*data);
  return update;
}

/// Applies the fixture's behaviours in the order `conformance/README.md` fixes:
/// refuse an unexpected call, wait to be cancelled, stream progress, confirm,
/// elicit, then answer with the canned value.
awaitable<Result<Json>> run_action(std::shared_ptr<const ActionScript> script,
                                   ActionContext context) {
  if (script->assert_handler_not_called) {
    co_return ActionError::handler("the handler for " + script->name +
                                   " ran, but the fixture says it must not");
  }
  if (script->blocks_until_cancelled) {
    // The session answers -32001 the moment the cancellation arrives and
    // ignores whatever settles second, so this return value never reaches the
    // wire. Waiting here rather than never returning is what lets the
    // invocation's coroutine frame go away with the invocation.
    co_await context.wait_for_cancellation();
    co_return ActionError::handler("invocation " + context.invocation_id() + " was cancelled");
  }

  for (const Json& entry : script->progress) context.progress(progress_update(entry));

  if (script->confirms.has_value()) {
    auto confirmed = co_await context.confirm(*script->confirms);
    if (!confirmed.ok()) co_return std::move(confirmed).error();
    if (script->returns_confirm_result) {
      Json answer = Json::object();
      answer["confirmed"] = confirmed.value();
      co_return answer;
    }
  }

  if (script->elicits.has_value()) {
    ElicitRequest request(script->elicits->question);
    request.json_schema(script->elicits->json_schema);
    auto answered = co_await context.elicit(std::move(request));
    if (!answered.ok()) co_return std::move(answered).error();
  }

  co_return script->returns;
}

std::optional<std::string> register_action(HostBuilder& builder, const Json& declaration) {
  if (auto refusal = unknown_member(declaration, "an action",
                                    {"name", "description", "returns", "inputSchema",
                                     "assertHandlerNotCalled", "blocksUntilCancelled", "progress",
                                     "confirms", "returnsConfirmResult", "elicits"})) {
    return refusal;
  }
  const Json* const name = member(declaration, "name");
  if (name == nullptr || !name->is_string()) return "an action has no name";

  auto script = std::make_shared<ActionScript>();
  script->name = name->get<std::string>();
  if (const Json* const returns = member(declaration, "returns")) script->returns = *returns;
  script->assert_handler_not_called = read_flag(declaration, "assertHandlerNotCalled");
  script->blocks_until_cancelled = read_flag(declaration, "blocksUntilCancelled");
  if (const Json* const progress = member(declaration, "progress"); progress != nullptr) {
    if (!progress->is_array()) return "action \"" + script->name + "\": progress must be an array";
    script->progress.assign(progress->begin(), progress->end());
  }
  if (const Json* const confirms = member(declaration, "confirms");
      confirms != nullptr && confirms->is_string()) {
    script->confirms = confirms->get<std::string>();
  }
  script->returns_confirm_result = read_flag(declaration, "returnsConfirmResult");
  if (const Json* const elicits = member(declaration, "elicits"); elicits != nullptr) {
    if (auto refusal = unknown_member(*elicits, "action \"" + script->name + "\": elicits",
                                      {"question", "jsonSchema"})) {
      return refusal;
    }
    const Json* const schema = member(*elicits, "jsonSchema");
    if (schema == nullptr) return "action \"" + script->name + "\": elicits has no jsonSchema";
    script->elicits = ElicitationScript{read_text(*elicits, "question"), *schema};
  }

  auto action = builder.action(script->name);
  action.description(read_text(declaration, "description"));
  if (const Json* const declared = member(declaration, "inputSchema"); declared != nullptr) {
    if (auto refusal = unenforceable_keyword(*declared)) {
      return "action \"" + script->name + "\": " + *refusal;
    }
    Json enforced = *declared;
    action.input_schema(*declared, [enforced](const Json& input) { return check(enforced, input); });
  }
  action.handler([script](Json, ActionContext context) {
    return run_action(script, std::move(context));
  });
  return std::nullopt;
}

awaitable<Result<Json>> read_value(std::shared_ptr<const Json> value) { co_return *value; }

struct UpdateSchedule {
  std::mutex guard;
  std::condition_variable waker;
  bool stopped = false;
};

Subscription start_updates(std::shared_ptr<const std::vector<Json>> updates,
                           ResourceEmitter emitter) {
  auto schedule = std::make_shared<UpdateSchedule>();
  auto pushing = std::make_shared<std::jthread>([updates, emitter,
                                                 schedule](std::stop_token stopping) {
    // The teardown normally trips `stopped` itself; this covers a subscription
    // dropped without `stop()`, where only the thread's own token fires.
    std::stop_callback waking(stopping, [schedule] {
      {
        const std::lock_guard closing(schedule->guard);
        schedule->stopped = true;
      }
      schedule->waker.notify_all();
    });
    for (const Json& value : *updates) {
      std::unique_lock waiting(schedule->guard);
      if (schedule->waker.wait_for(waiting, kUpdateSpacing, [&schedule] { return schedule->stopped; })) {
        return;
      }
      waiting.unlock();
      emitter.emit(value);
    }
  });
  return Subscription::with_teardown([schedule, pushing] {
    {
      const std::lock_guard closing(schedule->guard);
      schedule->stopped = true;
    }
    schedule->waker.notify_all();
  });
}

std::optional<std::string> register_resource(HostBuilder& builder, const Json& declaration) {
  if (auto refusal = unknown_member(
          declaration, "a resource", {"name", "description", "value", "subscribable", "emits"})) {
    return refusal;
  }
  const Json* const name = member(declaration, "name");
  if (name == nullptr || !name->is_string()) return "a resource has no name";
  const auto resource_name = name->get<std::string>();

  auto updates = std::make_shared<std::vector<Json>>();
  if (const Json* const emits = member(declaration, "emits"); emits != nullptr) {
    if (!emits->is_array()) return "resource \"" + resource_name + "\": emits must be an array";
    for (std::size_t index = 0; index < emits->size(); ++index) {
      const Json* const value = member((*emits)[index], "value");
      if (value == nullptr) {
        return "resource \"" + resource_name + "\": emits[" + std::to_string(index) +
               "] has no value";
      }
      updates->push_back(*value);
    }
  }

  const Json* const declared_value = member(declaration, "value");
  auto value = std::make_shared<const Json>(declared_value == nullptr ? Json() : *declared_value);

  auto resource = builder.resource(resource_name);
  resource.description(read_text(declaration, "description"));
  if (read_flag(declaration, "subscribable")) {
    auto queued = std::shared_ptr<const std::vector<Json>>(updates);
    resource.subscribe(
        [queued](ResourceEmitter emitter) { return start_updates(queued, std::move(emitter)); });
  }
  resource.reader([value] { return read_value(value); });
  return std::nullopt;
}

}  // namespace

std::optional<std::string> register_fixture(HostBuilder& builder, const Json& document) {
  const Json* const requirements = member(document, "requires");
  if (requirements != nullptr && requirements->is_array()) {
    for (const Json& tag : *requirements) {
      if (tag == "uds") {
        return "this host speaks WebSocket only; declare uds in the runner's unsupported list";
      }
    }
  }

  const Json* const application = member(document, "fixture");
  if (application == nullptr) return "the fixture document has no fixture member";
  if (auto refusal = unknown_member(*application, "the fixture",
                                    {"actions", "resources", "hostMintedClaim"})) {
    return refusal;
  }
  if (member(*application, "hostMintedClaim") != nullptr) {
    return "this host uses gateway-minted claims; declare host-minted-claim in the runner's "
           "unsupported list";
  }

  if (const Json* const actions = member(*application, "actions"); actions != nullptr) {
    if (!actions->is_array()) return "the fixture's actions must be an array";
    for (const Json& declaration : *actions) {
      if (auto refusal = register_action(builder, declaration)) return refusal;
    }
  }
  if (const Json* const resources = member(*application, "resources"); resources != nullptr) {
    if (!resources->is_array()) return "the fixture's resources must be an array";
    for (const Json& declaration : *resources) {
      if (auto refusal = register_resource(builder, declaration)) return refusal;
    }
  }
  return std::nullopt;
}

}  // namespace conformance
