#include <tesseron/error.hpp>

#include <stdexcept>
#include <utility>

namespace tesseron {

int to_wire_code(TesseronErrorCode code) noexcept {
  switch (code) {
    case TesseronErrorCode::ParseError:
      return -32700;
    case TesseronErrorCode::InvalidRequest:
      return -32600;
    case TesseronErrorCode::MethodNotFound:
      return -32601;
    case TesseronErrorCode::InvalidParams:
      return -32602;
    case TesseronErrorCode::InternalError:
      return -32603;
    case TesseronErrorCode::ProtocolMismatch:
      return -32000;
    case TesseronErrorCode::Cancelled:
      return -32001;
    case TesseronErrorCode::Timeout:
      return -32002;
    case TesseronErrorCode::ActionNotFound:
      return -32003;
    case TesseronErrorCode::InputValidation:
      return -32004;
    case TesseronErrorCode::HandlerError:
      return -32005;
    case TesseronErrorCode::SamplingNotAvailable:
      return -32006;
    case TesseronErrorCode::ElicitationNotAvailable:
      return -32007;
    case TesseronErrorCode::SamplingDepthExceeded:
      return -32008;
    case TesseronErrorCode::Unauthorized:
      return -32009;
    case TesseronErrorCode::TransportClosed:
      return -32010;
    case TesseronErrorCode::ResumeFailed:
      return -32011;
  }
  return -32603;
}

std::optional<TesseronErrorCode> from_wire_code(int code) noexcept {
  switch (code) {
    case -32700:
      return TesseronErrorCode::ParseError;
    case -32600:
      return TesseronErrorCode::InvalidRequest;
    case -32601:
      return TesseronErrorCode::MethodNotFound;
    case -32602:
      return TesseronErrorCode::InvalidParams;
    case -32603:
      return TesseronErrorCode::InternalError;
    case -32000:
      return TesseronErrorCode::ProtocolMismatch;
    case -32001:
      return TesseronErrorCode::Cancelled;
    case -32002:
      return TesseronErrorCode::Timeout;
    case -32003:
      return TesseronErrorCode::ActionNotFound;
    case -32004:
      return TesseronErrorCode::InputValidation;
    case -32005:
      return TesseronErrorCode::HandlerError;
    case -32006:
      return TesseronErrorCode::SamplingNotAvailable;
    case -32007:
      return TesseronErrorCode::ElicitationNotAvailable;
    case -32008:
      return TesseronErrorCode::SamplingDepthExceeded;
    case -32009:
      return TesseronErrorCode::Unauthorized;
    case -32010:
      return TesseronErrorCode::TransportClosed;
    case -32011:
      return TesseronErrorCode::ResumeFailed;
    default:
      return std::nullopt;
  }
}

std::string_view name_of(TesseronErrorCode code) noexcept {
  switch (code) {
    case TesseronErrorCode::ParseError:
      return "ParseError";
    case TesseronErrorCode::InvalidRequest:
      return "InvalidRequest";
    case TesseronErrorCode::MethodNotFound:
      return "MethodNotFound";
    case TesseronErrorCode::InvalidParams:
      return "InvalidParams";
    case TesseronErrorCode::InternalError:
      return "InternalError";
    case TesseronErrorCode::ProtocolMismatch:
      return "ProtocolMismatch";
    case TesseronErrorCode::Cancelled:
      return "Cancelled";
    case TesseronErrorCode::Timeout:
      return "Timeout";
    case TesseronErrorCode::ActionNotFound:
      return "ActionNotFound";
    case TesseronErrorCode::InputValidation:
      return "InputValidation";
    case TesseronErrorCode::HandlerError:
      return "HandlerError";
    case TesseronErrorCode::SamplingNotAvailable:
      return "SamplingNotAvailable";
    case TesseronErrorCode::ElicitationNotAvailable:
      return "ElicitationNotAvailable";
    case TesseronErrorCode::SamplingDepthExceeded:
      return "SamplingDepthExceeded";
    case TesseronErrorCode::Unauthorized:
      return "Unauthorized";
    case TesseronErrorCode::TransportClosed:
      return "TransportClosed";
    case TesseronErrorCode::ResumeFailed:
      return "ResumeFailed";
  }
  return "InternalError";
}

ProtocolError::ProtocolError(TesseronErrorCode code, std::string message)
    : code_(to_wire_code(code)), message_(std::move(message)) {}

ProtocolError::ProtocolError(int code, std::string message)
    : code_(code), message_(std::move(message)) {}

ProtocolError& ProtocolError::with_data(Json data) {
  data_ = std::move(data);
  return *this;
}

std::optional<TesseronErrorCode> ProtocolError::named_code() const noexcept {
  return from_wire_code(code_);
}

Json ProtocolError::to_json() const {
  Json payload = Json::object();
  payload["code"] = code_;
  payload["message"] = message_;
  if (data_.has_value()) payload["data"] = *data_;
  return payload;
}

std::optional<ProtocolError> ProtocolError::from_json(const Json& value) {
  if (!value.is_object()) return std::nullopt;
  const auto code = value.find("code");
  if (code == value.end() || !code->is_number_integer()) return std::nullopt;
  const auto message = value.find("message");
  ProtocolError error(code->get<int>(), message != value.end() && message->is_string()
                                            ? message->get<std::string>()
                                            : std::string());
  const auto data = value.find("data");
  if (data != value.end()) error.with_data(*data);
  return error;
}

ActionError ActionError::handler(std::string message) {
  ActionError error;
  error.code_ = TesseronErrorCode::HandlerError;
  error.message_ = std::move(message);
  return error;
}

ActionError ActionError::protocol(TesseronErrorCode code, std::string message,
                                  std::optional<Json> data) {
  ActionError error;
  error.code_ = code;
  error.message_ = std::move(message);
  error.data_ = std::move(data);
  return error;
}

ActionError ActionError::internal(std::exception_ptr source) {
  ActionError error;
  error.code_ = TesseronErrorCode::InternalError;
  error.message_ = "Internal error";
  error.internal_source_ = std::move(source);
  return error;
}

ActionError ActionError::internal(const std::exception& source) {
  return internal(std::make_exception_ptr(std::runtime_error(source.what())));
}

ActionError& ActionError::with_data(Json data) {
  data_ = std::move(data);
  return *this;
}

ProtocolError ActionError::to_protocol_error() const {
  ProtocolError error(code_, message_);
  if (data_.has_value()) error.with_data(*data_);
  return error;
}

ActionError ActionError::from_protocol_error(const ProtocolError& error) {
  return protocol(error.named_code().value_or(TesseronErrorCode::InternalError), error.message(),
                  error.data());
}

HostError::HostError(Kind kind, std::string message) : kind_(kind), message_(std::move(message)) {}

}  // namespace tesseron
