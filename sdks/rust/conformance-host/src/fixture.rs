//! Turns a conformance fixture document into registered actions and resources.
//!
//! The grammar is the one `conformance/README.md` documents under "Fixture
//! adapter grammar". Anything in that grammar this release cannot serve is
//! rejected here rather than ignored, so a capability the host does not have
//! shows up as a failed launch instead of a fixture that quietly passed.

use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{Map, Value, json};
use tesseron::{
    Action, ActionContext, ActionError, ElicitRequest, ProgressUpdate, Resource, ResourceEmitter,
    Subscription, TesseronHostBuilder,
};

use crate::schema_subset;

/// How far apart queued resource updates are pushed.
///
/// The runner stamps a frame's arrival and compares it with the moment the
/// labeled step finished, so an update written into the same socket flush as
/// the subscription acknowledgement can land too early to satisfy `notBefore`.
/// Spacing the updates out is what a fixture's `afterStep` is asking for.
const UPDATE_SPACING: Duration = Duration::from_millis(25);

/// The whole fixture file. Only the adapter's half is read; `steps` is the
/// runner's script and never reaches the host.
#[derive(Debug, Deserialize)]
struct FixtureDocument {
    #[serde(default)]
    requires: Vec<String>,
    fixture: FixtureApplication,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureApplication {
    #[serde(default)]
    actions: Vec<FixtureAction>,
    #[serde(default)]
    resources: Vec<FixtureResource>,
    #[serde(default)]
    host_minted_claim: Option<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureAction {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    returns: Value,
    #[serde(default)]
    input_schema: Option<Value>,
    #[serde(default)]
    assert_handler_not_called: bool,
    #[serde(default)]
    blocks_until_cancelled: bool,
    /// Progress updates kept as raw objects so an entry carrying an explicit
    /// `"data": null` stays distinguishable from one that omits the key.
    #[serde(default)]
    progress: Vec<Map<String, Value>>,
    #[serde(default)]
    confirms: Option<String>,
    #[serde(default)]
    returns_confirm_result: bool,
    #[serde(default)]
    elicits: Option<FixtureElicitation>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureElicitation {
    question: String,
    /// Handed to the SDK exactly as written, including the shapes the protocol
    /// rejects: these fixtures exist to prove the SDK does the rejecting.
    json_schema: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureResource {
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    value: Value,
    #[serde(default)]
    subscribable: bool,
    /// Each entry is `{ afterStep, value }`. `afterStep` names the runner step
    /// the update has to land behind, which the runner checks on its own side.
    #[serde(default)]
    emits: Vec<Map<String, Value>>,
}

/// Everything one action's handler needs, shared across every invocation of it.
struct ActionScript {
    name: String,
    returns: Value,
    assert_handler_not_called: bool,
    blocks_until_cancelled: bool,
    progress: Vec<Map<String, Value>>,
    confirms: Option<String>,
    returns_confirm_result: bool,
    elicits: Option<FixtureElicitation>,
}

/// Reads a fixture document and registers everything it declares.
///
/// # Errors
///
/// Returns a message naming the capability when the fixture needs behaviour
/// this release does not implement, or when its `inputSchema` uses a keyword
/// the adapter cannot enforce.
pub fn register(
    builder: TesseronHostBuilder,
    document: &str,
) -> Result<TesseronHostBuilder, String> {
    let fixture: FixtureDocument = serde_json::from_str(document)
        .map_err(|problem| format!("unreadable fixture: {problem}"))?;

    if fixture.requires.iter().any(|tag| tag == "uds") {
        return Err(
            "this host speaks WebSocket only; declare uds in TESSERON_CONFORMANCE_UNSUPPORTED"
                .to_owned(),
        );
    }
    if fixture.fixture.host_minted_claim.is_some() {
        return Err(
            "this host uses gateway-minted claims; declare host-minted-claim in TESSERON_CONFORMANCE_UNSUPPORTED"
                .to_owned(),
        );
    }

    let mut builder = builder;
    for action in fixture.fixture.actions {
        builder = builder.action(build_action(action)?);
    }
    for resource in fixture.fixture.resources {
        builder = builder.resource(build_resource(resource)?);
    }
    Ok(builder)
}

fn build_action(fixture: FixtureAction) -> Result<Action, String> {
    let script = Arc::new(ActionScript {
        name: fixture.name.clone(),
        returns: fixture.returns,
        assert_handler_not_called: fixture.assert_handler_not_called,
        blocks_until_cancelled: fixture.blocks_until_cancelled,
        progress: fixture.progress,
        confirms: fixture.confirms,
        returns_confirm_result: fixture.returns_confirm_result,
        elicits: fixture.elicits,
    });

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
    Ok(action)
}

/// Applies the fixture's behaviours in the order `conformance/README.md` fixes:
/// refuse an unexpected call, wait to be cancelled, stream progress, confirm,
/// elicit, then answer with the canned value.
async fn run_action(script: &ActionScript, context: ActionContext) -> Result<Value, ActionError> {
    if script.assert_handler_not_called {
        return Err(ActionError::handler(format!(
            "the handler for {} ran, but the fixture says it must not",
            script.name
        )));
    }
    if script.blocks_until_cancelled {
        // The session answers -32001 when the cancellation arrives and drops
        // this future; anything returned here would race it.
        return std::future::pending::<Result<Value, ActionError>>().await;
    }

    for entry in &script.progress {
        context.progress(progress_update(entry));
    }

    if let Some(question) = &script.confirms {
        let confirmed = context.confirm(question.as_str()).await?;
        if script.returns_confirm_result {
            return Ok(json!({ "confirmed": confirmed }));
        }
    }

    if let Some(elicitation) = &script.elicits {
        context
            .elicit(
                ElicitRequest::new(elicitation.question.as_str())
                    .json_schema(elicitation.json_schema.clone()),
            )
            .await?;
    }

    Ok(script.returns.clone())
}

fn progress_update(entry: &Map<String, Value>) -> ProgressUpdate {
    let mut update = ProgressUpdate::new();
    if let Some(percent) = entry.get("percent").and_then(Value::as_f64) {
        update = update.percent(percent);
    }
    if let Some(message) = entry.get("message").and_then(Value::as_str) {
        update = update.message(message);
    }
    if let Some(data) = entry.get("data") {
        update = update.data(data.clone());
    }
    update
}

fn build_resource(fixture: FixtureResource) -> Result<Resource, String> {
    let updates = Arc::new(queued_updates(&fixture)?);
    let value = Arc::new(fixture.value);
    let mut resource = Resource::new(fixture.name, move || {
        let value = Arc::clone(&value);
        async move { Ok(value.as_ref().clone()) }
    })
    .description(fixture.description);

    if fixture.subscribable {
        resource = resource.subscribe(move |emitter| start_updates(&updates, emitter));
    }
    Ok(resource)
}

fn queued_updates(fixture: &FixtureResource) -> Result<Vec<Value>, String> {
    fixture
        .emits
        .iter()
        .enumerate()
        .map(|(index, update)| {
            update.get("value").cloned().ok_or_else(|| {
                format!(
                    "resource {:?}: emits[{index}] has no value",
                    fixture.name.as_str()
                )
            })
        })
        .collect()
}

fn start_updates(updates: &Arc<Vec<Value>>, emitter: ResourceEmitter) -> Subscription {
    let mut pushing = Vec::with_capacity(updates.len());
    for (index, value) in updates.iter().enumerate() {
        let emitter = emitter.clone();
        let value = value.clone();
        let position = u32::try_from(index).unwrap_or(u32::MAX);
        let delay = UPDATE_SPACING * (position + 1);
        pushing.push(tokio::spawn(async move {
            tokio::time::sleep(delay).await;
            emitter.emit(value);
        }));
    }
    Subscription::new(move || {
        for update in pushing {
            update.abort();
        }
    })
}
