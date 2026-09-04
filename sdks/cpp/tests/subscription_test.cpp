#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <utility>

#include <catch2/catch_test_macros.hpp>

#include <boost/asio/awaitable.hpp>

#include <tesseron/host.hpp>

#include "gateway_double.hpp"

using tesseron::Host;
using tesseron::HostOptions;
using tesseron::Json;
using tesseron::ManifestPublication;
using tesseron::ResourceEmitter;
using tesseron::Result;
using tesseron::Subscription;
using tesseron::testing::GatewayDouble;

namespace {

/// The emitter the host handed the subscriber, plus whether the teardown ran.
struct SubscriberRecord {
  std::mutex guard;
  std::optional<ResourceEmitter> emitter;
  std::atomic<int> subscribes{0};
  std::atomic<int> teardowns{0};

  void remember(ResourceEmitter handed) {
    const std::lock_guard<std::mutex> holding(guard);
    emitter = std::move(handed);
    subscribes.fetch_add(1);
  }

  void emit(Json value) {
    const std::lock_guard<std::mutex> holding(guard);
    REQUIRE(emitter.has_value());
    emitter->emit(std::move(value));
  }
};

struct CounterHost {
  std::shared_ptr<SubscriberRecord> record = std::make_shared<SubscriberRecord>();
  std::optional<Host> host;

  CounterHost() {
    HostOptions options;
    options.manifest = ManifestPublication::disabled();

    auto builder = Host::builder();
    builder.application("probe", "Probe");
    builder.options(std::move(options));

    auto watched = record;
    builder.resource("counter")
        .description("A number that changes")
        .subscribe([watched](ResourceEmitter emitter) {
          watched->remember(std::move(emitter));
          return Subscription::with_teardown([watched] { watched->teardowns.fetch_add(1); });
        })
        .reader([]() -> boost::asio::awaitable<Result<Json>> { co_return Json(7); });
    builder.resource("plain").reader(
        []() -> boost::asio::awaitable<Result<Json>> { co_return Json(1); });

    auto listening = builder.listen();
    REQUIRE(listening.ok());
    host = std::move(listening).value();
  }

  ~CounterHost() {
    if (host.has_value()) host->shutdown();
  }

  [[nodiscard]] const std::string& url() const { return host->url(); }
};

Json resource_request(const std::string& id, const std::string& method, const Json& params) {
  Json frame = Json::object();
  frame["jsonrpc"] = "2.0";
  frame["id"] = id;
  frame["method"] = method;
  frame["params"] = params;
  return frame;
}

Json named(const std::string& name) {
  Json params = Json::object();
  params["name"] = name;
  return params;
}

/// Opens a session and answers the hello, leaving the gateway ready to send
/// resource traffic.
void open_session(GatewayDouble& gateway) {
  const auto hello = gateway.receive();
  REQUIRE(hello.has_value());
  gateway.accept_handshake(*hello);
}

}  // namespace

TEST_CASE("a resource read answers the reader's value", "[resources]") {
  CounterHost probe;
  GatewayDouble gateway(probe.url());
  open_session(gateway);

  gateway.send(resource_request("r-1", "resources/read", named("counter")));

  const auto answer = gateway.receive();
  REQUIRE(answer.has_value());
  REQUIRE(answer->at("id") == "r-1");
  REQUIRE(answer->at("result").at("value") == 7);
}

TEST_CASE("subscribe acknowledges before the subscriber pushes anything", "[resources]") {
  CounterHost probe;
  GatewayDouble gateway(probe.url());
  open_session(gateway);

  Json params = named("counter");
  params["subscriptionId"] = "sub-1";
  gateway.send(resource_request("s-1", "resources/subscribe", params));

  const auto acknowledgement = gateway.receive();
  REQUIRE(acknowledgement.has_value());
  REQUIRE(acknowledgement->at("id") == "s-1");
  REQUIRE(acknowledgement->at("result").is_null());
  REQUIRE(probe.record->subscribes.load() == 1);

  probe.record->emit(Json(8));
  const auto update = gateway.receive_method("resources/updated");
  REQUIRE(update.has_value());
  REQUIRE(update->at("params").at("subscriptionId") == "sub-1");
  REQUIRE(update->at("params").at("value") == 8);
}

TEST_CASE("unsubscribe runs the teardown and stops the updates", "[resources]") {
  CounterHost probe;
  GatewayDouble gateway(probe.url());
  open_session(gateway);

  Json params = named("counter");
  params["subscriptionId"] = "sub-1";
  gateway.send(resource_request("s-1", "resources/subscribe", params));
  REQUIRE(gateway.receive().has_value());

  Json dropping = Json::object();
  dropping["subscriptionId"] = "sub-1";
  gateway.send(resource_request("s-2", "resources/unsubscribe", dropping));

  const auto acknowledgement = gateway.receive();
  REQUIRE(acknowledgement.has_value());
  REQUIRE(acknowledgement->at("id") == "s-2");
  REQUIRE(acknowledgement->at("result").is_null());
  REQUIRE(probe.record->teardowns.load() == 1);

  // A subscriber that kept its emitter is exactly the leak this checks for:
  // nothing it pushes afterwards may reach an agent that already left.
  probe.record->emit(Json(9));
  REQUIRE_FALSE(gateway.receive_method("resources/updated", std::chrono::milliseconds(250))
                    .has_value());
}

TEST_CASE("a closing transport tears every subscription down", "[resources]") {
  CounterHost probe;
  {
    GatewayDouble gateway(probe.url());
    open_session(gateway);

    Json params = named("counter");
    params["subscriptionId"] = "sub-1";
    gateway.send(resource_request("s-1", "resources/subscribe", params));
    REQUIRE(gateway.receive().has_value());
    REQUIRE(probe.record->teardowns.load() == 0);
  }

  // The teardown runs on the host's thread as the session unwinds, so this
  // waits for it rather than reading the counter straight away.
  const auto deadline = std::chrono::steady_clock::now() + tesseron::testing::kPatience;
  while (probe.record->teardowns.load() == 0 && std::chrono::steady_clock::now() < deadline) {
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  REQUIRE(probe.record->teardowns.load() == 1);
}

TEST_CASE("a resource that declares no subscriber cannot be subscribed to", "[resources]") {
  CounterHost probe;
  GatewayDouble gateway(probe.url());
  open_session(gateway);

  SECTION("a resource with no subscriber") {
    Json params = named("plain");
    params["subscriptionId"] = "sub-1";
    gateway.send(resource_request("s-1", "resources/subscribe", params));

    const auto answer = gateway.receive();
    REQUIRE(answer.has_value());
    REQUIRE(answer->at("error").at("code") == -32003);
  }

  SECTION("a resource that was never declared") {
    Json params = named("nothing-here");
    params["subscriptionId"] = "sub-1";
    gateway.send(resource_request("s-1", "resources/subscribe", params));

    const auto answer = gateway.receive();
    REQUIRE(answer.has_value());
    REQUIRE(answer->at("error").at("code") == -32003);
  }

  SECTION("reading an undeclared resource") {
    gateway.send(resource_request("r-1", "resources/read", named("nothing-here")));

    const auto answer = gateway.receive();
    REQUIRE(answer.has_value());
    REQUIRE(answer->at("error").at("code") == -32003);
  }
}
