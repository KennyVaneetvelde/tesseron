use serde::{Deserialize, Serialize};
use serde_json::{Map, Number, Value};

use crate::error::ProtocolError;
use crate::protocol::JSONRPC_VERSION;

/// The `id` member correlating a JSON-RPC request with its response.
///
/// JSON-RPC allows a string, any JSON number, or null. The id is echoed back in
/// whichever shape it arrived rather than normalised.
#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(untagged)]
pub enum RequestId {
    /// A null id still identifies a request and must receive a null response.
    Null,
    /// A numeric id, including unsigned and fractional JSON numbers.
    Number(Number),
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
    InvalidRequest {
        id: RequestId,
        problem: String,
    },
    /// Valid JSON that is not an envelope this peer can act on.
    Malformed(String),
}

/// Sorts a decoded JSON value into its JSON-RPC shape.
///
/// Presence, not nullness, decides: a success response carrying `"result": null`
/// is a success, and a request carrying `"id": null` still expects a response.
pub(crate) fn classify(frame: Value) -> IncomingFrame {
    let Value::Object(mut members) = frame else {
        return IncomingFrame::Malformed("envelope is not a JSON object".to_owned());
    };
    let jsonrpc = members.remove("jsonrpc");
    let raw_id = members.remove("id");
    let id = raw_id.as_ref().and_then(parse_request_id);
    if jsonrpc != Some(Value::String(JSONRPC_VERSION.to_owned())) {
        return IncomingFrame::InvalidRequest {
            id: id.unwrap_or(RequestId::Null),
            problem: "envelope is missing jsonrpc: \"2.0\"".to_owned(),
        };
    }

    let method = members.remove("method");
    let params = members.remove("params").unwrap_or(Value::Null);
    if let Some(Value::String(method)) = method {
        return match (raw_id.is_some(), id) {
            (false, _) => IncomingFrame::Notification { method, params },
            (true, Some(id)) => IncomingFrame::Request { id, method, params },
            (true, None) => IncomingFrame::InvalidRequest {
                id: RequestId::Null,
                problem: "request id is not a string, number, or null".to_owned(),
            },
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

fn parse_request_id(value: &Value) -> Option<RequestId> {
    match value {
        Value::Null => Some(RequestId::Null),
        Value::String(text) => Some(RequestId::Text(text.clone())),
        Value::Number(number) => Some(RequestId::Number(number.clone())),
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

/// Builds a notification envelope: a method with no id, so the peer never
/// answers it. Fails only when `params` cannot serialise.
pub(crate) fn notification(
    method: &str,
    params: impl Serialize,
) -> Result<Value, serde_json::Error> {
    let mut envelope = Map::new();
    envelope.insert(
        "jsonrpc".to_owned(),
        Value::String(JSONRPC_VERSION.to_owned()),
    );
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
            RequestId::Null => Value::Null,
            RequestId::Number(number) => Value::Number(number.clone()),
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
                assert_eq!(id, RequestId::Number(Number::from(1)));
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
    fn a_method_with_a_null_id_is_a_request() {
        let frame = classify(serde_json::json!({
            "jsonrpc": "2.0",
            "id": null,
            "method": "actions/invoke",
            "params": {}
        }));
        assert!(matches!(
            frame,
            IncomingFrame::Request {
                id: RequestId::Null,
                ..
            }
        ));
    }

    #[test]
    fn ids_keep_their_original_json_number() {
        for id in [
            serde_json::json!(u64::MAX),
            serde_json::json!(-1),
            serde_json::json!(1.5),
        ] {
            let frame = classify(serde_json::json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": "actions/invoke",
                "params": {}
            }));
            match frame {
                IncomingFrame::Request { id: request_id, .. } => {
                    assert_eq!(envelope_with_id(&request_id)["id"], id);
                }
                other => panic!("expected a request, got {other:?}"),
            }
        }
    }

    #[test]
    fn a_missing_jsonrpc_member_is_an_invalid_request() {
        let frame = classify(serde_json::json!({ "id": "inv-1", "method": "actions/invoke" }));
        assert!(matches!(frame, IncomingFrame::InvalidRequest { .. }));
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
    fn a_notification_carries_no_id() {
        let envelope =
            notification("actions/progress", serde_json::json!({ "percent": 10 })).unwrap();
        assert_eq!(envelope["jsonrpc"], "2.0");
        assert_eq!(envelope["method"], "actions/progress");
        assert_eq!(envelope["params"]["percent"], 10);
        assert!(
            envelope.get("id").is_none(),
            "an id would make the gateway wait for a response"
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
