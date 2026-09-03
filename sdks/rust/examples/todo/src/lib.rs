#![allow(missing_docs)]

use std::sync::{Arc, Mutex, MutexGuard};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tesseron::{
    Action, ActionContext, ActionError, ElicitRequest, ProgressUpdate, Resource, SampleRequest,
    Subscription, Tesseron, TesseronErrorCode, TesseronHostBuilder,
};
use tokio::sync::broadcast;

#[derive(Clone, Serialize)]
pub struct Todo {
    #[serde(rename = "id")]
    identifier: String,
    text: String,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tag: Option<String>,
}

struct TodoStore {
    next_identifier: u64,
    todos: Vec<Todo>,
}

impl TodoStore {
    fn create(&mut self, text: String, tag: Option<String>) -> Todo {
        let todo = Todo {
            identifier: format!("t{}", self.next_identifier),
            text,
            done: false,
            tag,
        };
        self.next_identifier += 1;
        self.todos.push(todo.clone());
        todo
    }
}

#[derive(Clone)]
pub struct TodoList {
    store: Arc<Mutex<TodoStore>>,
    updates: broadcast::Sender<Vec<Todo>>,
}

impl TodoList {
    fn new() -> Self {
        let (updates, _) = broadcast::channel(32);
        Self {
            store: Arc::new(Mutex::new(TodoStore {
                next_identifier: 1,
                todos: Vec::new(),
            })),
            updates,
        }
    }

    pub fn add(&self, text: String, tag: Option<String>) -> Result<Todo, ActionError> {
        let mut store = self.lock()?;
        let todo = store.create(text, tag);
        self.publish(&store);
        Ok(todo)
    }

    pub fn toggle(&self, identifier: &str) -> Result<Todo, ActionError> {
        let mut store = self.lock()?;
        let todo = store
            .todos
            .iter_mut()
            .find(|todo| todo.identifier == identifier)
            .ok_or_else(todo_not_found)?;
        todo.done = !todo.done;
        let updated = todo.clone();
        self.publish(&store);
        Ok(updated)
    }

    pub fn delete(&self, identifier: String) -> Result<DeleteTodoResult, ActionError> {
        let mut store = self.lock()?;
        let original_length = store.todos.len();
        store.todos.retain(|todo| todo.identifier != identifier);
        if store.todos.len() == original_length {
            return Err(todo_not_found());
        }
        self.publish(&store);
        Ok(DeleteTodoResult {
            identifier,
            removed: true,
        })
    }

    pub fn snapshot(&self) -> Result<Vec<Todo>, ActionError> {
        Ok(self.lock()?.todos.clone())
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Vec<Todo>> {
        self.updates.subscribe()
    }

    fn clear_completed(&self) -> Result<ClearCompletedResult, ActionError> {
        let mut store = self.lock()?;
        let original_length = store.todos.len();
        store.todos.retain(|todo| !todo.done);
        let removed = original_length - store.todos.len();
        if removed > 0 {
            self.publish(&store);
        }
        Ok(ClearCompletedResult { removed })
    }

    fn rename(&self, identifier: &str, new_name: String) -> Result<(), ActionError> {
        let mut store = self.lock()?;
        let todo = store
            .todos
            .iter_mut()
            .find(|todo| todo.identifier == identifier)
            .ok_or_else(todo_not_found)?;
        todo.text = new_name;
        self.publish(&store);
        Ok(())
    }

    fn import(&self, text: String, tag: Option<String>) -> Result<Todo, ActionError> {
        self.add(text, tag)
    }

    fn lock(&self) -> Result<MutexGuard<'_, TodoStore>, ActionError> {
        self.store.lock().map_err(|_| {
            ActionError::protocol(
                TesseronErrorCode::HandlerError,
                "Todo state is unavailable",
                None,
            )
        })
    }

    fn publish(&self, store: &TodoStore) {
        let _ = self.updates.send(store.todos.clone());
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
    #[serde(rename = "id")]
    identifier: String,
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
pub struct DeleteTodoResult {
    #[serde(rename = "id")]
    identifier: String,
    removed: bool,
}

#[derive(Serialize)]
struct ClearCompletedResult {
    removed: usize,
}

#[derive(Serialize)]
struct RenameTodoResult {
    #[serde(rename = "id")]
    identifier: String,
    renamed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
    #[serde(rename = "newName", skip_serializing_if = "Option::is_none")]
    new_name: Option<String>,
}

#[derive(Serialize)]
struct ImportedTodosResult {
    added: usize,
    #[serde(rename = "ids")]
    identifiers: Vec<String>,
}

#[derive(Serialize)]
struct SuggestedTodosResult {
    theme: String,
    added: usize,
    #[serde(rename = "ids")]
    identifiers: Vec<String>,
}

fn todo_not_found() -> ActionError {
    ActionError::protocol(
        TesseronErrorCode::HandlerError,
        "Todo not found",
        Some(json!({ "kind": "not_found" })),
    )
}

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

pub fn todo_application(
    application_id: impl Into<String>,
    application_name: impl Into<String>,
) -> (TesseronHostBuilder, TodoList) {
    let todos = TodoList::new();
    let add_todos = todos.clone();
    let toggle_todos = todos.clone();
    let delete_todos = todos.clone();
    let list_todos = todos.clone();
    let clear_todos = todos.clone();
    let rename_todos = todos.clone();
    let import_todos = todos.clone();
    let suggest_todos = todos.clone();

    let builder = Tesseron::builder()
        .application(application_id, application_name)
        .action(Action::typed("addTodo", move |input: AddTodoInput, _context| {
            let todos = add_todos.clone();
            async move { todos.add(input.text, input.tag) }
        }))
        .action(Action::typed(
            "toggleTodo",
            move |input: TodoIdentifierInput, _context| {
                let todos = toggle_todos.clone();
                async move { todos.toggle(&input.identifier) }
            },
        ))
        .action(Action::typed(
            "deleteTodo",
            move |input: TodoIdentifierInput, _context| {
                let todos = delete_todos.clone();
                async move { todos.delete(input.identifier) }
            },
        ))
        .action(Action::typed(
            "listTodos",
            move |input: ListTodosInput, _context| {
                let todos = list_todos.clone();
                async move {
                    let todos = todos.snapshot()?;
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
                let todos = clear_todos.clone();
                async move { todos.clear_completed() }
            },
        ))
        .action(Action::typed(
            "renameTodo",
            move |input: TodoIdentifierInput, context: ActionContext| {
                let todos = rename_todos.clone();
                async move {
                    let previous_text = todos
                        .snapshot()?
                        .into_iter()
                        .find(|todo| todo.identifier == input.identifier)
                        .map(|todo| todo.text)
                        .ok_or_else(todo_not_found)?;
                    let answer = context
                        .elicit_as::<RenameTodoAnswer>(ElicitRequest::for_type::<RenameTodoAnswer>(
                            format!("Rename \"{previous_text}\" to?"),
                        ))
                        .await?;
                    let Some(answer) = answer else {
                        return Ok(RenameTodoResult {
                            identifier: input.identifier,
                            renamed: false,
                            cancelled: Some(true),
                            new_name: None,
                        });
                    };
                    todos.rename(&input.identifier, answer.new_name.clone())?;
                    Ok(RenameTodoResult {
                        identifier: input.identifier,
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
                let todos = import_todos.clone();
                async move {
                    let item_count = input.items.len();
                    let mut identifiers = Vec::with_capacity(item_count);
                    for (index, text) in input.items.into_iter().enumerate() {
                        let todo = todos.import(text, input.tag.clone())?;
                        identifiers.push(todo.identifier);
                        context.progress(
                            ProgressUpdate::new()
                                .message(format!("{}/{} imported", index + 1, item_count))
                                .percent(((index + 1) * 100 / item_count) as f64),
                        );
                    }
                    Ok(ImportedTodosResult {
                        added: identifiers.len(),
                        identifiers,
                    })
                }
            },
        ))
        .action(Action::typed(
            "suggestTodos",
            move |input: SuggestTodosInput, context: ActionContext| {
                let todos = suggest_todos.clone();
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
                    let mut store = todos.lock()?;
                    let suggested_todos = suggested
                        .items
                        .into_iter()
                        .map(|text| store.create(text, Some(input.theme.clone())))
                        .collect::<Vec<_>>();
                    todos.publish(&store);
                    Ok(SuggestedTodosResult {
                        theme: input.theme,
                        added: suggested_todos.len(),
                        identifiers: suggested_todos.into_iter().map(|todo| todo.identifier).collect(),
                    })
                }
            },
        ))
        .resource(todo_resource(todos.clone()));

    (builder, todos)
}
