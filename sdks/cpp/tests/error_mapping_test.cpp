#include <stdexcept>
#include <string>
#include <vector>

#include <catch2/catch_test_macros.hpp>

#include <tesseron/error.hpp>
#include <tesseron/json.hpp>
#include <tesseron/schema.hpp>

#include "elicit_schema.hpp"

using tesseron::ActionError;
using tesseron::Json;
using tesseron::ProtocolError;
using tesseron::TesseronErrorCode;
using tesseron::ValidationIssue;
using tesseron::detail::validate_elicitation_schema;

TEST_CASE("every protocol code round-trips through its wire integer", "[errors]") {
  const std::vector<std::pair<TesseronErrorCode, int>> catalog = {
      {TesseronErrorCode::ParseError, -32700},
      {TesseronErrorCode::InvalidRequest, -32600},
      {TesseronErrorCode::MethodNotFound, -32601},
      {TesseronErrorCode::InvalidParams, -32602},
      {TesseronErrorCode::InternalError, -32603},
      {TesseronErrorCode::ProtocolMismatch, -32000},
      {TesseronErrorCode::Cancelled, -32001},
      {TesseronErrorCode::Timeout, -32002},
      {TesseronErrorCode::ActionNotFound, -32003},
      {TesseronErrorCode::InputValidation, -32004},
      {TesseronErrorCode::HandlerError, -32005},
      {TesseronErrorCode::SamplingNotAvailable, -32006},
      {TesseronErrorCode::ElicitationNotAvailable, -32007},
      {TesseronErrorCode::SamplingDepthExceeded, -32008},
      {TesseronErrorCode::Unauthorized, -32009},
      {TesseronErrorCode::TransportClosed, -32010},
      {TesseronErrorCode::ResumeFailed, -32011},
  };

  for (const auto& [code, wire] : catalog) {
    REQUIRE(tesseron::to_wire_code(code) == wire);
    REQUIRE(tesseron::from_wire_code(wire) == code);
  }
  REQUIRE_FALSE(tesseron::from_wire_code(-31999).has_value());
}

TEST_CASE("a handler failure reaches the agent as -32005", "[errors]") {
  const auto sent = ActionError::handler("cart 91 is already checked out").to_protocol_error();

  REQUIRE(sent.code() == -32005);
  REQUIRE(sent.message() == "cart 91 is already checked out");
}

TEST_CASE("a protocol failure keeps its code and its data", "[errors]") {
  Json detail = Json::object();
  detail["retryAfterMilliseconds"] = 250;
  const auto sent =
      ActionError::protocol(TesseronErrorCode::Unauthorized, "sign in first", detail)
          .to_protocol_error();

  REQUIRE(sent.code() == -32009);
  REQUIRE(sent.message() == "sign in first");
  REQUIRE(sent.data().has_value());
  REQUIRE(*sent.data() == detail);
}

TEST_CASE("an internal failure keeps its cause on this side of the socket", "[errors]") {
  const std::runtime_error cause("connection string was empty");
  const auto failure = ActionError::internal(cause);
  const auto sent = failure.to_protocol_error();

  REQUIRE(sent.code() == -32603);
  REQUIRE(sent.message().find("connection string") == std::string::npos);
  REQUIRE(failure.internal_source() != nullptr);
}

TEST_CASE("a gateway failure becomes a handler-visible failure", "[errors]") {
  ProtocolError refusal(TesseronErrorCode::ElicitationNotAvailable, "no elicitation negotiated");
  Json detail = Json::object();
  detail["capability"] = "elicitation";
  refusal.with_data(detail);

  const auto seen = ActionError::from_protocol_error(refusal);

  REQUIRE(seen.code() == TesseronErrorCode::ElicitationNotAvailable);
  REQUIRE(seen.message() == "no elicitation negotiated");
  REQUIRE(seen.data().has_value());
  REQUIRE(*seen.data() == detail);
  REQUIRE(seen.to_protocol_error().code() == -32007);
}

TEST_CASE("an unknown wire code survives the trip back out", "[errors]") {
  const ProtocolError future(-32099, "a code from a newer gateway");

  REQUIRE_FALSE(future.named_code().has_value());
  REQUIRE(future.to_json().at("code") == -32099);

  const auto decoded = ProtocolError::from_json(future.to_json());
  REQUIRE(decoded.has_value());
  REQUIRE(decoded->code() == -32099);
}

TEST_CASE("validation issues travel as the bare array -32004 pins", "[errors]") {
  const std::vector<ValidationIssue> issues = {
      ValidationIssue{"required property is missing", {"b"}},
      ValidationIssue{"expected type \"number\", got string", {"a"}},
  };

  const auto data = tesseron::validation_issues_to_json(issues);

  REQUIRE(data.is_array());
  REQUIRE(data.size() == 2);
  REQUIRE(data.at(0).at("message") == "required property is missing");
  REQUIRE(data.at(0).at("path") == Json::array({"b"}));
}

TEST_CASE("an elicitation schema the protocol forbids is refused before it is sent", "[errors]") {
  const auto rejected = [](const Json& schema) {
    const auto refusal = validate_elicitation_schema(schema);
    REQUIRE(refusal.has_value());
    REQUIRE(refusal->to_protocol_error().code() == -32602);
  };

  SECTION("a schema that is not an object") { rejected(Json::array()); }

  SECTION("a top-level type other than object") {
    Json schema = Json::object();
    schema["type"] = "string";
    rejected(schema);
  }

  SECTION("a combinator at the top level") {
    Json schema = Json::object();
    schema["type"] = "object";
    schema["anyOf"] = Json::array();
    rejected(schema);
  }

  SECTION("a property that is not a primitive") {
    Json nested = Json::object();
    nested["type"] = "object";
    Json properties = Json::object();
    properties["address"] = nested;
    Json schema = Json::object();
    schema["type"] = "object";
    schema["properties"] = properties;
    rejected(schema);
  }
}

TEST_CASE("a flat object of primitives is an acceptable elicitation schema", "[errors]") {
  Json name = Json::object();
  name["type"] = "string";
  Json properties = Json::object();
  properties["name"] = name;
  Json schema = Json::object();
  schema["type"] = "object";
  schema["properties"] = properties;

  REQUIRE_FALSE(validate_elicitation_schema(schema).has_value());
  REQUIRE_FALSE(validate_elicitation_schema(tesseron::detail::confirmation_schema()).has_value());
  REQUIRE_FALSE(validate_elicitation_schema(tesseron::detail::permissive_schema()).has_value());
}
