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

Work in progress, tracking protocol 1.2.0. The whole host half of the protocol
is here: the handshake, claiming, session resume with token rotation, action
invocation with input validation and cancellation, streaming progress, resource
reads and subscriptions, and the `ActionContext` round trips back into the
agent for sampling, confirmation, elicitation, and logging. All four
`Capabilities` flags are declared.

Host-minted claim codes are the one thing left out. The gateway mints the code,
and a restarted process is a new session. Nothing is published to crates.io yet.

Two details worth knowing before you write a handler:

- `progress` clamps percent into 0 to 100 and never lets it fall below a value
  already sent for this invocation. An agent drawing a progress bar reads a
  backwards jump as a restart, and the message and data are worth keeping.
- `elicit` checks the JSON Schema against what MCP elicitation can render
  before anything reaches the wire. A schema with a top-level `oneOf`, or a
  property typed `object` or `array`, fails with `-32602` and the agent is
  never asked.

## Using it

```rust,no_run
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

`output_schema_from_type` puts the type your handler returns in the manifest. It
helps the agent shape tool results. It does not validate the value at runtime.

```rust
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tesseron::{Action, ActionContext, ActionError};

#[derive(Deserialize, JsonSchema)]
struct GetTodo {
    id: String,
}

#[derive(Serialize, JsonSchema)]
struct Todo {
    id: String,
}

async fn get_todo(input: GetTodo, _context: ActionContext) -> Result<Todo, ActionError> {
    Ok(Todo { id: input.id })
}

let _action = Action::typed("get_todo", get_todo).output_schema_from_type::<Todo>();
```

Subscribe *before* `listen()`. The gateway can dial and finish the handshake
before `listen()` returns, and a receiver created afterwards misses the welcome
that carries the claim code.

## Examples

Run `cargo run --manifest-path sdks/rust/examples/todo/Cargo.toml` for the headless todo app.
Run `cargo run --manifest-path sdks/rust/examples/prompts/Cargo.toml` for the prompt library.
Each prints a claim code after the gateway connects. In Claude Code with the Tesseron plugin loaded, tell Claude to claim that code, then call the actions.

The Tauri 2 example puts the same todo list in a desktop window. Its Rust commands and its eight agent actions mutate one shared store, and the headless and desktop apps import the same action registrations, schemas, and `todos://all` resource from `examples/todo`. Agent mutations emit a Tauri event so the open window updates without a refresh.

This is the exact Windows command sequence used to check and run it:

```bash
cargo install tauri-cli --locked
cargo check --manifest-path sdks/rust/Cargo.toml -p tauri-todo
cd sdks/rust/examples/tauri-todo
cargo tauri dev
```

The window shows the claim code from the gateway. Claim it in Claude Code, then call `rust_tauri_todo__addTodo`; the new item appears in the list.

CI passes `--exclude tauri-todo` to its workspace clippy, test, and build commands, then runs `cargo check -p tauri-todo` only on Windows. Tauri needs GTK and WebKit development packages on Linux, and installing that desktop stack would slow down the Ubuntu SDK job without adding protocol coverage. The Windows check compiles the example without bundling an installer.

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
pnpm conformance:run:rust
```

Every fixture passes. The skips are the `bind/*` fixtures, which need a
host-minted claim, plus `uds` on Windows; `conformance/run-reference.mjs` owns
both lists and CI runs the same script.

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
