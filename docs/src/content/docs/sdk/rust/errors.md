---
title: Errors (Rust)
description: Host startup errors, handler failures, protocol envelopes, and the complete 17-code catalog.
related:
  - sdk/rust/actions
  - sdk/rust/context
  - sdk/rust/index
  - protocol/errors
---

<!-- snippets from examples/todo -->

The Rust SDK keeps three error types separate. `HostError` means the application could not start or shut down. `ActionError` is what a handler returns when an invocation fails. `ProtocolError` is the JSON-RPC error object that crosses the connection.

## The code catalog

`TesseronErrorCode` is the closed set of protocol codes. `as_wire_code()` returns the JSON-RPC integer, and `from_wire_code(...)` returns `None` for an integer this SDK does not define.

| Code | Variant | When |
| --- | --- | --- |
| `-32700` | `ParseError` | The peer sent bytes that are not valid JSON. |
| `-32600` | `InvalidRequest` | The envelope is not a valid JSON-RPC 2.0 message. |
| `-32601` | `MethodNotFound` | The requested method is not part of the Tesseron protocol. |
| `-32602` | `InvalidParams` | Method parameters do not match the documented shape, including an elicit schema MCP cannot render. |
| `-32603` | `InternalError` | An unexpected failure occurred. Detail stays local. |
| `-32000` | `ProtocolMismatch` | The host and gateway disagree on the protocol major version. |
| `-32001` | `Cancelled` | The agent cancelled the invocation. |
| `-32002` | `Timeout` | The invocation passed its action timeout. |
| `-32003` | `ActionNotFound` | No action is registered under the requested name, or a resource is not readable or subscribable. |
| `-32004` | `InputValidation` | The invocation input failed the action's declared schema. |
| `-32005` | `HandlerError` | The handler reported a domain failure. |
| `-32006` | `SamplingNotAvailable` | The agent did not negotiate sampling. |
| `-32007` | `ElicitationNotAvailable` | The agent did not negotiate elicitation. |
| `-32008` | `SamplingDepthExceeded` | The gateway's sampling-depth limit was exceeded. |
| `-32009` | `Unauthorized` | The session is unclaimed or the operation is not permitted. |
| `-32010` | `TransportClosed` | The transport closed while a request was in flight. |
| `-32011` | `ResumeFailed` | The gateway refused the resume credentials. |

## ActionError

Handlers return `Result<Output, ActionError>`. Use `ActionError::handler(message)` for a domain failure that should reach the agent as `HandlerError`. Use `ActionError::protocol(code, message, data)` when the agent needs a specific code and optional structured `Value`. `ActionError::with_data(data)` adds detail to an existing error.

`ActionError::internal(source)` keeps the source error in `internal_source()` and sends only `-32603 Internal error`. An unexpected error from a handler follows the same redacted path. This keeps panic messages, database URLs, and other local details off the wire.

## ProtocolError

`ProtocolError` represents the JSON-RPC `error` member with public `code: i32`, `message: String`, and optional `data: Value`. It keeps the raw integer so a newer peer's unknown code can round-trip. Call `named_code()` when you want `Option<TesseronErrorCode>`.

`ProtocolError::new(code, message)` builds a known-code payload, and `.with_data(data)` attaches structured detail. The SDK turns gateway responses into `ActionError` when a handler's `sample`, `confirm`, or `elicit` request fails.

## HostError

These errors occur before an invocation reaches a handler:

| Variant | When |
| --- | --- |
| `MissingApplication` | No application was registered before `listen()`. |
| `InvalidApplicationId(String)` | The id fails `^[a-z][a-z0-9_]*$` or is reserved. |
| `InvalidTypedActionInputSchema { action_name, input_type_name }` | A typed action's derived or overridden input schema is not an object root. The error names both the action and Rust input type. |
| `DuplicateName(String)` | Two actions or two resources use the same name. |
| `NonLoopbackBindAddress(SocketAddr)` | `bind_address(...)` was given a non-loopback address. |
| `Listen(io::Error)` | The loopback listener could not bind. |
| `Manifest(io::Error)` | The instance manifest could not be written or removed. |
| `HomeDirectoryUnknown` | The home directory for `~/.tesseron` could not be resolved. |

`listen()` refuses a non-loopback address before binding. `shutdown().await` reports a manifest removal failure through `HostError::Manifest`.
