---
title: Tauri (Rust)
description: Put a Rust host in tauri::State and refresh the window when an agent mutates shared todo state.
related:
  - sdk/rust/index
  - sdk/rust/resources
  - sdk/rust/context
  - examples/vanilla-todo
---

<!-- snippets from sdks/rust/examples/todo -->

The `tauri-todo` example uses the same Rust host as a headless app. `setup()` creates the application from `examples/todo`, stores the host in Tauri state, and forwards updates to the window.

## The setup pattern

This is the setup closure from `sdks/rust/examples/tauri-todo/src/main.rs`:

```rust
fn main() {
    let application = tauri::Builder::default()
        .setup(|application| {
            let (builder, todos) = todo_application("rust_tauri_todo", "Rust Tauri Todo");
            let events = builder.subscribe();
            let host = tauri::async_runtime::block_on(builder.listen())?;

            forward_todo_updates(application.handle().clone(), &todos);
            forward_connection_updates(application.handle().clone(), events);
            application.manage(todos);
            application.manage(TesseronState::new(Arc::new(host)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_todos,
            add_todo,
            toggle_todo,
            delete_todo,
            connection_status
        ])
        .build(tauri::generate_context!())
        .expect("error while building Tesseron Todo");
```

The full example keeps `Arc<TesseronHost>` inside `TesseronState`, wrapped in a `Mutex<Option<...>>`. Tauri commands read and mutate the shared `TodoList`. On `RunEvent::Exit`, the app takes the host from state and calls `host.shutdown()` so the accept loop stops and the manifest is removed.

`todo_application(...)` comes from `sdks/rust/examples/todo/src/lib.rs`. It owns the action registrations, typed input and output shapes, and the `todos://all` resource. The headless and Tauri binaries import that same function, so their agent surface stays aligned.

## Refreshing the window

The shared list publishes a new snapshot after every mutation. The Tauri side listens to that channel and emits `todos-updated`:

```rust
fn forward_todo_updates(application_handle: AppHandle, todos: &TodoList) {
    let mut updates = todos.subscribe();
    tauri::async_runtime::spawn(async move {
        while let Ok(todos) = updates.recv().await {
            if application_handle.emit(TODO_UPDATED_EVENT, todos).is_err() {
                break;
            }
        }
    });
}
```

The frontend listens for the `todos-updated` event and replaces its list. Agent mutations therefore update the open window without a refresh. Connection events follow the same pattern with `connection-updated`; `HostEvent::Welcome` exposes the claim code, `HostEvent::Claimed` identifies the agent, and `HostEvent::Disconnected` reports a dropped gateway connection.

## Run the example

The exact Windows sequence is in the crate README: install the Tauri CLI, check the example, change into its directory, and run `cargo tauri dev`. The window shows the claim code from the gateway. Claim it in Claude Code, then call `rust_tauri_todo__addTodo`; the new item appears in the list.

Tauri is checked separately on Windows in CI. The main Rust workspace checks exclude `tauri-todo` on Linux because its GTK and WebKit development stack adds desktop dependencies without adding protocol coverage.
