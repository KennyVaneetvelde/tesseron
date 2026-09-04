#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(missing_docs)]

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};
use tesseron::{HostEvent, TesseronHost, WelcomeResult};
use tesseron_todo_example::{DeleteTodoResult, Todo, TodoList, todo_application};

const TODO_UPDATED_EVENT: &str = "todos-updated";
const CONNECTION_UPDATED_EVENT: &str = "connection-updated";

struct TesseronState {
    host: Mutex<Option<Arc<TesseronHost>>>,
}

impl TesseronState {
    fn new(host: Arc<TesseronHost>) -> Self {
        Self {
            host: Mutex::new(Some(host)),
        }
    }

    fn current_status(&self) -> Result<ConnectionStatus, String> {
        let host = self
            .host
            .lock()
            .map_err(|_| "Tesseron host state is unavailable".to_owned())?;
        Ok(host
            .as_deref()
            .and_then(TesseronHost::welcome)
            .as_ref()
            .map_or_else(ConnectionStatus::waiting, status_from_welcome))
    }

    fn take_host(&self) -> Option<Arc<TesseronHost>> {
        self.host.lock().ok()?.take()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ConnectionStatus {
    state: &'static str,
    message: String,
    claim_code: Option<String>,
    agent_name: Option<String>,
}

impl ConnectionStatus {
    fn waiting() -> Self {
        Self {
            state: "waiting",
            message: "Waiting for the Tesseron gateway".to_owned(),
            claim_code: None,
            agent_name: None,
        }
    }

    fn ready_to_claim(claim_code: String) -> Self {
        Self {
            state: "readyToClaim",
            message: "Claim this app from Claude Code".to_owned(),
            claim_code: Some(claim_code),
            agent_name: None,
        }
    }

    fn claimed(agent_name: String) -> Self {
        Self {
            state: "claimed",
            message: format!("Connected to {agent_name}"),
            claim_code: None,
            agent_name: Some(agent_name),
        }
    }

    fn disconnected() -> Self {
        Self {
            state: "disconnected",
            message: "Gateway disconnected. Waiting to reconnect".to_owned(),
            claim_code: None,
            agent_name: None,
        }
    }

    fn failed(problem: impl ToString) -> Self {
        Self {
            state: "failed",
            message: problem.to_string(),
            claim_code: None,
            agent_name: None,
        }
    }
}

fn status_from_welcome(welcome: &WelcomeResult) -> ConnectionStatus {
    if let Some(claim_code) = welcome.claim_code.clone() {
        ConnectionStatus::ready_to_claim(claim_code)
    } else if welcome.agent.id != "pending" {
        ConnectionStatus::claimed(welcome.agent.name.clone())
    } else {
        ConnectionStatus::waiting()
    }
}

fn command_error(problem: tesseron::ActionError) -> String {
    problem.message().to_owned()
}

#[tauri::command]
fn list_todos(todos: State<'_, TodoList>) -> Result<Vec<Todo>, String> {
    todos.snapshot().map_err(command_error)
}

#[tauri::command]
fn add_todo(text: String, tag: Option<String>, todos: State<'_, TodoList>) -> Result<Todo, String> {
    todos.add(text, tag).map_err(command_error)
}

#[tauri::command]
fn toggle_todo(identifier: String, todos: State<'_, TodoList>) -> Result<Todo, String> {
    todos.toggle(&identifier).map_err(command_error)
}

#[tauri::command]
fn delete_todo(identifier: String, todos: State<'_, TodoList>) -> Result<DeleteTodoResult, String> {
    todos.delete(identifier).map_err(command_error)
}

#[tauri::command]
fn connection_status(state: State<'_, TesseronState>) -> Result<ConnectionStatus, String> {
    state.current_status()
}

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

fn forward_connection_updates(
    application_handle: AppHandle,
    mut events: tokio::sync::broadcast::Receiver<HostEvent>,
) {
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            let status = match event {
                HostEvent::Welcome(welcome) => {
                    if let Some(claim_code) = &welcome.claim_code {
                        println!("Claim code: {claim_code}");
                    }
                    status_from_welcome(&welcome)
                }
                HostEvent::Claimed(claimed) => ConnectionStatus::claimed(claimed.agent.name),
                HostEvent::HandshakeFailed(problem) => ConnectionStatus::failed(problem),
                HostEvent::Disconnected => ConnectionStatus::disconnected(),
                _ => continue,
            };
            if application_handle
                .emit(CONNECTION_UPDATED_EVENT, status)
                .is_err()
            {
                break;
            }
        }
    });
}

fn shutdown_host(application_handle: &AppHandle) {
    let Some(state) = application_handle.try_state::<TesseronState>() else {
        return;
    };
    let Some(host) = state.take_host() else {
        return;
    };
    let Ok(host) = Arc::try_unwrap(host) else {
        eprintln!("Tesseron host still has active owners during shutdown");
        return;
    };
    if let Err(problem) = tauri::async_runtime::block_on(host.shutdown()) {
        eprintln!("Could not shut down the Tesseron host: {problem}");
    }
}

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

    application.run(|application_handle, event| {
        if matches!(event, RunEvent::Exit) {
            shutdown_host(application_handle);
        }
    });
}
