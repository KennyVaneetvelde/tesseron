//! Drives a live host over a real WebSocket, playing the gateway's half.
//!
//! The conformance corpus in `conformance/` is the authority on the wire
//! format, but it only runs when the Node runner is built and, on Windows, only
//! when the host path is spelled for `cmd.exe`. These tests keep the same
//! ground covered from `cargo test` alone.

// A failed assertion is the point of a test, so a panicking unwrap is the
// clearest way to write one; the workspace denies it everywhere else.
#![allow(clippy::unwrap_used)]

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde_json::{Value, json};
use tesseron::{
    Action, ActionContext, ActionError, ElicitRequest, GATEWAY_SUBPROTOCOL, HostEvent, LogEntry,
    ManifestPublication, PROTOCOL_VERSION, ProgressUpdate, Resource, SampleRequest, Subscription,
    Tesseron, TesseronErrorCode, TesseronHost, TesseronHostBuilder, ValidationIssue,
};
use tokio::net::TcpStream;
use tokio::sync::broadcast::Receiver;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::client::IntoClientRequest as _;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

/// Long enough that a loaded machine does not fail the suite, short enough that
/// a genuine hang reports instead of running the job out of time.
const PATIENCE: Duration = Duration::from_secs(10);

fn application() -> TesseronHostBuilder {
    Tesseron::builder()
        .application("todo", "Todo")
        .manifest(ManifestPublication::Disabled)
}

fn with_actions() -> TesseronHostBuilder {
    application()
        .action(
            Action::json("add", |input: Value, _context: ActionContext| async move {
                let left = input["left"].as_i64().unwrap_or_default();
                let right = input["right"].as_i64().unwrap_or_default();
                Ok(json!({ "sum": left + right }))
            })
            .description("Adds two numbers")
            .input_schema(json!({
                "type": "object",
                "properties": { "left": { "type": "number" }, "right": { "type": "number" } },
                "required": ["left", "right"]
            }))
            .validate_with(|input: &Value| {
                let mut issues = Vec::new();
                for field in ["left", "right"] {
                    if !input.get(field).is_some_and(Value::is_number) {
                        issues.push(ValidationIssue::new(
                            "expected a number",
                            vec![field.to_owned()],
                        ));
                    }
                }
                if issues.is_empty() {
                    Ok(())
                } else {
                    Err(issues)
                }
            }),
        )
        .action(Action::json(
            "never_finishes",
            |_input: Value, _context: ActionContext| async move {
                std::future::pending::<Result<Value, ActionError>>().await
            },
        ))
        .resource(Resource::new("settings", || async {
            Ok(json!({ "theme": "dark" }))
        }))
}

/// The gateway's end of one connection.
struct Gateway {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Gateway {
    async fn dial(url: &str) -> Self {
        let mut request = url.into_client_request().unwrap();
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(GATEWAY_SUBPROTOCOL),
        );
        let (socket, _response) =
            tokio::time::timeout(PATIENCE, tokio_tungstenite::connect_async(request))
                .await
                .expect("the host accepted the upgrade in time")
                .expect("the host accepted the gateway subprotocol");
        Self { socket }
    }

    async fn next_frame(&mut self) -> Value {
        loop {
            let message = tokio::time::timeout(PATIENCE, self.socket.next())
                .await
                .expect("the host sent a frame in time")
                .expect("the host did not close the socket")
                .expect("the frame was readable");
            match message {
                Message::Text(text) => return serde_json::from_str(&text).unwrap(),
                Message::Close(_) => panic!("the host closed the socket"),
                _ => continue,
            }
        }
    }

    async fn send(&mut self, frame: Value) {
        self.socket
            .send(Message::text(frame.to_string()))
            .await
            .unwrap();
    }

    /// Answers whatever request the host is waiting on, and hands back what it
    /// asked for so the caller can assert on it.
    async fn answer_next(&mut self, result: Value) -> Value {
        let request = self.next_frame().await;
        self.send(json!({
            "jsonrpc": "2.0",
            "id": request["id"].clone(),
            "result": result,
        }))
        .await;
        request
    }

    async fn call(&mut self, id: i64, method: &str, params: Value) -> Value {
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        self.next_frame().await
    }

    async fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await;
    }

    async fn drop_transport(mut self) {
        let _ = self.socket.close(None).await;
    }
}

fn welcome(session_id: &str, resume_token: &str, claim_code: Option<&str>) -> Value {
    let mut result = json!({
        "sessionId": session_id,
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": {
            "streaming": true,
            "subscriptions": true,
            "sampling": true,
            "elicitation": true
        },
        "agent": { "id": "pending", "name": "Awaiting agent" },
        "resumeToken": resume_token,
    });
    if let Some(code) = claim_code {
        result["claimCode"] = json!(code);
    }
    result
}

async fn next_event(events: &mut Receiver<HostEvent>) -> HostEvent {
    tokio::time::timeout(PATIENCE, events.recv())
        .await
        .expect("the host emitted an event in time")
        .expect("the event channel stayed open")
}

async fn started(builder: TesseronHostBuilder) -> (TesseronHost, Receiver<HostEvent>) {
    // Subscribing after listen() races the handshake: the gateway can dial and
    // be welcomed before the caller ever gets a receiver.
    let events = builder.subscribe();
    let host = builder.listen().await.unwrap();
    (host, events)
}

#[tokio::test(flavor = "multi_thread")]
async fn hello_carries_the_manifest_and_declares_every_capability() {
    let (host, mut events) = started(with_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;

    let hello = gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;

    assert_eq!(hello["jsonrpc"], "2.0");
    assert_eq!(hello["method"], "tesseron/hello");
    assert!(
        !hello["id"].is_null(),
        "hello is a request, not a notification"
    );

    let params = &hello["params"];
    assert_eq!(params["protocolVersion"], PROTOCOL_VERSION);
    assert_eq!(params["app"]["id"], "todo");
    assert_eq!(params["app"]["name"], "Todo");
    assert_eq!(params["capabilities"]["streaming"], true);
    assert_eq!(params["capabilities"]["subscriptions"], true);
    assert_eq!(params["capabilities"]["sampling"], true);
    assert_eq!(params["capabilities"]["elicitation"], true);

    let actions = params["actions"].as_array().unwrap();
    assert_eq!(actions.len(), 2, "registration order is preserved");
    assert_eq!(actions[0]["name"], "add");
    assert_eq!(actions[0]["description"], "Adds two numbers");
    assert_eq!(
        actions[0]["inputSchema"]["required"],
        json!(["left", "right"])
    );

    let resources = params["resources"].as_array().unwrap();
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0]["name"], "settings");
    assert_eq!(resources[0]["subscribable"], false);

    match next_event(&mut events).await {
        HostEvent::Welcome(result) => {
            assert_eq!(result.session_id, "session-1");
            assert_eq!(result.claim_code.as_deref(), Some("ABC-123"));
        }
        other => panic!("expected a welcome, got {other:?}"),
    }
    assert_eq!(host.welcome().unwrap().session_id, "session-1");

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claim_notification_reaches_the_application() {
    let (host, mut events) = started(application()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;
    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Welcome(_)
    ));

    gateway
        .notify(
            "tesseron/claimed",
            json!({
                "agent": { "id": "claude", "name": "Claude" },
                "claimedAt": 1_756_900_000_000_i64
            }),
        )
        .await;

    match next_event(&mut events).await {
        HostEvent::Claimed(claim) => {
            assert_eq!(claim.agent.id, "claude");
            assert_eq!(claim.claimed_at, 1_756_900_000_000);
        }
        other => panic!("expected a claim, got {other:?}"),
    }

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_reconnect_resumes_with_the_token_the_last_welcome_rotated_in() {
    let (host, mut events) = started(application()).await;

    let mut first = Gateway::dial(host.url()).await;
    let hello = first
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;
    assert_eq!(hello["method"], "tesseron/hello");
    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Welcome(_)
    ));
    first.drop_transport().await;
    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Disconnected
    ));

    let mut second = Gateway::dial(host.url()).await;
    let resume = second
        .answer_next(welcome("session-1", "token-2", None))
        .await;
    assert_eq!(resume["method"], "tesseron/resume");
    assert_eq!(resume["params"]["sessionId"], "session-1");
    assert_eq!(resume["params"]["resumeToken"], "token-1");
    assert_eq!(
        resume["params"]["app"]["id"], "todo",
        "resume repeats the manifest so the gateway can replace its copy"
    );
    match next_event(&mut events).await {
        HostEvent::Welcome(result) => {
            assert!(
                result.claim_code.is_none(),
                "a resumed session is already claimed"
            );
        }
        other => panic!("expected a welcome, got {other:?}"),
    }
    second.drop_transport().await;
    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Disconnected
    ));

    let mut third = Gateway::dial(host.url()).await;
    let second_resume = third
        .answer_next(welcome("session-1", "token-3", None))
        .await;
    assert_eq!(
        second_resume["params"]["resumeToken"], "token-2",
        "the token the previous welcome rotated in is the one that gets used"
    );

    third.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_refused_resume_falls_back_to_a_fresh_hello() {
    let (host, mut events) = started(application()).await;

    let mut first = Gateway::dial(host.url()).await;
    first
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;
    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Welcome(_)
    ));
    first.drop_transport().await;
    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Disconnected
    ));

    let mut second = Gateway::dial(host.url()).await;
    let resume = second.next_frame().await;
    assert_eq!(resume["method"], "tesseron/resume");
    second
        .send(json!({
            "jsonrpc": "2.0",
            "id": resume["id"].clone(),
            "error": { "code": -32011, "message": "Resume failed" }
        }))
        .await;

    let hello = second
        .answer_next(welcome("session-2", "token-9", Some("XYZ-789")))
        .await;
    assert_eq!(hello["method"], "tesseron/hello");
    match next_event(&mut events).await {
        HostEvent::Welcome(result) => assert_eq!(result.claim_code.as_deref(), Some("XYZ-789")),
        other => panic!("expected a welcome, got {other:?}"),
    }

    second.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_welcome_from_another_protocol_major_is_refused() {
    let (host, mut events) = started(application()).await;
    let mut gateway = Gateway::dial(host.url()).await;

    let mut mismatched = welcome("session-1", "token-1", Some("ABC-123"));
    mismatched["protocolVersion"] = json!("2.0.0");
    gateway.answer_next(mismatched).await;

    match next_event(&mut events).await {
        HostEvent::HandshakeFailed(refusal) => {
            assert_eq!(
                refusal.named_code(),
                Some(TesseronErrorCode::ProtocolMismatch)
            );
            assert!(refusal.message.contains("2.0.0"), "{}", refusal.message);
        }
        other => panic!("expected a refusal, got {other:?}"),
    }
    assert!(host.welcome().is_none());

    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_upgrade_without_the_gateway_subprotocol_is_refused() {
    let (host, _events) = started(application()).await;

    let outcome = tokio::time::timeout(
        PATIENCE,
        tokio_tungstenite::connect_async(host.url().into_client_request().unwrap()),
    )
    .await
    .expect("the host answered the upgrade in time");
    assert!(
        outcome.is_err(),
        "the endpoint exists for the gateway, not for arbitrary local clients"
    );

    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn invocations_answer_output_not_found_and_validation_failures() {
    let (host, _events) = started(with_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;

    let success = gateway
        .call(
            1,
            "actions/invoke",
            json!({ "name": "add", "input": { "left": 2, "right": 3 }, "invocationId": "inv-1" }),
        )
        .await;
    assert_eq!(success["id"], 1);
    assert_eq!(success["result"]["invocationId"], "inv-1");
    assert_eq!(success["result"]["output"]["sum"], 5);

    let missing = gateway
        .call(
            2,
            "actions/invoke",
            json!({ "name": "nope", "input": {}, "invocationId": "inv-2" }),
        )
        .await;
    assert_eq!(missing["error"]["code"], -32003);

    let invalid = gateway
        .call(
            3,
            "actions/invoke",
            json!({ "name": "add", "input": { "left": "two" }, "invocationId": "inv-3" }),
        )
        .await;
    assert_eq!(invalid["error"]["code"], -32004);
    let issues = invalid["error"]["data"].as_array().unwrap();
    assert_eq!(
        issues.len(),
        2,
        "every failing field is reported: {issues:?}"
    );

    let unknown_method = gateway.call(4, "actions/explode", json!({})).await;
    assert_eq!(unknown_method["error"]["code"], -32601);

    let read = gateway
        .call(5, "resources/read", json!({ "name": "settings" }))
        .await;
    assert_eq!(read["result"]["value"]["theme"], "dark");

    let unreadable = gateway
        .call(6, "resources/read", json!({ "name": "nope" }))
        .await;
    assert_eq!(unreadable["error"]["code"], -32003);

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn cancelling_an_invocation_answers_the_request_that_is_still_open() {
    let (host, _events) = started(with_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;

    gateway
        .send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "actions/invoke",
            "params": {
                "name": "never_finishes",
                "input": {},
                "invocationId": "inv-1"
            }
        }))
        .await;
    gateway
        .notify("actions/cancel", json!({ "invocationId": "inv-1" }))
        .await;

    let cancelled = gateway.next_frame().await;
    assert_eq!(cancelled["id"], 1);
    assert_eq!(cancelled["error"]["code"], -32001);

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_transport_fails_the_invocations_it_orphaned() {
    let (host, mut events) = started(with_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;
    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Welcome(_)
    ));

    gateway
        .send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "actions/invoke",
            "params": { "name": "never_finishes", "input": {}, "invocationId": "inv-1" }
        }))
        .await;
    gateway.drop_transport().await;

    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Disconnected
    ));
    host.shutdown().await.unwrap();
}

/// A host whose handlers exercise every context round trip the gateway answers.
fn with_context_actions() -> TesseronHostBuilder {
    application()
        .action(Action::json(
            "report",
            |_input: Value, context: ActionContext| async move {
                context.progress(ProgressUpdate::new().percent(10.0));
                context.progress(ProgressUpdate::new().percent(2.0).message("regressed"));
                context.log(LogEntry::info("halfway"));
                context.progress(ProgressUpdate::new().percent(100.0));
                Ok(json!({ "done": true }))
            },
        ))
        .action(Action::json(
            "delete_all",
            |_input: Value, context: ActionContext| async move {
                let confirmed = context.confirm("Delete everything?").await?;
                Ok(json!({ "confirmed": confirmed }))
            },
        ))
        .action(Action::json(
            "rename",
            |_input: Value, context: ActionContext| async move {
                let answer = context
                    .elicit(
                        ElicitRequest::new("What should it be called?").json_schema(json!({
                            "type": "object",
                            "properties": { "name": { "type": "string" } },
                            "required": ["name"]
                        })),
                    )
                    .await?;
                Ok(json!({ "answer": answer }))
            },
        ))
        .action(Action::json(
            "rename_with_a_broken_schema",
            |_input: Value, context: ActionContext| async move {
                context
                    .elicit(
                        ElicitRequest::new("What should it be called?").json_schema(
                            json!({ "type": "object", "oneOf": [{ "type": "object" }] }),
                        ),
                    )
                    .await?;
                Ok(Value::Null)
            },
        ))
        .action(Action::json(
            "whoami",
            |_input: Value, context: ActionContext| async move {
                Ok(json!({
                    "agent": context.agent().id.clone(),
                    "sampling": context.agent_capabilities().sampling
                }))
            },
        ))
        .action(Action::json(
            "summarise",
            |_input: Value, context: ActionContext| async move {
                let summary = context
                    .sample(SampleRequest::new("Summarise this").max_tokens(64))
                    .await?;
                Ok(json!({ "summary": summary }))
            },
        ))
}

#[tokio::test(flavor = "multi_thread")]
async fn progress_streams_forward_and_a_regression_is_raised_to_the_ceiling() {
    let (host, _events) = started(with_context_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;

    gateway
        .send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "actions/invoke",
            "params": { "name": "report", "input": {}, "invocationId": "inv-1" }
        }))
        .await;

    let first = gateway.next_frame().await;
    assert_eq!(first["method"], "actions/progress");
    assert!(first.get("id").is_none(), "progress is a notification");
    assert_eq!(first["params"]["invocationId"], "inv-1");
    assert_eq!(first["params"]["percent"], 10.0);

    let regressed = gateway.next_frame().await;
    assert_eq!(
        regressed["params"]["percent"], 10.0,
        "a backwards percent is raised to the ceiling already sent"
    );
    assert_eq!(regressed["params"]["message"], "regressed");

    let logged = gateway.next_frame().await;
    assert_eq!(logged["method"], "log");
    assert_eq!(logged["params"]["level"], "info");
    assert_eq!(logged["params"]["message"], "halfway");

    let last = gateway.next_frame().await;
    assert_eq!(last["params"]["percent"], 100.0);

    let answer = gateway.next_frame().await;
    assert_eq!(answer["result"]["output"]["done"], true);

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_declined_confirmation_is_false_rather_than_a_failure() {
    let (host, _events) = started(with_context_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;

    gateway
        .send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "actions/invoke",
            "params": { "name": "delete_all", "input": {}, "invocationId": "inv-1" }
        }))
        .await;

    let question = gateway.next_frame().await;
    assert_eq!(question["method"], "elicitation/request");
    assert_eq!(question["params"]["question"], "Delete everything?");
    assert_eq!(
        question["params"]["schema"],
        json!({ "type": "object", "properties": {}, "required": [] }),
        "confirm asks for no fields so the agent renders accept or decline"
    );
    gateway
        .send(json!({
            "jsonrpc": "2.0",
            "id": question["id"].clone(),
            "result": { "action": "decline" }
        }))
        .await;

    let answer = gateway.next_frame().await;
    assert_eq!(answer["result"]["output"]["confirmed"], false);

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_accepted_elicitation_hands_the_value_to_the_handler() {
    let (host, _events) = started(with_context_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;

    gateway
        .send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "actions/invoke",
            "params": { "name": "rename", "input": {}, "invocationId": "inv-1" }
        }))
        .await;

    let question = gateway.next_frame().await;
    assert_eq!(question["method"], "elicitation/request");
    assert_eq!(question["params"]["invocationId"], "inv-1");
    assert_eq!(question["params"]["schema"]["required"], json!(["name"]));
    gateway
        .send(json!({
            "jsonrpc": "2.0",
            "id": question["id"].clone(),
            "result": { "action": "accept", "value": { "name": "Groceries" } }
        }))
        .await;

    let answer = gateway.next_frame().await;
    assert_eq!(answer["result"]["output"]["answer"]["name"], "Groceries");

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_schema_the_agent_cannot_render_fails_before_anything_is_asked() {
    let (host, _events) = started(with_context_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;

    let refusal = gateway
        .call(
            1,
            "actions/invoke",
            json!({
                "name": "rename_with_a_broken_schema",
                "input": {},
                "invocationId": "inv-1"
            }),
        )
        .await;

    assert_eq!(
        refusal["error"]["code"], -32602,
        "the very next frame is the refusal, so nothing was ever asked"
    );

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn sampling_forwards_the_prompt_and_returns_the_content() {
    let (host, _events) = started(with_context_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;

    gateway
        .send(json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "actions/invoke",
            "params": { "name": "summarise", "input": {}, "invocationId": "inv-1" }
        }))
        .await;

    let request = gateway.next_frame().await;
    assert_eq!(request["method"], "sampling/request");
    assert_eq!(request["params"]["prompt"], "Summarise this");
    assert_eq!(request["params"]["maxTokens"], 64);
    assert_eq!(request["params"]["invocationId"], "inv-1");
    gateway
        .send(json!({
            "jsonrpc": "2.0",
            "id": request["id"].clone(),
            "result": { "content": "three sentences" }
        }))
        .await;

    let answer = gateway.next_frame().await;
    assert_eq!(answer["result"]["output"]["summary"], "three sentences");

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn an_agent_that_negotiated_nothing_gets_the_documented_refusals() {
    let (host, _events) = started(with_context_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    let mut plain = welcome("session-1", "token-1", Some("ABC-123"));
    plain["capabilities"] = json!({
        "streaming": false,
        "subscriptions": false,
        "sampling": false,
        "elicitation": false
    });
    gateway.answer_next(plain).await;

    let confirmed = gateway
        .call(
            1,
            "actions/invoke",
            json!({ "name": "delete_all", "input": {}, "invocationId": "inv-1" }),
        )
        .await;
    assert_eq!(
        confirmed["result"]["output"]["confirmed"], false,
        "confirm has a safe default and never asks"
    );

    let elicited = gateway
        .call(
            2,
            "actions/invoke",
            json!({ "name": "rename", "input": {}, "invocationId": "inv-2" }),
        )
        .await;
    assert_eq!(elicited["error"]["code"], -32007);

    let sampled = gateway
        .call(
            3,
            "actions/invoke",
            json!({ "name": "summarise", "input": {}, "invocationId": "inv-3" }),
        )
        .await;
    assert_eq!(sampled["error"]["code"], -32006);

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_subscription_pushes_updates_and_its_cleanup_runs_on_unsubscribe() {
    let torn_down = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&torn_down);
    let host_builder = application().resource(
        Resource::new("cart", || async { Ok(json!({ "total": 0 })) }).subscribe(move |emitter| {
            let counter = Arc::clone(&counter);
            let pushing = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                emitter.emit(json!({ "total": 42 }));
            });
            Subscription::new(move || {
                pushing.abort();
                counter.fetch_add(1, Ordering::Relaxed);
            })
        }),
    );
    let (host, _events) = started(host_builder).await;
    let mut gateway = Gateway::dial(host.url()).await;
    let hello = gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;
    assert_eq!(
        hello["params"]["resources"][0]["subscribable"], true,
        "registering a subscriber is what declares the resource subscribable"
    );

    let acknowledgement = gateway
        .call(
            1,
            "resources/subscribe",
            json!({ "name": "cart", "subscriptionId": "sub-1" }),
        )
        .await;
    assert_eq!(acknowledgement["id"], 1);
    assert!(acknowledgement.get("error").is_none());

    let update = gateway.next_frame().await;
    assert_eq!(update["method"], "resources/updated");
    assert!(update.get("id").is_none());
    assert_eq!(update["params"]["subscriptionId"], "sub-1");
    assert_eq!(update["params"]["value"], json!({ "total": 42 }));

    let dropped = gateway
        .call(
            2,
            "resources/unsubscribe",
            json!({ "subscriptionId": "sub-1" }),
        )
        .await;
    assert_eq!(dropped["id"], 2);
    assert_eq!(torn_down.load(Ordering::Relaxed), 1);

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn subscribing_to_a_resource_that_declared_no_subscriber_is_refused() {
    let (host, _events) = started(with_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;

    let refusal = gateway
        .call(
            1,
            "resources/subscribe",
            json!({ "name": "settings", "subscriptionId": "sub-1" }),
        )
        .await;
    assert_eq!(refusal["error"]["code"], -32003);

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_dropped_transport_tears_down_every_subscription() {
    let torn_down = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&torn_down);
    let host_builder = application().resource(
        Resource::new("cart", || async { Ok(Value::Null) }).subscribe(move |_emitter| {
            let counter = Arc::clone(&counter);
            Subscription::new(move || {
                counter.fetch_add(1, Ordering::Relaxed);
            })
        }),
    );
    let (host, mut events) = started(host_builder).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;
    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Welcome(_)
    ));
    gateway
        .call(
            1,
            "resources/subscribe",
            json!({ "name": "cart", "subscriptionId": "sub-1" }),
        )
        .await;

    gateway.drop_transport().await;
    assert!(matches!(
        next_event(&mut events).await,
        HostEvent::Disconnected
    ));
    assert_eq!(
        torn_down.load(Ordering::Relaxed),
        1,
        "a subscriber still holding a listener would emit into a closed socket"
    );

    host.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn a_claim_that_lands_behind_the_welcome_still_names_the_agent() {
    let (host, _events) = started(with_context_actions()).await;
    let mut gateway = Gateway::dial(host.url()).await;
    gateway
        .answer_next(welcome("session-1", "token-1", Some("ABC-123")))
        .await;
    // Deliberately not waiting for the Welcome event first: a gateway writes
    // the claim straight behind the welcome, and the host applies the welcome
    // from a task the read loop only wakes, so both arrival orders happen.
    gateway
        .notify(
            "tesseron/claimed",
            json!({
                "agent": { "id": "claude", "name": "Claude" },
                "claimedAt": 1_756_900_000_000_i64,
                "agentCapabilities": {
                    "streaming": true,
                    "subscriptions": true,
                    "sampling": false,
                    "elicitation": true
                }
            }),
        )
        .await;

    let answer = gateway
        .call(
            1,
            "actions/invoke",
            json!({ "name": "whoami", "input": {}, "invocationId": "inv-1" }),
        )
        .await;
    assert_eq!(answer["result"]["output"]["agent"], "claude");
    assert_eq!(
        answer["result"]["output"]["sampling"], false,
        "the claim's own capability block is the one the agent agreed to"
    );

    gateway.drop_transport().await;
    host.shutdown().await.unwrap();
}
