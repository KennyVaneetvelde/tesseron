use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio::task::JoinHandle;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
use tokio_tungstenite::tungstenite::http::header::SEC_WEBSOCKET_PROTOCOL;
use tokio_tungstenite::tungstenite::http::{HeaderValue, StatusCode};

use crate::action::{Action, ActionHandler, InputValidator};
use crate::error::{HostError, ProtocolError};
use crate::manifest::{self, InstanceManifest, ManifestPublication};
use crate::protocol::{
    ActionDescriptor, AgentIdentity, ApplicationDescriptor, Capabilities, ClaimedParams,
    GATEWAY_SUBPROTOCOL, HelloParams, PROTOCOL_VERSION, ResourceDescriptor, ResumeParams,
    WelcomeResult, is_valid_application_id,
};
use crate::resource::{Resource, ResourceReader, ResourceSubscriber};
use crate::session;

/// How many events the host buffers for each subscriber before the slowest one
/// starts missing them.
const EVENT_BUFFER: usize = 32;

/// What the origin field says when the application does not set one.
///
/// A native host has no browser origin, and the gateway overwrites the field
/// with what it observed on the upgrade anyway, so declaring anything more
/// specific would only be a guess.
const UNKNOWN_ORIGIN: &str = "unknown";

/// Pause after a failed `accept` before trying again.
const ACCEPT_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

/// Something the gateway did that the application may want to react to.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum HostEvent {
    /// The handshake succeeded. On a fresh session the welcome carries the
    /// claim code to show the user; on a resumed one it does not, because the
    /// session is already paired.
    Welcome(WelcomeResult),
    /// The user redeemed the claim code. Stop displaying it.
    Claimed(ClaimedParams),
    /// The gateway refused the handshake. A protocol major mismatch lands here.
    HandshakeFailed(ProtocolError),
    /// The gateway connection ended. The host keeps listening, and the gateway
    /// dials again when it is ready.
    Disconnected,
}

#[derive(Clone)]
pub(crate) struct RegisteredAction {
    pub descriptor: ActionDescriptor,
    pub validator: Option<Arc<dyn InputValidator>>,
    pub handler: ActionHandler,
}

#[derive(Clone)]
pub(crate) struct RegisteredResource {
    pub descriptor: ResourceDescriptor,
    pub reader: ResourceReader,
    pub subscriber: Option<ResourceSubscriber>,
}

pub(crate) struct Registry {
    pub actions: HashMap<String, RegisteredAction>,
    pub resources: HashMap<String, RegisteredResource>,
    action_order: Vec<String>,
    resource_order: Vec<String>,
}

impl Registry {
    /// Manifest entries keep registration order so the agent sees a stable list
    /// across restarts rather than whatever order the hash map iterates in.
    fn action_descriptors(&self) -> Vec<ActionDescriptor> {
        self.action_order
            .iter()
            .filter_map(|name| self.actions.get(name))
            .map(|action| action.descriptor.clone())
            .collect()
    }

    fn resource_descriptors(&self) -> Vec<ResourceDescriptor> {
        self.resource_order
            .iter()
            .filter_map(|name| self.resources.get(name))
            .map(|resource| resource.descriptor.clone())
            .collect()
    }
}

/// State every connection shares: what to announce, what to dispatch to, and
/// what the last welcome established.
pub(crate) struct SharedHost {
    application: ApplicationDescriptor,
    capabilities: Capabilities,
    pub registry: Registry,
    events: broadcast::Sender<HostEvent>,
    welcome: Mutex<Option<WelcomeResult>>,
    claim: Mutex<Option<ClaimedParams>>,
    resume: Mutex<Option<(String, String)>>,
}

impl SharedHost {
    pub(crate) fn emit(&self, event: HostEvent) {
        let _ = self.events.send(event);
    }

    pub(crate) fn hello_params(&self) -> HelloParams {
        HelloParams {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            app: self.application.clone(),
            actions: self.registry.action_descriptors(),
            resources: self.registry.resource_descriptors(),
            capabilities: self.capabilities,
        }
    }

    pub(crate) fn resume_params(&self, session_id: String, resume_token: String) -> ResumeParams {
        ResumeParams {
            protocol_version: PROTOCOL_VERSION.to_owned(),
            session_id,
            resume_token,
            app: self.application.clone(),
            actions: self.registry.action_descriptors(),
            resources: self.registry.resource_descriptors(),
            capabilities: self.capabilities,
        }
    }

    /// The credentials for the next `tesseron/resume`, if the last welcome
    /// issued any.
    ///
    /// They live in memory only. A restarted process is a new session by
    /// design: persisting a bearer token to disk would hand a resumable claimed
    /// session to anything that can read the file.
    pub(crate) fn resume_credentials(&self) -> Option<(String, String)> {
        self.resume.lock().ok().and_then(|resume| resume.clone())
    }

    pub(crate) fn reset_session_state(&self) {
        if let Ok(mut welcome) = self.welcome.lock() {
            *welcome = None;
        }
        if let Ok(mut claim) = self.claim.lock() {
            *claim = None;
        }
        if let Ok(mut resume) = self.resume.lock() {
            *resume = None;
        }
    }

    /// Stores the welcome and the token it rotated in.
    ///
    /// Resume tokens are one-shot, so the freshest welcome is always the one to
    /// keep; a welcome without a token means this session cannot be resumed.
    pub(crate) fn record_welcome(&self, welcome: &WelcomeResult) {
        if let Ok(mut stored) = self.welcome.lock() {
            *stored = Some(welcome.clone());
        }
        if let Ok(mut resume) = self.resume.lock() {
            *resume = welcome
                .resume_token
                .clone()
                .map(|token| (welcome.session_id.clone(), token));
        }
    }

    /// Applies `tesseron/claimed` to the stored welcome: the agent is known now
    /// and the claim code has been spent, so anything rendering it has to stop.
    ///
    /// A claim that carries the gateway's own capability block replaces the
    /// welcome's, because on the host-minted path the welcome the host answered
    /// itself never saw the real agent.
    pub(crate) fn record_claim(&self, claimed: &ClaimedParams) {
        if let Ok(mut stored) = self.claim.lock() {
            *stored = Some(claimed.clone());
        }
        self.apply_claim(claimed);
    }

    fn apply_claim(&self, claimed: &ClaimedParams) {
        let negotiated = claimed
            .agent_capabilities
            .clone()
            .and_then(|capabilities| serde_json::from_value::<Capabilities>(capabilities).ok());
        if let Ok(mut stored) = self.welcome.lock() {
            if let Some(welcome) = stored.as_mut() {
                welcome.agent = claimed.agent.clone();
                welcome.claim_code = None;
                if let Some(negotiated) = negotiated {
                    welcome.capabilities = negotiated;
                }
            }
        }
    }

    /// What the last welcome negotiated. Nothing, until one arrives: a handler
    /// must not sample or elicit at an agent that never agreed to it.
    pub(crate) fn negotiated_capabilities(&self) -> Capabilities {
        self.welcome_snapshot()
            .map_or_else(Capabilities::none, |welcome| welcome.capabilities)
    }

    /// Who is on the other end, or the pending placeholder before a claim.
    pub(crate) fn agent_identity(&self) -> AgentIdentity {
        self.welcome_snapshot().map_or_else(
            || AgentIdentity {
                id: "pending".to_owned(),
                name: "Awaiting agent".to_owned(),
            },
            |welcome| welcome.agent,
        )
    }

    pub(crate) fn origin(&self) -> &str {
        &self.application.origin
    }

    fn welcome_snapshot(&self) -> Option<WelcomeResult> {
        self.welcome.lock().ok().and_then(|welcome| welcome.clone())
    }
}

/// Collects an application definition, then starts serving it.
pub struct TesseronHostBuilder {
    application: Option<ApplicationDescriptor>,
    capabilities: Capabilities,
    actions: Vec<Action>,
    resources: Vec<Resource>,
    bind_address: SocketAddr,
    manifest: ManifestPublication,
    events: broadcast::Sender<HostEvent>,
}

impl TesseronHostBuilder {
    pub(crate) fn new() -> Self {
        let (events, _receiver) = broadcast::channel(EVENT_BUFFER);
        Self {
            application: None,
            capabilities: Capabilities::implemented(),
            actions: Vec::new(),
            resources: Vec::new(),
            bind_address: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
            manifest: ManifestPublication::default(),
            events,
        }
    }

    /// Names the application. The id becomes the prefix on every MCP tool this
    /// application contributes, so it has to match `^[a-z][a-z0-9_]*$`.
    #[must_use]
    pub fn application(mut self, id: impl Into<String>, name: impl Into<String>) -> Self {
        self.application = Some(ApplicationDescriptor {
            id: id.into(),
            name: name.into(),
            description: None,
            origin: UNKNOWN_ORIGIN.to_owned(),
            version: None,
            icon_url: None,
        });
        self
    }

    /// Replaces the whole application descriptor, for the fields
    /// [`TesseronHostBuilder::application`] does not take.
    #[must_use]
    pub fn application_descriptor(mut self, application: ApplicationDescriptor) -> Self {
        self.application = Some(application);
        self
    }

    /// Registers one action.
    #[must_use]
    pub fn action(mut self, action: Action) -> Self {
        self.actions.push(action);
        self
    }

    /// Registers one resource.
    #[must_use]
    pub fn resource(mut self, resource: Resource) -> Self {
        self.resources.push(resource);
        self
    }

    /// Overrides the address the host binds.
    ///
    /// The default is `127.0.0.1:0`, an ephemeral loopback port. Tesseron's
    /// threat model is same-host, same-user, so binding anything routable hands
    /// the application's actions to the network.
    #[must_use]
    pub fn bind_address(mut self, address: SocketAddr) -> Self {
        self.bind_address = address;
        self
    }

    /// Chooses where, or whether, the instance manifest is published.
    #[must_use]
    pub fn manifest(mut self, publication: ManifestPublication) -> Self {
        self.manifest = publication;
        self
    }

    /// Subscribes before the host starts listening, so no event can be missed
    /// between [`TesseronHostBuilder::listen`] returning and the gateway
    /// dialling in.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<HostEvent> {
        self.events.subscribe()
    }

    /// Binds the listener, publishes the manifest, and starts accepting the
    /// gateway.
    ///
    /// The returned host owns the accept loop. Dropping it without
    /// [`TesseronHost::shutdown`] leaves the manifest behind, and the gateway
    /// keeps re-dialling an endpoint that is gone.
    ///
    /// # Errors
    ///
    /// Returns [`HostError`] when the application is missing or misnamed, when
    /// two registrations share a name, when the listener cannot bind, or when
    /// the manifest cannot be written.
    pub async fn listen(mut self) -> Result<TesseronHost, HostError> {
        let application = self
            .application
            .clone()
            .ok_or(HostError::MissingApplication)?;
        if !is_valid_application_id(&application.id) {
            return Err(HostError::InvalidApplicationId(application.id));
        }

        if !self.bind_address.ip().is_loopback() {
            return Err(HostError::NonLoopbackBindAddress(self.bind_address));
        }

        let registry = self.build_registry()?;
        let listener = TcpListener::bind(self.bind_address)
            .await
            .map_err(HostError::Listen)?;
        let local_address = listener.local_addr().map_err(HostError::Listen)?;
        let url = format!("ws://{local_address}/");

        let instance_id = manifest::mint_instance_id();
        let manifest_path = self.publish_manifest(&instance_id, &application.name, &url)?;

        let shared = Arc::new(SharedHost {
            application,
            capabilities: self.capabilities,
            registry,
            events: self.events.clone(),
            welcome: Mutex::new(None),
            claim: Mutex::new(None),
            resume: Mutex::new(None),
        });
        let accept_loop = tokio::spawn(accept_gateway_connections(listener, Arc::clone(&shared)));

        Ok(TesseronHost {
            url,
            local_address,
            shared,
            accept_loop,
            manifest_path,
        })
    }

    fn build_registry(&mut self) -> Result<Registry, HostError> {
        let mut actions = HashMap::new();
        let mut action_order = Vec::new();
        for action in self.actions.drain(..) {
            let (descriptor, validator, handler) = action.into_parts();
            let name = descriptor.name.clone();
            if actions.contains_key(&name) {
                return Err(HostError::DuplicateName(name));
            }
            action_order.push(name.clone());
            actions.insert(
                name,
                RegisteredAction {
                    descriptor,
                    validator,
                    handler,
                },
            );
        }

        let mut resources = HashMap::new();
        let mut resource_order = Vec::new();
        for resource in self.resources.drain(..) {
            let (descriptor, reader, subscriber) = resource.into_parts();
            let name = descriptor.name.clone();
            if resources.contains_key(&name) {
                return Err(HostError::DuplicateName(name));
            }
            resource_order.push(name.clone());
            resources.insert(
                name,
                RegisteredResource {
                    descriptor,
                    reader,
                    subscriber,
                },
            );
        }

        Ok(Registry {
            actions,
            resources,
            action_order,
            resource_order,
        })
    }

    fn publish_manifest(
        &self,
        instance_id: &str,
        app_name: &str,
        url: &str,
    ) -> Result<Option<PathBuf>, HostError> {
        let directory = match &self.manifest {
            ManifestPublication::Disabled => return Ok(None),
            ManifestPublication::Directory(directory) => directory.clone(),
            ManifestPublication::DefaultDirectory => manifest::default_instance_directory()?,
        };
        let document = InstanceManifest::for_websocket(
            instance_id.to_owned(),
            app_name.to_owned(),
            url.to_owned(),
        );
        manifest::publish(&document, &directory).map(Some)
    }
}

impl std::fmt::Debug for TesseronHostBuilder {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TesseronHostBuilder")
            .field("application", &self.application)
            .field("actions", &self.actions.len())
            .field("resources", &self.resources.len())
            .field("bind_address", &self.bind_address)
            .finish_non_exhaustive()
    }
}

/// A listening application: one endpoint, one manifest, one gateway at a time.
#[derive(Debug)]
pub struct TesseronHost {
    url: String,
    local_address: SocketAddr,
    shared: Arc<SharedHost>,
    accept_loop: JoinHandle<()>,
    manifest_path: Option<PathBuf>,
}

impl TesseronHost {
    /// The `ws://` URL the gateway dials. Also what the manifest advertises.
    #[must_use]
    pub fn url(&self) -> &str {
        &self.url
    }

    /// The bound loopback address, useful when the port was ephemeral.
    #[must_use]
    pub const fn local_address(&self) -> SocketAddr {
        self.local_address
    }

    /// The published manifest, or `None` when publication is disabled.
    #[must_use]
    pub fn instance_manifest_path(&self) -> Option<&Path> {
        self.manifest_path.as_deref()
    }

    /// Subscribes to the event stream. Events emitted before this call are not
    /// replayed; use [`TesseronHostBuilder::subscribe`] to catch every one.
    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<HostEvent> {
        self.shared.events.subscribe()
    }

    /// The most recent welcome, with `tesseron/claimed` already applied, so a
    /// user interface can read the current claim code and agent at any time.
    #[must_use]
    pub fn welcome(&self) -> Option<WelcomeResult> {
        self.shared.welcome_snapshot()
    }

    /// Stops accepting, then removes the instance manifest.
    ///
    /// # Errors
    ///
    /// Returns [`HostError::Manifest`] when the manifest cannot be removed. A
    /// manifest that is already gone is not an error.
    pub async fn shutdown(self) -> Result<(), HostError> {
        self.accept_loop.abort();
        let _ = self.accept_loop.await;
        match &self.manifest_path {
            Some(path) => manifest::withdraw(path),
            None => Ok(()),
        }
    }
}

async fn accept_gateway_connections(listener: TcpListener, shared: Arc<SharedHost>) {
    loop {
        let (stream, _peer) = match listener.accept().await {
            Ok(accepted) => accepted,
            Err(problem) => {
                // A descriptor limit or a transient kernel refusal must not turn
                // the accept loop into a busy loop that burns the core.
                eprintln!("tesseron: could not accept a connection: {problem}");
                tokio::time::sleep(ACCEPT_RETRY_DELAY).await;
                continue;
            }
        };
        match accept_gateway_handshake(stream).await {
            // Serving inline is the single-connection-per-session rule: a
            // second dial waits in the accept queue instead of racing the
            // handshake of the first.
            Ok(socket) => session::serve_connection(socket, Arc::clone(&shared)).await,
            Err(problem) => eprintln!("tesseron: refused a WebSocket upgrade: {problem}"),
        }
    }
}

/// Completes the WebSocket upgrade, insisting on the gateway subprotocol.
///
/// The endpoint exists for the gateway. Anything else on the machine that finds
/// the port gets a 400 rather than a session.
async fn accept_gateway_handshake(
    stream: TcpStream,
) -> Result<WebSocketStream<TcpStream>, tokio_tungstenite::tungstenite::Error> {
    tokio_tungstenite::accept_hdr_async(stream, negotiate_gateway_subprotocol).await
}

// The signature is tungstenite's `Callback` contract, so the rejection cannot be
// boxed without failing to implement the trait.
#[allow(clippy::result_large_err)]
fn negotiate_gateway_subprotocol(
    request: &Request,
    mut response: Response,
) -> Result<Response, ErrorResponse> {
    if !offers_gateway_subprotocol(request) {
        let mut rejection = ErrorResponse::new(Some(format!(
            "this endpoint requires the {GATEWAY_SUBPROTOCOL} subprotocol"
        )));
        *rejection.status_mut() = StatusCode::BAD_REQUEST;
        return Err(rejection);
    }
    response.headers_mut().insert(
        SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(GATEWAY_SUBPROTOCOL),
    );
    Ok(response)
}

fn offers_gateway_subprotocol(request: &Request) -> bool {
    request
        .headers()
        .get_all(SEC_WEBSOCKET_PROTOCOL)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|protocol| protocol.trim() == GATEWAY_SUBPROTOCOL)
}

impl std::fmt::Debug for SharedHost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SharedHost")
            .field("application", &self.application)
            .finish_non_exhaustive()
    }
}
