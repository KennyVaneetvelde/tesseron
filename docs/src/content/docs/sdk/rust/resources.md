---
title: Resources (Rust)
description: Readable and subscribable application state with ResourceEmitter pushes and cleanup.
related:
  - sdk/rust/index
  - sdk/rust/actions
  - protocol/resources
---

<!-- snippets from examples/todo -->

A resource is named application state the agent can read, and optionally follow. Actions change things; resources report the current value.

## Registering a resource

`Resource::new(name, read)` takes a synchronous callback that returns a future resolving to `Result<Value, ActionError>`. The callback runs on every `resources/read`, so it reads current state rather than a snapshot captured during registration.

The todo example registers a readable and subscribable `todos://all` resource like this:

```rust
fn todo_resource(todos: TodoList) -> Resource {
    let resource_todos = todos.clone();

    Resource::new("todos://all", move || {
        let todos = resource_todos.clone();
        async move {
            let todos = todos.snapshot()?;
            serde_json::to_value(todos).map_err(ActionError::internal)
        }
    })
    .description("The complete todo list. Pushed on every mutation.")
    .subscribe(move |emitter| {
        let mut updates = todos.subscribe();
        let task = tokio::spawn(async move {
            while let Ok(todos) = updates.recv().await {
                if let Ok(value) = serde_json::to_value(todos) {
                    emitter.emit(value);
                }
            }
        });
        Subscription::new(move || task.abort())
    })
}
```

`.description(...)` publishes the text the agent sees. Calling `.subscribe(..)` marks the resource as subscribable and gives the callback one `ResourceEmitter` for that subscription.

## Pushing updates

`ResourceEmitter::emit(Value)` sends a `resources/updated` notification to the agent subscribed through that emitter. It is fire-and-forget. Emitting after the transport closes or after unsubscribe is dropped. Cloning an emitter keeps the same subscription id, which lets a spawned task keep pushing until its `Subscription` cleanup runs.

`Subscription::new(stop)` stores a `FnOnce` cleanup. The SDK runs it when the agent unsubscribes and when the transport closes. Use `Subscription::without_cleanup()` when the callback started nothing that needs teardown.

The subscribe callback is synchronous. Start the event source and return the subscription promptly. A spawned task, as in the example, can wait for updates without blocking the session loop.

## Wire behavior

`resources/subscribe` and `resources/unsubscribe` acknowledge with `result: null`. The acknowledgement is sent before the subscriber starts, so an immediate push cannot overtake it. Unsubscribing an unknown id is harmless.

Reading an undeclared resource returns `TesseronErrorCode::ActionNotFound` with `Resource not readable: <name>`. Subscribing to an undeclared or non-subscribable resource returns the same code with `Resource not subscribable: <name>`.

A reader can return `ActionError` for a domain failure. An unexpected reader error is reported as `-32603 Internal error`.

## Registration lifetime

Resource registrations are fixed once `listen()` runs. Runtime add and remove with list-change notifications is SQ-42 and is not shipped. Register every `Resource` on `TesseronHostBuilder` before starting the host.
