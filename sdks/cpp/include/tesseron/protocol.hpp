#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include <tesseron/json.hpp>

namespace tesseron {

/// The protocol version this library speaks, as it appears in every handshake.
///
/// The gateway compares `major.minor`: a different major is a hard reject with
/// `TesseronErrorCode::ProtocolMismatch`, a different minor is accepted.
inline constexpr std::string_view kProtocolVersion = "1.2.0";

/// The JSON-RPC version every envelope carries.
inline constexpr std::string_view kJsonRpcVersion = "2.0";

/// The WebSocket subprotocol the gateway sends on its upgrade request. An
/// upgrade without it is not a gateway dial, and the host refuses it.
inline constexpr std::string_view kGatewaySubprotocol = "tesseron-gateway";

/// The JSON-RPC method names this library sends or answers.
namespace methods {
inline constexpr std::string_view kHello = "tesseron/hello";
inline constexpr std::string_view kResume = "tesseron/resume";
inline constexpr std::string_view kClaimed = "tesseron/claimed";
inline constexpr std::string_view kInvoke = "actions/invoke";
inline constexpr std::string_view kCancel = "actions/cancel";
inline constexpr std::string_view kProgress = "actions/progress";
inline constexpr std::string_view kRead = "resources/read";
inline constexpr std::string_view kSubscribe = "resources/subscribe";
inline constexpr std::string_view kUnsubscribe = "resources/unsubscribe";
inline constexpr std::string_view kUpdated = "resources/updated";
inline constexpr std::string_view kSample = "sampling/request";
inline constexpr std::string_view kElicit = "elicitation/request";
inline constexpr std::string_view kLog = "log";
}  // namespace methods

/// What the application itself can do, sent in the handshake, and what the
/// welcome negotiated back.
struct Capabilities {
  bool streaming = false;
  bool subscriptions = false;
  bool sampling = false;
  bool elicitation = false;

  /// The set this library can honestly declare: everything protocol 1.2.0
  /// defines for a host.
  [[nodiscard]] static Capabilities implemented() noexcept { return {true, true, true, true}; }

  /// Nothing negotiated. The starting point before a welcome arrives, and the
  /// answer a handler gets when the gateway sent no capability block.
  [[nodiscard]] static Capabilities none() noexcept { return {}; }

  [[nodiscard]] Json to_json() const;
  [[nodiscard]] static Capabilities from_json(const Json& value);

  friend bool operator==(const Capabilities&, const Capabilities&) = default;
};

/// Who the application is, as the gateway and the agent see it.
struct ApplicationDescriptor {
  std::string id;
  std::string name;
  std::optional<std::string> description;
  /// Informational: the gateway treats the origin observed on the upgrade as
  /// authoritative and overwrites whatever is declared here.
  std::string origin = "unknown";
  std::optional<std::string> version;
  std::optional<std::string> icon_url;

  [[nodiscard]] Json to_json() const;
};

/// One action as it appears in the handshake manifest.
struct ActionDescriptor {
  std::string name;
  /// Always sent, empty when unset.
  std::string description;
  /// Always sent, even when it is the permissive `{}`, because the gateway
  /// projects it into the MCP tool schema.
  Json input_schema = Json::object();
  std::optional<Json> output_schema;
  std::optional<std::uint64_t> timeout_milliseconds;

  [[nodiscard]] Json to_json() const;
};

/// One resource as it appears in the handshake manifest.
struct ResourceDescriptor {
  std::string name;
  std::string description;
  bool subscribable = false;

  [[nodiscard]] Json to_json() const;
};

/// Identity of the agent on the other end of the session.
struct AgentIdentity {
  std::string id = "pending";
  std::string name = "Awaiting agent";

  [[nodiscard]] Json to_json() const;
  [[nodiscard]] static AgentIdentity from_json(const Json& value);
};

/// The result of `tesseron/hello` and of `tesseron/resume`.
///
/// There is no `tesseron/welcome` method on the wire; "welcome" is the name of
/// this result shape.
struct WelcomeResult {
  std::string session_id;
  std::string protocol_version;
  /// A gateway that omits the block has negotiated nothing, so the default is
  /// the empty set rather than what this host declared.
  Capabilities capabilities = Capabilities::none();
  AgentIdentity agent;
  /// Present only on a fresh hello: a resumed session is already claimed.
  std::optional<std::string> claim_code;
  /// The bearer token for the next `tesseron/resume`, rotated on every
  /// successful resume.
  std::optional<std::string> resume_token;

  [[nodiscard]] static std::optional<WelcomeResult> from_json(const Json& value);
};

/// `tesseron/claimed` parameters: the claim code has been redeemed.
struct ClaimedParams {
  AgentIdentity agent;
  std::int64_t claimed_at = 0;
  std::optional<Json> agent_capabilities;

  [[nodiscard]] static std::optional<ClaimedParams> from_json(const Json& value);
};

/// Severity of a `log` notification, matching the MCP logging levels the
/// gateway forwards to.
enum class LogLevel { Debug, Info, Warn, Error };

[[nodiscard]] std::string_view name_of(LogLevel level) noexcept;

/// Whether an application id is usable as an MCP tool prefix. The grammar is
/// `^[a-z][a-z0-9_]*$`, and `tesseron`, `mcp`, and `system` are reserved.
[[nodiscard]] bool is_valid_application_id(std::string_view id) noexcept;

/// Whether two protocol versions agree on their major component. A missing or
/// unparsable major counts as a mismatch, because guessing is how a 2.x gateway
/// silently talks to a 1.x host.
[[nodiscard]] bool shares_major_version(std::string_view left, std::string_view right) noexcept;

/// Whether an address literal is loopback: `127.0.0.0/8` or `::1`.
///
/// Tesseron's threat model is same-host, same-user, so anything routable would
/// hand the application's actions to the network.
[[nodiscard]] bool is_loopback_address(std::string_view address) noexcept;

}  // namespace tesseron
