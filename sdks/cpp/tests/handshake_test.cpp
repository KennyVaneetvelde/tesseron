#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <boost/asio/awaitable.hpp>

#include <tesseron/host.hpp>

#include "gateway_double.hpp"

using tesseron::ActionContext;
using tesseron::Host;
using tesseron::HostEvent;
using tesseron::HostOptions;
using tesseron::Json;
using tesseron::ManifestPublication;
using tesseron::Result;
using tesseron::testing::GatewayDouble;

namespace {

/// The events the session reported, readable from the test thread while the
/// host's own thread is still writing to it.
struct EventLog {
  std::mutex guard;
  std::condition_variable arrival;
  std::vector<HostEvent> events;

  void push(const HostEvent& event) {
    {
      const std::lock_guard<std::mutex> holding(guard);
      events.push_back(event);
    }
    arrival.notify_all();
  }

  [[nodiscard]] std::optional<HostEvent> wait_for(
      HostEvent::Kind kind, std::chrono::milliseconds patience = tesseron::testing::kPatience) {
    std::unique_lock<std::mutex> waiting(guard);
    const auto found = [this, kind] {
      return std::find_if(events.begin(), events.end(), [kind](const HostEvent& event) {
        return event.kind == kind;
      });
    };
    if (!arrival.wait_for(waiting, patience, [&found, this] { return found() != events.end(); })) {
      return std::nullopt;
    }
    return *found();
  }
};

/// A host with one action and one resource, no manifest on disk, and a record
/// of every event the session reported.
struct ProbeHost {
  std::shared_ptr<std::atomic<int>> handler_runs = std::make_shared<std::atomic<int>>(0);
  std::shared_ptr<EventLog> events = std::make_shared<EventLog>();
  std::optional<Host> host;

  ProbeHost() {
    HostOptions options;
    options.manifest = ManifestPublication::disabled();

    auto builder = Host::builder();
    builder.application("probe", "Probe");
    builder.options(std::move(options));
    builder.on_event([log = events](const HostEvent& event) { log->push(event); });

    auto runs = handler_runs;
    builder.action("add")
        .description("Add two numbers")
        .input(tesseron::schema::object({
            tesseron::schema::required("a", tesseron::schema::number()),
            tesseron::schema::required("b", tesseron::schema::number()),
        }))
        .handler([runs](Json input, ActionContext) -> boost::asio::awaitable<Result<Json>> {
          runs->fetch_add(1);
          Json sum = Json::object();
          sum["sum"] = input.at("a").get<double>() + input.at("b").get<double>();
          co_return sum;
        });
    builder.resource("counter").description("A number").reader(
        []() -> boost::asio::awaitable<Result<Json>> { co_return Json(1); });

    auto listening = builder.listen();
    REQUIRE(listening.ok());
    host = std::move(listening).value();
  }

  ~ProbeHost() {
    if (host.has_value()) host->shutdown();
  }

  [[nodiscard]] const std::string& url() const { return host->url(); }
};

Json invoke(const std::string& id, const std::string& name, Json input) {
  Json params = Json::object();
  params["name"] = name;
  params["invocationId"] = "inv-" + id;
  params["input"] = std::move(input);

  Json frame = Json::object();
  frame["jsonrpc"] = "2.0";
  frame["id"] = id;
  frame["method"] = "actions/invoke";
  frame["params"] = std::move(params);
  return frame;
}

Json refusal(const Json& request, int code, const std::string& message) {
  Json error = Json::object();
  error["code"] = code;
  error["message"] = message;

  Json frame = Json::object();
  frame["jsonrpc"] = "2.0";
  frame["id"] = request.at("id");
  frame["error"] = std::move(error);
  return frame;
}

Json addition_input() {
  Json input = Json::object();
  input["a"] = 2;
  input["b"] = 3;
  return input;
}

}  // namespace

TEST_CASE("the host opens with a hello carrying its manifest", "[handshake]") {
  ProbeHost probe;
  GatewayDouble gateway(probe.url());

  const auto hello = gateway.receive();
  REQUIRE(hello.has_value());
  REQUIRE(hello->at("method") == "tesseron/hello");

  const auto& params = hello->at("params");
  REQUIRE(params.at("protocolVersion") == "1.2.0");
  REQUIRE(params.at("app").at("id") == "probe");
  REQUIRE(params.at("app").at("name") == "Probe");

  // The runner's capability cross-check reads these four, so a host that
  // implements them has to say so on every dial.
  const auto& capabilities = params.at("capabilities");
  REQUIRE(capabilities.at("streaming") == true);
  REQUIRE(capabilities.at("subscriptions") == true);
  REQUIRE(capabilities.at("sampling") == true);
  REQUIRE(capabilities.at("elicitation") == true);

  REQUIRE(params.at("actions").size() == 1);
  REQUIRE(params.at("actions").at(0).at("name") == "add");
  REQUIRE(params.at("actions").at(0).at("description") == "Add two numbers");
  REQUIRE(params.at("actions").at(0).at("inputSchema").at("required") ==
          Json::array({"a", "b"}));
  REQUIRE(params.at("resources").size() == 1);
  REQUIRE(params.at("resources").at(0).at("name") == "counter");
  REQUIRE(params.at("resources").at(0).at("subscribable") == false);
}

TEST_CASE("an accepted welcome opens the session for invocations", "[handshake]") {
  ProbeHost probe;
  GatewayDouble gateway(probe.url());

  const auto hello = gateway.receive();
  REQUIRE(hello.has_value());
  gateway.accept_handshake(*hello);
  gateway.send(invoke("1", "add", addition_input()));

  const auto answer = gateway.receive();
  REQUIRE(answer.has_value());
  REQUIRE(answer->at("id") == "1");
  REQUIRE(answer->at("result").at("invocationId") == "inv-1");
  REQUIRE(answer->at("result").at("output").at("sum") == 5.0);
  REQUIRE(probe.handler_runs->load() == 1);

  const auto welcome = probe.host->welcome();
  REQUIRE(welcome.has_value());
  REQUIRE(welcome->session_id == "session-under-test");
  REQUIRE(welcome->claim_code == "CLAIM-0001");
}

TEST_CASE("an upgrade without the gateway subprotocol is refused", "[handshake]") {
  ProbeHost probe;

  REQUIRE(tesseron::testing::upgrade_status_without_subprotocol(probe.url()) == 400);
}

TEST_CASE("a refused handshake never reaches a handler", "[handshake]") {
  ProbeHost probe;
  GatewayDouble gateway(probe.url());

  const auto hello = gateway.receive();
  REQUIRE(hello.has_value());
  // Written back to back so the invocation is already in the host's read buffer
  // when the refusal is applied. That is the ordering a gateway pipelining
  // behind its own response produces.
  gateway.send(refusal(*hello, -32000, "this gateway speaks protocol 2.0.0"));
  gateway.send(invoke("1", "add", addition_input()));

  REQUIRE(gateway.closed());
  REQUIRE(probe.handler_runs->load() == 0);
  REQUIRE_FALSE(probe.host->welcome().has_value());

  const auto reported = probe.events->wait_for(HostEvent::Kind::HandshakeFailed);
  REQUIRE(reported.has_value());
  REQUIRE(reported->handshake_failure->code() == -32000);
}

TEST_CASE("a welcome from another protocol major is refused by the host too", "[handshake]") {
  ProbeHost probe;
  GatewayDouble gateway(probe.url());

  const auto hello = gateway.receive();
  REQUIRE(hello.has_value());
  gateway.accept_handshake(*hello, "2.0.0");

  REQUIRE(gateway.closed());
  REQUIRE_FALSE(probe.host->welcome().has_value());

  const auto reported = probe.events->wait_for(HostEvent::Kind::HandshakeFailed);
  REQUIRE(reported.has_value());
  REQUIRE(reported->handshake_failure->code() == -32000);
}

TEST_CASE("a claim that arrives before the welcome is ignored", "[handshake]") {
  ProbeHost probe;
  GatewayDouble gateway(probe.url());

  const auto hello = gateway.receive();
  REQUIRE(hello.has_value());

  Json agent = Json::object();
  agent["name"] = "an agent that never saw the code";
  Json claimed = Json::object();
  claimed["agent"] = std::move(agent);
  claimed["claimedAt"] = 1'700'000'000'000;
  Json frame = Json::object();
  frame["jsonrpc"] = "2.0";
  frame["method"] = "tesseron/claimed";
  frame["params"] = std::move(claimed);
  gateway.send(frame);

  gateway.accept_handshake(*hello);
  gateway.send(invoke("1", "add", addition_input()));
  REQUIRE(gateway.receive().has_value());

  const auto welcome = probe.host->welcome();
  REQUIRE(welcome.has_value());
  REQUIRE(welcome->agent.name == "conformance-double");
}

TEST_CASE("a second dial resumes, then falls back to hello when the token is stale",
          "[handshake]") {
  ProbeHost probe;
  {
    GatewayDouble first(probe.url());
    const auto hello = first.receive();
    REQUIRE(hello.has_value());
    REQUIRE(hello->at("method") == "tesseron/hello");
    first.accept_handshake(*hello);
    first.send(invoke("1", "add", addition_input()));
    REQUIRE(first.receive().has_value());
  }

  GatewayDouble second(probe.url());
  const auto resume = second.receive();
  REQUIRE(resume.has_value());
  REQUIRE(resume->at("method") == "tesseron/resume");
  REQUIRE(resume->at("params").at("sessionId") == "session-under-test");
  REQUIRE(resume->at("params").at("resumeToken") == "resume-token-1");
  // The manifest rides along, because a restarted application may have changed
  // it since the session was claimed.
  REQUIRE(resume->at("params").at("actions").size() == 1);

  second.send(refusal(*resume, -32011, "that session is gone"));

  const auto hello = second.receive();
  REQUIRE(hello.has_value());
  REQUIRE(hello->at("method") == "tesseron/hello");
  second.accept_handshake(*hello);
  second.send(invoke("2", "add", addition_input()));

  const auto answer = second.receive();
  REQUIRE(answer.has_value());
  REQUIRE(answer->at("id") == "2");
}

TEST_CASE("an unknown action is answered without running anything", "[handshake]") {
  ProbeHost probe;
  GatewayDouble gateway(probe.url());

  const auto hello = gateway.receive();
  REQUIRE(hello.has_value());
  gateway.accept_handshake(*hello);
  gateway.send(invoke("1", "subtract", addition_input()));

  const auto answer = gateway.receive();
  REQUIRE(answer.has_value());
  REQUIRE(answer->at("error").at("code") == -32003);
  REQUIRE(probe.handler_runs->load() == 0);
}

TEST_CASE("input the declared schema rejects never reaches the handler", "[handshake]") {
  ProbeHost probe;
  GatewayDouble gateway(probe.url());

  const auto hello = gateway.receive();
  REQUIRE(hello.has_value());
  gateway.accept_handshake(*hello);

  Json wrong = Json::object();
  wrong["a"] = "not a number";
  gateway.send(invoke("1", "add", wrong));

  const auto answer = gateway.receive();
  REQUIRE(answer.has_value());
  REQUIRE(answer->at("error").at("code") == -32004);
  REQUIRE(answer->at("error").at("data").is_array());
  REQUIRE(answer->at("error").at("data").size() == 2);
  REQUIRE(probe.handler_runs->load() == 0);
}
