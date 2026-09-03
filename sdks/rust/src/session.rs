use std::collections::HashMap;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde::Serialize;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::action::issues_payload;
use crate::context::{ActionContext, Cancellation};
use crate::error::{ActionError, ProtocolError, TesseronErrorCode};
use crate::host::{HostEvent, SharedHost};
use crate::jsonrpc::{self, IncomingFrame, RequestId};
use crate::protocol::{
    CancelParams, ClaimedParams, InvokeParams, InvokeResult, PROTOCOL_VERSION, ReadResourceParams,
    ReadResourceResult, WelcomeResult, methods, shares_major_version,
};

/// How long an invocation may run before the host answers `-32002` on its own.
///
/// The gateway applies the same 60-second default from its side. The host keeps
/// its own clock so a handler that never returns cannot pin an invocation open
/// after the agent has stopped waiting.
const DEFAULT_INVOCATION_TIMEOUT: Duration = Duration::from_secs(60);

/// One gateway connection, from the socket opening to the socket closing.
struct Session {
    outgoing: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    pending: Mutex<HashMap<RequestId, oneshot::Sender<Result<Value, ProtocolError>>>>,
    invocations: Mutex<HashMap<String, Cancellation>>,
    next_request_id: AtomicI64,
}

impl Session {
    fn new(outgoing: mpsc::UnboundedSender<Message>) -> Self {
        Self {
            outgoing: Mutex::new(Some(outgoing)),
            pending: Mutex::new(HashMap::new()),
            invocations: Mutex::new(HashMap::new()),
            next_request_id: AtomicI64::new(1),
        }
    }

    fn send_envelope(&self, envelope: &Value) {
        let text = envelope.to_string();
        if let Ok(outgoing) = self.outgoing.lock() {
            if let Some(sender) = outgoing.as_ref() {
                let _ = sender.send(Message::text(text));
            }
        }
    }

    /// Stops the writer task. Frames queued after this are dropped, which is
    /// what the caller wants: the socket is going away.
    fn stop_sending(&self) {
        if let Ok(mut outgoing) = self.outgoing.lock() {
            outgoing.take();
        }
    }

    fn mint_request_id(&self) -> RequestId {
        RequestId::Number(self.next_request_id.fetch_add(1, Ordering::Relaxed))
    }

    /// Sends a request and waits for the response the gateway correlates by id.
    async fn call(&self, method: &str, params: impl Serialize) -> Result<Value, ProtocolError> {
        let id = self.mint_request_id();
        let envelope = jsonrpc::request(&id, method, params).map_err(|problem| {
            ProtocolError::new(
                TesseronErrorCode::InternalError,
                format!("could not encode {method}: {problem}"),
            )
        })?;

        let (sender, receiver) = oneshot::channel();
        match self.pending.lock() {
            Ok(mut pending) => {
                pending.insert(id.clone(), sender);
            }
            Err(_) => {
                return Err(ProtocolError::new(
                    TesseronErrorCode::InternalError,
                    "session state is poisoned",
                ));
            }
        }

        self.send_envelope(&envelope);
        receiver.await.unwrap_or_else(|_| {
            Err(ProtocolError::new(
                TesseronErrorCode::TransportClosed,
                "the gateway connection closed before the response arrived",
            ))
        })
    }

    fn resolve(&self, id: &RequestId, outcome: Result<Value, ProtocolError>) {
        let waiting = self
            .pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(id));
        if let Some(sender) = waiting {
            let _ = sender.send(outcome);
        }
    }

    /// Fails every request still waiting on a response. The transport is gone,
    /// so no answer is ever coming.
    fn fail_all_pending(&self) {
        let waiting = match self.pending.lock() {
            Ok(mut pending) => pending.drain().collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for (_id, sender) in waiting {
            let _ = sender.send(Err(ProtocolError::new(
                TesseronErrorCode::TransportClosed,
                "the gateway connection closed",
            )));
        }
    }

    fn register_invocation(&self, invocation_id: &str) -> Cancellation {
        let cancellation = Cancellation::new();
        if let Ok(mut invocations) = self.invocations.lock() {
            invocations.insert(invocation_id.to_owned(), cancellation.clone());
        }
        cancellation
    }

    fn finish_invocation(&self, invocation_id: &str) {
        if let Ok(mut invocations) = self.invocations.lock() {
            invocations.remove(invocation_id);
        }
    }

    fn cancel_invocation(&self, invocation_id: &str) {
        let cancellation = self
            .invocations
            .lock()
            .ok()
            .and_then(|invocations| invocations.get(invocation_id).cloned());
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
        }
    }

    fn cancel_all_invocations(&self) {
        let running = match self.invocations.lock() {
            Ok(mut invocations) => invocations.drain().collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for (_invocation_id, cancellation) in running {
            cancellation.cancel();
        }
    }
}

/// Serves one gateway connection until the socket closes.
///
/// The handshake runs as its own task because its response arrives through the
/// same read loop that has to keep running to deliver it.
pub(crate) async fn serve_connection(socket: WebSocketStream<TcpStream>, host: Arc<SharedHost>) {
    let (sink, incoming) = socket.split();
    let (outgoing_sender, outgoing_receiver) = mpsc::unbounded_channel();
    let session = Arc::new(Session::new(outgoing_sender));

    let writer = tokio::spawn(forward_outgoing(sink, outgoing_receiver));
    let handshake = tokio::spawn(open_session(Arc::clone(&session), Arc::clone(&host)));

    read_until_closed(incoming, &session, &host).await;

    session.cancel_all_invocations();
    session.fail_all_pending();
    session.stop_sending();
    let _ = handshake.await;
    let _ = writer.await;
    host.emit(HostEvent::Disconnected);
}

async fn forward_outgoing(
    mut sink: futures_util::stream::SplitSink<WebSocketStream<TcpStream>, Message>,
    mut outgoing: mpsc::UnboundedReceiver<Message>,
) {
    while let Some(message) = outgoing.recv().await {
        if sink.send(message).await.is_err() {
            break;
        }
    }
    let _ = sink.close().await;
}

async fn read_until_closed(
    mut incoming: futures_util::stream::SplitStream<WebSocketStream<TcpStream>>,
    session: &Arc<Session>,
    host: &Arc<SharedHost>,
) {
    while let Some(message) = incoming.next().await {
        let payload = match message {
            Ok(Message::Text(text)) => text.as_str().to_owned(),
            // Binary frames are coerced and parsed anyway: relays between the
            // gateway and the host have been observed re-framing text as binary.
            Ok(Message::Binary(bytes)) => match String::from_utf8(bytes.to_vec()) {
                Ok(text) => text,
                Err(_) => continue,
            },
            Ok(Message::Close(_)) => break,
            Ok(_) => continue,
            Err(_) => break,
        };
        match serde_json::from_str::<Value>(&payload) {
            Ok(frame) => dispatch(jsonrpc::classify(frame), session, host),
            Err(problem) => {
                eprintln!("tesseron: dropping an unparsable frame: {problem}");
            }
        }
    }
}

fn dispatch(frame: IncomingFrame, session: &Arc<Session>, host: &Arc<SharedHost>) {
    match frame {
        IncomingFrame::Success { id, result } => session.resolve(&id, Ok(result)),
        IncomingFrame::Failure { id, error } => session.resolve(&id, Err(error)),
        IncomingFrame::Request { id, method, params } => {
            handle_request(id, &method, params, session, host);
        }
        IncomingFrame::Notification { method, params } => {
            handle_notification(&method, params, session, host);
        }
        IncomingFrame::Malformed(problem) => {
            eprintln!("tesseron: dropping a frame that is not JSON-RPC 2.0: {problem}");
        }
    }
}

fn handle_request(
    id: RequestId,
    method: &str,
    params: Value,
    session: &Arc<Session>,
    host: &Arc<SharedHost>,
) {
    match method {
        methods::INVOKE => start_invocation(id, params, session, host),
        methods::READ => start_resource_read(id, params, session, host),
        _ => session.send_envelope(&jsonrpc::failure(
            &id,
            &ProtocolError::new(
                TesseronErrorCode::MethodNotFound,
                format!("Method not found: {method}"),
            ),
        )),
    }
}

fn handle_notification(
    method: &str,
    params: Value,
    session: &Arc<Session>,
    host: &Arc<SharedHost>,
) {
    match method {
        methods::CANCEL => {
            if let Ok(cancel) = serde_json::from_value::<CancelParams>(params) {
                session.cancel_invocation(&cancel.invocation_id);
            }
        }
        methods::CLAIMED => {
            if let Ok(claimed) = serde_json::from_value::<ClaimedParams>(params) {
                host.record_claim(&claimed);
                host.emit(HostEvent::Claimed(claimed));
            }
        }
        _ => {}
    }
}

fn start_invocation(id: RequestId, params: Value, session: &Arc<Session>, host: &Arc<SharedHost>) {
    let invoke = match serde_json::from_value::<InvokeParams>(params) {
        Ok(invoke) => invoke,
        Err(problem) => {
            session.send_envelope(&jsonrpc::failure(
                &id,
                &ProtocolError::new(
                    TesseronErrorCode::InvalidParams,
                    format!("Invalid actions/invoke params: {problem}"),
                ),
            ));
            return;
        }
    };

    let Some(action) = host.registry.actions.get(&invoke.name).cloned() else {
        session.send_envelope(&jsonrpc::failure(
            &id,
            &ProtocolError::new(
                TesseronErrorCode::ActionNotFound,
                format!("Action not found: {}", invoke.name),
            ),
        ));
        return;
    };

    if let Some(validator) = &action.validator {
        if let Err(issues) = validator.validate(&invoke.input) {
            session.send_envelope(&jsonrpc::failure(
                &id,
                &ProtocolError::new(TesseronErrorCode::InputValidation, "Invalid input")
                    .with_data(issues_payload(&issues)),
            ));
            return;
        }
    }

    let cancellation = session.register_invocation(&invoke.invocation_id);
    let context = ActionContext::new(
        invoke.name.clone(),
        invoke.invocation_id.clone(),
        cancellation.clone(),
    );
    let timeout = action
        .descriptor
        .timeout_ms
        .map_or(DEFAULT_INVOCATION_TIMEOUT, Duration::from_millis);
    let session = Arc::clone(session);

    tokio::spawn(async move {
        let running = action.handler.invoke(invoke.input, context);
        let outcome = tokio::select! {
            biased;
            () = cancellation.cancelled() => Err(ProtocolError::new(
                TesseronErrorCode::Cancelled,
                format!("Invocation {} was cancelled", invoke.invocation_id),
            )),
            result = tokio::time::timeout(timeout, running) => match result {
                Ok(Ok(output)) => Ok(output),
                Ok(Err(failure)) => Err(wire_error(failure)),
                Err(_elapsed) => {
                    cancellation.cancel();
                    Err(ProtocolError::new(
                        TesseronErrorCode::Timeout,
                        format!("Invocation {} exceeded {} ms", invoke.invocation_id, timeout.as_millis()),
                    ))
                }
            },
        };
        session.finish_invocation(&invoke.invocation_id);
        let envelope = match outcome {
            Ok(output) => jsonrpc::success(
                &id,
                InvokeResult {
                    invocation_id: invoke.invocation_id,
                    output,
                },
            )
            .unwrap_or_else(|problem| {
                jsonrpc::failure(
                    &id,
                    &ProtocolError::new(
                        TesseronErrorCode::InternalError,
                        format!("could not encode the action output: {problem}"),
                    ),
                )
            }),
            Err(failure) => jsonrpc::failure(&id, &failure),
        };
        session.send_envelope(&envelope);
    });
}

fn start_resource_read(
    id: RequestId,
    params: Value,
    session: &Arc<Session>,
    host: &Arc<SharedHost>,
) {
    let read = match serde_json::from_value::<ReadResourceParams>(params) {
        Ok(read) => read,
        Err(problem) => {
            session.send_envelope(&jsonrpc::failure(
                &id,
                &ProtocolError::new(
                    TesseronErrorCode::InvalidParams,
                    format!("Invalid resources/read params: {problem}"),
                ),
            ));
            return;
        }
    };

    let Some(resource) = host.registry.resources.get(&read.name).cloned() else {
        session.send_envelope(&jsonrpc::failure(
            &id,
            &ProtocolError::new(
                TesseronErrorCode::ActionNotFound,
                format!("Resource not readable: {}", read.name),
            ),
        ));
        return;
    };

    let session = Arc::clone(session);
    tokio::spawn(async move {
        let envelope = match resource.reader.read().await {
            Ok(value) => {
                jsonrpc::success(&id, ReadResourceResult { value }).unwrap_or_else(|problem| {
                    jsonrpc::failure(
                        &id,
                        &ProtocolError::new(
                            TesseronErrorCode::InternalError,
                            format!("could not encode the resource value: {problem}"),
                        ),
                    )
                })
            }
            Err(failure) => jsonrpc::failure(&id, &wire_error(failure)),
        };
        session.send_envelope(&envelope);
    });
}

/// Turns a handler failure into its wire payload, reporting the cause that
/// [`ActionError::internal`] deliberately keeps off the socket.
fn wire_error(failure: ActionError) -> ProtocolError {
    if let Some(source) = failure.internal_source() {
        eprintln!("tesseron: handler failed with an internal error: {source}");
    }
    failure.into_protocol_error()
}

/// Runs `tesseron/resume` when this host already holds credentials, and
/// `tesseron/hello` otherwise.
///
/// A refused resume falls back to a fresh hello on the same socket: the
/// credentials are stale, not the connection.
async fn open_session(session: Arc<Session>, host: Arc<SharedHost>) {
    if let Some((session_id, resume_token)) = host.resume_credentials() {
        match session
            .call(
                methods::RESUME,
                host.resume_params(session_id, resume_token),
            )
            .await
        {
            Ok(result) => {
                accept_welcome(&session, &host, result);
                return;
            }
            Err(refusal) => {
                if refusal.named_code() == Some(TesseronErrorCode::ProtocolMismatch) {
                    reject_handshake(&session, &host, refusal);
                    return;
                }
                host.forget_resume_credentials();
                eprintln!("tesseron: resume refused, opening a fresh session: {refusal}");
            }
        }
    }

    match session.call(methods::HELLO, host.hello_params()).await {
        Ok(result) => accept_welcome(&session, &host, result),
        Err(refusal) => reject_handshake(&session, &host, refusal),
    }
}

/// Takes the welcome, unless the gateway answered with a protocol this host
/// cannot speak.
///
/// The gateway is the side that normally rejects a major mismatch, but a
/// welcome from a different major is just as unusable here, and continuing with
/// it would surface as mysterious method errors later.
fn accept_welcome(session: &Arc<Session>, host: &Arc<SharedHost>, result: Value) {
    let welcome = match serde_json::from_value::<WelcomeResult>(result) {
        Ok(welcome) => welcome,
        Err(problem) => {
            reject_handshake(
                session,
                host,
                ProtocolError::new(
                    TesseronErrorCode::InvalidParams,
                    format!("the gateway sent an unreadable welcome: {problem}"),
                ),
            );
            return;
        }
    };
    if !shares_major_version(&welcome.protocol_version, PROTOCOL_VERSION) {
        reject_handshake(
            session,
            host,
            ProtocolError::new(
                TesseronErrorCode::ProtocolMismatch,
                format!(
                    "the gateway speaks protocol {}; this host speaks {PROTOCOL_VERSION}",
                    welcome.protocol_version
                ),
            ),
        );
        return;
    }
    host.record_welcome(&welcome);
    host.emit(HostEvent::Welcome(welcome));
}

/// Ends the connection after a handshake the gateway refused.
///
/// A refusal is about this application, not this socket, so retrying the same
/// hello would loop. The host reports it and waits for the next dial.
fn reject_handshake(session: &Arc<Session>, host: &Arc<SharedHost>, refusal: ProtocolError) {
    if refusal.named_code() != Some(TesseronErrorCode::TransportClosed) {
        host.emit(HostEvent::HandshakeFailed(refusal));
    }
    session.stop_sending();
}
