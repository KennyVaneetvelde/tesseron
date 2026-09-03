#![allow(missing_docs)]

use std::sync::{Arc, Mutex, MutexGuard};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tesseron::{
    Action, ActionContext, ActionError, ElicitRequest, HostEvent, ProgressUpdate, Resource,
    SampleRequest, Subscription, Tesseron, TesseronErrorCode,
};
use tokio::sync::broadcast;

#[derive(Clone, Serialize)]
struct Todo {
    id: String,
    text: String,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tag: Option<String>,
}

struct TodoStore {
    next_identifier: u64,
    todos: Vec<Todo>,
    updates: broadcast::Sender<Vec<Todo>>,
}

impl TodoStore {
    fn new(updates: broadcast::Sender<Vec<Todo>>) -> Self {
        Self {
            next_identifier: 1,
            todos: Vec::new(),
            updates,
        }
    }

    fn create(&mut self, text: String, tag: Option<String>) -> Todo {
        let todo = Todo {
            id: format!("t{}", self.next_identifier),
            text,
            done: false,
            tag,
        };
        self.next_identifier += 1;
        self.todos.push(todo.clone());
        todo
    }

    fn publish(&self) {
        let _ = self.updates.send(self.todos.clone());
    }
}

#[derive(Deserialize, JsonSchema)]
struct AddTodoInput {
    #[schemars(length(min = 1))]
    text: String,
    tag: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct TodoIdentifierInput {
    id: String,
}

#[derive(Deserialize, JsonSchema)]
struct ListTodosInput {
    filter: Option<TodoFilter>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
enum TodoFilter {
    All,
    Active,
    Completed,
}

#[derive(Deserialize, JsonSchema)]
struct EmptyInput {}

#[derive(Deserialize, JsonSchema)]
struct RenameTodoAnswer {
    #[schemars(length(min = 1))]
    #[serde(rename = "newName")]
    new_name: String,
}

#[derive(Deserialize, JsonSchema)]
struct ImportTodosInput {
    #[schemars(length(min = 1, max = 50))]
    items: Vec<String>,
    tag: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct SuggestTodosInput {
    #[schemars(length(min = 1))]
    theme: String,
    #[schemars(range(min = 1, max = 10))]
    count: Option<u8>,
}

#[derive(Deserialize, JsonSchema)]
struct SuggestedTodos {
    items: Vec<String>,
}

#[derive(Serialize)]
struct DeleteTodoResult {
    id: String,
    removed: bool,
}

#[derive(Serialize)]
struct ClearCompletedResult {
    removed: usize,
}

#[derive(Serialize)]
struct RenameTodoResult {
    id: String,
    renamed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
    #[serde(rename = "newName", skip_serializing_if = "Option::is_none")]
    new_name: Option<String>,
}

#[derive(Serialize)]
struct ImportedTodosResult {
    added: usize,
    ids: Vec<String>,
}

#[derive(Serialize)]
struct SuggestedTodosResult {
    theme: String,
    added: usize,
    ids: Vec<String>,
}

fn todo_not_found() -> ActionError {
    ActionError::protocol(
        TesseronErrorCode::HandlerError,
        "Todo not found",
        Some(json!({ "kind": "not_found" })),
    )
}

fn lock_store(store: &Mutex<TodoStore>) -> Result<MutexGuard<'_, TodoStore>, ActionError> {
    store.lock().map_err(|_| {
        ActionError::protocol(
            TesseronErrorCode::HandlerError,
            "Todo state is unavailable",
            None,
        )
    })
}

fn todos_snapshot(store: &Arc<Mutex<TodoStore>>) -> Result<Vec<Todo>, ActionError> {
    let store = lock_store(store)?;
    Ok(store.todos.clone())
}

fn todo_resource(
    store: Arc<Mutex<TodoStore>>,
    update_sender: broadcast::Sender<Vec<Todo>>,
) -> Resource {
    let resource_store = Arc::clone(&store);

    Resource::new("todos://all", move || {
        let store = Arc::clone(&resource_store);
        async move {
            let todos = todos_snapshot(&store)?;
            serde_json::to_value(todos).map_err(ActionError::internal)
        }
    })
    .description("The complete todo list. Pushed on every mutation.")
    .subscribe(move |emitter| {
        let mut updates = update_sender.subscribe();
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (updates, _) = broadcast::channel(32);
    let store = Arc::new(Mutex::new(TodoStore::new(updates.clone())));

    let add_store = Arc::clone(&store);
    let toggle_store = Arc::clone(&store);
    let delete_store = Arc::clone(&store);
    let list_store = Arc::clone(&store);
    let clear_store = Arc::clone(&store);
    let rename_store = Arc::clone(&store);
    let import_store = Arc::clone(&store);
    let suggest_store = Arc::clone(&store);

    let builder = Tesseron::builder()
        .application("rust_todo", "Rust Todo")
        .action(Action::typed("addTodo", move |input: AddTodoInput, _context| {
            let store = Arc::clone(&add_store);
            async move {
                let mut store = lock_store(&store)?;
                let todo = store.create(input.text, input.tag);
                store.publish();
                Ok(todo)
            }
        }))
        .action(Action::typed(
            "toggleTodo",
            move |input: TodoIdentifierInput, _context| {
                let store = Arc::clone(&toggle_store);
                async move {
                    let mut store = lock_store(&store)?;
                    let todo = store
                        .todos
                        .iter_mut()
                        .find(|todo| todo.id == input.id)
                        .ok_or_else(todo_not_found)?;
                    todo.done = !todo.done;
                    let updated = todo.clone();
                    store.publish();
                    Ok(updated)
                }
            },
        ))
        .action(Action::typed(
            "deleteTodo",
            move |input: TodoIdentifierInput, _context| {
                let store = Arc::clone(&delete_store);
                async move {
                    let mut store = lock_store(&store)?;
                    let original_length = store.todos.len();
                    store.todos.retain(|todo| todo.id != input.id);
                    if store.todos.len() == original_length {
                        return Err(todo_not_found());
                    }
                    store.publish();
                    Ok(DeleteTodoResult {
                        id: input.id,
                        removed: true,
                    })
                }
            },
        ))
        .action(Action::typed(
            "listTodos",
            move |input: ListTodosInput, _context| {
                let store = Arc::clone(&list_store);
                async move {
                    let todos = todos_snapshot(&store)?;
                    let filter = input.filter.unwrap_or(TodoFilter::All);
                    Ok(todos
                        .into_iter()
                        .filter(|todo| match filter {
                            TodoFilter::All => true,
                            TodoFilter::Active => !todo.done,
                            TodoFilter::Completed => todo.done,
                        })
                        .collect::<Vec<_>>())
                }
            },
        ))
        .action(Action::typed(
            "clearCompleted",
            move |_input: EmptyInput, _context| {
                let store = Arc::clone(&clear_store);
                async move {
                    let mut store = lock_store(&store)?;
                    let original_length = store.todos.len();
                    store.todos.retain(|todo| !todo.done);
                    let removed = original_length - store.todos.len();
                    if removed > 0 {
                        store.publish();
                    }
                    Ok(ClearCompletedResult { removed })
                }
            },
        ))
        .action(Action::typed(
            "renameTodo",
            move |input: TodoIdentifierInput, context: ActionContext| {
                let store = Arc::clone(&rename_store);
                async move {
                    let previous_text = {
                        let store = lock_store(&store)?;
                        store
                            .todos
                            .iter()
                            .find(|todo| todo.id == input.id)
                            .map(|todo| todo.text.clone())
                            .ok_or_else(todo_not_found)?
                    };
                    let answer = context
                        .elicit_as::<RenameTodoAnswer>(ElicitRequest::for_type::<RenameTodoAnswer>(format!(
                            "Rename \"{previous_text}\" to?"
                        )))
                        .await?;
                    let Some(answer) = answer else {
                        return Ok(RenameTodoResult {
                            id: input.id,
                            renamed: false,
                            cancelled: Some(true),
                            new_name: None,
                        });
                    };
                    let mut store = lock_store(&store)?;
                    let todo = store
                        .todos
                        .iter_mut()
                        .find(|todo| todo.id == input.id)
                        .ok_or_else(todo_not_found)?;
                    todo.text = answer.new_name.clone();
                    store.publish();
                    Ok(RenameTodoResult {
                        id: input.id,
                        renamed: true,
                        cancelled: None,
                        new_name: Some(answer.new_name),
                    })
                }
            },
        ))
        .action(Action::typed(
            "importTodos",
            move |input: ImportTodosInput, context: ActionContext| {
                let store = Arc::clone(&import_store);
                async move {
                    let item_count = input.items.len();
                    let mut ids = Vec::with_capacity(item_count);
                    for (index, text) in input.items.into_iter().enumerate() {
                        let todo = {
                            let mut store = lock_store(&store)?;
                            let todo = store.create(text, input.tag.clone());
                            store.publish();
                            todo
                        };
                        ids.push(todo.id);
                        context.progress(
                            ProgressUpdate::new()
                                .message(format!("{}/{} imported", index + 1, item_count))
                                .percent(((index + 1) * 100 / item_count) as f64),
                        );
                    }
                    Ok(ImportedTodosResult {
                        added: ids.len(),
                        ids,
                    })
                }
            },
        ))
        .action(Action::typed(
            "suggestTodos",
            move |input: SuggestTodosInput, context: ActionContext| {
                let store = Arc::clone(&suggest_store);
                async move {
                    let count = input.count.unwrap_or(5);
                    context.progress(ProgressUpdate::new().message("asking LLM...").percent(25.0));
                    let suggested = context
                        .sample_as::<SuggestedTodos>(
                            SampleRequest::for_type::<SuggestedTodos>(format!(
                                "Produce exactly {count} concrete todo items for the theme \"{}\". Return JSON matching {{ items: string[] }}. Items should be short, imperative, and user-friendly. No numbering.",
                                input.theme
                            ))
                            .max_tokens(400),
                        )
                        .await?;
                    context.progress(
                        ProgressUpdate::new()
                            .message("adding to list...")
                            .percent(80.0),
                    );
                    let mut store = lock_store(&store)?;
                    let todos = suggested
                        .items
                        .into_iter()
                        .map(|text| store.create(text, Some(input.theme.clone())))
                        .collect::<Vec<_>>();
                    store.publish();
                    Ok(SuggestedTodosResult {
                        theme: input.theme,
                        added: todos.len(),
                        ids: todos.into_iter().map(|todo| todo.id).collect(),
                    })
                }
            },
        ))
        .resource(todo_resource(Arc::clone(&store), updates));
    let mut events = builder.subscribe();
    let host = builder.listen().await?;

    while let Ok(event) = events.recv().await {
        if let HostEvent::Welcome(welcome) = event {
            if let Some(claim_code) = welcome.claim_code {
                println!("Claim code: {claim_code}");
                break;
            }
        }
    }

    tokio::signal::ctrl_c().await?;
    host.shutdown().await?;
    Ok(())
}
