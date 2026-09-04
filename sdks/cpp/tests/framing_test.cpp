#include <catch2/catch_test_macros.hpp>

#include <tesseron/json.hpp>
#include <tesseron/protocol.hpp>

#include "jsonrpc.hpp"

using tesseron::Json;
using tesseron::ProtocolError;
using tesseron::TesseronErrorCode;
using tesseron::detail::classify;
using tesseron::detail::IncomingFrame;
using tesseron::detail::RequestId;

namespace {

Json envelope(const Json& members) {
  Json frame = members;
  frame["jsonrpc"] = "2.0";
  return frame;
}

}  // namespace

TEST_CASE("a request carries its id, method and params", "[framing]") {
  const auto frame =
      classify(envelope({{"id", 7}, {"method", "actions/invoke"}, {"params", {{"name", "add"}}}}));

  REQUIRE(frame.kind == IncomingFrame::Kind::Request);
  REQUIRE(frame.method == "actions/invoke");
  REQUIRE(frame.id.has_value());
  REQUIRE(frame.id->to_json() == Json(7));
  REQUIRE(frame.params.at("name") == "add");
}

TEST_CASE("a frame without an id is a notification", "[framing]") {
  const auto frame =
      classify(envelope({{"method", "actions/cancel"}, {"params", {{"invocationId", "inv-1"}}}}));

  REQUIRE(frame.kind == IncomingFrame::Kind::Notification);
  REQUIRE(frame.method == "actions/cancel");
  REQUIRE_FALSE(frame.id.has_value());
}

TEST_CASE("presence decides a response, not nullness", "[framing]") {
  SECTION("a null result is still a success") {
    const auto frame = classify(envelope({{"id", "s-1"}, {"result", nullptr}}));
    REQUIRE(frame.kind == IncomingFrame::Kind::Success);
    REQUIRE(frame.result.is_null());
  }

  SECTION("an error member is a failure") {
    const auto frame = classify(
        envelope({{"id", "s-1"}, {"error", {{"code", -32003}, {"message", "Action not found"}}}}));
    REQUIRE(frame.kind == IncomingFrame::Kind::Failure);
    REQUIRE(frame.error.has_value());
    REQUIRE(frame.error->code() == -32003);
    REQUIRE(frame.error->named_code() == TesseronErrorCode::ActionNotFound);
  }

  SECTION("neither member is malformed") {
    const auto frame = classify(envelope({{"id", "s-1"}}));
    REQUIRE(frame.kind == IncomingFrame::Kind::Malformed);
  }
}

TEST_CASE("a frame that is not JSON-RPC 2.0 is refused rather than guessed at", "[framing]") {
  SECTION("no jsonrpc member") {
    const auto frame = classify(Json({{"id", 1}, {"method", "actions/invoke"}}));
    REQUIRE(frame.kind == IncomingFrame::Kind::Malformed);
  }

  SECTION("a different jsonrpc version") {
    Json frame = Json::object();
    frame["jsonrpc"] = "1.0";
    frame["id"] = 1;
    frame["method"] = "actions/invoke";
    REQUIRE(classify(frame).kind == IncomingFrame::Kind::Malformed);
  }

  SECTION("a value that is not an object") {
    REQUIRE(classify(Json::array()).kind == IncomingFrame::Kind::Malformed);
  }
}

TEST_CASE("a malformed frame keeps a readable id for the error response", "[framing]") {
  SECTION("missing jsonrpc") {
    const auto frame = classify(Json({{"id", "missing-version"}, {"method", "actions/invoke"}}));
    REQUIRE(frame.kind == IncomingFrame::Kind::Malformed);
    REQUIRE(frame.id.has_value());
    REQUIRE(frame.id->to_json() == "missing-version");
  }

  SECTION("wrong jsonrpc type") {
    const auto frame = classify(
        Json({{"jsonrpc", 2}, {"id", 7}, {"method", "actions/invoke"}}));
    REQUIRE(frame.kind == IncomingFrame::Kind::Malformed);
    REQUIRE(frame.id.has_value());
    REQUIRE(frame.id->to_json() == Json(7));
  }

  SECTION("wrong jsonrpc value") {
    const auto frame = classify(
        Json({{"jsonrpc", "1.0"}, {"id", nullptr}, {"method", "actions/invoke"}}));
    REQUIRE(frame.kind == IncomingFrame::Kind::Malformed);
    REQUIRE(frame.id.has_value());
    REQUIRE(frame.id->to_json().is_null());
  }
}

TEST_CASE("an id is echoed in the shape it arrived", "[framing]") {
  SECTION("a fractional number keeps its fraction") {
    const auto frame = classify(envelope({{"id", 1.5}, {"method", "resources/read"}}));
    REQUIRE(frame.id.has_value());
    REQUIRE(tesseron::detail::success(*frame.id, Json()).at("id") == Json(1.5));
  }

  SECTION("a null id is a usable id") {
    const auto frame = classify(envelope({{"id", nullptr}, {"method", "resources/read"}}));
    REQUIRE(frame.kind == IncomingFrame::Kind::Request);
    REQUIRE(frame.id.has_value());
    REQUIRE(frame.id->to_json().is_null());
  }

  SECTION("a string id and the same digits as a number are different requests") {
    const auto text = RequestId::from_json(Json("1"));
    const auto number = RequestId::from_json(Json(1));
    REQUIRE(text.has_value());
    REQUIRE(number.has_value());
    REQUIRE(text->key() != number->key());
  }

  SECTION("an array or object id is refused") {
    REQUIRE_FALSE(RequestId::from_json(Json::array()).has_value());
    REQUIRE_FALSE(RequestId::from_json(Json::object()).has_value());
  }
}

TEST_CASE("outgoing envelopes carry the protocol version", "[framing]") {
  const auto id = RequestId::from_number(42);

  const auto call = tesseron::detail::request(id, "tesseron/hello", Json::object());
  REQUIRE(call.at("jsonrpc") == "2.0");
  REQUIRE(call.at("id") == Json(42));
  REQUIRE(call.at("method") == "tesseron/hello");

  const auto ping = tesseron::detail::notification("actions/progress", Json::object());
  REQUIRE(ping.at("jsonrpc") == "2.0");
  REQUIRE(ping.find("id") == ping.end());

  const auto refusal = tesseron::detail::failure(
      id, ProtocolError(TesseronErrorCode::ActionNotFound, "Action not found: add"));
  REQUIRE(refusal.at("error").at("code") == -32003);
  REQUIRE(refusal.find("result") == refusal.end());

  const auto acknowledgement = tesseron::detail::success(id, Json());
  REQUIRE(acknowledgement.at("result").is_null());
  REQUIRE(acknowledgement.find("error") == acknowledgement.end());
}
