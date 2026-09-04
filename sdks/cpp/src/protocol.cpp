#include <tesseron/protocol.hpp>

#include <array>
#include <algorithm>
#include <cctype>

#include <boost/asio/ip/address.hpp>

namespace tesseron {
namespace {

constexpr std::array<std::string_view, 3> kReservedApplicationIds{"tesseron", "mcp", "system"};

bool read_boolean(const Json& value, const char* key) {
  const auto found = value.find(key);
  return found != value.end() && found->is_boolean() && found->get<bool>();
}

std::string read_string(const Json& value, const char* key, std::string fallback) {
  const auto found = value.find(key);
  if (found == value.end() || !found->is_string()) return fallback;
  return found->get<std::string>();
}

std::optional<std::string> read_optional_string(const Json& value, const char* key) {
  const auto found = value.find(key);
  if (found == value.end() || !found->is_string()) return std::nullopt;
  return found->get<std::string>();
}

}  // namespace

Json Capabilities::to_json() const {
  return Json{{"streaming", streaming},
              {"subscriptions", subscriptions},
              {"sampling", sampling},
              {"elicitation", elicitation}};
}

Capabilities Capabilities::from_json(const Json& value) {
  if (!value.is_object()) return none();
  return Capabilities{read_boolean(value, "streaming"), read_boolean(value, "subscriptions"),
                      read_boolean(value, "sampling"), read_boolean(value, "elicitation")};
}

Json ApplicationDescriptor::to_json() const {
  Json payload = Json::object();
  payload["id"] = id;
  payload["name"] = name;
  if (description.has_value()) payload["description"] = *description;
  payload["origin"] = origin;
  if (version.has_value()) payload["version"] = *version;
  if (icon_url.has_value()) payload["iconUrl"] = *icon_url;
  return payload;
}

Json ActionDescriptor::to_json() const {
  Json payload = Json::object();
  payload["name"] = name;
  payload["description"] = description;
  payload["inputSchema"] = input_schema;
  if (output_schema.has_value()) payload["outputSchema"] = *output_schema;
  if (timeout_milliseconds.has_value()) payload["timeoutMs"] = *timeout_milliseconds;
  return payload;
}

Json ResourceDescriptor::to_json() const {
  return Json{{"name", name}, {"description", description}, {"subscribable", subscribable}};
}

Json AgentIdentity::to_json() const { return Json{{"id", id}, {"name", name}}; }

AgentIdentity AgentIdentity::from_json(const Json& value) {
  if (!value.is_object()) return AgentIdentity{};
  return AgentIdentity{read_string(value, "id", "pending"),
                       read_string(value, "name", "Awaiting agent")};
}

std::optional<WelcomeResult> WelcomeResult::from_json(const Json& value) {
  if (!value.is_object()) return std::nullopt;
  const auto session_id = read_optional_string(value, "sessionId");
  const auto protocol_version = read_optional_string(value, "protocolVersion");
  if (!session_id.has_value() || !protocol_version.has_value()) return std::nullopt;

  WelcomeResult welcome;
  welcome.session_id = *session_id;
  welcome.protocol_version = *protocol_version;
  const auto capabilities = value.find("capabilities");
  welcome.capabilities =
      capabilities == value.end() ? Capabilities::none() : Capabilities::from_json(*capabilities);
  const auto agent = value.find("agent");
  welcome.agent = agent == value.end() ? AgentIdentity{} : AgentIdentity::from_json(*agent);
  welcome.claim_code = read_optional_string(value, "claimCode");
  welcome.resume_token = read_optional_string(value, "resumeToken");
  return welcome;
}

std::optional<ClaimedParams> ClaimedParams::from_json(const Json& value) {
  if (!value.is_object()) return std::nullopt;
  ClaimedParams claimed;
  const auto agent = value.find("agent");
  if (agent == value.end()) return std::nullopt;
  claimed.agent = AgentIdentity::from_json(*agent);
  const auto claimed_at = value.find("claimedAt");
  if (claimed_at != value.end() && claimed_at->is_number()) {
    claimed.claimed_at = claimed_at->get<std::int64_t>();
  }
  const auto capabilities = value.find("agentCapabilities");
  if (capabilities != value.end()) claimed.agent_capabilities = *capabilities;
  return claimed;
}

std::string_view name_of(LogLevel level) noexcept {
  switch (level) {
    case LogLevel::Debug:
      return "debug";
    case LogLevel::Info:
      return "info";
    case LogLevel::Warn:
      return "warn";
    case LogLevel::Error:
      return "error";
  }
  return "info";
}

bool is_valid_application_id(std::string_view id) noexcept {
  if (std::find(kReservedApplicationIds.begin(), kReservedApplicationIds.end(), id) !=
      kReservedApplicationIds.end()) {
    return false;
  }
  if (id.empty()) return false;
  if (id.front() < 'a' || id.front() > 'z') return false;
  return std::all_of(id.begin() + 1, id.end(), [](char character) {
    return (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') ||
           character == '_';
  });
}

bool shares_major_version(std::string_view left, std::string_view right) noexcept {
  const auto major_of = [](std::string_view version) {
    const auto separator = version.find('.');
    return separator == std::string_view::npos ? version : version.substr(0, separator);
  };
  const auto left_major = major_of(left);
  return !left_major.empty() && left_major == major_of(right);
}

bool is_loopback_address(std::string_view address) noexcept {
  boost::system::error_code parse_failure;
  const auto parsed = boost::asio::ip::make_address(std::string(address), parse_failure);
  if (parse_failure) return false;
  return parsed.is_loopback();
}

}  // namespace tesseron
