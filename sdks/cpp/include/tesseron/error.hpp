#pragma once

#include <exception>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <variant>

#include <tesseron/json.hpp>

namespace tesseron {

/// Every error code the Tesseron wire protocol defines, named.
///
/// The set is closed. A gateway that sends an integer outside it is speaking a
/// protocol this library does not implement, so `ProtocolError` keeps the raw
/// integer and `ProtocolError::named_code` answers `std::nullopt` rather than
/// inventing an enumerator.
enum class TesseronErrorCode {
  ParseError,
  InvalidRequest,
  MethodNotFound,
  InvalidParams,
  InternalError,
  ProtocolMismatch,
  Cancelled,
  Timeout,
  ActionNotFound,
  InputValidation,
  HandlerError,
  SamplingNotAvailable,
  ElicitationNotAvailable,
  SamplingDepthExceeded,
  Unauthorized,
  TransportClosed,
  ResumeFailed,
};

/// The JSON-RPC integer a code is written as on the wire.
[[nodiscard]] int to_wire_code(TesseronErrorCode code) noexcept;

/// Names a wire integer, or `std::nullopt` when the peer used a code this
/// protocol version does not define.
[[nodiscard]] std::optional<TesseronErrorCode> from_wire_code(int code) noexcept;

/// The enumerator's own spelling, for logs and test failures.
[[nodiscard]] std::string_view name_of(TesseronErrorCode code) noexcept;

/// The `error` member of a JSON-RPC failure response, exactly as it travels.
///
/// The code stays an `int` so an envelope from a newer gateway round-trips
/// without loss.
class ProtocolError {
 public:
  ProtocolError() = default;
  ProtocolError(TesseronErrorCode code, std::string message);
  ProtocolError(int code, std::string message);

  /// Attaches structured detail whose shape is defined per error code.
  ProtocolError& with_data(Json data);

  [[nodiscard]] int code() const noexcept { return code_; }
  [[nodiscard]] const std::string& message() const noexcept { return message_; }
  [[nodiscard]] const std::optional<Json>& data() const noexcept { return data_; }
  [[nodiscard]] std::optional<TesseronErrorCode> named_code() const noexcept;

  [[nodiscard]] Json to_json() const;
  [[nodiscard]] static std::optional<ProtocolError> from_json(const Json& value);

 private:
  int code_ = 0;
  std::string message_;
  std::optional<Json> data_;
};

/// What an action handler answers with when it cannot produce its output.
///
/// The distinction that matters on the wire is deliberate: `handler` and
/// `protocol` send their message and data to the agent, while `internal` keeps
/// the cause on this side of the socket and answers a bare `-32603`.
class ActionError {
 public:
  /// A domain failure the agent is meant to read: unknown id, empty cart,
  /// rejected transition. Answers `-32005 HandlerError`.
  [[nodiscard]] static ActionError handler(std::string message);

  /// A failure that must carry one specific protocol code, keeping both the
  /// code and the structured `data` the agent needs to branch on.
  [[nodiscard]] static ActionError protocol(TesseronErrorCode code, std::string message,
                                            std::optional<Json> data = std::nullopt);

  /// An unexpected failure. The cause is kept locally and reported through
  /// `internal_source`; the agent only ever sees `-32603` with a fixed message,
  /// because an exception's text in a handler error is a leak.
  [[nodiscard]] static ActionError internal(std::exception_ptr source);
  [[nodiscard]] static ActionError internal(const std::exception& source);

  /// Attaches structured detail the agent can branch on.
  ActionError& with_data(Json data);

  [[nodiscard]] TesseronErrorCode code() const noexcept { return code_; }
  [[nodiscard]] const std::string& message() const noexcept { return message_; }
  [[nodiscard]] const std::optional<Json>& data() const noexcept { return data_; }

  /// The cause `internal` held back from the wire.
  [[nodiscard]] std::exception_ptr internal_source() const noexcept { return internal_source_; }

  /// The payload to put in the JSON-RPC failure response. Reporting the
  /// held-back cause is the caller's job.
  [[nodiscard]] ProtocolError to_protocol_error() const;

  /// Turns whatever the gateway answered into a handler-visible failure.
  [[nodiscard]] static ActionError from_protocol_error(const ProtocolError& error);

 private:
  ActionError() = default;

  TesseronErrorCode code_ = TesseronErrorCode::InternalError;
  std::string message_;
  std::optional<Json> data_;
  std::exception_ptr internal_source_;
};

/// Why a host could not start, publish itself, or shut down.
class HostError {
 public:
  enum class Kind {
    MissingApplication,
    InvalidApplicationId,
    DuplicateName,
    NonLoopbackBindAddress,
    Listen,
    Manifest,
    HomeDirectoryUnknown,
  };

  HostError(Kind kind, std::string message);

  [[nodiscard]] Kind kind() const noexcept { return kind_; }
  [[nodiscard]] const std::string& message() const noexcept { return message_; }

 private:
  Kind kind_;
  std::string message_;
};

/// A value or the reason there is none.
///
/// Handlers answer `Result<Json>`; startup answers `Result<Host, HostError>`.
/// Nothing in this library throws across a handler boundary, so the error type
/// is part of the signature rather than something a caller has to guess at.
template <typename Value, typename Error = ActionError>
class Result {
 public:
  static constexpr bool holds_value = !std::is_void_v<Value>;
  using ValueType = std::conditional_t<holds_value, Value, std::monostate>;

  Result(ValueType value)  // NOLINT(google-explicit-constructor)
      : state_(std::in_place_index<0>, std::move(value)) {}
  Result(Error error)  // NOLINT(google-explicit-constructor)
      : state_(std::in_place_index<1>, std::move(error)) {}

  [[nodiscard]] static Result success()
    requires(!holds_value)
  {
    return Result(std::monostate{});
  }

  [[nodiscard]] bool ok() const noexcept { return state_.index() == 0; }
  explicit operator bool() const noexcept { return ok(); }

  [[nodiscard]] ValueType& value() & { return std::get<0>(state_); }
  [[nodiscard]] const ValueType& value() const& { return std::get<0>(state_); }
  [[nodiscard]] ValueType&& value() && { return std::get<0>(std::move(state_)); }

  [[nodiscard]] const Error& error() const& { return std::get<1>(state_); }
  [[nodiscard]] Error&& error() && { return std::get<1>(std::move(state_)); }

 private:
  std::variant<ValueType, Error> state_;
};

}  // namespace tesseron
