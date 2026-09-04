use std::error::Error;
use std::fmt;
use std::io;
use std::net::SocketAddr;

use serde::de::{Deserialize, Deserializer, Error as DeserializeError};
use serde::ser::{Serialize, Serializer};
use serde_json::Value;

/// Every error code the Tesseron wire protocol defines, named.
///
/// The set is closed: a gateway that sends an integer outside it is speaking a
/// protocol this crate does not implement, so [`ProtocolError`] keeps the raw
/// integer and [`ProtocolError::named_code`] returns `None` rather than
/// inventing a variant.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum TesseronErrorCode {
    /// The peer sent bytes that are not valid JSON.
    ParseError,
    /// The envelope is valid JSON but not a valid JSON-RPC 2.0 message.
    InvalidRequest,
    /// The requested method is not part of the Tesseron protocol.
    MethodNotFound,
    /// The method exists but its `params` do not match the documented shape.
    InvalidParams,
    /// The peer failed for a reason it does not expose.
    InternalError,
    /// The two sides disagree on the protocol major version.
    ProtocolMismatch,
    /// The invocation was cancelled before it produced a result.
    Cancelled,
    /// The invocation exceeded the action's timeout.
    Timeout,
    /// No action is registered under the requested name.
    ActionNotFound,
    /// The invocation input failed the action's declared schema.
    InputValidation,
    /// The handler itself failed. Domain failures belong here.
    HandlerError,
    /// The agent did not negotiate sampling, so `ctx.sample` cannot run.
    SamplingNotAvailable,
    /// The agent did not negotiate elicitation, so `ctx.elicit` cannot run.
    ElicitationNotAvailable,
    /// A sampling call nested deeper than the gateway's cap allows.
    SamplingDepthExceeded,
    /// The caller is not permitted to do this, typically an unclaimed session.
    Unauthorized,
    /// The transport closed while the request was in flight.
    TransportClosed,
    /// `tesseron/resume` was refused; fall back to a fresh `tesseron/hello`.
    ResumeFailed,
}

impl TesseronErrorCode {
    /// The JSON-RPC integer this code is written as on the wire.
    #[must_use]
    pub const fn as_wire_code(self) -> i32 {
        match self {
            Self::ParseError => -32700,
            Self::InvalidRequest => -32600,
            Self::MethodNotFound => -32601,
            Self::InvalidParams => -32602,
            Self::InternalError => -32603,
            Self::ProtocolMismatch => -32000,
            Self::Cancelled => -32001,
            Self::Timeout => -32002,
            Self::ActionNotFound => -32003,
            Self::InputValidation => -32004,
            Self::HandlerError => -32005,
            Self::SamplingNotAvailable => -32006,
            Self::ElicitationNotAvailable => -32007,
            Self::SamplingDepthExceeded => -32008,
            Self::Unauthorized => -32009,
            Self::TransportClosed => -32010,
            Self::ResumeFailed => -32011,
        }
    }

    /// Names a wire integer, or returns `None` when the peer sent a code this
    /// protocol version does not define.
    #[must_use]
    pub const fn from_wire_code(code: i32) -> Option<Self> {
        match code {
            -32700 => Some(Self::ParseError),
            -32600 => Some(Self::InvalidRequest),
            -32601 => Some(Self::MethodNotFound),
            -32602 => Some(Self::InvalidParams),
            -32603 => Some(Self::InternalError),
            -32000 => Some(Self::ProtocolMismatch),
            -32001 => Some(Self::Cancelled),
            -32002 => Some(Self::Timeout),
            -32003 => Some(Self::ActionNotFound),
            -32004 => Some(Self::InputValidation),
            -32005 => Some(Self::HandlerError),
            -32006 => Some(Self::SamplingNotAvailable),
            -32007 => Some(Self::ElicitationNotAvailable),
            -32008 => Some(Self::SamplingDepthExceeded),
            -32009 => Some(Self::Unauthorized),
            -32010 => Some(Self::TransportClosed),
            -32011 => Some(Self::ResumeFailed),
            _ => None,
        }
    }
}

impl fmt::Display for TesseronErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{self:?} ({})", self.as_wire_code())
    }
}

impl Serialize for TesseronErrorCode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_i32(self.as_wire_code())
    }
}

impl<'de> Deserialize<'de> for TesseronErrorCode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let code = i32::deserialize(deserializer)?;
        Self::from_wire_code(code)
            .ok_or_else(|| D::Error::custom(format!("unknown Tesseron error code {code}")))
    }
}

/// The `error` member of a JSON-RPC failure response, exactly as it travels.
///
/// The code stays an `i32` so an envelope from a newer gateway round-trips
/// without loss; call [`ProtocolError::named_code`] when you want the enum.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct ProtocolError {
    /// The JSON-RPC error code.
    pub code: i32,
    /// Human-readable explanation. Never machine-parsed.
    pub message: String,
    /// Structured detail whose shape is defined per error code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl ProtocolError {
    /// Builds a failure payload for a code this protocol version defines.
    #[must_use]
    pub fn new(code: TesseronErrorCode, message: impl Into<String>) -> Self {
        Self {
            code: code.as_wire_code(),
            message: message.into(),
            data: None,
        }
    }

    /// Attaches structured detail to the payload.
    #[must_use]
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    /// The named code, or `None` when the peer used an integer outside the
    /// protocol's closed set.
    #[must_use]
    pub fn named_code(&self) -> Option<TesseronErrorCode> {
        TesseronErrorCode::from_wire_code(self.code)
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.message, self.code)
    }
}

impl Error for ProtocolError {}

/// What an action handler returns when it cannot produce its output.
///
/// The distinction that matters on the wire is deliberate: [`ActionError::handler`]
/// and [`ActionError::protocol`] send their message and data to the agent,
/// while [`ActionError::internal`] keeps the cause on this side of the socket
/// and answers with a bare `-32603`.
#[derive(Debug)]
pub struct ActionError {
    code: TesseronErrorCode,
    message: String,
    data: Option<Value>,
    internal_source: Option<Box<dyn Error + Send + Sync>>,
}

impl ActionError {
    /// A domain failure the agent is meant to read: unknown id, empty cart,
    /// rejected transition. Answers `-32005 HandlerError`.
    #[must_use]
    pub fn handler(message: impl Into<String>) -> Self {
        Self {
            code: TesseronErrorCode::HandlerError,
            message: message.into(),
            data: None,
            internal_source: None,
        }
    }

    /// A failure that must carry one specific protocol code, keeping both the
    /// code and the structured `data` the agent needs to branch on.
    #[must_use]
    pub fn protocol(
        code: TesseronErrorCode,
        message: impl Into<String>,
        data: Option<Value>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            data,
            internal_source: None,
        }
    }

    /// An unexpected failure. The cause is kept locally and reported through
    /// [`ActionError::internal_source`]; the agent only ever sees `-32603` with
    /// a fixed message, because a panic message or a database URL in a handler
    /// error is a leak.
    #[must_use]
    pub fn internal(source: impl Into<Box<dyn Error + Send + Sync>>) -> Self {
        Self {
            code: TesseronErrorCode::InternalError,
            message: "Internal error".to_owned(),
            data: None,
            internal_source: Some(source.into()),
        }
    }

    /// Attaches structured detail the agent can branch on.
    #[must_use]
    pub fn with_data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }

    /// The wire code this error answers with.
    #[must_use]
    pub const fn code(&self) -> TesseronErrorCode {
        self.code
    }

    /// The message the agent will see.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// The structured detail the agent will see, if any.
    #[must_use]
    pub const fn data(&self) -> Option<&Value> {
        self.data.as_ref()
    }

    /// The cause held back from the wire by [`ActionError::internal`].
    #[must_use]
    pub fn internal_source(&self) -> Option<&(dyn Error + Send + Sync + 'static)> {
        self.internal_source.as_deref()
    }

    /// The payload to put in the JSON-RPC failure response. Pure: reporting the
    /// held-back cause is the caller's job.
    #[must_use]
    pub fn into_protocol_error(self) -> ProtocolError {
        ProtocolError {
            code: self.code.as_wire_code(),
            message: self.message,
            data: self.data,
        }
    }
}

impl fmt::Display for ActionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} ({})", self.message, self.code)
    }
}

impl Error for ActionError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.internal_source
            .as_ref()
            .map(|source| source.as_ref() as &(dyn Error + 'static))
    }
}

/// Why a host could not start, publish itself, or shut down.
#[derive(Debug)]
#[non_exhaustive]
pub enum HostError {
    /// No application descriptor was registered before `listen`.
    MissingApplication,
    /// The application id does not match `^[a-z][a-z0-9_]*$`, or it is one of
    /// the reserved ids (`tesseron`, `mcp`, `system`).
    InvalidApplicationId(String),
    /// Two actions, or two resources, were registered under one name. The
    /// manifest has to stay unambiguous because the gateway projects each name
    /// into a distinct MCP tool.
    DuplicateName(String),
    /// The configured address is reachable off the local machine.
    NonLoopbackBindAddress(SocketAddr),
    /// The loopback listener could not bind.
    Listen(io::Error),
    /// The instance manifest could not be written or removed.
    Manifest(io::Error),
    /// The home directory that holds `~/.tesseron/instances` could not be
    /// resolved from the environment.
    HomeDirectoryUnknown,
}

impl fmt::Display for HostError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingApplication => {
                formatter.write_str("no application was registered before listen()")
            }
            Self::InvalidApplicationId(id) => write!(
                formatter,
                "application id {id:?} must match ^[a-z][a-z0-9_]*$ and must not be reserved"
            ),
            Self::DuplicateName(name) => {
                write!(formatter, "{name:?} was registered more than once")
            }
            Self::NonLoopbackBindAddress(address) => write!(
                formatter,
                "Tesseron hosts bind loopback addresses only; {address} is not loopback"
            ),
            Self::Listen(source) => {
                write!(formatter, "could not bind the loopback listener: {source}")
            }
            Self::Manifest(source) => write!(
                formatter,
                "could not publish the instance manifest: {source}"
            ),
            Self::HomeDirectoryUnknown => {
                formatter.write_str("could not resolve a home directory for ~/.tesseron")
            }
        }
    }
}

impl Error for HostError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Listen(source) | Self::Manifest(source) => Some(source),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_named_code_round_trips_through_its_wire_integer() {
        let codes = [
            TesseronErrorCode::ParseError,
            TesseronErrorCode::InvalidRequest,
            TesseronErrorCode::MethodNotFound,
            TesseronErrorCode::InvalidParams,
            TesseronErrorCode::InternalError,
            TesseronErrorCode::ProtocolMismatch,
            TesseronErrorCode::Cancelled,
            TesseronErrorCode::Timeout,
            TesseronErrorCode::ActionNotFound,
            TesseronErrorCode::InputValidation,
            TesseronErrorCode::HandlerError,
            TesseronErrorCode::SamplingNotAvailable,
            TesseronErrorCode::ElicitationNotAvailable,
            TesseronErrorCode::SamplingDepthExceeded,
            TesseronErrorCode::Unauthorized,
            TesseronErrorCode::TransportClosed,
            TesseronErrorCode::ResumeFailed,
        ];
        assert_eq!(codes.len(), 17);
        for code in codes {
            assert_eq!(
                TesseronErrorCode::from_wire_code(code.as_wire_code()),
                Some(code)
            );
        }
    }

    #[test]
    fn wire_integers_match_the_published_error_table() {
        assert_eq!(TesseronErrorCode::ProtocolMismatch.as_wire_code(), -32000);
        assert_eq!(TesseronErrorCode::Cancelled.as_wire_code(), -32001);
        assert_eq!(TesseronErrorCode::ActionNotFound.as_wire_code(), -32003);
        assert_eq!(TesseronErrorCode::InputValidation.as_wire_code(), -32004);
        assert_eq!(TesseronErrorCode::HandlerError.as_wire_code(), -32005);
        assert_eq!(TesseronErrorCode::ResumeFailed.as_wire_code(), -32011);
        assert_eq!(TesseronErrorCode::from_wire_code(-31999), None);
    }

    #[test]
    fn internal_errors_keep_their_cause_off_the_wire() {
        let error = ActionError::internal(io::Error::other("connection string leaked"));
        assert!(error.internal_source().is_some());
        let payload = error.into_protocol_error();
        assert_eq!(payload.code, -32603);
        assert_eq!(payload.message, "Internal error");
        assert!(payload.data.is_none());
    }

    #[test]
    fn protocol_errors_keep_their_code_and_data() {
        let error = ActionError::protocol(
            TesseronErrorCode::HandlerError,
            "no todo with that id",
            Some(serde_json::json!({ "kind": "not_found" })),
        );
        let payload = error.into_protocol_error();
        assert_eq!(payload.code, -32005);
        assert_eq!(
            payload.data,
            Some(serde_json::json!({ "kind": "not_found" }))
        );
    }
}
