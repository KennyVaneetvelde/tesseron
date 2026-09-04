#include "session.hpp"

#include <exception>
#include <iostream>
#include <utility>

#include <boost/asio/buffer.hpp>
#include <boost/asio/co_spawn.hpp>
#include <boost/asio/detached.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/redirect_error.hpp>
#include <boost/asio/use_awaitable.hpp>

#include <tesseron/protocol.hpp>
#include <tesseron/schema.hpp>

namespace tesseron::detail {
namespace {

using boost::asio::awaitable;
using boost::asio::redirect_error;
using boost::asio::use_awaitable;

/// How long an invocation may run before the host answers `-32002` on its own.
///
/// The gateway applies the same 60-second default from its side. The host keeps
/// its own clock so a handler that never returns cannot pin an invocation open
/// after the agent has stopped waiting.
constexpr std::chrono::milliseconds kDefaultInvocationTimeout{60000};

/// A timer that is never meant to expire, only to be cancelled.
void park(boost::asio::steady_timer& timer) {
  timer.expires_at(std::chrono::steady_clock::time_point::max());
}

std::optional<std::string> read_string(const Json& value, const char* key) {
  if (!value.is_object()) return std::nullopt;
  const auto found = value.find(key);
  if (found == value.end() || !found->is_string()) return std::nullopt;
  return found->get<std::string>();
}

std::optional<std::string> read_route(const Json& params) {
  if (!params.is_object()) return std::nullopt;
  const auto client = params.find("client");
  if (client == params.end()) return std::nullopt;
  return read_string(*client, "route");
}

/// Turns a handler failure into its wire payload, reporting the cause that
/// `ActionError::internal` deliberately keeps off the socket.
ProtocolError wire_error(const ActionError& failure) {
  if (failure.internal_source()) {
    try {
      std::rethrow_exception(failure.internal_source());
    } catch (const std::exception& source) {
      std::cerr << "tesseron: handler failed with an internal error: " << source.what() << '\n';
    } catch (...) {
      std::cerr << "tesseron: handler failed with an internal error of an unknown type\n";
    }
  }
  return failure.to_protocol_error();
}

}  // namespace

Session::PendingCall::PendingCall(const boost::asio::any_io_executor& executor)
    : waker(executor) {
  park(waker);
}

Session::RunningInvocation::RunningInvocation(const boost::asio::any_io_executor& executor,
                                              std::shared_ptr<InvocationState> state)
    : state(std::move(state)), waker(executor) {
  park(waker);
}

void Session::RunningInvocation::settle(Result<Json, ProtocolError> answer) {
  if (outcome.has_value()) return;
  outcome = std::move(answer);
  waker.cancel();
}

Session::Session(WebSocketStream socket, std::shared_ptr<HostState> host)
    : socket_(std::move(socket)),
      host_(std::move(host)),
      executor_(socket_.get_executor()),
      writer_wake_(executor_),
      handshake_wake_(executor_) {
  park(writer_wake_);
  park(handshake_wake_);
}

awaitable<void> Session::serve(WebSocketStream socket, std::shared_ptr<HostState> host) {
  const auto session = std::make_shared<Session>(std::move(socket), std::move(host));
  session->host_->connection = session;
  co_await session->run();
}

boost::asio::any_io_executor Session::executor() const { return executor_; }

void Session::dispatch_to_application(std::function<void()> work) {
  if (host_->application_dispatcher) {
    host_->application_dispatcher(std::move(work));
    return;
  }
  work();
}

void Session::notify(std::string method, Json params) {
  send_envelope(notification(method, std::move(params)));
}

awaitable<Result<Json, ProtocolError>> Session::call(std::string method, Json params) {
  const auto self = shared_from_this();
  if (!transport_open_) {
    co_return ProtocolError(TesseronErrorCode::TransportClosed,
                            "the gateway connection is closed");
  }

  const auto id = mint_request_id();
  const auto key = id.key();
  const auto waiting = std::make_shared<PendingCall>(executor_);
  pending_.emplace(key, waiting);
  send_envelope(request(id, method, std::move(params)));

  while (!waiting->outcome.has_value()) {
    boost::system::error_code ignored;
    co_await waiting->waker.async_wait(redirect_error(use_awaitable, ignored));
  }
  pending_.erase(key);
  co_return std::move(*waiting->outcome);
}

RequestId Session::mint_request_id() { return RequestId::from_number(next_request_id_++); }

void Session::send_envelope(const Json& envelope) {
  std::string text = envelope.dump();
  {
    const std::lock_guard<std::mutex> guard(outgoing_guard_);
    if (sending_stopped_) return;
    outgoing_.push_back(std::move(text));
  }
  boost::asio::post(executor_, [self = shared_from_this()] { self->writer_wake_.cancel(); });
}

void Session::stop_sending() {
  {
    const std::lock_guard<std::mutex> guard(outgoing_guard_);
    if (sending_stopped_) return;
    sending_stopped_ = true;
  }
  writer_wake_.cancel();
}

awaitable<void> Session::write_loop() {
  const auto self = shared_from_this();
  while (true) {
    std::optional<std::string> next;
    bool finished = false;
    {
      const std::lock_guard<std::mutex> guard(outgoing_guard_);
      if (!outgoing_.empty()) {
        next = std::move(outgoing_.front());
        outgoing_.pop_front();
      } else {
        finished = sending_stopped_;
      }
    }

    if (next.has_value()) {
      boost::system::error_code write_failure;
      co_await socket_.async_write(boost::asio::buffer(*next),
                                   redirect_error(use_awaitable, write_failure));
      if (write_failure) break;
      continue;
    }
    if (finished) break;

    boost::system::error_code ignored;
    co_await writer_wake_.async_wait(redirect_error(use_awaitable, ignored));
  }

  // Closing here rather than at the read loop's end is what makes a refused
  // handshake visible to the gateway: `reject_handshake` stops the queue, and
  // this is the only place that owns the socket's write half.
  boost::system::error_code ignored;
  co_await socket_.async_close(boost::beast::websocket::close_code::normal,
                               redirect_error(use_awaitable, ignored));
}

awaitable<void> Session::read_until_closed() {
  boost::beast::flat_buffer buffer;
  while (true) {
    boost::system::error_code read_failure;
    co_await socket_.async_read(buffer, redirect_error(use_awaitable, read_failure));
    if (read_failure) break;

    // Binary frames are parsed too: relays between the gateway and the host
    // have been observed re-framing text as binary.
    const auto payload = boost::beast::buffers_to_string(buffer.data());
    buffer.consume(buffer.size());

    const Json frame = Json::parse(payload, nullptr, false);
    if (frame.is_discarded()) {
      std::cerr << "tesseron: dropping an unparsable frame\n";
      continue;
    }
    dispatch(classify(frame));
  }
}

awaitable<void> Session::run() {
  const auto self = shared_from_this();
  boost::asio::co_spawn(executor_, write_loop(), boost::asio::detached);
  boost::asio::co_spawn(executor_, open_session(), boost::asio::detached);

  co_await read_until_closed();

  transport_open_ = false;
  settle_handshake(Handshake::Failed);
  cancel_all_invocations();
  drop_all_subscriptions();
  fail_all_pending();
  stop_sending();

  HostEvent event;
  event.kind = HostEvent::Kind::Disconnected;
  host_->emit(event);
}

void Session::close() {
  transport_open_ = false;
  settle_handshake(Handshake::Failed);
  cancel_all_invocations();
  drop_all_subscriptions();
  fail_all_pending();
  stop_sending();
  boost::beast::get_lowest_layer(socket_).close();
}

void Session::dispatch(IncomingFrame frame) {
  switch (frame.kind) {
    case IncomingFrame::Kind::Success:
      resolve(*frame.id, std::move(frame.result));
      return;
    case IncomingFrame::Kind::Failure:
      resolve(*frame.id, std::move(*frame.error));
      return;
    case IncomingFrame::Kind::Request:
      handle_request(*frame.id, frame.method, frame.params);
      return;
    case IncomingFrame::Kind::Notification:
      handle_notification(frame.method, frame.params);
      return;
    case IncomingFrame::Kind::Malformed:
      std::cerr << "tesseron: dropping a frame that is not JSON-RPC 2.0: " << frame.problem << '\n';
      return;
  }
}

void Session::handle_request(const RequestId& id, const std::string& method, const Json& params) {
  if (method == methods::kInvoke) {
    start_invocation(id, params);
  } else if (method == methods::kRead) {
    start_resource_read(id, params);
  } else if (method == methods::kSubscribe) {
    subscribe_to_resource(id, params);
  } else if (method == methods::kUnsubscribe) {
    unsubscribe_from_resource(id, params);
  } else {
    send_envelope(failure(
        id, ProtocolError(TesseronErrorCode::MethodNotFound, "Method not found: " + method)));
  }
}

void Session::handle_notification(const std::string& method, const Json& params) {
  if (method == methods::kCancel) {
    const auto invocation_id = read_string(params, "invocationId");
    if (invocation_id.has_value()) cancel_invocation(*invocation_id);
    return;
  }
  if (method != methods::kClaimed) return;

  // A claim that arrives before any welcome names a session this host has not
  // opened, so applying it would spend a claim code the user never saw.
  if (!host_->welcome_snapshot().has_value()) {
    std::cerr << "tesseron: ignoring a tesseron/claimed that arrived before the welcome\n";
    return;
  }
  const auto claimed = ClaimedParams::from_json(params);
  if (!claimed.has_value()) return;

  host_->record_claim(*claimed);
  HostEvent event;
  event.kind = HostEvent::Kind::Claimed;
  event.claimed = *claimed;
  host_->emit(event);
}

void Session::start_invocation(const RequestId& id, const Json& params) {
  const auto action_name = read_string(params, "name");
  const auto invocation_id = read_string(params, "invocationId");
  if (!action_name.has_value() || !invocation_id.has_value()) {
    send_envelope(failure(id, ProtocolError(TesseronErrorCode::InvalidParams,
                                            "Invalid actions/invoke params: name and invocationId "
                                            "are both required strings")));
    return;
  }

  const auto action = host_->actions.find(*action_name);
  if (action == host_->actions.end()) {
    send_envelope(failure(
        id, ProtocolError(TesseronErrorCode::ActionNotFound, "Action not found: " + *action_name)));
    return;
  }

  const auto declared_input = params.find("input");
  Json input = declared_input == params.end() ? Json() : *declared_input;

  if (action->second.validator.has_value()) {
    const auto issues = (*action->second.validator)(input);
    if (!issues.empty()) {
      send_envelope(failure(id, ProtocolError(TesseronErrorCode::InputValidation, "Invalid input")
                                    .with_data(validation_issues_to_json(issues))));
      return;
    }
  }

  auto state = std::make_shared<InvocationState>();
  state->action_name = *action_name;
  state->invocation_id = *invocation_id;
  state->origin = host_->application.origin;
  state->route = read_route(params);
  state->channel = shared_from_this();

  auto running = std::make_shared<RunningInvocation>(executor_, state);
  invocations_.insert_or_assign(*invocation_id, running);

  const auto declared_timeout = action->second.descriptor.timeout_milliseconds;
  const auto timeout = declared_timeout.has_value()
                           ? std::chrono::milliseconds(*declared_timeout)
                           : kDefaultInvocationTimeout;
  boost::asio::co_spawn(
      executor_,
      run_invocation(id, std::move(running), action->second.handler, std::move(input), timeout),
      boost::asio::detached);
}

awaitable<void> Session::run_invocation(RequestId id, std::shared_ptr<RunningInvocation> running,
                                        ActionHandler handler, Json input,
                                        std::chrono::milliseconds timeout) {
  const auto self = shared_from_this();

  // A gateway that writes an invocation straight behind its welcome reaches the
  // read loop before the handshake task has applied it, and a refused handshake
  // must not run application code at all.
  if (!co_await handshake_settled()) {
    finish_invocation(running->state->invocation_id);
    co_return;
  }

  running->state->agent = host_->agent_identity();
  running->state->agent_capabilities = host_->negotiated_capabilities();

  boost::asio::steady_timer deadline(executor_);
  deadline.expires_after(timeout);
  deadline.async_wait([running, timeout](const boost::system::error_code& expired) {
    if (expired) return;
    running->state->cancellation.request_stop();
    running->settle(ProtocolError(TesseronErrorCode::Timeout,
                                  "Invocation " + running->state->invocation_id + " exceeded " +
                                      std::to_string(timeout.count()) + " ms"));
  });

  boost::asio::co_spawn(executor_, drive_handler(running, std::move(handler), std::move(input)),
                        boost::asio::detached);

  while (!running->outcome.has_value()) {
    boost::system::error_code ignored;
    co_await running->waker.async_wait(redirect_error(use_awaitable, ignored));
  }
  deadline.cancel();
  finish_invocation(running->state->invocation_id);

  auto answer = std::move(*running->outcome);
  if (!answer.ok()) {
    send_envelope(failure(id, std::move(answer).error()));
    co_return;
  }
  Json result = Json::object();
  result["invocationId"] = running->state->invocation_id;
  result["output"] = std::move(answer).value();
  send_envelope(success(id, std::move(result)));
}

awaitable<void> Session::drive_handler(std::shared_ptr<RunningInvocation> running,
                                       ActionHandler handler, Json input) {
  const auto self = shared_from_this();
  const ActionContext context(running->state);
  try {
    auto outcome = co_await handler(std::move(input), context);
    if (outcome.ok()) {
      running->settle(std::move(outcome).value());
    } else {
      running->settle(wire_error(std::move(outcome).error()));
    }
  } catch (const std::exception& problem) {
    std::cerr << "tesseron: handler for " << running->state->action_name
              << " threw: " << problem.what() << '\n';
    running->settle(ProtocolError(TesseronErrorCode::InternalError, "Internal error"));
  } catch (...) {
    std::cerr << "tesseron: handler for " << running->state->action_name
              << " threw a value that is not an exception\n";
    running->settle(ProtocolError(TesseronErrorCode::InternalError, "Internal error"));
  }
}

void Session::finish_invocation(const std::string& invocation_id) {
  invocations_.erase(invocation_id);
}

void Session::cancel_invocation(const std::string& invocation_id) {
  const auto found = invocations_.find(invocation_id);
  if (found == invocations_.end()) return;
  const auto running = found->second;
  running->state->cancellation.request_stop();
  running->settle(
      ProtocolError(TesseronErrorCode::Cancelled, "Invocation " + invocation_id + " was cancelled"));
}

void Session::cancel_all_invocations() {
  auto running = std::move(invocations_);
  invocations_.clear();
  for (auto& [invocation_id, invocation] : running) {
    invocation->state->cancellation.request_stop();
    invocation->settle(ProtocolError(TesseronErrorCode::TransportClosed,
                                     "the gateway connection closed during invocation " +
                                         invocation_id));
  }
}

void Session::start_resource_read(const RequestId& id, const Json& params) {
  const auto name = read_string(params, "name");
  if (!name.has_value()) {
    send_envelope(failure(id, ProtocolError(TesseronErrorCode::InvalidParams,
                                            "Invalid resources/read params: name is required")));
    return;
  }
  const auto resource = host_->resources.find(*name);
  if (resource == host_->resources.end()) {
    send_envelope(failure(
        id, ProtocolError(TesseronErrorCode::ActionNotFound, "Resource not readable: " + *name)));
    return;
  }
  boost::asio::co_spawn(executor_, answer_resource_read(id, resource->second.reader),
                        boost::asio::detached);
}

awaitable<void> Session::answer_resource_read(RequestId id, ResourceReader reader) {
  const auto self = shared_from_this();
  try {
    auto value = co_await reader();
    if (!value.ok()) {
      send_envelope(failure(id, wire_error(std::move(value).error())));
      co_return;
    }
    Json result = Json::object();
    result["value"] = std::move(value).value();
    send_envelope(success(id, std::move(result)));
  } catch (const std::exception& problem) {
    std::cerr << "tesseron: a resource reader threw: " << problem.what() << '\n';
    send_envelope(
        failure(id, ProtocolError(TesseronErrorCode::InternalError, "Internal error")));
  }
}

void Session::subscribe_to_resource(const RequestId& id, const Json& params) {
  const auto name = read_string(params, "name");
  const auto subscription_id = read_string(params, "subscriptionId");
  if (!name.has_value() || !subscription_id.has_value()) {
    send_envelope(failure(id, ProtocolError(TesseronErrorCode::InvalidParams,
                                            "Invalid resources/subscribe params: name and "
                                            "subscriptionId are both required strings")));
    return;
  }

  const auto resource = host_->resources.find(*name);
  if (resource == host_->resources.end() || !resource->second.subscriber.has_value()) {
    send_envelope(failure(
        id, ProtocolError(TesseronErrorCode::ActionNotFound, "Resource not subscribable: " + *name)));
    return;
  }

  // The acknowledgement goes out before the subscriber runs, so a value the
  // subscriber emits immediately cannot overtake the response the agent is
  // still waiting on.
  send_envelope(success(id, Json()));

  auto state = std::make_shared<SubscriptionState>();
  state->channel = shared_from_this();
  state->subscription_id = *subscription_id;

  drop_subscription(*subscription_id);
  auto subscription = (*resource->second.subscriber)(ResourceEmitter(state));
  subscriptions_.insert_or_assign(*subscription_id,
                                  RegisteredSubscription{std::move(state), std::move(subscription)});
}

void Session::unsubscribe_from_resource(const RequestId& id, const Json& params) {
  const auto subscription_id = read_string(params, "subscriptionId");
  if (!subscription_id.has_value()) {
    send_envelope(failure(id, ProtocolError(TesseronErrorCode::InvalidParams,
                                            "Invalid resources/unsubscribe params: subscriptionId "
                                            "is required")));
    return;
  }
  // An id nobody registered is not an error: the agent and the transport can
  // race, and there is nothing left to tear down either way.
  drop_subscription(*subscription_id);
  send_envelope(success(id, Json()));
}

void Session::drop_subscription(const std::string& subscription_id) {
  const auto found = subscriptions_.find(subscription_id);
  if (found == subscriptions_.end()) return;
  auto registered = std::move(found->second);
  subscriptions_.erase(found);
  registered.state->active.store(false, std::memory_order_release);
  registered.subscription.stop();
}

void Session::drop_all_subscriptions() {
  auto registered = std::move(subscriptions_);
  subscriptions_.clear();
  for (auto& [subscription_id, subscription] : registered) {
    subscription.state->active.store(false, std::memory_order_release);
    subscription.subscription.stop();
  }
}

void Session::resolve(const RequestId& id, Result<Json, ProtocolError> outcome) {
  const auto found = pending_.find(id.key());
  if (found == pending_.end()) return;
  if (found->second->outcome.has_value()) return;
  found->second->outcome = std::move(outcome);
  found->second->waker.cancel();
}

void Session::fail_all_pending() {
  for (auto& [key, waiting] : pending_) {
    if (waiting->outcome.has_value()) continue;
    waiting->outcome =
        ProtocolError(TesseronErrorCode::TransportClosed, "the gateway connection closed");
    waiting->waker.cancel();
  }
}

awaitable<bool> Session::handshake_settled() {
  while (handshake_ == Handshake::Pending) {
    boost::system::error_code ignored;
    co_await handshake_wake_.async_wait(redirect_error(use_awaitable, ignored));
  }
  co_return handshake_ == Handshake::Ready;
}

void Session::settle_handshake(Handshake outcome) {
  handshake_ = outcome;
  handshake_wake_.cancel();
}

awaitable<void> Session::open_session() {
  const auto self = shared_from_this();

  if (const auto credentials = host_->resume_credentials()) {
    auto answer =
        co_await call(std::string(methods::kResume),
                      host_->resume_params(credentials->first, credentials->second));
    if (answer.ok()) {
      accept_welcome(std::move(answer).value());
      co_return;
    }
    const auto refusal = std::move(answer).error();
    if (refusal.named_code() == TesseronErrorCode::ProtocolMismatch) {
      reject_handshake(refusal);
      co_return;
    }
    // The credentials are stale, not the connection, so a fresh hello follows
    // on the same socket. The whole session goes with them: the gateway has
    // forgotten it, and a stale welcome would negotiate capabilities nobody
    // agreed to.
    host_->forget_session();
    std::cerr << "tesseron: resume refused, opening a fresh session: " << refusal.message() << '\n';
  }

  auto answer = co_await call(std::string(methods::kHello), host_->hello_params());
  if (answer.ok()) {
    accept_welcome(std::move(answer).value());
    co_return;
  }
  reject_handshake(std::move(answer).error());
}

void Session::accept_welcome(const Json& result) {
  const auto welcome = WelcomeResult::from_json(result);
  if (!welcome.has_value()) {
    reject_handshake(ProtocolError(TesseronErrorCode::InvalidParams,
                                   "the gateway sent an unreadable welcome: " + result.dump()));
    return;
  }
  // The gateway is the side that normally rejects a major mismatch, but a
  // welcome from a different major is just as unusable here, and continuing
  // with it would surface as mysterious method errors later.
  if (!shares_major_version(welcome->protocol_version, kProtocolVersion)) {
    reject_handshake(ProtocolError(TesseronErrorCode::ProtocolMismatch,
                                   "the gateway speaks protocol " + welcome->protocol_version +
                                       "; this host speaks " + std::string(kProtocolVersion)));
    return;
  }

  host_->record_welcome(*welcome);
  settle_handshake(Handshake::Ready);

  HostEvent event;
  event.kind = HostEvent::Kind::Welcome;
  event.welcome = *welcome;
  host_->emit(event);
}

void Session::reject_handshake(const ProtocolError& refusal) {
  // Settling first is what stops an invocation the gateway queued behind the
  // handshake from reaching a handler on a session that was never opened.
  settle_handshake(Handshake::Failed);
  if (refusal.named_code() != TesseronErrorCode::TransportClosed) {
    HostEvent event;
    event.kind = HostEvent::Kind::HandshakeFailed;
    event.handshake_failure = refusal;
    host_->emit(event);
  }
  // A refusal is about this application, not this socket, so retrying the same
  // hello would loop. The host reports it and waits for the next dial.
  stop_sending();
}

}  // namespace tesseron::detail
