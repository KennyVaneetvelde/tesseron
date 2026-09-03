use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};
use tokio::sync::watch;

use crate::action::json_schema_for;
use crate::elicit_schema;
use crate::error::{ActionError, ProtocolError, TesseronErrorCode};
use crate::protocol::{
    ActionProgressParams, AgentIdentity, Capabilities, ElicitationAction, ElicitationRequestParams,
    ElicitationResult, LogLevel, LogParams, SamplingRequestParams, SamplingResult, methods,
};

/// A response the host is still waiting on.
type PendingResponse<'a> = Pin<Box<dyn Future<Output = Result<Value, ProtocolError>> + Send + 'a>>;

/// The connection a running handler talks back through.
///
/// The session implements this. Keeping it a trait is what lets the context
/// live in this module without reaching into the session's private state, and
/// what lets a detached context answer honestly instead of panicking.
pub(crate) trait GatewayChannel: Send + Sync {
    fn notify(&self, method: &str, params: Value);
    fn call<'a>(&'a self, method: &'a str, params: Value) -> PendingResponse<'a>;
}

/// The channel a context gets when there is no live connection behind it.
///
/// Notifications go nowhere, which is what a fire-and-forget frame does on a
/// closed socket anyway, and every request answers `-32010` rather than hanging.
#[cfg(test)]
pub(crate) struct DetachedChannel;

#[cfg(test)]
impl GatewayChannel for DetachedChannel {
    fn notify(&self, _method: &str, _params: Value) {}

    fn call<'a>(&'a self, _method: &'a str, _params: Value) -> PendingResponse<'a> {
        Box::pin(async {
            Err(ProtocolError::new(
                TesseronErrorCode::TransportClosed,
                "this invocation has no gateway connection",
            ))
        })
    }
}

/// A cancellation signal shared between the session and one running handler.
///
/// The gateway cancels with a notification rather than a request, so nothing
/// answers `actions/cancel`; the invocation it names answers `-32001` instead.
/// A handler that ignores this signal still gets its answer replaced, but it
/// keeps burning the thread it was given, so long handlers should await
/// [`Cancellation::cancelled`] alongside their own work.
#[derive(Clone, Debug)]
pub struct Cancellation {
    state: Arc<watch::Sender<bool>>,
}

impl Cancellation {
    pub(crate) fn new() -> Self {
        let (sender, _receiver) = watch::channel(false);
        Self {
            state: Arc::new(sender),
        }
    }

    /// Records the cancellation.
    ///
    /// `send_replace` rather than `send`: `send` reports "no receivers" as an
    /// error and leaves the value alone, so a handler that never awaits
    /// [`Cancellation::cancelled`] would keep reading `false` forever.
    pub(crate) fn cancel(&self) {
        self.state.send_replace(true);
    }

    /// Whether cancellation has already been requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        *self.state.borrow()
    }

    /// Resolves as soon as cancellation is requested, immediately if it already
    /// was.
    pub async fn cancelled(&self) {
        let mut receiver = self.state.subscribe();
        while !*receiver.borrow_and_update() {
            if receiver.changed().await.is_err() {
                return;
            }
        }
    }
}

/// One streaming update from a running handler.
///
/// Every field is optional; send whichever the handler actually knows.
#[derive(Clone, Debug, Default)]
pub struct ProgressUpdate {
    message: Option<String>,
    percent: Option<f64>,
    data: Option<Value>,
}

impl ProgressUpdate {
    /// An update carrying nothing yet.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the status line the agent shows the user.
    #[must_use]
    pub fn message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    /// Sets completion, 0 to 100. Values outside that range are clamped, and a
    /// value below one already sent is raised to it: see
    /// [`ActionContext::progress`].
    #[must_use]
    pub const fn percent(mut self, percent: f64) -> Self {
        self.percent = Some(percent);
        self
    }

    /// Attaches free-form structured detail for agents that render it.
    #[must_use]
    pub fn data(mut self, data: Value) -> Self {
        self.data = Some(data);
        self
    }
}

/// What to ask the agent's model for.
#[derive(Clone, Debug)]
pub struct SampleRequest {
    prompt: String,
    json_schema: Option<Value>,
    max_tokens: Option<u32>,
}

impl SampleRequest {
    /// Asks the model to answer `prompt`.
    #[must_use]
    pub fn new(prompt: impl Into<String>) -> Self {
        Self {
            prompt: prompt.into(),
            json_schema: None,
            max_tokens: None,
        }
    }

    /// Sends a JSON Schema the agent can use to constrain the model's output.
    #[must_use]
    pub fn json_schema(mut self, schema: Value) -> Self {
        self.json_schema = Some(schema);
        self
    }

    /// Derives the output schema from the type the handler will decode into.
    #[must_use]
    pub fn for_type<Output: JsonSchema>(prompt: impl Into<String>) -> Self {
        Self::new(prompt).json_schema(json_schema_for::<Output>())
    }

    /// Caps how many tokens the sampling call may consume.
    #[must_use]
    pub const fn max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = Some(max_tokens);
        self
    }
}

/// What to ask the user for.
#[derive(Clone, Debug)]
pub struct ElicitRequest {
    question: String,
    json_schema: Option<Value>,
}

impl ElicitRequest {
    /// Asks `question` with the permissive single-text-field schema.
    #[must_use]
    pub fn new(question: impl Into<String>) -> Self {
        Self {
            question: question.into(),
            json_schema: None,
        }
    }

    /// Sends a JSON Schema the agent renders as a form. It must satisfy the
    /// elicitation rules in the specification, or
    /// [`ActionContext::elicit`] answers `-32602` without sending anything.
    #[must_use]
    pub fn json_schema(mut self, schema: Value) -> Self {
        self.json_schema = Some(schema);
        self
    }

    /// Derives the form schema from the type the answer will decode into.
    #[must_use]
    pub fn for_type<Answer: JsonSchema>(question: impl Into<String>) -> Self {
        Self::new(question).json_schema(json_schema_for::<Answer>())
    }
}

/// One structured log line, forwarded to the agent's MCP logging.
#[derive(Clone, Debug)]
pub struct LogEntry {
    level: LogLevel,
    message: String,
    meta: Option<Map<String, Value>>,
}

impl LogEntry {
    /// Detail only useful while debugging the application.
    #[must_use]
    pub fn debug(message: impl Into<String>) -> Self {
        Self::new(LogLevel::Debug, message)
    }

    /// Ordinary progress worth recording.
    #[must_use]
    pub fn info(message: impl Into<String>) -> Self {
        Self::new(LogLevel::Info, message)
    }

    /// Something unexpected that did not stop the invocation.
    #[must_use]
    pub fn warn(message: impl Into<String>) -> Self {
        Self::new(LogLevel::Warn, message)
    }

    /// A failure the user or the agent should know about.
    #[must_use]
    pub fn error(message: impl Into<String>) -> Self {
        Self::new(LogLevel::Error, message)
    }

    /// A line at an explicit level.
    #[must_use]
    pub fn new(level: LogLevel, message: impl Into<String>) -> Self {
        Self {
            level,
            message: message.into(),
            meta: None,
        }
    }

    /// Attaches structured metadata to the line.
    #[must_use]
    pub fn meta(mut self, meta: Map<String, Value>) -> Self {
        self.meta = Some(meta);
        self
    }
}

/// Everything one invocation needs, assembled by the session.
pub(crate) struct InvocationEnvironment {
    pub action_name: String,
    pub invocation_id: String,
    pub cancellation: Cancellation,
    pub channel: Arc<dyn GatewayChannel>,
    pub agent_capabilities: Capabilities,
    pub agent: AgentIdentity,
    pub origin: String,
    pub route: Option<String>,
}

/// What a handler is told about the invocation it is running, and everything it
/// can send back while it runs.
///
/// The context is cheap to clone and every clone talks to the same invocation,
/// including the shared progress ceiling, so a handler can hand one to a helper
/// task without losing monotonicity.
#[derive(Clone)]
pub struct ActionContext {
    action_name: String,
    invocation_id: String,
    cancellation: Cancellation,
    channel: Arc<dyn GatewayChannel>,
    agent_capabilities: Capabilities,
    agent: AgentIdentity,
    origin: String,
    route: Option<String>,
    highest_percent: Arc<Mutex<Option<f64>>>,
}

impl ActionContext {
    pub(crate) fn new(environment: InvocationEnvironment) -> Self {
        Self {
            action_name: environment.action_name,
            invocation_id: environment.invocation_id,
            cancellation: environment.cancellation,
            channel: environment.channel,
            agent_capabilities: environment.agent_capabilities,
            agent: environment.agent,
            origin: environment.origin,
            route: environment.route,
            highest_percent: Arc::new(Mutex::new(None)),
        }
    }

    /// A context with no connection behind it, for exercising a handler
    /// directly from a test.
    #[cfg(test)]
    pub(crate) fn detached(action_name: &str, invocation_id: &str) -> Self {
        Self::new(InvocationEnvironment {
            action_name: action_name.to_owned(),
            invocation_id: invocation_id.to_owned(),
            cancellation: Cancellation::new(),
            channel: Arc::new(DetachedChannel),
            agent_capabilities: Capabilities::none(),
            agent: AgentIdentity {
                id: "unknown".to_owned(),
                name: "unknown".to_owned(),
            },
            origin: "unknown".to_owned(),
            route: None,
        })
    }

    /// The action being run.
    #[must_use]
    pub fn action_name(&self) -> &str {
        &self.action_name
    }

    /// The gateway's id for this invocation. Correlates progress, cancellation,
    /// and logs with the request the agent is waiting on.
    #[must_use]
    pub fn invocation_id(&self) -> &str {
        &self.invocation_id
    }

    /// The signal that fires when the agent cancels this invocation.
    #[must_use]
    pub const fn cancellation(&self) -> &Cancellation {
        &self.cancellation
    }

    /// Shorthand for [`Cancellation::is_cancelled`] on this invocation.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.cancellation.is_cancelled()
    }

    /// What the agent on the other end negotiated. Check this before
    /// [`ActionContext::sample`] or [`ActionContext::elicit`] when the handler
    /// has a useful non-interactive fallback.
    #[must_use]
    pub const fn agent_capabilities(&self) -> Capabilities {
        self.agent_capabilities
    }

    /// Who is invoking. `pending` until the session is claimed.
    #[must_use]
    pub const fn agent(&self) -> &AgentIdentity {
        &self.agent
    }

    /// The origin the session was established from.
    #[must_use]
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Where in the application the agent was, when the gateway said.
    #[must_use]
    pub fn route(&self) -> Option<&str> {
        self.route.as_deref()
    }

    /// Streams one progress update to the agent.
    ///
    /// Percent is clamped into 0 to 100 and never allowed to fall below a value
    /// already sent for this invocation: an agent rendering a progress bar
    /// treats a backwards jump as a restart, and the message and data are worth
    /// more than the regression. Fire-and-forget, like every notification.
    pub fn progress(&self, update: ProgressUpdate) {
        let percent = update.percent.map(|percent| self.raise_ceiling(percent));
        self.channel.notify(
            methods::PROGRESS,
            to_params(ActionProgressParams {
                invocation_id: self.invocation_id.clone(),
                message: update.message,
                percent,
                data: update.data,
            }),
        );
    }

    /// Asks the agent's model to answer `request.prompt`.
    ///
    /// Sampling depth is not a field in any Tesseron frame: the gateway owns
    /// `maxSamplingDepth` and answers `-32008` itself, so the host forwards the
    /// request without counting.
    ///
    /// # Errors
    ///
    /// `-32006 SamplingNotAvailable` when the agent did not negotiate sampling,
    /// and whatever the gateway answered otherwise.
    pub async fn sample(&self, request: SampleRequest) -> Result<Value, ActionError> {
        if !self.agent_capabilities.sampling {
            return Err(ActionError::protocol(
                TesseronErrorCode::SamplingNotAvailable,
                "the connected agent did not negotiate sampling",
                None,
            ));
        }
        let answer = self
            .channel
            .call(
                methods::SAMPLE,
                to_params(SamplingRequestParams {
                    invocation_id: self.invocation_id.clone(),
                    prompt: request.prompt,
                    schema: request.json_schema,
                    max_tokens: request.max_tokens,
                }),
            )
            .await
            .map_err(from_protocol_error)?;
        let result: SamplingResult = serde_json::from_value(answer).map_err(|problem| {
            ActionError::protocol(
                TesseronErrorCode::HandlerError,
                format!("the gateway sent an unreadable sampling result: {problem}"),
                None,
            )
        })?;
        Ok(result.content)
    }

    /// [`ActionContext::sample`], decoded into the type the handler wants.
    ///
    /// A model asked for structured output answers with the JSON as text, so a
    /// string result is parsed before it is decoded.
    ///
    /// # Errors
    ///
    /// Everything [`ActionContext::sample`] returns, plus `-32005 HandlerError`
    /// when the answer does not decode.
    pub async fn sample_as<Output: DeserializeOwned>(
        &self,
        request: SampleRequest,
    ) -> Result<Output, ActionError> {
        let content = self.sample(request).await?;
        let decoded = match &content {
            Value::String(text) => serde_json::from_str(text).map_err(|problem| {
                ActionError::protocol(
                    TesseronErrorCode::HandlerError,
                    format!("the sampling result was not valid JSON: {problem}"),
                    Some(serde_json::json!({ "raw": text })),
                )
            })?,
            other => other.clone(),
        };
        serde_json::from_value(decoded).map_err(|problem| {
            ActionError::protocol(
                TesseronErrorCode::HandlerError,
                format!("the sampling result did not match the expected shape: {problem}"),
                None,
            )
        })
    }

    /// Asks the user a yes-or-no question through the agent.
    ///
    /// `true` only on an explicit accept. A decline, a cancel, and an agent that
    /// never negotiated elicitation all answer `false`, which is the safe
    /// reading for the destructive-operation gates this exists for.
    ///
    /// # Errors
    ///
    /// Whatever the gateway answered when the prompt itself failed. The user's
    /// answer is never an error.
    pub async fn confirm(&self, question: impl Into<String>) -> Result<bool, ActionError> {
        if !self.agent_capabilities.elicitation {
            return Ok(false);
        }
        let result = self
            .request_elicitation(question.into(), elicit_schema::confirmation_schema())
            .await?;
        Ok(result.action == ElicitationAction::Accept)
    }

    /// Asks the user for structured content through the agent.
    ///
    /// `None` on a decline or a cancel. Unlike [`ActionContext::confirm`] a
    /// missing capability is an error, because structured content has no safe
    /// default and the handler has to branch on it explicitly.
    ///
    /// # Errors
    ///
    /// `-32007 ElicitationNotAvailable` when the agent did not negotiate
    /// elicitation, `-32602 InvalidParams` when the schema is not one MCP can
    /// render, and whatever the gateway answered otherwise.
    pub async fn elicit(&self, request: ElicitRequest) -> Result<Option<Value>, ActionError> {
        if !self.agent_capabilities.elicitation {
            return Err(ActionError::protocol(
                TesseronErrorCode::ElicitationNotAvailable,
                "the connected agent did not negotiate elicitation",
                None,
            ));
        }
        let schema = request
            .json_schema
            .unwrap_or_else(elicit_schema::permissive_schema);
        elicit_schema::validate(&schema)?;
        let result = self.request_elicitation(request.question, schema).await?;
        if result.action == ElicitationAction::Accept {
            Ok(Some(result.value))
        } else {
            Ok(None)
        }
    }

    /// [`ActionContext::elicit`], decoded into the type the handler wants.
    ///
    /// # Errors
    ///
    /// Everything [`ActionContext::elicit`] returns, plus `-32005 HandlerError`
    /// when the accepted answer does not decode.
    pub async fn elicit_as<Answer: DeserializeOwned>(
        &self,
        request: ElicitRequest,
    ) -> Result<Option<Answer>, ActionError> {
        let Some(value) = self.elicit(request).await? else {
            return Ok(None);
        };
        serde_json::from_value(value).map(Some).map_err(|problem| {
            ActionError::protocol(
                TesseronErrorCode::HandlerError,
                format!("the elicited answer did not match the expected shape: {problem}"),
                None,
            )
        })
    }

    /// Forwards one log line to the agent. Fire-and-forget.
    pub fn log(&self, entry: LogEntry) {
        self.channel.notify(
            methods::LOG,
            to_params(LogParams {
                invocation_id: self.invocation_id.clone(),
                level: entry.level,
                message: entry.message,
                meta: entry.meta,
            }),
        );
    }

    async fn request_elicitation(
        &self,
        question: String,
        schema: Value,
    ) -> Result<ElicitationResult, ActionError> {
        let answer = self
            .channel
            .call(
                methods::ELICIT,
                to_params(ElicitationRequestParams {
                    invocation_id: self.invocation_id.clone(),
                    question,
                    schema,
                }),
            )
            .await
            .map_err(from_protocol_error)?;
        serde_json::from_value(answer).map_err(|problem| {
            ActionError::protocol(
                TesseronErrorCode::HandlerError,
                format!("the gateway sent an unreadable elicitation result: {problem}"),
                None,
            )
        })
    }

    /// Returns the percent this update may report, and remembers it.
    fn raise_ceiling(&self, requested: f64) -> f64 {
        let bounded = requested.clamp(0.0, 100.0);
        let Ok(mut highest) = self.highest_percent.lock() else {
            return bounded;
        };
        let allowed = match *highest {
            Some(previous) if previous > bounded => previous,
            _ => bounded,
        };
        *highest = Some(allowed);
        allowed
    }
}

impl fmt::Debug for ActionContext {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActionContext")
            .field("action_name", &self.action_name)
            .field("invocation_id", &self.invocation_id)
            .field("agent_capabilities", &self.agent_capabilities)
            .finish_non_exhaustive()
    }
}

/// Encodes params that are plain data, so a serialisation failure is a bug in
/// this crate rather than something a caller can trigger.
fn to_params(params: impl serde::Serialize) -> Value {
    serde_json::to_value(params).unwrap_or(Value::Null)
}

fn from_protocol_error(error: ProtocolError) -> ActionError {
    let code = error
        .named_code()
        .unwrap_or(TesseronErrorCode::InternalError);
    ActionError::protocol(code, error.message, error.data)
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex as StdMutex;

    use super::*;

    #[tokio::test]
    async fn cancelled_resolves_for_a_signal_that_already_fired() {
        let cancellation = Cancellation::new();
        cancellation.cancel();
        assert!(cancellation.is_cancelled());
        cancellation.cancelled().await;
    }

    #[tokio::test]
    async fn cancelled_wakes_a_waiter_registered_before_the_signal() {
        let cancellation = Cancellation::new();
        let waiter = cancellation.clone();
        let task = tokio::spawn(async move { waiter.cancelled().await });
        tokio::task::yield_now().await;
        cancellation.cancel();
        task.await.unwrap();
    }

    /// Records what a handler sent and answers requests with a canned result.
    struct RecordingChannel {
        sent: StdMutex<Vec<(String, Value)>>,
        answer: Value,
    }

    impl RecordingChannel {
        fn new(answer: Value) -> Arc<Self> {
            Arc::new(Self {
                sent: StdMutex::new(Vec::new()),
                answer,
            })
        }

        fn frames(&self) -> Vec<(String, Value)> {
            self.sent.lock().unwrap().clone()
        }
    }

    impl GatewayChannel for RecordingChannel {
        fn notify(&self, method: &str, params: Value) {
            self.sent.lock().unwrap().push((method.to_owned(), params));
        }

        fn call<'a>(&'a self, method: &'a str, params: Value) -> PendingResponse<'a> {
            self.sent.lock().unwrap().push((method.to_owned(), params));
            let answer = self.answer.clone();
            Box::pin(async move { Ok(answer) })
        }
    }

    fn context_with(channel: Arc<dyn GatewayChannel>, capabilities: Capabilities) -> ActionContext {
        ActionContext::new(InvocationEnvironment {
            action_name: "act".to_owned(),
            invocation_id: "i-1".to_owned(),
            cancellation: Cancellation::new(),
            channel,
            agent_capabilities: capabilities,
            agent: AgentIdentity {
                id: "agent".to_owned(),
                name: "Agent".to_owned(),
            },
            origin: "tesseron-test://rust".to_owned(),
            route: None,
        })
    }

    #[tokio::test]
    async fn progress_percent_never_goes_backwards_or_out_of_range() {
        let channel = RecordingChannel::new(Value::Null);
        let context = context_with(
            Arc::clone(&channel) as Arc<dyn GatewayChannel>,
            Capabilities::implemented(),
        );

        context.progress(ProgressUpdate::new().percent(55.0));
        context.progress(ProgressUpdate::new().percent(10.0).message("regressed"));
        context.progress(ProgressUpdate::new().percent(140.0));
        context.progress(ProgressUpdate::new().message("no percent at all"));

        let frames = channel.frames();
        assert_eq!(frames.len(), 4);
        assert!(frames.iter().all(|(method, _)| method == methods::PROGRESS));
        assert_eq!(frames[0].1["percent"], 55.0);
        assert_eq!(
            frames[1].1["percent"], 55.0,
            "a regression is raised to the ceiling, and the message survives"
        );
        assert_eq!(frames[1].1["message"], "regressed");
        assert_eq!(frames[2].1["percent"], 100.0);
        assert!(frames[3].1.get("percent").is_none());
    }

    #[tokio::test]
    async fn confirm_reads_only_an_explicit_accept_as_yes() {
        for (answer, expected) in [
            (serde_json::json!({ "action": "accept" }), true),
            (serde_json::json!({ "action": "decline" }), false),
            (serde_json::json!({ "action": "cancel" }), false),
        ] {
            let channel = RecordingChannel::new(answer);
            let context = context_with(
                Arc::clone(&channel) as Arc<dyn GatewayChannel>,
                Capabilities::implemented(),
            );
            assert_eq!(context.confirm("Delete it?").await.unwrap(), expected);
            let frames = channel.frames();
            assert_eq!(frames[0].0, methods::ELICIT);
            assert_eq!(frames[0].1["question"], "Delete it?");
            assert_eq!(frames[0].1["schema"]["type"], "object");
        }
    }

    #[tokio::test]
    async fn confirm_without_the_capability_answers_no_without_asking() {
        let channel = RecordingChannel::new(Value::Null);
        let context = context_with(
            Arc::clone(&channel) as Arc<dyn GatewayChannel>,
            Capabilities::none(),
        );
        assert!(!context.confirm("Delete it?").await.unwrap());
        assert!(channel.frames().is_empty());
    }

    #[tokio::test]
    async fn elicit_without_the_capability_is_an_error_the_handler_has_to_branch_on() {
        let channel = RecordingChannel::new(Value::Null);
        let context = context_with(
            Arc::clone(&channel) as Arc<dyn GatewayChannel>,
            Capabilities::none(),
        );
        let error = context
            .elicit(ElicitRequest::new("Which one?"))
            .await
            .expect_err("structured content has no safe default");
        assert_eq!(error.code(), TesseronErrorCode::ElicitationNotAvailable);
        assert!(channel.frames().is_empty());
    }

    #[tokio::test]
    async fn a_rejected_elicit_schema_never_reaches_the_wire() {
        let channel = RecordingChannel::new(Value::Null);
        let context = context_with(
            Arc::clone(&channel) as Arc<dyn GatewayChannel>,
            Capabilities::implemented(),
        );
        let error = context
            .elicit(
                ElicitRequest::new("Which one?")
                    .json_schema(serde_json::json!({ "type": "object", "not": {} })),
            )
            .await
            .expect_err("a top-level not is not renderable");
        assert_eq!(error.code(), TesseronErrorCode::InvalidParams);
        assert!(channel.frames().is_empty());
    }

    #[tokio::test]
    async fn elicit_passes_its_schema_through_unchanged_and_decodes_the_answer() {
        let channel = RecordingChannel::new(serde_json::json!({
            "action": "accept",
            "value": { "warehouse": "WH-7" }
        }));
        let context = context_with(
            Arc::clone(&channel) as Arc<dyn GatewayChannel>,
            Capabilities::implemented(),
        );
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "warehouse": { "minLength": 1 } }
        });
        let answer: Option<Map<String, Value>> = context
            .elicit_as(ElicitRequest::new("Which warehouse?").json_schema(schema.clone()))
            .await
            .unwrap();
        assert_eq!(answer.unwrap()["warehouse"], "WH-7");
        assert_eq!(channel.frames()[0].1["schema"], schema);
    }

    #[tokio::test]
    async fn a_declined_elicit_is_absence_rather_than_failure() {
        let channel = RecordingChannel::new(serde_json::json!({ "action": "decline" }));
        let context = context_with(
            channel as Arc<dyn GatewayChannel>,
            Capabilities::implemented(),
        );
        assert!(
            context
                .elicit(ElicitRequest::new("Which one?"))
                .await
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn sampling_needs_the_capability_and_unwraps_the_content() {
        let refused = RecordingChannel::new(Value::Null);
        let context = context_with(
            Arc::clone(&refused) as Arc<dyn GatewayChannel>,
            Capabilities::none(),
        );
        let error = context
            .sample(SampleRequest::new("Summarise this"))
            .await
            .expect_err("the agent never negotiated sampling");
        assert_eq!(error.code(), TesseronErrorCode::SamplingNotAvailable);
        assert!(refused.frames().is_empty());

        let channel = RecordingChannel::new(serde_json::json!({ "content": "{\"score\":3}" }));
        let context = context_with(
            Arc::clone(&channel) as Arc<dyn GatewayChannel>,
            Capabilities::implemented(),
        );
        let decoded: Map<String, Value> = context
            .sample_as(SampleRequest::new("Score this").max_tokens(80))
            .await
            .unwrap();
        assert_eq!(decoded["score"], 3);
        assert_eq!(channel.frames()[0].1["maxTokens"], 80);
    }

    #[tokio::test]
    async fn a_log_entry_carries_its_level_and_invocation() {
        let channel = RecordingChannel::new(Value::Null);
        let context = context_with(
            Arc::clone(&channel) as Arc<dyn GatewayChannel>,
            Capabilities::implemented(),
        );
        context.log(LogEntry::warn("close to the limit"));
        let frames = channel.frames();
        assert_eq!(frames[0].0, methods::LOG);
        assert_eq!(frames[0].1["level"], "warn");
        assert_eq!(frames[0].1["message"], "close to the limit");
        assert_eq!(frames[0].1["invocationId"], "i-1");
    }

    #[tokio::test]
    async fn a_detached_context_answers_closed_instead_of_hanging() {
        let context = ActionContext::detached("act", "i-1");
        context.progress(ProgressUpdate::new().percent(10.0));
        assert!(!context.confirm("Anyone there?").await.unwrap());
    }
}
