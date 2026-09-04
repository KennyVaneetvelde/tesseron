#pragma once

#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>

#include <boost/asio/any_io_executor.hpp>
#include <boost/asio/awaitable.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/steady_timer.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>

#include <tesseron/context.hpp>
#include <tesseron/error.hpp>
#include <tesseron/json.hpp>
#include <tesseron/resource.hpp>

#include "host_state.hpp"
#include "invocation_state.hpp"
#include "jsonrpc.hpp"
#include "subscription_state.hpp"

namespace tesseron::detail {

using WebSocketStream = boost::beast::websocket::stream<boost::beast::tcp_stream>;

/// One gateway connection, from the socket opening to the socket closing.
///
/// Every member runs on the host's single I/O thread except the outgoing queue,
/// which anything holding a `ResourceEmitter` may push to. That is why the
/// queue has a lock and nothing else does.
class Session final : public GatewayChannel, public std::enable_shared_from_this<Session> {
 public:
  Session(WebSocketStream socket, std::shared_ptr<HostState> host);

  /// Serves one connection until its socket closes, then reports the
  /// disconnection to the application.
  [[nodiscard]] static boost::asio::awaitable<void> serve(WebSocketStream socket,
                                                          std::shared_ptr<HostState> host);

  void notify(std::string method, Json params) override;
  [[nodiscard]] boost::asio::awaitable<Result<Json, ProtocolError>> call(std::string method,
                                                                         Json params) override;
  void dispatch_to_application(std::function<void()> work) override;
  [[nodiscard]] boost::asio::any_io_executor executor() const override;

  /// Tears the connection down from outside its read loop, which is what
  /// `Host::shutdown` needs to stop the I/O thread.
  void close();

 private:
  enum class Handshake { Pending, Ready, Failed };

  /// A request this host sent and is still waiting on.
  struct PendingCall {
    explicit PendingCall(const boost::asio::any_io_executor& executor);

    boost::asio::steady_timer waker;
    std::optional<Result<Json, ProtocolError>> outcome;
  };

  /// One `actions/invoke` in flight.
  ///
  /// Settlement is first-wins between the handler returning, the agent
  /// cancelling, and the timeout firing, so the three cannot answer one request
  /// twice.
  struct RunningInvocation {
    RunningInvocation(const boost::asio::any_io_executor& executor,
                      std::shared_ptr<InvocationState> state);

    void settle(Result<Json, ProtocolError> answer);

    std::shared_ptr<InvocationState> state;
    boost::asio::steady_timer waker;
    std::optional<Result<Json, ProtocolError>> outcome;
  };

  /// One `resources/subscribe` the agent has not dropped yet.
  struct RegisteredSubscription {
    std::shared_ptr<SubscriptionState> state;
    Subscription subscription;
  };

  [[nodiscard]] boost::asio::awaitable<void> run();
  [[nodiscard]] boost::asio::awaitable<void> read_until_closed();
  [[nodiscard]] boost::asio::awaitable<void> write_loop();
  [[nodiscard]] boost::asio::awaitable<void> open_session();

  void send_envelope(const Json& envelope);
  void stop_sending();
  [[nodiscard]] RequestId mint_request_id();

  void dispatch(IncomingFrame frame);
  void handle_request(const RequestId& id, const std::string& method, const Json& params);
  void handle_notification(const std::string& method, const Json& params);

  void start_invocation(const RequestId& id, const Json& params);
  [[nodiscard]] boost::asio::awaitable<void> run_invocation(
      RequestId id, std::shared_ptr<RunningInvocation> running, ActionHandler handler, Json input,
      std::chrono::milliseconds timeout);
  [[nodiscard]] boost::asio::awaitable<void> drive_handler(
      std::shared_ptr<RunningInvocation> running, ActionHandler handler, Json input);
  void finish_invocation(const std::string& invocation_id);
  void cancel_invocation(const std::string& invocation_id);
  void cancel_all_invocations();

  void start_resource_read(const RequestId& id, const Json& params);
  [[nodiscard]] boost::asio::awaitable<void> answer_resource_read(RequestId id,
                                                                  ResourceReader reader);
  void subscribe_to_resource(const RequestId& id, const Json& params);
  void unsubscribe_from_resource(const RequestId& id, const Json& params);
  void drop_subscription(const std::string& subscription_id);
  void drop_all_subscriptions();

  void resolve(const RequestId& id, Result<Json, ProtocolError> outcome);
  void fail_all_pending();

  [[nodiscard]] boost::asio::awaitable<bool> handshake_settled();
  void settle_handshake(Handshake outcome);
  void accept_welcome(const Json& result);
  void reject_handshake(const ProtocolError& refusal);

  WebSocketStream socket_;
  std::shared_ptr<HostState> host_;
  boost::asio::any_io_executor executor_;

  std::mutex outgoing_guard_;
  std::deque<std::string> outgoing_;
  bool sending_stopped_ = false;
  boost::asio::steady_timer writer_wake_;

  bool transport_open_ = true;
  std::int64_t next_request_id_ = 1;
  std::map<std::string, std::shared_ptr<PendingCall>> pending_;

  Handshake handshake_ = Handshake::Pending;
  boost::asio::steady_timer handshake_wake_;

  std::map<std::string, std::shared_ptr<RunningInvocation>> invocations_;
  std::map<std::string, RegisteredSubscription> subscriptions_;
};

}  // namespace tesseron::detail
