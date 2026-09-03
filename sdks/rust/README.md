# Tesseron Rust SDK

Rust half of the [Tesseron](https://eigenwise.github.io/tesseron/) protocol: your
application binds a loopback WebSocket, writes an instance manifest, and the MCP
gateway dials *in*. There is no port to configure and no gateway address to
point at.

Two crates live here:

| Crate | Where | What it is |
|---|---|---|
| `tesseron` | `sdks/rust/` | the SDK you depend on |
| `tesseron-conformance-host` | `sdks/rust/conformance-host/` | test binary the `@tesseron/conformance` runner drives; not published |

The SDK is the workspace root rather than a third directory beside the host,
because `cargo fmt --manifest-path sdks/rust/Cargo.toml` needs a package to
point at. Against a virtual manifest it prints `Failed to find targets` and
exits 1.

## Status

Work in progress, tracking protocol 1.2.0. This first release covers the
handshake, claiming, session resume with token rotation, action invocation with
input validation and cancellation, and resource reads. Streaming progress,
resource subscriptions, sampling, and elicitation are not implemented, so
`Capabilities` reports them as `false` and the gateway never routes them here.
Nothing is published to crates.io yet.

## Using it

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
    .action(Action::typed("add_todo", add_todo));
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
# Ok(())
# }
```

Subscribe *before* `listen()`. The gateway can dial and finish the handshake
before `listen()` returns, and a receiver created afterwards misses the welcome
that carries the claim code.

## Working on it

Edition 2024, MSRV 1.85. `Cargo.lock` is committed because the workspace holds a
binary, and because `futures-util` 0.3.34 depends on a `futures-macro` release
that was never published; the lock pins 0.3.33.

```bash
cargo fmt --manifest-path sdks/rust/Cargo.toml --all --check
cargo clippy --manifest-path sdks/rust/Cargo.toml --workspace --all-targets -- -D warnings
cargo test --manifest-path sdks/rust/Cargo.toml --workspace
```

`cargo fmt` needs `--all` to reach the conformance host; without it, it formats
the root package only.

Conformance, from the repo root, against the language-neutral corpus in
`conformance/`:

```bash
cargo build --manifest-path sdks/rust/Cargo.toml --workspace
pnpm -r --filter @tesseron/conformance build
TESSERON_CONFORMANCE_UNSUPPORTED=elicitation,host-minted-claim,sampling,streaming,subscriptions,uds \
  node conformance/runner/dist/tesseron-conformance.cjs \
  --host "sdks/rust/target/debug/tesseron-conformance-host"
```

That works on Windows too, but only since the runner started resolving a
`--host` that is nothing but a path. Before that, cmd.exe ended the command
token at the first `/` and the whole suite died as `'sdks' is not recognized`.
If you are pinned to `@tesseron/conformance` 1.2.0 or older, spell the path
`.\sdks\rust\target\debug\tesseron-conformance-host` instead.

## House rules

- No `unwrap()` outside tests. `unwrap_used` is denied at the workspace level.
- `#![deny(missing_docs)]` on the library. A doc comment states the contract, not
  what the line does.
- No abbreviations in names.
