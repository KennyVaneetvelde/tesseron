#![allow(missing_docs)]

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tesseron::{
    Action, ActionContext, ActionError, ElicitRequest, HostEvent, ProgressUpdate, Resource,
    SampleRequest, Subscription, Tesseron, TesseronErrorCode,
};
use tokio::sync::broadcast;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Prompt {
    id: String,
    name: String,
    template: String,
    tags: Vec<String>,
    created_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_tested_at: Option<u64>,
    times_tested: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TestResult {
    prompt_id: String,
    prompt_name: String,
    input: BTreeMap<String, String>,
    response: String,
    tested_at: u64,
}

struct PromptStore {
    next_identifier: u64,
    prompts: HashMap<String, Prompt>,
    last_test: Option<TestResult>,
    library_updates: broadcast::Sender<Vec<Prompt>>,
    last_test_updates: broadcast::Sender<Option<TestResult>>,
}

impl PromptStore {
    fn new(
        library_updates: broadcast::Sender<Vec<Prompt>>,
        last_test_updates: broadcast::Sender<Option<TestResult>>,
    ) -> Self {
        Self {
            next_identifier: 1,
            prompts: HashMap::new(),
            last_test: None,
            library_updates,
            last_test_updates,
        }
    }

    fn library_snapshot(&self) -> Vec<Prompt> {
        let mut prompts = self.prompts.values().cloned().collect::<Vec<_>>();
        prompts.sort_by(|left, right| left.id.cmp(&right.id));
        prompts
    }

    fn create(&mut self, name: String, template: String, tags: Vec<String>) -> Prompt {
        let prompt = Prompt {
            id: format!("p{}", self.next_identifier),
            name,
            template,
            tags,
            created_at: timestamp(),
            last_tested_at: None,
            times_tested: 0,
        };
        self.next_identifier += 1;
        self.prompts.insert(prompt.id.clone(), prompt.clone());
        prompt
    }

    fn publish_library(&self) {
        let _ = self.library_updates.send(self.library_snapshot());
    }

    fn publish_last_test(&self) {
        let _ = self.last_test_updates.send(self.last_test.clone());
    }
}

#[derive(Deserialize, JsonSchema)]
struct AddPromptInput {
    #[schemars(length(min = 1))]
    name: String,
    #[schemars(length(min = 1))]
    template: String,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
struct ListPromptsInput {
    tag: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
struct PromptIdentifierInput {
    id: String,
}

#[derive(Deserialize, JsonSchema)]
struct TestPromptInput {
    id: String,
    variables: Option<BTreeMap<String, String>>,
}

#[derive(Deserialize, JsonSchema)]
struct RefinePromptAnswer {
    #[schemars(length(min = 1))]
    instruction: String,
}

#[derive(Deserialize, JsonSchema)]
struct GenerateVariantsInput {
    id: String,
    #[schemars(range(min = 1, max = 10))]
    count: Option<u8>,
}

#[derive(Deserialize)]
struct VariantResponse {
    variants: Vec<String>,
}

#[derive(Deserialize, JsonSchema)]
struct ImportedPrompt {
    #[schemars(length(min = 1))]
    name: String,
    #[schemars(length(min = 1))]
    template: String,
    tags: Option<Vec<String>>,
}

#[derive(Deserialize, JsonSchema)]
struct ImportPromptsInput {
    #[schemars(length(min = 1, max = 50))]
    items: Vec<ImportedPrompt>,
}

#[derive(Deserialize, JsonSchema)]
struct EmptyInput {}

#[derive(Deserialize, JsonSchema)]
struct PurgeAnswer {
    confirmation: String,
}

#[derive(Serialize)]
struct DeletePromptResult {
    id: String,
    deleted: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TestPromptResult {
    id: String,
    response: String,
    times_tested: u64,
}

#[derive(Serialize)]
struct RefinePromptResult {
    id: String,
    refined: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    instruction: Option<String>,
    #[serde(rename = "previousTemplate", skip_serializing_if = "Option::is_none")]
    previous_template: Option<String>,
    #[serde(rename = "newTemplate", skip_serializing_if = "Option::is_none")]
    new_template: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GeneratedVariantsResult {
    source_id: String,
    added: usize,
    ids: Vec<String>,
}

#[derive(Serialize)]
struct ImportedPromptsResult {
    added: usize,
    ids: Vec<String>,
}

#[derive(Serialize)]
struct PurgeResult {
    removed: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_millis() as u64)
}

fn prompt_not_found() -> ActionError {
    ActionError::protocol(
        TesseronErrorCode::HandlerError,
        "Prompt not found",
        Some(json!({ "kind": "not_found" })),
    )
}

fn lock_store(store: &Mutex<PromptStore>) -> Result<MutexGuard<'_, PromptStore>, ActionError> {
    store.lock().map_err(|_| {
        ActionError::protocol(
            TesseronErrorCode::HandlerError,
            "Prompt state is unavailable",
            None,
        )
    })
}

fn prompt_library(store: &Arc<Mutex<PromptStore>>) -> Result<Vec<Prompt>, ActionError> {
    let store = lock_store(store)?;
    Ok(store.library_snapshot())
}

fn sampled_text(value: Value) -> Result<String, ActionError> {
    match value {
        Value::String(text) => Ok(text),
        value => Err(ActionError::protocol(
            TesseronErrorCode::HandlerError,
            "The sampling result was not text",
            Some(json!({ "content": value })),
        )),
    }
}

fn fill_template(
    template: &str,
    variables: &BTreeMap<String, String>,
) -> Result<String, ActionError> {
    let mut rendered = String::with_capacity(template.len());
    let mut remainder = template;
    while let Some(start) = remainder.find("{{") {
        rendered.push_str(&remainder[..start]);
        let after_open = &remainder[start + 2..];
        let Some(end) = after_open.find("}}") else {
            rendered.push_str(&remainder[start..]);
            return Ok(rendered);
        };
        let variable = after_open[..end].trim();
        let value = variables.get(variable).ok_or_else(|| {
            ActionError::protocol(
                TesseronErrorCode::HandlerError,
                format!("Missing variable \"{variable}\" for prompt template"),
                None,
            )
        })?;
        rendered.push_str(value);
        remainder = &after_open[end + 2..];
    }
    rendered.push_str(remainder);
    Ok(rendered)
}

fn library_resource(
    store: Arc<Mutex<PromptStore>>,
    updates: broadcast::Sender<Vec<Prompt>>,
) -> Resource {
    let resource_store = Arc::clone(&store);
    Resource::new("library", move || {
        let store = Arc::clone(&resource_store);
        async move {
            let library = prompt_library(&store)?;
            serde_json::to_value(library).map_err(ActionError::internal)
        }
    })
    .description("Live snapshot of every prompt in the library. Pushed on every change.")
    .subscribe(move |emitter| {
        let mut updates = updates.subscribe();
        let task = tokio::spawn(async move {
            while let Ok(library) = updates.recv().await {
                if let Ok(value) = serde_json::to_value(library) {
                    emitter.emit(value);
                }
            }
        });
        Subscription::new(move || task.abort())
    })
}

fn last_test_resource(
    store: Arc<Mutex<PromptStore>>,
    updates: broadcast::Sender<Option<TestResult>>,
) -> Resource {
    let resource_store = Arc::clone(&store);
    Resource::new("lastTest", move || {
        let store = Arc::clone(&resource_store);
        async move {
            let store = lock_store(&store)?;
            serde_json::to_value(store.last_test.clone()).map_err(ActionError::internal)
        }
    })
    .description(
        "The most recent test result from testPrompt, or null if no prompt has been tested.",
    )
    .subscribe(move |emitter| {
        let mut updates = updates.subscribe();
        let task = tokio::spawn(async move {
            while let Ok(last_test) = updates.recv().await {
                if let Ok(value) = serde_json::to_value(last_test) {
                    emitter.emit(value);
                }
            }
        });
        Subscription::new(move || task.abort())
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (library_updates, _) = broadcast::channel(32);
    let (last_test_updates, _) = broadcast::channel(32);
    let store = Arc::new(Mutex::new(PromptStore::new(
        library_updates.clone(),
        last_test_updates.clone(),
    )));

    let add_store = Arc::clone(&store);
    let list_store = Arc::clone(&store);
    let delete_store = Arc::clone(&store);
    let test_store = Arc::clone(&store);
    let refine_store = Arc::clone(&store);
    let variants_store = Arc::clone(&store);
    let import_store = Arc::clone(&store);
    let purge_store = Arc::clone(&store);

    let builder = Tesseron::builder()
        .application("rust_prompts", "Rust Prompts")
        .action(Action::typed("addPrompt", move |input: AddPromptInput, _context| {
            let store = Arc::clone(&add_store);
            async move {
                let mut store = lock_store(&store)?;
                let prompt = store.create(input.name, input.template, input.tags.unwrap_or_default());
                store.publish_library();
                Ok(prompt)
            }
        }))
        .action(Action::typed(
            "listPrompts",
            move |input: ListPromptsInput, _context| {
                let store = Arc::clone(&list_store);
                async move {
                    let prompts = prompt_library(&store)?;
                    Ok(match input.tag {
                        Some(tag) => prompts
                            .into_iter()
                            .filter(|prompt| prompt.tags.contains(&tag))
                            .collect::<Vec<_>>(),
                        None => prompts,
                    })
                }
            },
        ))
        .action(Action::typed(
            "deletePrompt",
            move |input: PromptIdentifierInput, context: ActionContext| {
                let store = Arc::clone(&delete_store);
                async move {
                    let prompt = {
                        let store = lock_store(&store)?;
                        store.prompts.get(&input.id).cloned().ok_or_else(prompt_not_found)?
                    };
                    let confirmed = context
                        .confirm(format!(
                            "Delete prompt \"{}\" (tested {}x)? This cannot be undone.",
                            prompt.name, prompt.times_tested
                        ))
                        .await?;
                    if !confirmed {
                        return Ok(DeletePromptResult {
                            id: input.id,
                            deleted: false,
                            cancelled: Some(true),
                        });
                    }
                    let mut store = lock_store(&store)?;
                    store.prompts.remove(&input.id).ok_or_else(prompt_not_found)?;
                    store.publish_library();
                    Ok(DeletePromptResult {
                        id: input.id,
                        deleted: true,
                        cancelled: None,
                    })
                }
            },
        ))
        .action(Action::typed(
            "testPrompt",
            move |input: TestPromptInput, context: ActionContext| {
                let store = Arc::clone(&test_store);
                async move {
                    let prompt = {
                        let store = lock_store(&store)?;
                        store.prompts.get(&input.id).cloned().ok_or_else(prompt_not_found)?
                    };
                    let variables = input.variables.unwrap_or_default();
                    let filled = fill_template(&prompt.template, &variables)?;
                    context.progress(ProgressUpdate::new().message("asking LLM...").percent(25.0));
                    let response = sampled_text(
                        context
                            .sample(SampleRequest::new(filled).max_tokens(512))
                            .await?,
                    )?;
                    context.progress(
                        ProgressUpdate::new()
                            .message("storing result...")
                            .percent(90.0),
                    );
                    let mut store = lock_store(&store)?;
                    let prompt = store.prompts.get_mut(&input.id).ok_or_else(prompt_not_found)?;
                    prompt.last_tested_at = Some(timestamp());
                    prompt.times_tested += 1;
                    let result = TestResult {
                        prompt_id: prompt.id.clone(),
                        prompt_name: prompt.name.clone(),
                        input: variables,
                        response: response.clone(),
                        tested_at: timestamp(),
                    };
                    let times_tested = prompt.times_tested;
                    store.last_test = Some(result);
                    store.publish_library();
                    store.publish_last_test();
                    Ok(TestPromptResult {
                        id: input.id,
                        response,
                        times_tested,
                    })
                }
            },
        ))
        .action(Action::typed(
            "refinePrompt",
            move |input: PromptIdentifierInput, context: ActionContext| {
                let store = Arc::clone(&refine_store);
                async move {
                    let prompt = {
                        let store = lock_store(&store)?;
                        store.prompts.get(&input.id).cloned().ok_or_else(prompt_not_found)?
                    };
                    let answer = context
                        .elicit_as::<RefinePromptAnswer>(ElicitRequest::for_type::<RefinePromptAnswer>(format!(
                            "Refining \"{}\". What should change? (e.g. \"make it more concise\", \"demand JSON output\", \"add a role\")",
                            prompt.name
                        )))
                        .await?;
                    let Some(answer) = answer else {
                        return Ok(RefinePromptResult {
                            id: input.id,
                            refined: false,
                            cancelled: Some(true),
                            instruction: None,
                            previous_template: None,
                            new_template: None,
                        });
                    };
                    context.progress(
                        ProgressUpdate::new()
                            .message("applying refinement...")
                            .percent(40.0),
                    );
                    let rewritten = sampled_text(
                        context
                            .sample(
                                SampleRequest::new(format!(
                                    "You rewrite prompt templates. Return the new template only, no prose.\n\nOriginal template:\n{}\n\nInstruction: {}",
                                    prompt.template, answer.instruction
                                ))
                                .max_tokens(800),
                            )
                            .await?,
                    )?;
                    let mut store = lock_store(&store)?;
                    let prompt = store.prompts.get_mut(&input.id).ok_or_else(prompt_not_found)?;
                    let previous_template = prompt.template.clone();
                    prompt.template = rewritten.trim().to_owned();
                    let new_template = prompt.template.clone();
                    store.publish_library();
                    Ok(RefinePromptResult {
                        id: input.id,
                        refined: true,
                        cancelled: None,
                        instruction: Some(answer.instruction),
                        previous_template: Some(previous_template),
                        new_template: Some(new_template),
                    })
                }
            },
        ))
        .action(Action::typed(
            "generateVariants",
            move |input: GenerateVariantsInput, context: ActionContext| {
                let store = Arc::clone(&variants_store);
                async move {
                    let source = {
                        let store = lock_store(&store)?;
                        store.prompts.get(&input.id).cloned().ok_or_else(prompt_not_found)?
                    };
                    let count = input.count.unwrap_or(3);
                    context.progress(
                        ProgressUpdate::new()
                            .message("requesting variants...")
                            .percent(10.0),
                    );
                    let schema = json!({
                        "type": "object",
                        "properties": {
                            "variants": {
                                "type": "array",
                                "items": { "type": "string", "minLength": 10 },
                                "minItems": count,
                                "maxItems": count
                            }
                        },
                        "required": ["variants"]
                    });
                    let response = context
                        .sample_as::<VariantResponse>(
                            SampleRequest::new(format!(
                                "Produce exactly {count} distinct variations of the prompt below. Vary the phrasing, tone, or structure, but preserve the intent. Return JSON: {{ variants: string[] }}.\n\nPrompt:\n{}",
                                source.template
                            ))
                            .json_schema(schema)
                            .max_tokens(1200),
                        )
                        .await?;
                    let mut store = lock_store(&store)?;
                    let mut ids = Vec::with_capacity(response.variants.len());
                    for (index, template) in response.variants.into_iter().enumerate() {
                        let prompt = store.create(
                            format!("{} (variant {})", source.name, index + 1),
                            template,
                            source
                                .tags
                                .iter()
                                .cloned()
                                .chain(std::iter::once("variant".to_owned()))
                                .collect(),
                        );
                        ids.push(prompt.id);
                        context.progress(
                            ProgressUpdate::new()
                                .message(format!("variant {}/{} stored", index + 1, count))
                                .percent(((index + 1) * 100 / usize::from(count)) as f64),
                        );
                    }
                    store.publish_library();
                    Ok(GeneratedVariantsResult {
                        source_id: input.id,
                        added: ids.len(),
                        ids,
                    })
                }
            },
        ))
        .action(Action::typed(
            "importPrompts",
            move |input: ImportPromptsInput, context: ActionContext| {
                let store = Arc::clone(&import_store);
                async move {
                    let item_count = input.items.len();
                    let mut ids = Vec::with_capacity(item_count);
                    for (index, item) in input.items.into_iter().enumerate() {
                        let prompt = {
                            let mut store = lock_store(&store)?;
                            let prompt = store.create(item.name, item.template, item.tags.unwrap_or_default());
                            store.publish_library();
                            prompt
                        };
                        ids.push(prompt.id);
                        context.progress(
                            ProgressUpdate::new()
                                .message(format!("{}/{} imported", index + 1, item_count))
                                .percent(((index + 1) * 100 / item_count) as f64),
                        );
                    }
                    Ok(ImportedPromptsResult {
                        added: ids.len(),
                        ids,
                    })
                }
            },
        ))
        .action(Action::typed(
            "purgeAll",
            move |_input: EmptyInput, context: ActionContext| {
                let store = Arc::clone(&purge_store);
                async move {
                    let prompt_count = {
                        let store = lock_store(&store)?;
                        store.prompts.len()
                    };
                    if prompt_count == 0 {
                        return Ok(PurgeResult {
                            removed: 0,
                            cancelled: None,
                        });
                    }
                    let answer = context
                        .elicit_as::<PurgeAnswer>(ElicitRequest::for_type::<PurgeAnswer>(format!(
                            "Permanently delete ALL {prompt_count} prompts? Type \"DELETE\" to confirm."
                        )))
                        .await?;
                    if answer.as_ref().is_none_or(|answer| answer.confirmation.trim() != "DELETE") {
                        return Ok(PurgeResult {
                            removed: 0,
                            cancelled: Some(true),
                        });
                    }
                    let mut store = lock_store(&store)?;
                    store.prompts.clear();
                    store.last_test = None;
                    store.publish_library();
                    store.publish_last_test();
                    Ok(PurgeResult {
                        removed: prompt_count,
                        cancelled: None,
                    })
                }
            },
        ))
        .resource(library_resource(Arc::clone(&store), library_updates))
        .resource(last_test_resource(Arc::clone(&store), last_test_updates));
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
