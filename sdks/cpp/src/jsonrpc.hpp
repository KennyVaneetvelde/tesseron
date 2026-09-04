#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

#include <tesseron/error.hpp>
#include <tesseron/json.hpp>

namespace tesseron::detail {

/// The `id` member correlating a JSON-RPC request with its response.
///
/// JSON-RPC allows a string or a number and Tesseron peers use both, so the id
/// is echoed back in exactly the shape it arrived rather than normalised. That
/// includes a fractional number, an integer wider than `std::int64_t`, and the
/// literal `null`: re-encoding any of them would answer a request the gateway
/// can no longer correlate.
class RequestId {
 public:
  /// Reads an id member. Answers nothing when the value is an array or an
  /// object, which JSON-RPC 2.0 does not allow as an id.
  [[nodiscard]] static std::optional<RequestId> from_json(const Json& value);
  [[nodiscard]] static RequestId from_number(std::int64_t number);

  [[nodiscard]] const Json& to_json() const noexcept { return value_; }

  /// A stable key for the pending-request table. Distinguishes `1` from `"1"`,
  /// which a peer is allowed to use for two different requests.
  [[nodiscard]] std::string key() const { return value_.dump(); }

  friend bool operator==(const RequestId& left, const RequestId& right) {
    return left.value_ == right.value_;
  }

 private:
  explicit RequestId(Json value) : value_(std::move(value)) {}

  Json value_;
};

/// One decoded frame from the gateway, sorted into the four JSON-RPC shapes.
struct IncomingFrame {
  enum class Kind {
    Request,
    Notification,
    Success,
    Failure,
    /// Valid JSON that is not a JSON-RPC 2.0 message this peer can act on.
    Malformed,
  };

  Kind kind = Kind::Malformed;
  std::optional<RequestId> id;
  std::string method;
  Json params;
  Json result;
  std::optional<ProtocolError> error;
  /// Why the frame was rejected, when `kind` is `Malformed`.
  std::string problem;
};

/// Sorts a decoded JSON value into its JSON-RPC shape.
///
/// Presence, not nullness, decides: a success response carrying
/// `"result": null` is a success, not a response with neither member. The
/// `jsonrpc` member is required, because a frame without it is not a JSON-RPC
/// 2.0 message and guessing what a peer meant is how version drift hides.
[[nodiscard]] IncomingFrame classify(const Json& frame);

[[nodiscard]] Json request(const RequestId& id, std::string_view method, Json params);
[[nodiscard]] Json notification(std::string_view method, Json params);
[[nodiscard]] Json success(const RequestId& id, Json result);
[[nodiscard]] Json failure(const RequestId& id, const ProtocolError& error);

}  // namespace tesseron::detail
