#include "gateway_double.hpp"

#include <stdexcept>
#include <utility>

#include <boost/asio/buffer.hpp>
#include <boost/asio/co_spawn.hpp>
#include <boost/asio/connect.hpp>
#include <boost/asio/detached.hpp>
#include <boost/asio/ip/tcp.hpp>
#include <boost/asio/post.hpp>
#include <boost/asio/redirect_error.hpp>
#include <boost/asio/use_awaitable.hpp>
#include <boost/beast/http.hpp>

#include <tesseron/protocol.hpp>

namespace tesseron::testing {
namespace {

using boost::asio::awaitable;
using boost::asio::use_awaitable;

struct Endpoint {
  std::string host;
  std::string port;
};

Endpoint split_websocket_url(const std::string& url) {
  constexpr std::string_view kScheme = "ws://";
  if (url.rfind(kScheme, 0) != 0) throw std::invalid_argument("not a ws:// url: " + url);
  const auto authority_start = kScheme.size();
  const auto authority_end = url.find('/', authority_start);
  const auto authority = url.substr(authority_start, authority_end - authority_start);
  const auto separator = authority.rfind(':');
  if (separator == std::string::npos) throw std::invalid_argument("no port in url: " + url);
  return {authority.substr(0, separator), authority.substr(separator + 1)};
}

boost::asio::ip::tcp::endpoint dial(boost::asio::io_context& io, const Endpoint& target) {
  boost::asio::ip::tcp::resolver resolver(io);
  const auto found = resolver.resolve(target.host, target.port);
  return *found.begin();
}

}  // namespace

GatewayDouble::GatewayDouble(const std::string& url)
    : socket_(io_), writer_wake_(io_, boost::asio::steady_timer::time_point::max()) {
  const auto target = split_websocket_url(url);
  boost::beast::get_lowest_layer(socket_).connect(dial(io_, target));
  socket_.set_option(boost::beast::websocket::stream_base::decorator(
      [](boost::beast::websocket::request_type& request) {
        request.set(boost::beast::http::field::sec_websocket_protocol,
                    std::string(kGatewaySubprotocol));
      }));
  socket_.handshake(target.host + ":" + target.port, "/");

  worker_ = std::thread([this] {
    boost::asio::co_spawn(io_, read_until_closed(), boost::asio::detached);
    boost::asio::co_spawn(io_, write_loop(), boost::asio::detached);
    io_.run();
  });
}

GatewayDouble::~GatewayDouble() {
  boost::asio::post(io_, [this] {
    boost::beast::get_lowest_layer(socket_).close();
    writer_wake_.cancel();
  });
  if (worker_.joinable()) worker_.join();
}

awaitable<void> GatewayDouble::read_until_closed() {
  boost::beast::flat_buffer buffer;
  while (true) {
    boost::system::error_code failure;
    co_await socket_.async_read(buffer, redirect_error(use_awaitable, failure));
    if (failure) break;
    const auto payload = boost::beast::buffers_to_string(buffer.data());
    buffer.consume(buffer.size());
    Json frame = Json::parse(payload, nullptr, false);
    {
      const std::lock_guard<std::mutex> guard(incoming_->guard);
      incoming_->frames.push_back(std::move(frame));
    }
    incoming_->arrival.notify_all();
  }
  {
    const std::lock_guard<std::mutex> guard(incoming_->guard);
    incoming_->ended = true;
  }
  incoming_->arrival.notify_all();
  writer_wake_.cancel();
}

awaitable<void> GatewayDouble::write_loop() {
  while (true) {
    std::optional<std::string> next;
    {
      const std::lock_guard<std::mutex> guard(outgoing_guard_);
      if (!outgoing_.empty()) {
        next = std::move(outgoing_.front());
        outgoing_.pop_front();
      }
    }
    if (next.has_value()) {
      boost::system::error_code failure;
      co_await socket_.async_write(boost::asio::buffer(*next),
                                   redirect_error(use_awaitable, failure));
      if (failure) break;
      continue;
    }
    {
      const std::lock_guard<std::mutex> guard(incoming_->guard);
      if (incoming_->ended) break;
    }
    boost::system::error_code ignored;
    co_await writer_wake_.async_wait(redirect_error(use_awaitable, ignored));
  }
}

void GatewayDouble::send(const Json& frame) {
  {
    const std::lock_guard<std::mutex> guard(outgoing_guard_);
    outgoing_.push_back(frame.dump());
  }
  boost::asio::post(io_, [this] { writer_wake_.cancel(); });
}

std::optional<Json> GatewayDouble::receive(std::chrono::milliseconds patience) {
  std::unique_lock<std::mutex> waiting(incoming_->guard);
  const auto arrived = incoming_->arrival.wait_for(
      waiting, patience, [this] { return !incoming_->frames.empty() || incoming_->ended; });
  if (!arrived || incoming_->frames.empty()) return std::nullopt;
  Json frame = std::move(incoming_->frames.front());
  incoming_->frames.pop_front();
  return frame;
}

std::optional<Json> GatewayDouble::receive_method(const std::string& method,
                                                  std::chrono::milliseconds patience) {
  const auto deadline = std::chrono::steady_clock::now() + patience;
  while (std::chrono::steady_clock::now() < deadline) {
    const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
        deadline - std::chrono::steady_clock::now());
    auto frame = receive(remaining);
    if (!frame.has_value()) return std::nullopt;
    const auto named = frame->find("method");
    if (named != frame->end() && *named == method) return frame;
  }
  return std::nullopt;
}

bool GatewayDouble::closed(std::chrono::milliseconds patience) {
  std::unique_lock<std::mutex> waiting(incoming_->guard);
  return incoming_->arrival.wait_for(waiting, patience, [this] { return incoming_->ended; });
}

void GatewayDouble::accept_handshake(const Json& frame, const std::string& protocol_version) {
  Json welcome = Json::object();
  welcome["sessionId"] = "session-under-test";
  welcome["protocolVersion"] = protocol_version;
  welcome["capabilities"] = Capabilities::implemented().to_json();
  Json agent = Json::object();
  agent["name"] = "conformance-double";
  welcome["agent"] = std::move(agent);
  welcome["claimCode"] = "CLAIM-0001";
  welcome["resumeToken"] = "resume-token-1";

  Json answer = Json::object();
  answer["jsonrpc"] = std::string(kJsonRpcVersion);
  answer["id"] = frame.at("id");
  answer["result"] = std::move(welcome);
  send(answer);
}

unsigned upgrade_status_without_subprotocol(const std::string& url) {
  const auto target = split_websocket_url(url);
  boost::asio::io_context io;
  boost::asio::ip::tcp::socket socket(io);
  socket.connect(dial(io, target));

  boost::beast::http::request<boost::beast::http::empty_body> upgrade(
      boost::beast::http::verb::get, "/", 11);
  upgrade.set(boost::beast::http::field::host, target.host + ":" + target.port);
  upgrade.set(boost::beast::http::field::upgrade, "websocket");
  upgrade.set(boost::beast::http::field::connection, "Upgrade");
  upgrade.set(boost::beast::http::field::sec_websocket_version, "13");
  upgrade.set(boost::beast::http::field::sec_websocket_key, "dGhlIHNhbXBsZSBub25jZQ==");
  boost::beast::http::write(socket, upgrade);

  boost::beast::flat_buffer buffer;
  boost::beast::http::response<boost::beast::http::string_body> answer;
  boost::beast::http::read(socket, buffer, answer);
  return answer.result_int();
}

}  // namespace tesseron::testing
