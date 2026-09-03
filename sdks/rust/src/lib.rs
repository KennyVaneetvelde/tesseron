//! Rust SDK for the [Tesseron](https://eigenwise.github.io/tesseron/) protocol.
//!
//! A Tesseron application hosts a loopback endpoint and publishes an instance
//! manifest; the MCP gateway discovers that manifest and dials *in*. This crate
//! owns the application half of that contract: the wire types, the JSON-RPC
//! correlation, the WebSocket listener, the manifest, and the handshake that
//! turns a fresh socket into a claimed session.
//!
//! ```no_run
//! use tesseron::{Action, ActionContext, ActionError, Tesseron};
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! async fn ping(_input: serde_json::Value, _context: ActionContext) -> Result<serde_json::Value, ActionError> {
//!     Ok(serde_json::json!({ "ok": true }))
//! }
//!
//! let builder = Tesseron::builder()
//!     .application("todo", "Todo")
//!     .action(Action::json("ping", ping));
//! let mut events = builder.subscribe();
//! let host = builder.listen().await?;
//!
//! // The gateway mints the claim code and hands it back in the welcome.
//! while let Ok(event) = events.recv().await {
//!     if let tesseron::HostEvent::Welcome(welcome) = event {
//!         if let Some(code) = welcome.claim_code {
//!             println!("Claim this session with {code}");
//!         }
//!         break;
//!     }
//! }
//!
//! host.shutdown().await?;
//! # Ok(())
//! # }
//! ```
//!
//! ## What this version covers
//!
//! The whole host half of protocol 1.2.0: handshake, claiming, session resume
//! with token rotation, action invocation with input validation, cancellation
//! and streaming progress, resource reads and subscriptions, and the
//! [`ActionContext`] round trips back into the agent for sampling, confirmation,
//! elicitation, and logging. All four [`Capabilities`] flags are declared.
//!
//! Host-minted claim codes are the one thing left out. The gateway mints the
//! code, and a restarted process is a new session.

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

pub use action::{Action, ActionHandler, InputValidator, ValidationIssue};
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
pub use resource::{Resource, ResourceEmitter, ResourceReader, ResourceSubscriber, Subscription};

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
