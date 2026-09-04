use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::{SinkExt as _, StreamExt as _};
use serde::Serialize;
use serde_json::Value;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;

use crate::action::issues_payload;
use crate::context::{ActionContext, Cancellation, GatewayChannel, InvocationEnvironment};
use crate::error::{ActionError, ProtocolError, TesseronErrorCode};
use crate::host::{HostEvent, SharedHost};
use crate::jsonrpc::{self, IncomingFrame, RequestId};
use crate::protocol::{
    CancelParams, ClaimedParams, InvokeParams, InvokeResult, PROTOCOL_VERSION, ReadResourceParams,
    ReadResourceResult, SubscribeResourceParams, UnsubscribeResourceParams, WelcomeResult, methods,
    shares_major_version,
};
use crate::resource::{ResourceEmitter, Subscription};

/// How long an invocation may run before the host answers `-32002` on its own.
///
/// The gateway applies the same 60-second default from its side. The host keeps
/// its own clock so a handler that never returns cannot pin an invocation open
/// after the agent has stopped waiting.
const DEFAULT_INVOCATION_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Clone, Copy, Eq, PartialEq)]
enum HandshakeState {
    Waiting,
    Accepted,
    Rejected,
}

struct HandshakeGate {
    state: HandshakeState,
    pending_claim: Option<ClaimedParams>,
}

struct PendingRequests {
    closed: bool,
    waiting: HashMap<RequestId, oneshot::Sender<Result<Value, ProtocolError>>>,
}

/// One gateway connection, from the socket opening to the socket closing.
struct Session {
    outgoing: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    pending: Mutex<PendingRequests>,
    invocations: Mutex<HashMap<String, Cancellation>>,
    subscriptions: Mutex<HashMap<String, Subscription>>,
    next_request_id: AtomicI64,
    handshake: Mutex<HandshakeGate>,
    handshake_state: watch::Sender<HandshakeState>,
}

impl Session {
    fn new(outgoing: mpsc::UnboundedSender<Message>) -> Self {
        let (handshake_state, _receiver) = watch::channel(HandshakeState::Waiting);
        Self {
            outgoing: Mutex::new(Some(outgoing)),
            pending: Mutex::new(PendingRequests {
                closed: false,
                waiting: HashMap::new(),
            }),
            invocations: Mutex::new(HashMap::new()),
            subscriptions: Mutex::new(HashMap::new()),
            next_request_id: AtomicI64::new(1),
            handshake: Mutex::new(HandshakeGate {
                state: HandshakeState::Waiting,
                pending_claim: None,
            }),
            handshake_state,
        }
    }

    fn accept_handshake(&self, host: &SharedHost) {
        let Ok(mut gate) = self.handshake.lock() else {
            return;
        };
        gate.state = HandshakeState::Accepted;
        if let Some(claimed) = gate.pending_claim.take() {
            host.record_claim(&claimed);
            host.emit(HostEvent::Claimed(claimed));
        }
        self.handshake_state.send_replace(HandshakeState::Accepted);
    }

    fn reject_handshake(&self) {
        if let Ok(mut gate) = self.handshake.lock() {
            gate.state = HandshakeState::Rejected;
            gate.pending_claim = None;
        }
        self.handshake_state.send_replace(HandshakeState::Rejected);
    }

    fn record_claim(&self, claimed: ClaimedParams, host: &SharedHost) {
        let Ok(mut gate) = self.handshake.lock() else {
            return;
        };
        match gate.state {
            HandshakeState::Waiting => gate.pending_claim = Some(claimed),
            HandshakeState::Accepted => {
                host.record_claim(&claimed);
                host.emit(HostEvent::Claimed(claimed));
            }
            HandshakeState::Rejected => {}
        }
    }

    async fn handshake_accepted(&self) -> bool {
        let mut state = self.handshake_state.subscribe();
        loop {
            let current_state = *state.borrow_and_update();
            match current_state {
                HandshakeState::Accepted => return true,
                HandshakeState::Rejected => return false,
                HandshakeState::Waiting => {
                    if state.changed().await.is_err() {
                        return false;
                    }
                }
            }
        }
    }

    fn handshake_is_waiting(&self) -> bool {
        self.handshake
            .lock()
            .is_ok_and(|gate| gate.state == HandshakeState::Waiting)
    }

    fn handshake_is_accepted(&self) -> bool {
        self.handshake
            .lock()
            .is_ok_and(|gate| gate.state == HandshakeState::Accepted)
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
        RequestId::Number(self.next_request_id.fetch_add(1, Ordering::Relaxed).into())
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
            Ok(mut pending) if !pending.closed => {
                pending.waiting.insert(id.clone(), sender);
            }
            Ok(_) => {
                return Err(ProtocolError::new(
                    TesseronErrorCode::TransportClosed,
                    "the gateway connection closed",
                ));
            }
            Err(_) => {
                return Err(ProtocolError::new(
                    TesseronErrorCode::InternalError,
                    "session state is poisoned",
                ));
            }
        }

        let _slot = PendingRequest {
            session: self,
            id: id.clone(),
        };
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
            .and_then(|mut pending| pending.waiting.remove(id));
        if let Some(sender) = waiting {
            let _ = sender.send(outcome);
        }
    }

    /// Fails every request still waiting on a response. The transport is gone,
    /// so no answer is ever coming.
    fn fail_all_pending(&self) {
        let waiting = match self.pending.lock() {
            Ok(mut pending) => {
                pending.closed = true;
                pending.waiting.drain().collect::<Vec<_>>()
            }
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
        match self.invocations.lock() {
            Ok(mut invocations) => invocations
                .entry(invocation_id.to_owned())
                .or_insert_with(Cancellation::new)
                .clone(),
            Err(_) => Cancellation::new(),
        }
    }

    fn finish_invocation(&self, invocation_id: &str) {
        if let Ok(mut invocations) = self.invocations.lock() {
            invocations.remove(invocation_id);
        }
    }

    fn cancel_invocation(&self, invocation_id: &str) {
        let cancellation = match self.invocations.lock() {
            Ok(mut invocations) => invocations
                .entry(invocation_id.to_owned())
                .or_insert_with(Cancellation::new)
                .clone(),
            Err(_) => return,
        };
        cancellation.cancel();
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

    fn register_subscription(&self, subscription_id: &str, subscription: Subscription) {
        let replaced = match self.subscriptions.lock() {
            Ok(mut subscriptions) => subscriptions.insert(subscription_id.to_owned(), subscription),
            // A subscription nothing can ever stop is worse than no
            // subscription: tear it down instead of leaving it emitting.
            Err(_) => Some(subscription),
        };
        if let Some(replaced) = replaced {
            replaced.stop();
        }
    }

    fn drop_subscription(&self, subscription_id: &str) {
        let subscription = self
            .subscriptions
            .lock()
            .ok()
            .and_then(|mut subscriptions| subscriptions.remove(subscription_id));
        if let Some(subscription) = subscription {
            subscription.stop();
        }
    }

    /// Tears down every subscription. The agent that registered them is gone,
    /// and a subscriber still holding a listener would emit into a closed
    /// socket for as long as the application runs.
    fn drop_all_subscriptions(&self) {
        let registered = match self.subscriptions.lock() {
            Ok(mut subscriptions) => subscriptions.drain().collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        };
        for (_subscription_id, subscription) in registered {
            subscription.stop();
        }
    }
}

impl GatewayChannel for Session {
    fn notify(&self, method: &str, params: Value) {
        match jsonrpc::notification(method, params) {
            Ok(envelope) => self.send_envelope(&envelope),
            Err(problem) => {
                eprintln!("tesseron: could not encode a {method} notification: {problem}")
            }
        }
    }

    fn call<'a>(
        &'a self,
        method: &'a str,
        params: Value,
    ) -> Pin<Box<dyn Future<Output = Result<Value, ProtocolError>> + Send + 'a>> {
        Box::pin(Self::call(self, method, params))
    }
}

/// Removes a pending entry when the caller stops waiting.
///
/// A cancelled invocation drops the future that was awaiting an elicitation or
/// a sampling answer; without this the slot would sit in the map for the life
/// of the connection.
struct PendingRequest<'a> {
    session: &'a Session,
    id: RequestId,
}

impl Drop for PendingRequest<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.session.pending.lock() {
            pending.waiting.remove(&self.id);
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
    session.drop_all_subscriptions();
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
        IncomingFrame::InvalidRequest { id, problem } => {
            session.send_envelope(&jsonrpc::failure(
                &id,
                &ProtocolError::new(TesseronErrorCode::InvalidRequest, problem),
            ));
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
    if session.handshake_is_waiting() {
        let session = Arc::clone(session);
        let host = Arc::clone(host);
        let method = method.to_owned();
        tokio::spawn(async move {
            if session.handshake_accepted().await {
                handle_accepted_request(id, &method, params, &session, &host);
            }
        });
        return;
    }
    if session.handshake_is_accepted() {
        handle_accepted_request(id, method, params, session, host);
    }
}

fn handle_accepted_request(
    id: RequestId,
    method: &str,
    params: Value,
    session: &Arc<Session>,
    host: &Arc<SharedHost>,
) {
    match method {
        methods::INVOKE => start_invocation(id, params, session, host),
        methods::READ => start_resource_read(id, params, session, host),
        methods::SUBSCRIBE => subscribe_to_resource(id, params, session, host),
        methods::UNSUBSCRIBE => unsubscribe_from_resource(id, params, session),
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
                session.record_claim(claimed, host);
            }
        }
        _ => {}
    }
}

fn start_invocation(id: RequestId, params: Value, session: &Arc<Session>, host: &Arc<SharedHost>) {
    let mut invoke = match serde_json::from_value::<InvokeParams>(params) {
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
    let route = invoke.client.take().and_then(|client| client.route);
    let timeout = action
        .descriptor
        .timeout_ms
        .map_or(DEFAULT_INVOCATION_TIMEOUT, Duration::from_millis);
    let session = Arc::clone(session);
    let host = Arc::clone(host);

    tokio::spawn(async move {
        if !session.handshake_accepted().await {
            session.finish_invocation(&invoke.invocation_id);
            return;
        }
        let context = ActionContext::new(InvocationEnvironment {
            action_name: invoke.name.clone(),
            invocation_id: invoke.invocation_id.clone(),
            cancellation: cancellation.clone(),
            channel: Arc::clone(&session) as Arc<dyn GatewayChannel>,
            agent_capabilities: host.negotiated_capabilities(),
            agent: host.agent_identity(),
            origin: host.origin().to_owned(),
            route,
        });
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

/// Registers a subscriber for one resource.
///
/// The acknowledgement goes out before the subscriber runs, so a value the
/// subscriber emits immediately cannot overtake the response the agent is still
/// waiting on. Both halves happen inside the read loop, so an unsubscribe that
/// follows straight after always finds the subscription to tear down.
fn subscribe_to_resource(
    id: RequestId,
    params: Value,
    session: &Arc<Session>,
    host: &Arc<SharedHost>,
) {
    let subscribe = match serde_json::from_value::<SubscribeResourceParams>(params) {
        Ok(subscribe) => subscribe,
        Err(problem) => {
            session.send_envelope(&jsonrpc::failure(
                &id,
                &ProtocolError::new(
                    TesseronErrorCode::InvalidParams,
                    format!("Invalid resources/subscribe params: {problem}"),
                ),
            ));
            return;
        }
    };

    let subscriber = host
        .registry
        .resources
        .get(&subscribe.name)
        .and_then(|resource| resource.subscriber.clone());
    let Some(subscriber) = subscriber else {
        session.send_envelope(&jsonrpc::failure(
            &id,
            &ProtocolError::new(
                TesseronErrorCode::ActionNotFound,
                format!("Resource not subscribable: {}", subscribe.name),
            ),
        ));
        return;
    };

    session.send_envelope(&acknowledgement(&id));
    let emitter = ResourceEmitter::new(
        Arc::clone(session) as Arc<dyn GatewayChannel>,
        subscribe.subscription_id.clone(),
    );
    let subscription = subscriber
        .subscribe(emitter.clone())
        .gate_emitter(emitter.active_flag());
    session.register_subscription(&subscribe.subscription_id, subscription);
}

/// Drops a subscription. An id nobody registered is not an error: the agent and
/// the transport can race, and there is nothing left to tear down either way.
fn unsubscribe_from_resource(id: RequestId, params: Value, session: &Arc<Session>) {
    let unsubscribe = match serde_json::from_value::<UnsubscribeResourceParams>(params) {
        Ok(unsubscribe) => unsubscribe,
        Err(problem) => {
            session.send_envelope(&jsonrpc::failure(
                &id,
                &ProtocolError::new(
                    TesseronErrorCode::InvalidParams,
                    format!("Invalid resources/unsubscribe params: {problem}"),
                ),
            ));
            return;
        }
    };
    session.drop_subscription(&unsubscribe.subscription_id);
    session.send_envelope(&acknowledgement(&id));
}

/// The empty success both subscription methods answer with.
fn acknowledgement(id: &RequestId) -> Value {
    jsonrpc::success(id, Value::Null).unwrap_or_else(|_| {
        jsonrpc::failure(
            id,
            &ProtocolError::new(
                TesseronErrorCode::InternalError,
                "could not encode the acknowledgement",
            ),
        )
    })
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
    if run_handshake(&session, &host).await {
        session.accept_handshake(&host);
    }
}

async fn run_handshake(session: &Arc<Session>, host: &Arc<SharedHost>) -> bool {
    if let Some((session_id, resume_token)) = host.resume_credentials() {
        match session
            .call(
                methods::RESUME,
                host.resume_params(session_id, resume_token),
            )
            .await
        {
            Ok(result) => return accept_welcome(session, host, result),
            Err(refusal) => {
                if refusal.named_code() == Some(TesseronErrorCode::ProtocolMismatch) {
                    reject_handshake(session, host, refusal);
                    return false;
                }
                host.reset_session_state();
                eprintln!("tesseron: resume refused, opening a fresh session: {refusal}");
            }
        }
    }

    match session.call(methods::HELLO, host.hello_params()).await {
        Ok(result) => accept_welcome(session, host, result),
        Err(refusal) => {
            reject_handshake(session, host, refusal);
            false
        }
    }
}

/// Takes the welcome, unless the gateway answered with a protocol this host
/// cannot speak.
///
/// The gateway is the side that normally rejects a major mismatch, but a
/// welcome from a different major is just as unusable here, and continuing with
/// it would surface as mysterious method errors later.
fn accept_welcome(session: &Arc<Session>, host: &Arc<SharedHost>, result: Value) -> bool {
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
            return false;
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
        return false;
    }
    host.record_welcome(&welcome);
    host.emit(HostEvent::Welcome(welcome));
    true
}

/// Ends the connection after a handshake the gateway refused.
///
/// A refusal is about this application, not this socket, so retrying the same
/// hello would loop. The host reports it and waits for the next dial.
fn reject_handshake(session: &Arc<Session>, host: &Arc<SharedHost>, refusal: ProtocolError) {
    session.reject_handshake();
    if refusal.named_code() != Some(TesseronErrorCode::TransportClosed) {
        host.emit(HostEvent::HandshakeFailed(refusal));
    }
    session.stop_sending();
}
