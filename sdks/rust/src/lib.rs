#![doc = include_str!("../README.md")]
#![deny(missing_docs)]
#![cfg_attr(test, allow(clippy::unwrap_used))]

mod action;
mod context;
mod elicit_schema;
mod error;
mod host;
mod jsonrpc;
mod manifest;
mod protocol;
mod resource;
mod session;

pub use action::{Action, InputValidator, ValidationIssue};
pub use context::{
    ActionContext, Cancellation, ElicitRequest, LogEntry, ProgressUpdate, SampleRequest,
};
pub use error::{ActionError, HostError, ProtocolError, TesseronErrorCode};
pub use host::{HostEvent, TesseronHost, TesseronHostBuilder};
pub use jsonrpc::RequestId;
pub use manifest::{InstanceManifest, ManifestPublication, TransportSpecification};
pub use protocol::{
    ActionDescriptor, AgentIdentity, ApplicationDescriptor, Capabilities, ClaimedParams,
    HelloParams, LogLevel, ResourceDescriptor, ResumeParams, WelcomeResult, methods,
};
pub use protocol::{GATEWAY_SUBPROTOCOL, JSONRPC_VERSION, PROTOCOL_VERSION};
pub use resource::{Resource, ResourceEmitter, Subscription};

/// Entry point for building an application host.
///
/// The type exists only to hang [`Tesseron::builder`] off a name that reads the
/// way the other Tesseron SDKs do; every piece of state lives on
/// [`TesseronHostBuilder`] and then on [`TesseronHost`].
#[derive(Debug)]
pub struct Tesseron;

impl Tesseron {
    /// Starts a host definition. Register the application, its actions, and its
    /// resources on the returned builder, then call
    /// [`TesseronHostBuilder::listen`].
    #[must_use]
    pub fn builder() -> TesseronHostBuilder {
        TesseronHostBuilder::new()
    }
}
