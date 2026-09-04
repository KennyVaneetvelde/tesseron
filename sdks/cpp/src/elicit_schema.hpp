#pragma once

#include <optional>

#include <tesseron/error.hpp>
#include <tesseron/json.hpp>

namespace tesseron::detail {

/// The schema `ActionContext::confirm` sends: an object with no properties,
/// which MCP clients render as a bare accept-or-decline prompt.
[[nodiscard]] Json confirmation_schema();

/// The fallback for an elicit request that declares no schema of its own. One
/// text field, which is the least a client can render.
[[nodiscard]] Json permissive_schema();

/// Checks a schema against the protocol 1.2.0 elicitation rules.
///
/// MCP renders an elicit prompt as a flat form, so the protocol constrains the
/// schema to a single object of primitive leaves. The host checks on the send
/// path, before the frame leaves, so the failure lands at the `elicit` call site
/// instead of surfacing as a gateway rejection three hops later.
///
/// Answers `-32602 InvalidParams` naming the first rule the schema breaks, or
/// nothing when it passes.
[[nodiscard]] std::optional<ActionError> validate_elicitation_schema(const Json& schema);

}  // namespace tesseron::detail
