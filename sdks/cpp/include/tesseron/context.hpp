#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <stop_token>
#include <string>

#include <boost/asio/any_io_executor.hpp>
#include <boost/asio/awaitable.hpp>

#include <tesseron/error.hpp>
#include <tesseron/json.hpp>
#include <tesseron/protocol.hpp>

namespace tesseron {

namespace detail {

/// The connection a running handler talks back through.
///
/// The session implements this. Keeping it an interface is what lets the
/// context live here without reaching into the session's private state.
class GatewayChannel {
 public:
  virtual ~GatewayChannel() = default;

  virtual void notify(std::string method, Json params) = 0;
  virtual boost::asio::awaitable<Result<Json, ProtocolError>> call(std::string method,
                                                                   Json params) = 0;
  virtual void dispatch_to_application(std::function<void()> work) = 0;
  virtual boost::asio::any_io_executor executor() const = 0;
};

struct InvocationState;

}  // namespace detail

/// One streaming update from a running handler. Every field is optional; send
/// whichever the handler actually knows.
class ProgressUpdate {
 public:
  ProgressUpdate() = default;

  ProgressUpdate& message(std::string message);
  /// Completion, 0 to 100. Values outside that range are clamped and a value
  /// below one already sent is raised to it: see `ActionContext::progress`.
  ProgressUpdate& percent(int percent);
  ProgressUpdate& data(Json data);

  [[nodiscard]] const std::optional<std::string>& message() const noexcept { return message_; }
  [[nodiscard]] const std::optional<int>& percent() const noexcept { return percent_; }
  [[nodiscard]] const std::optional<Json>& data() const noexcept { return data_; }

 private:
  std::optional<std::string> message_;
  std::optional<int> percent_;
  std::optional<Json> data_;
};

/// What to ask the agent's model for.
class SampleRequest {
 public:
  explicit SampleRequest(std::string prompt);

  /// Sends a JSON Schema the agent can use to constrain the model's output.
  SampleRequest& json_schema(Json schema);
  /// Caps how many tokens the sampling call may consume.
  SampleRequest& max_tokens(std::uint32_t max_tokens);

  [[nodiscard]] const std::string& prompt() const noexcept { return prompt_; }
  [[nodiscard]] const std::optional<Json>& json_schema() const noexcept { return json_schema_; }
  [[nodiscard]] const std::optional<std::uint32_t>& max_tokens() const noexcept {
    return max_tokens_;
  }

 private:
  std::string prompt_;
  std::optional<Json> json_schema_;
  std::optional<std::uint32_t> max_tokens_;
};

/// What to ask the user for.
class ElicitRequest {
 public:
  explicit ElicitRequest(std::string question);

  /// Sends a JSON Schema the agent renders as a form. It must satisfy the
  /// elicitation rules in the specification, or `ActionContext::elicit` answers
  /// `-32602` without sending anything.
  ElicitRequest& json_schema(Json schema);

  [[nodiscard]] const std::string& question() const noexcept { return question_; }
  [[nodiscard]] const std::optional<Json>& json_schema() const noexcept { return json_schema_; }

 private:
  std::string question_;
  std::optional<Json> json_schema_;
};

/// One structured log line, forwarded to the agent's MCP logging.
class LogEntry {
 public:
  LogEntry(LogLevel level, std::string message);

  [[nodiscard]] static LogEntry debug(std::string message);
  [[nodiscard]] static LogEntry info(std::string message);
  [[nodiscard]] static LogEntry warn(std::string message);
  [[nodiscard]] static LogEntry error(std::string message);

  /// Attaches structured metadata to the line.
  LogEntry& meta(Json meta);

  [[nodiscard]] LogLevel level() const noexcept { return level_; }
  [[nodiscard]] const std::string& message() const noexcept { return message_; }
  [[nodiscard]] const std::optional<Json>& meta() const noexcept { return meta_; }

 private:
  LogLevel level_;
  std::string message_;
  std::optional<Json> meta_;
};

/// What a handler is told about the invocation it is running, and everything it
/// can send back while it runs.
///
/// The context is cheap to copy and every copy talks to the same invocation,
/// including the shared progress ceiling, so a handler can hand one to a helper
/// without losing monotonicity.
class ActionContext {
 public:
  explicit ActionContext(std::shared_ptr<detail::InvocationState> state);

  [[nodiscard]] const std::string& action_name() const noexcept;
  /// The gateway's id for this invocation. Correlates progress, cancellation,
  /// and logs with the request the agent is waiting on.
  [[nodiscard]] const std::string& invocation_id() const noexcept;
  /// Who is invoking. `pending` until the session is claimed.
  [[nodiscard]] const AgentIdentity& agent() const noexcept;
  [[nodiscard]] const std::string& origin() const noexcept;
  /// Where in the application the agent was, when the gateway said.
  [[nodiscard]] const std::optional<std::string>& route() const noexcept;
  /// What the agent on the other end negotiated. Check this before `sample` or
  /// `elicit` when the handler has a useful non-interactive fallback.
  [[nodiscard]] Capabilities agent_capabilities() const noexcept;

  /// Fires when the agent cancels this invocation, when the invocation times
  /// out, and when the transport closes under it.
  [[nodiscard]] std::stop_token stop_token() const noexcept;
  [[nodiscard]] bool cancelled() const noexcept;
  /// Resolves as soon as cancellation is requested, immediately if it already
  /// was. A long handler should await this alongside its own work.
  [[nodiscard]] boost::asio::awaitable<void> wait_for_cancellation() const;

  /// Streams one progress update to the agent.
  ///
  /// Percent is clamped into 0 to 100 and never allowed to fall below a value
  /// already sent for this invocation: an agent rendering a progress bar reads
  /// a backwards jump as a restart. Fire-and-forget, like every notification.
  void progress(const ProgressUpdate& update) const;

  /// Forwards one log line to the agent. Fire-and-forget.
  void log(const LogEntry& entry) const;

  /// Asks the agent's model to answer the request's prompt.
  ///
  /// Sampling depth is not a field in any Tesseron frame: the gateway owns
  /// `maxSamplingDepth` and answers `-32008` itself, so the host forwards the
  /// request without counting.
  [[nodiscard]] boost::asio::awaitable<Result<Json>> sample(SampleRequest request) const;

  /// Asks the user a yes-or-no question through the agent.
  ///
  /// `true` only on an explicit accept. A decline, a cancel, and an agent that
  /// never negotiated elicitation all answer `false`, which is the safe reading
  /// for the destructive-operation gates this exists for.
  [[nodiscard]] boost::asio::awaitable<Result<bool>> confirm(std::string question) const;

  /// Asks the user for structured content through the agent.
  ///
  /// Answers an empty optional on a decline or a cancel. Unlike `confirm`, a
  /// missing capability is an error, because structured content has no safe
  /// default and the handler has to branch on it explicitly.
  [[nodiscard]] boost::asio::awaitable<Result<std::optional<Json>>> elicit(
      ElicitRequest request) const;

  /// Runs `work` on the application's own thread and resumes the handler back
  /// on the host's I/O thread.
  ///
  /// Without a `HostOptions::application_dispatcher` the work runs inline,
  /// which is correct for a headless application that has no other thread.
  [[nodiscard]] boost::asio::awaitable<void> on_application_thread(
      std::function<void()> work) const;

 private:
  std::shared_ptr<detail::InvocationState> state_;
};

}  // namespace tesseron
