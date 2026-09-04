---
title: Rust SDK
description: The Rust implementation of the Tesseron host protocol, with typed actions, resources, and the full context API.
related:
  - sdk/index
  - sdk/rust/actions
  - sdk/rust/conformance
  - sdk/porting
  - protocol/compatibility
---

<!-- snippets from sdks/rust/examples/todo -->

`tesseron` is the Rust host SDK. Your application binds a loopback WebSocket, writes an instance manifest, and the MCP gateway dials in. The agent gets typed actions and readable resources from the process that owns the state.

It speaks protocol [**1.2.0**](/protocol/), the same version as the TypeScript and Python SDKs. Compatibility follows protocol version, never package numbers. See the [compatibility contract](/protocol/compatibility/).

The crate is unpublished for now. It lives in the hub repository at [`sdks/rust/`](https://github.com/eigenwise/tesseron/tree/main/sdks/rust). Add it as a git dependency with `cargo add tesseron --git https://github.com/eigenwise/tesseron`.

## Requirements

Rust 1.85 or newer, edition 2024. The crate uses Tokio, `tokio-tungstenite`, Serde, Serde JSON, and Schemars. `Action::typed` inputs derive `Deserialize` and `JsonSchema`; serializable outputs can opt into a published schema.

## A first host

This is the small host from the crate README. The `#` lines are doctest helpers kept by the source crate.

```rust
use tesseron::{Action, ActionContext, ActionError, HostEvent, Tesseron};
use serde::{Deserialize, Serialize};
use schemars::JsonSchema;

#[derive(Deserialize, JsonSchema)]
struct AddTodo {
    title: String,
}

#[derive(Serialize, JsonSchema)]
struct Added {
    id: u64,
}

async fn add_todo(input: AddTodo, _context: ActionContext) -> Result<Added, ActionError> {
    Ok(Added { id: store_todo(input.title) })
}

# fn store_todo(_title: String) -> u64 { 1 }
# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let builder = Tesseron::builder()
    .application("todo", "Todo")
    .action(Action::typed("add_todo", add_todo).output_schema_from_type::<Added>());
let mut events = builder.subscribe();
let host = builder.listen().await?;

while let Ok(event) = events.recv().await {
    if let HostEvent::Welcome(welcome) = event {
        if let Some(code) = welcome.claim_code {
            println!("Claim this session with {code}");
        }
        break;
    }
}
host.shutdown().await?;
# Ok(())
# }
```

Subscribe before `listen()`. The gateway can finish the handshake before `listen()` returns, and `Welcome` carries the claim code for a fresh session. `host.url()` returns the loopback WebSocket URL when you need to inspect it or connect a test gateway.

Run the complete headless todo app from the repository root with `cargo run --manifest-path sdks/rust/examples/todo/Cargo.toml`. It prints a claim code after the gateway connects. With the Tesseron plugin loaded in Claude Code, tell Claude Code to claim that code, then call the actions.

## What it covers

Handshake and claiming, session resume with in-memory token rotation, typed and raw JSON actions, input validation, cancellation, per-action timeouts, streaming progress, sampling, confirmation, schema-checked elicitation, structured logs, and resources with reads, subscriptions, and pushes are included.

Claims are gateway-minted and transport is WebSocket only in this release. Host-minted bind claims and Unix domain sockets are outside the crate's shipped surface, so the [conformance suite](/sdk/rust/conformance/) skips those fixtures.

## Manifest and shutdown

`listen()` binds `127.0.0.1` on an OS-selected port and writes a v2 instance manifest into `~/.tesseron/instances/` once the URL is known. The directory is `0700`, the file is `0600`, and `shutdown().await` removes the manifest. Modes are advisory on Windows, where the user account is the access boundary.

`host.welcome()` returns the most recent `WelcomeResult`, with `claim_code` cleared after the agent claims the session. `host.subscribe()` can observe later events. To catch the first welcome, use `builder.subscribe()` before `listen()` as shown above.

## Next

- [Actions](/sdk/rust/actions/): typed and raw handlers, schemas, timeouts, and fixed registrations.
- [Resources](/sdk/rust/resources/): reads, subscriptions, emitters, and cleanup.
- [Context](/sdk/rust/context/): progress, confirmation, elicitation, sampling, logs, and cancellation.
- [Errors](/sdk/rust/errors/): `HostError`, `ActionError`, `ProtocolError`, and the 17 codes.
- [Conformance](/sdk/rust/conformance/): build the private host and run the shared corpus.
- [Tauri](/sdk/rust/tauri/): keep a host in `tauri::State` and update the window after agent mutations.
