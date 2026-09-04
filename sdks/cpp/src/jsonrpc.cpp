#include "jsonrpc.hpp"

#include <utility>

#include <tesseron/protocol.hpp>

namespace tesseron::detail {
namespace {

Json envelope_with_id(const RequestId& id) {
  Json envelope = Json::object();
  envelope["jsonrpc"] = std::string(kJsonRpcVersion);
  envelope["id"] = id.to_json();
  return envelope;
}

IncomingFrame malformed(std::string problem) {
  IncomingFrame frame;
  frame.kind = IncomingFrame::Kind::Malformed;
  frame.problem = std::move(problem);
  return frame;
}

bool declares_json_rpc_version(const Json& frame) {
  const auto version = frame.find("jsonrpc");
  return version != frame.end() && version->is_string() &&
         std::string_view(version->get_ref<const std::string&>()) == kJsonRpcVersion;
}

}  // namespace

std::optional<RequestId> RequestId::from_json(const Json& value) {
  if (value.is_string() || value.is_number() || value.is_null()) return RequestId(value);
  return std::nullopt;
}

RequestId RequestId::from_number(std::int64_t number) { return RequestId(Json(number)); }

IncomingFrame classify(const Json& frame) {
  if (!frame.is_object()) return malformed("envelope is not a JSON object");
  if (!declares_json_rpc_version(frame)) {
    return malformed("envelope does not declare jsonrpc " + std::string(kJsonRpcVersion));
  }

  const auto id_member = frame.find("id");
  // JSON-RPC sorts by presence: a notification omits `id` entirely, while
  // `"id": null` is a response to a request whose id could not be read.
  std::optional<RequestId> id;
  if (id_member != frame.end()) id = RequestId::from_json(*id_member);

  const auto method = frame.find("method");
  if (method != frame.end() && method->is_string()) {
    IncomingFrame decoded;
    decoded.kind = id.has_value() ? IncomingFrame::Kind::Request : IncomingFrame::Kind::Notification;
    decoded.id = std::move(id);
    decoded.method = method->get<std::string>();
    const auto params = frame.find("params");
    decoded.params = params == frame.end() ? Json() : *params;
    return decoded;
  }

  if (!id.has_value()) return malformed("envelope has neither a method nor an id");

  const auto error = frame.find("error");
  if (error != frame.end()) {
    auto decoded_error = ProtocolError::from_json(*error);
    if (!decoded_error.has_value()) return malformed("unreadable error member");
    IncomingFrame decoded;
    decoded.kind = IncomingFrame::Kind::Failure;
    decoded.id = std::move(id);
    decoded.error = std::move(decoded_error);
    return decoded;
  }

  const auto result = frame.find("result");
  if (result != frame.end()) {
    IncomingFrame decoded;
    decoded.kind = IncomingFrame::Kind::Success;
    decoded.id = std::move(id);
    decoded.result = *result;
    return decoded;
  }

  return malformed("response has neither a result nor an error");
}

Json request(const RequestId& id, std::string_view method, Json params) {
  Json envelope = envelope_with_id(id);
  envelope["method"] = std::string(method);
  envelope["params"] = std::move(params);
  return envelope;
}

Json notification(std::string_view method, Json params) {
  Json envelope = Json::object();
  envelope["jsonrpc"] = std::string(kJsonRpcVersion);
  envelope["method"] = std::string(method);
  envelope["params"] = std::move(params);
  return envelope;
}

Json success(const RequestId& id, Json result) {
  Json envelope = envelope_with_id(id);
  envelope["result"] = std::move(result);
  return envelope;
}

Json failure(const RequestId& id, const ProtocolError& error) {
  Json envelope = envelope_with_id(id);
  envelope["error"] = error.to_json();
  return envelope;
}

}  // namespace tesseron::detail
