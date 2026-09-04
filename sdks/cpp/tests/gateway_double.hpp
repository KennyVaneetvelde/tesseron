#pragma once

#include <chrono>
#include <condition_variable>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

#include <boost/asio/awaitable.hpp>
#include <boost/asio/io_context.hpp>
#include <boost/asio/steady_timer.hpp>
#include <boost/beast/core.hpp>
#include <boost/beast/websocket.hpp>

#include <tesseron/json.hpp>

namespace tesseron::testing {

/// How long a test waits for a frame the host is expected to send.
inline constexpr std::chrono::milliseconds kPatience{5000};

/// Plays the gateway against a running host over a real loopback socket.
///
/// The handshake state machine, the framing and the subscription lifetime only
/// exist in terms of what crosses the wire, so the tests that cover them talk
/// to an actual socket rather than to a mocked session.
class GatewayDouble {
 public:
  /// Dials `url` and completes the upgrade carrying the gateway subprotocol.
  explicit GatewayDouble(const std::string& url);
  GatewayDouble(const GatewayDouble&) = delete;
  GatewayDouble& operator=(const GatewayDouble&) = delete;
  ~GatewayDouble();

  void send(const Json& frame);

  /// The next frame, or nothing when none arrives inside `patience`.
  [[nodiscard]] std::optional<Json> receive(std::chrono::milliseconds patience = kPatience);

  /// The next frame whose `method` matches, discarding anything before it.
  [[nodiscard]] std::optional<Json> receive_method(const std::string& method,
                                                   std::chrono::milliseconds patience = kPatience);

  /// Whether the host closed the connection inside `patience`.
  [[nodiscard]] bool closed(std::chrono::milliseconds patience = kPatience);

  /// Answers the request in `frame` with a welcome the host will accept.
  void accept_handshake(const Json& frame, const std::string& protocol_version = "1.2.0");

 private:
  struct Incoming {
    std::mutex guard;
    std::condition_variable arrival;
    std::deque<Json> frames;
    bool ended = false;
  };

  [[nodiscard]] boost::asio::awaitable<void> read_until_closed();
  [[nodiscard]] boost::asio::awaitable<void> write_loop();

  boost::asio::io_context io_;
  boost::beast::websocket::stream<boost::beast::tcp_stream> socket_;
  boost::asio::steady_timer writer_wake_;
  std::mutex outgoing_guard_;
  std::deque<std::string> outgoing_;
  std::shared_ptr<Incoming> incoming_ = std::make_shared<Incoming>();
  std::thread worker_;
};

/// Performs a WebSocket upgrade with no `Sec-WebSocket-Protocol` header and
/// answers the HTTP status the host replied with.
[[nodiscard]] unsigned upgrade_status_without_subprotocol(const std::string& url);

}  // namespace tesseron::testing
