#include <memory>
#include <string>
#include <utility>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <boost/asio/io_context.hpp>

#include <tesseron/context.hpp>
#include <tesseron/json.hpp>
#include <tesseron/protocol.hpp>

#include "invocation_state.hpp"

using tesseron::ActionContext;
using tesseron::Json;
using tesseron::ProgressUpdate;
using tesseron::ProtocolError;
using tesseron::Result;
using tesseron::TesseronErrorCode;
using tesseron::detail::GatewayChannel;
using tesseron::detail::InvocationState;

namespace {

/// Keeps every notification a context sends instead of writing it to a socket.
class RecordingChannel final : public GatewayChannel {
 public:
  struct Notification {
    std::string method;
    Json params;
  };

  void notify(std::string method, Json params) override {
    sent.push_back({std::move(method), std::move(params)});
  }

  boost::asio::awaitable<Result<Json, ProtocolError>> call(std::string, Json) override {
    co_return ProtocolError(TesseronErrorCode::TransportClosed, "no gateway in this test");
  }

  void dispatch_to_application(std::function<void()> work) override { work(); }

  boost::asio::any_io_executor executor() const override { return io_.get_executor(); }

  std::vector<Notification> sent;

 private:
  mutable boost::asio::io_context io_;
};

struct Invocation {
  std::shared_ptr<RecordingChannel> channel = std::make_shared<RecordingChannel>();
  std::shared_ptr<InvocationState> state = std::make_shared<InvocationState>();

  Invocation() {
    state->action_name = "longRunning";
    state->invocation_id = "inv-1";
    state->channel = channel;
  }

  [[nodiscard]] ActionContext context() const { return ActionContext(state); }

  [[nodiscard]] std::vector<int> percents() const {
    std::vector<int> reported;
    for (const auto& notification : channel->sent) {
      const auto percent = notification.params.find("percent");
      if (percent != notification.params.end()) reported.push_back(percent->get<int>());
    }
    return reported;
  }
};

}  // namespace

TEST_CASE("a percentage never goes backwards", "[progress]") {
  Invocation invocation;
  const auto context = invocation.context();

  context.progress(ProgressUpdate().percent(50));
  context.progress(ProgressUpdate().percent(10));
  context.progress(ProgressUpdate().percent(51));

  REQUIRE(invocation.percents() == std::vector<int>{50, 50, 51});
}

TEST_CASE("a percentage outside 0..100 is clamped", "[progress]") {
  SECTION("below the floor") {
    Invocation invocation;
    invocation.context().progress(ProgressUpdate().percent(-5));
    REQUIRE(invocation.percents() == std::vector<int>{0});
  }

  SECTION("above the ceiling") {
    Invocation invocation;
    invocation.context().progress(ProgressUpdate().percent(150));
    invocation.context().progress(ProgressUpdate().percent(101));
    REQUIRE(invocation.percents() == std::vector<int>{100, 100});
  }
}

TEST_CASE("every copy of a context shares one ceiling", "[progress]") {
  Invocation invocation;
  const auto first = invocation.context();
  const auto handed_to_a_helper = first;

  first.progress(ProgressUpdate().percent(80));
  handed_to_a_helper.progress(ProgressUpdate().percent(20));

  REQUIRE(invocation.percents() == std::vector<int>{80, 80});
}

TEST_CASE("an update without a percentage sends no percentage", "[progress]") {
  Invocation invocation;
  invocation.context().progress(ProgressUpdate().message("still working"));

  REQUIRE(invocation.channel->sent.size() == 1);
  const auto& params = invocation.channel->sent.front().params;
  REQUIRE(invocation.channel->sent.front().method == "actions/progress");
  REQUIRE(params.at("invocationId") == "inv-1");
  REQUIRE(params.at("message") == "still working");
  REQUIRE(params.find("percent") == params.end());
}

TEST_CASE("progress carries structured data untouched", "[progress]") {
  Invocation invocation;
  Json rows = Json::object();
  rows["rowsWritten"] = 12;
  invocation.context().progress(ProgressUpdate().percent(5).data(rows));

  const auto& params = invocation.channel->sent.front().params;
  REQUIRE(params.at("data") == rows);
}
