---
title: Actions (Rust)
description: Typed and raw JSON actions, schema publication, validation, timeouts, and registration rules.
related:
  - sdk/rust/index
  - sdk/rust/context
  - sdk/rust/errors
  - protocol/actions
---

<!-- snippets from examples/todo -->

An action is a named handler the agent can invoke. The gateway projects each registration into an MCP tool.

## Typed actions

`Action::typed(name, handler)` takes an input type that implements `DeserializeOwned + JsonSchema` and an output type that implements `Serialize`. The derived Schemars document is JSON Schema 2020-12, and the same input type is deserialized before the handler runs.

This is the builder shape used by the crate README:

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

A typed input schema must have an object root. Use a struct for input, including an empty struct for an action with no input. Scalars, enums, and `Vec<T>` derive non-object roots and are refused when `listen()` runs with `HostError::InvalidTypedActionInputSchema`. The error names the action and the Rust input type. A typed action with `.input_schema(Value)` still has to publish an object-root schema.

Input that cannot deserialize is rejected with `ActionError` carrying `TesseronErrorCode::InputValidation`, and the handler does not run.

## Raw JSON actions

`Action::json(name, handler)` passes a `serde_json::Value` to the handler. It starts with a permissive `{}` input schema. Set `.input_schema(Value)` for the manifest and add `.validate_with(..)` when the schema must be enforced:

```rust
let mut action = Action::json(
    fixture.name,
    move |_input: Value, context: ActionContext| {
        let script = Arc::clone(&script);
        async move { run_action(&script, context).await }
    },
)
.description(fixture.description);

if let Some(schema) = fixture.input_schema {
    schema_subset::assert_enforceable(&schema)
        .map_err(|problem| format!("action {:?}: {problem}", action.name()))?;
    let enforced = schema.clone();
    action = action
        .input_schema(schema)
        .validate_with(move |input: &Value| schema_subset::check(&enforced, input));
}
```

The validator returns `Ok(())` for accepted input or `Err(Vec<ValidationIssue>)` for rejected input. A rejected value becomes `TesseronErrorCode::InputValidation`. With no validator, the declared schema documents the expected value and the raw JSON reaches the handler unchanged.

## Builder options

| Method | What it does |
| --- | --- |
| `.description(...)` | Publishes the text the agent reads for the tool. |
| `.input_schema(Value)` | Replaces the input schema in the manifest. |
| `.output_schema(Value)` | Publishes an informational output schema. |
| `.output_schema_from_type::<Output>()` | Derives and publishes the output schema from `Output`. |
| `.timeout(Duration)` | Sets the per-invocation deadline instead of the 60-second default. |
| `.validate_with(..)` | Adds a runtime validator for a raw JSON action. |

Output schema publication is opt-in. Nothing is published unless you call `.output_schema_from_type::<Output>()` or `.output_schema(Value)`. The schema describes the result for the agent; the crate does not validate handler output against it.

## Registering after listen

Clone the host handle into a spawned task when an action needs to be added or removed after `listen()`:

```rust
use serde_json::json;
use tesseron::{Action, TesseronHost};

let host = builder.listen().await?;
let host_clone: TesseronHost = host.clone();
let action = Action::json("refresh", |_input, _context| async {
    Ok(json!({ "ok": true }))
});

tokio::spawn(async move {
    host_clone.register_action(action);
    host_clone.remove_action("refresh");
});
```

`register_action(&self, action)` upserts by name, replacing the descriptor, validator, and handler while keeping the existing manifest slot. `remove_action(&self, name)` returns `true` when an action was removed and `false` for an unknown name.

After the session is welcomed, each call that changes the registry sends `actions/list_changed` with `{ "actions": [full manifest] }`. Before welcome, or without a connected gateway, changes are silent and the next `tesseron/hello` or resume carries the new manifest. Notifications are sent for each change without coalescing.

A duplicate action name on the builder returns `HostError::DuplicateName`. The application id is checked before the listener starts, and `bind_address(SocketAddr)` accepts loopback addresses only. `listen()` returns `HostError::NonLoopbackBindAddress` for anything else.

## Handler failures

Return `ActionError::handler(message)` for a domain failure that the agent should see. Use `ActionError::protocol(code, message, data)` when a specific Tesseron code and structured data are part of the contract. Use `ActionError::internal(source)` for an unexpected failure; the cause stays local and the agent receives `-32603 Internal error`. See [Errors](/sdk/rust/errors/).
