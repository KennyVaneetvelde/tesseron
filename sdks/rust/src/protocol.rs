use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The protocol version this crate speaks, as it appears in every handshake.
///
/// The gateway compares `major.minor`: a different major is a hard reject with
/// [`crate::TesseronErrorCode::ProtocolMismatch`], a different minor is accepted
/// with a warning.
pub const PROTOCOL_VERSION: &str = "1.2.0";

/// The JSON-RPC version every envelope carries.
pub const JSONRPC_VERSION: &str = "2.0";

/// The WebSocket subprotocol the gateway sends on its upgrade request.
///
/// An upgrade without it is not a gateway dial, and the host refuses it: the
/// endpoint exists for the gateway, not for arbitrary local clients.
pub const GATEWAY_SUBPROTOCOL: &str = "tesseron-gateway";

/// The JSON-RPC method names this crate sends or answers.
pub mod methods {
    /// Opens a session and publishes the application manifest.
    pub const HELLO: &str = "tesseron/hello";
    /// Rejoins a previously claimed session after a transport drop.
    pub const RESUME: &str = "tesseron/resume";
    /// Notifies the application that its claim code has been redeemed.
    pub const CLAIMED: &str = "tesseron/claimed";
    /// Runs one action and answers with its output.
    pub const INVOKE: &str = "actions/invoke";
    /// Aborts an in-flight invocation. A notification, so it carries no id.
    pub const CANCEL: &str = "actions/cancel";
    /// Reads one resource's current value.
    pub const READ: &str = "resources/read";
}

/// What the application itself can do, sent in the handshake.
///
/// This is the application half of the negotiation. The welcome comes back with
/// the intersection of these flags and the agent's own.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    /// Progress notifications during a running invocation.
    pub streaming: bool,
    /// Resource subscriptions and `resources/updated` pushes.
    pub subscriptions: bool,
    /// Handlers may ask the agent's model for a completion.
    pub sampling: bool,
    /// Handlers may ask the user a structured question through the agent.
    pub elicitation: bool,
}

impl Capabilities {
    /// The set this crate can honestly declare today: everything off.
    ///
    /// Declaring a capability the SDK cannot serve makes the gateway route work
    /// that will never be answered, so each flag flips to `true` only in the
    /// release that implements it.
    #[must_use]
    pub const fn implemented() -> Self {
        Self {
            streaming: false,
            subscriptions: false,
            sampling: false,
            elicitation: false,
        }
    }
}

/// Who the application is, as the gateway and the agent see it.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplicationDescriptor {
    /// Matches `^[a-z][a-z0-9_]*$` and becomes the prefix on every MCP tool
    /// this application contributes.
    pub id: String,
    /// Human-readable name shown to the user next to the claim code.
    pub name: String,
    /// One line about what the application does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Informational: the gateway treats the origin observed on the upgrade as
    /// authoritative and overwrites whatever is declared here.
    pub origin: String,
    /// Application version string, free-form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Icon the agent's user interface may display.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon_url: Option<String>,
}

/// One action as it appears in the handshake manifest.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionDescriptor {
    /// Unique within the application; becomes `<app id>__<name>` as an MCP tool.
    pub name: String,
    /// Shown to the agent when it picks a tool. Always sent, empty if unset.
    pub description: String,
    /// JSON Schema for the invocation input. Always sent, even when it is the
    /// permissive `{}`, because the gateway projects it into the tool schema.
    pub input_schema: Value,
    /// JSON Schema for the output, when the application declared one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
    /// Per-action override of the gateway's 60-second invocation timeout.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
}

/// One resource as it appears in the handshake manifest.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceDescriptor {
    /// Unique within the application.
    pub name: String,
    /// Shown to the agent. Always sent, empty if unset.
    pub description: String,
    /// Whether the agent may subscribe for pushed updates.
    pub subscribable: bool,
}

/// Identity of the agent on the other end of the session.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentIdentity {
    /// Stable identifier, `pending` until a claim happens.
    pub id: String,
    /// Human-readable name.
    pub name: String,
}

/// `tesseron/hello` parameters: the whole application manifest.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelloParams {
    /// The protocol version the application speaks.
    pub protocol_version: String,
    /// Who the application is.
    pub app: ApplicationDescriptor,
    /// Every registered action. Always sent, empty array included.
    pub actions: Vec<ActionDescriptor>,
    /// Every registered resource. Always sent, empty array included.
    pub resources: Vec<ResourceDescriptor>,
    /// What the application can do.
    pub capabilities: Capabilities,
}

/// `tesseron/resume` parameters: the manifest again, plus the credentials.
///
/// The manifest repeats because a restarted or rebuilt application may have
/// added, removed, or changed actions since the session was claimed; the
/// gateway replaces its stored copy with whatever resume brings in.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResumeParams {
    /// The protocol version the application speaks.
    pub protocol_version: String,
    /// The session being rejoined.
    pub session_id: String,
    /// The one-shot bearer token from the most recent welcome.
    pub resume_token: String,
    /// Who the application is.
    pub app: ApplicationDescriptor,
    /// Every registered action.
    pub actions: Vec<ActionDescriptor>,
    /// Every registered resource.
    pub resources: Vec<ResourceDescriptor>,
    /// What the application can do.
    pub capabilities: Capabilities,
}

/// The result of `tesseron/hello` and of `tesseron/resume`.
///
/// There is no `tesseron/welcome` method on the wire; "welcome" is the name of
/// this result shape.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WelcomeResult {
    /// Opaque session identifier, meaningful only to the gateway.
    pub session_id: String,
    /// The protocol version the gateway speaks.
    pub protocol_version: String,
    /// The intersection of the application's and the agent's capabilities.
    #[serde(default = "Capabilities::implemented")]
    pub capabilities: Capabilities,
    /// The claiming agent, or the pending placeholder until a claim happens.
    #[serde(default = "pending_agent")]
    pub agent: AgentIdentity,
    /// The code the user types into the agent to claim this session. Present
    /// only on a fresh hello: a resumed session is already claimed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub claim_code: Option<String>,
    /// The bearer token for the next `tesseron/resume`. Rotated on every
    /// successful resume, so the freshest welcome is the one to keep.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_token: Option<String>,
}

fn pending_agent() -> AgentIdentity {
    AgentIdentity {
        id: "pending".to_owned(),
        name: "Awaiting agent".to_owned(),
    }
}

/// `tesseron/claimed` parameters: the claim code has been redeemed.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimedParams {
    /// The agent that redeemed the code.
    pub agent: AgentIdentity,
    /// Unix-millis timestamp of the claim.
    pub claimed_at: i64,
    /// What the claiming agent can do, when the gateway reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_capabilities: Option<Value>,
}

/// `actions/invoke` parameters.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InvokeParams {
    pub name: String,
    #[serde(default)]
    pub input: Value,
    pub invocation_id: String,
}

/// `actions/invoke` result.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InvokeResult {
    pub invocation_id: String,
    pub output: Value,
}

/// `actions/cancel` parameters.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelParams {
    pub invocation_id: String,
}

/// `resources/read` parameters.
#[derive(Clone, Debug, Deserialize)]
pub(crate) struct ReadResourceParams {
    pub name: String,
}

/// `resources/read` result.
#[derive(Clone, Debug, Serialize)]
pub(crate) struct ReadResourceResult {
    pub value: Value,
}

const RESERVED_APPLICATION_IDS: [&str; 3] = ["tesseron", "mcp", "system"];

/// Whether an application id is usable as an MCP tool prefix.
///
/// The grammar is `^[a-z][a-z0-9_]*$` and three ids are reserved for the
/// gateway's own tools.
pub(crate) fn is_valid_application_id(id: &str) -> bool {
    if RESERVED_APPLICATION_IDS.contains(&id) {
        return false;
    }
    let mut characters = id.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_ascii_lowercase() {
        return false;
    }
    characters.all(|character| {
        character.is_ascii_lowercase() || character.is_ascii_digit() || character == '_'
    })
}

/// Whether two protocol versions agree on their major component.
///
/// A missing or unparsable major is treated as a mismatch rather than as a
/// match, because guessing is how a 2.x gateway silently talks to a 1.x host.
pub(crate) fn shares_major_version(left: &str, right: &str) -> bool {
    match (left.split('.').next(), right.split('.').next()) {
        (Some(left_major), Some(right_major)) => {
            !left_major.is_empty() && left_major == right_major
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn application_ids_follow_the_published_grammar() {
        assert!(is_valid_application_id("todo"));
        assert!(is_valid_application_id("todo_app2"));
        assert!(!is_valid_application_id(""));
        assert!(!is_valid_application_id("Todo"));
        assert!(!is_valid_application_id("2todo"));
        assert!(!is_valid_application_id("todo-app"));
        assert!(!is_valid_application_id("tesseron"));
        assert!(!is_valid_application_id("mcp"));
        assert!(!is_valid_application_id("system"));
    }

    #[test]
    fn major_version_comparison_ignores_minor_drift() {
        assert!(shares_major_version("1.2.0", "1.9.3"));
        assert!(!shares_major_version("1.2.0", "2.0.0"));
        assert!(!shares_major_version("", "1.2.0"));
    }

    #[test]
    fn hello_serialises_with_the_documented_field_names() {
        let hello = HelloParams {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            app: ApplicationDescriptor {
                id: "todo".to_owned(),
                name: "Todo".to_owned(),
                description: None,
                origin: "unknown".to_owned(),
                version: None,
                icon_url: None,
            },
            actions: vec![ActionDescriptor {
                name: "add".to_owned(),
                description: String::new(),
                input_schema: serde_json::json!({}),
                output_schema: None,
                timeout_ms: None,
            }],
            resources: Vec::new(),
            capabilities: Capabilities::implemented(),
        };
        let encoded = serde_json::to_value(&hello).unwrap();
        assert_eq!(encoded["protocolVersion"], "1.2.0");
        assert_eq!(encoded["actions"][0]["inputSchema"], serde_json::json!({}));
        assert_eq!(encoded["actions"][0]["description"], "");
        assert_eq!(encoded["capabilities"]["streaming"], false);
        assert!(encoded["app"].get("description").is_none());
    }
}
