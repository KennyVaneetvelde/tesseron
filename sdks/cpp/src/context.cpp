#include <tesseron/context.hpp>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <utility>

#include <boost/asio/post.hpp>
#include <boost/asio/redirect_error.hpp>
#include <boost/asio/steady_timer.hpp>
#include <boost/asio/this_coro.hpp>
#include <boost/asio/use_awaitable.hpp>

#include "elicit_schema.hpp"
#include "invocation_state.hpp"

namespace tesseron {
namespace {

using boost::asio::awaitable;

/// A timer that is never meant to expire, only to be cancelled. Waiting on one
/// is how a coroutine parks until something on the I/O thread wakes it.
std::shared_ptr<boost::asio::steady_timer> parked_timer(
    const boost::asio::any_io_executor& executor) {
  auto timer = std::make_shared<boost::asio::steady_timer>(executor);
  timer->expires_at(std::chrono::steady_clock::time_point::max());
  return timer;
}

awaitable<void> park_until_cancelled(std::shared_ptr<boost::asio::steady_timer> timer) {
  boost::system::error_code ignored;
  co_await timer->async_wait(boost::asio::redirect_error(boost::asio::use_awaitable, ignored));
}

/// The percent this update may report, remembered so the next one cannot fall
/// below it.
int raise_ceiling(detail::InvocationState& state, int requested) {
  const int bounded = std::clamp(requested, 0, 100);
  const std::lock_guard<std::mutex> guard(state.ceiling_guard);
  const int allowed =
      state.highest_percent.has_value() ? std::max(*state.highest_percent, bounded) : bounded;
  state.highest_percent = allowed;
  return allowed;
}

/// What the agent did with an elicitation prompt, plus whatever it sent back.
struct ElicitationOutcome {
  std::string action;
  Json value;
};

awaitable<Result<ElicitationOutcome>> request_elicitation(detail::InvocationState& state,
                                                          std::string question, Json schema) {
  Json params = Json::object();
  params["invocationId"] = state.invocation_id;
  params["question"] = std::move(question);
  params["schema"] = std::move(schema);

  auto answer = co_await state.channel->call(std::string(methods::kElicit), std::move(params));
  if (!answer.ok()) co_return ActionError::from_protocol_error(std::move(answer).error());

  const Json result = std::move(answer).value();
  const auto action = result.is_object() ? result.find("action") : result.end();
  if (action == result.end() || !action->is_string()) {
    co_return ActionError::protocol(TesseronErrorCode::HandlerError,
                                    "the gateway sent an unreadable elicitation result: " +
                                        result.dump());
  }
  const auto value = result.find("value");
  co_return ElicitationOutcome{action->get<std::string>(),
                               value == result.end() ? Json() : *value};
}

}  // namespace

ProgressUpdate& ProgressUpdate::message(std::string message) {
  message_ = std::move(message);
  return *this;
}

ProgressUpdate& ProgressUpdate::percent(int percent) {
  percent_ = percent;
  return *this;
}

ProgressUpdate& ProgressUpdate::data(Json data) {
  data_ = std::move(data);
  return *this;
}

SampleRequest::SampleRequest(std::string prompt) : prompt_(std::move(prompt)) {}

SampleRequest& SampleRequest::json_schema(Json schema) {
  json_schema_ = std::move(schema);
  return *this;
}

SampleRequest& SampleRequest::max_tokens(std::uint32_t max_tokens) {
  max_tokens_ = max_tokens;
  return *this;
}

ElicitRequest::ElicitRequest(std::string question) : question_(std::move(question)) {}

ElicitRequest& ElicitRequest::json_schema(Json schema) {
  json_schema_ = std::move(schema);
  return *this;
}

LogEntry::LogEntry(LogLevel level, std::string message)
    : level_(level), message_(std::move(message)) {}

LogEntry LogEntry::debug(std::string message) { return {LogLevel::Debug, std::move(message)}; }
LogEntry LogEntry::info(std::string message) { return {LogLevel::Info, std::move(message)}; }
LogEntry LogEntry::warn(std::string message) { return {LogLevel::Warn, std::move(message)}; }
LogEntry LogEntry::error(std::string message) { return {LogLevel::Error, std::move(message)}; }

LogEntry& LogEntry::meta(Json meta) {
  meta_ = std::move(meta);
  return *this;
}

ActionContext::ActionContext(std::shared_ptr<detail::InvocationState> state)
    : state_(std::move(state)) {}

const std::string& ActionContext::action_name() const noexcept { return state_->action_name; }

const std::string& ActionContext::invocation_id() const noexcept { return state_->invocation_id; }

const AgentIdentity& ActionContext::agent() const noexcept { return state_->agent; }

const std::string& ActionContext::origin() const noexcept { return state_->origin; }

const std::optional<std::string>& ActionContext::route() const noexcept { return state_->route; }

Capabilities ActionContext::agent_capabilities() const noexcept {
  return state_->agent_capabilities;
}

std::stop_token ActionContext::stop_token() const noexcept {
  return state_->cancellation.get_token();
}

bool ActionContext::cancelled() const noexcept { return state_->cancellation.stop_requested(); }

awaitable<void> ActionContext::wait_for_cancellation() const {
  if (state_->cancellation.stop_requested()) co_return;

  const auto executor = co_await boost::asio::this_coro::executor;
  const auto waker = parked_timer(executor);
  std::stop_callback wake(state_->cancellation.get_token(), [waker, executor] {
    boost::asio::post(executor, [waker] { waker->cancel(); });
  });
  while (!state_->cancellation.stop_requested()) co_await park_until_cancelled(waker);
}

void ActionContext::progress(const ProgressUpdate& update) const {
  Json params = Json::object();
  params["invocationId"] = state_->invocation_id;
  if (update.message().has_value()) params["message"] = *update.message();
  if (update.percent().has_value()) params["percent"] = raise_ceiling(*state_, *update.percent());
  if (update.data().has_value()) params["data"] = *update.data();
  state_->channel->notify(std::string(methods::kProgress), std::move(params));
}

void ActionContext::log(const LogEntry& entry) const {
  Json params = Json::object();
  params["invocationId"] = state_->invocation_id;
  params["level"] = std::string(name_of(entry.level()));
  params["message"] = entry.message();
  if (entry.meta().has_value()) params["meta"] = *entry.meta();
  state_->channel->notify(std::string(methods::kLog), std::move(params));
}

awaitable<Result<Json>> ActionContext::sample(SampleRequest request) const {
  if (!state_->agent_capabilities.sampling) {
    co_return ActionError::protocol(TesseronErrorCode::SamplingNotAvailable,
                                    "the connected agent did not negotiate sampling");
  }

  Json params = Json::object();
  params["invocationId"] = state_->invocation_id;
  params["prompt"] = request.prompt();
  if (request.json_schema().has_value()) params["schema"] = *request.json_schema();
  if (request.max_tokens().has_value()) params["maxTokens"] = *request.max_tokens();

  auto answer = co_await state_->channel->call(std::string(methods::kSample), std::move(params));
  if (!answer.ok()) co_return ActionError::from_protocol_error(std::move(answer).error());

  const Json result = std::move(answer).value();
  if (!result.is_object()) {
    co_return ActionError::protocol(
        TesseronErrorCode::HandlerError,
        "the gateway sent an unreadable sampling result: " + result.dump());
  }
  const auto content = result.find("content");
  co_return content == result.end() ? Json() : *content;
}

awaitable<Result<bool>> ActionContext::confirm(std::string question) const {
  if (!state_->agent_capabilities.elicitation) co_return false;

  auto answer =
      co_await request_elicitation(*state_, std::move(question), detail::confirmation_schema());
  if (!answer.ok()) co_return std::move(answer).error();
  co_return std::move(answer).value().action == "accept";
}

awaitable<Result<std::optional<Json>>> ActionContext::elicit(ElicitRequest request) const {
  if (!state_->agent_capabilities.elicitation) {
    co_return ActionError::protocol(TesseronErrorCode::ElicitationNotAvailable,
                                    "the connected agent did not negotiate elicitation");
  }

  Json schema =
      request.json_schema().has_value() ? *request.json_schema() : detail::permissive_schema();
  if (auto rejection = detail::validate_elicitation_schema(schema)) {
    co_return std::move(*rejection);
  }

  auto answer = co_await request_elicitation(*state_, request.question(), std::move(schema));
  if (!answer.ok()) co_return std::move(answer).error();

  auto outcome = std::move(answer).value();
  if (outcome.action != "accept") co_return std::optional<Json>();
  co_return std::optional<Json>(std::move(outcome.value));
}

awaitable<void> ActionContext::on_application_thread(std::function<void()> work) const {
  const auto executor = co_await boost::asio::this_coro::executor;
  const auto waker = parked_timer(executor);
  const auto finished = std::make_shared<std::atomic<bool>>(false);

  state_->channel->dispatch_to_application(
      [work = std::move(work), waker, finished, executor]() mutable {
        work();
        finished->store(true, std::memory_order_release);
        boost::asio::post(executor, [waker] { waker->cancel(); });
      });

  // A dispatcher that runs the work inline has already finished by the time
  // control gets here, and its wake-up would land on a timer nothing is waiting
  // on. Every other dispatcher can only finish once this thread parks, because
  // the wake-up it posts is handled here.
  while (!finished->load(std::memory_order_acquire)) co_await park_until_cancelled(waker);
}

}  // namespace tesseron
