use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::error::ProtocolError;
use crate::protocol::JSONRPC_VERSION;

/// The `id` member correlating a JSON-RPC request with its response.
///
/// JSON-RPC allows a string or a number and Tesseron peers use both, so the id
/// is echoed back in whichever shape it arrived rather than normalised.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RequestId {
    /// A numeric id, the shape this crate mints for its own requests.
    Number(i64),
    /// A string id, the shape the gateway uses for invocations.
    Text(String),
}

/// One decoded frame from the gateway, sorted into the four JSON-RPC shapes.
#[derive(Debug)]
pub(crate) enum IncomingFrame {
    Request {
        id: RequestId,
        method: String,
        params: Value,
    },
    Notification {
        method: String,
        params: Value,
    },
    Success {
        id: RequestId,
        result: Value,
    },
    Failure {
        id: RequestId,
        error: ProtocolError,
    },
    /// Valid JSON that is not a JSON-RPC 2.0 message this peer can act on.
    Malformed(String),
}

/// Sorts a decoded JSON value into its JSON-RPC shape.
///
/// Presence, not nullness, decides: a success response carrying `"result": null`
/// is a success, and `Option<Value>` deserialisation would have collapsed it
/// into "absent".
pub(crate) fn classify(frame: Value) -> IncomingFrame {
    let Value::Object(mut members) = frame else {
        return IncomingFrame::Malformed("envelope is not a JSON object".to_owned());
    };
    let id = members.remove("id").and_then(parse_request_id);
    let method = members.remove("method");
    let params = members.remove("params").unwrap_or(Value::Null);

    if let Some(Value::String(method)) = method {
        return match id {
            Some(id) => IncomingFrame::Request { id, method, params },
            None => IncomingFrame::Notification { method, params },
        };
    }

    let Some(id) = id else {
        return IncomingFrame::Malformed("envelope has neither a method nor an id".to_owned());
    };
    if let Some(error) = members.remove("error") {
        return match serde_json::from_value::<ProtocolError>(error) {
            Ok(error) => IncomingFrame::Failure { id, error },
            Err(problem) => IncomingFrame::Malformed(format!("unreadable error member: {problem}")),
        };
    }
    if members.contains_key("result") {
        let result = members.remove("result").unwrap_or(Value::Null);
        return IncomingFrame::Success { id, result };
    }
    IncomingFrame::Malformed("response has neither a result nor an error".to_owned())
}

fn parse_request_id(value: Value) -> Option<RequestId> {
    match value {
        Value::String(text) => Some(RequestId::Text(text)),
        Value::Number(number) => number.as_i64().map(RequestId::Number),
        _ => None,
    }
}

/// Builds a request envelope. Fails only when `params` cannot serialise.
pub(crate) fn request(
    id: &RequestId,
    method: &str,
    params: impl Serialize,
) -> Result<Value, serde_json::Error> {
    let mut envelope = envelope_with_id(id);
    envelope.insert("method".to_owned(), Value::String(method.to_owned()));
    envelope.insert("params".to_owned(), serde_json::to_value(params)?);
    Ok(Value::Object(envelope))
}

/// Builds a success response. Fails only when `result` cannot serialise.
pub(crate) fn success(id: &RequestId, result: impl Serialize) -> Result<Value, serde_json::Error> {
    let mut envelope = envelope_with_id(id);
    envelope.insert("result".to_owned(), serde_json::to_value(result)?);
    Ok(Value::Object(envelope))
}

/// Builds a failure response. Infallible: [`ProtocolError`] is plain data.
pub(crate) fn failure(id: &RequestId, error: &ProtocolError) -> Value {
    let mut envelope = envelope_with_id(id);
    let mut payload = Map::new();
    payload.insert("code".to_owned(), Value::from(error.code));
    payload.insert("message".to_owned(), Value::String(error.message.clone()));
    if let Some(data) = &error.data {
        payload.insert("data".to_owned(), data.clone());
    }
    envelope.insert("error".to_owned(), Value::Object(payload));
    Value::Object(envelope)
}

fn envelope_with_id(id: &RequestId) -> Map<String, Value> {
    let mut envelope = Map::new();
    envelope.insert(
        "jsonrpc".to_owned(),
        Value::String(JSONRPC_VERSION.to_owned()),
    );
    envelope.insert(
        "id".to_owned(),
        match id {
            RequestId::Number(number) => Value::from(*number),
            RequestId::Text(text) => Value::String(text.clone()),
        },
    );
    envelope
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_success_carrying_null_is_not_mistaken_for_a_failure() {
        let frame = classify(serde_json::json!({ "jsonrpc": "2.0", "id": 1, "result": null }));
        match frame {
            IncomingFrame::Success { id, result } => {
                assert_eq!(id, RequestId::Number(1));
                assert_eq!(result, Value::Null);
            }
            other => panic!("expected a success, got {other:?}"),
        }
    }

    #[test]
    fn a_method_without_an_id_is_a_notification() {
        let frame = classify(serde_json::json!({
            "jsonrpc": "2.0",
            "method": "tesseron/claimed",
            "params": { "agent": { "id": "a", "name": "b" }, "claimedAt": 1 }
        }));
        assert!(matches!(frame, IncomingFrame::Notification { .. }));
    }

    #[test]
    fn a_method_with_an_id_is_a_request() {
        let frame = classify(serde_json::json!({
            "jsonrpc": "2.0",
            "id": "inv-1",
            "method": "actions/invoke",
            "params": {}
        }));
        match frame {
            IncomingFrame::Request { id, method, .. } => {
                assert_eq!(id, RequestId::Text("inv-1".to_owned()));
                assert_eq!(method, "actions/invoke");
            }
            other => panic!("expected a request, got {other:?}"),
        }
    }

    #[test]
    fn failure_envelopes_keep_their_id_shape_and_data() {
        let error = ProtocolError::new(crate::TesseronErrorCode::InputValidation, "bad input")
            .with_data(serde_json::json!({ "issues": [] }));
        let envelope = failure(&RequestId::Text("inv-1".to_owned()), &error);
        assert_eq!(envelope["id"], "inv-1");
        assert_eq!(envelope["jsonrpc"], "2.0");
        assert_eq!(envelope["error"]["code"], -32004);
        assert_eq!(
            envelope["error"]["data"],
            serde_json::json!({ "issues": [] })
        );
    }

    #[test]
    fn a_bare_array_is_malformed() {
        assert!(matches!(
            classify(serde_json::json!([1, 2, 3])),
            IncomingFrame::Malformed(_)
        ));
    }
}
