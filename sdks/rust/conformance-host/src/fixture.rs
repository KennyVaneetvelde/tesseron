//! Turns a conformance fixture document into registered actions and resources.
//!
//! The grammar is the one `conformance/README.md` documents under "Fixture
//! adapter grammar". Anything in that grammar this release cannot serve is
//! rejected here rather than ignored, so a capability the host does not have
//! shows up as a failed launch instead of a fixture that quietly passed.

use std::sync::Arc;

use serde::Deserialize;
use serde_json::Value;
use tesseron::{Action, ActionContext, ActionError, Resource, TesseronHostBuilder};

use crate::schema_subset;

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
    #[serde(default)]
    progress: Option<Value>,
    #[serde(default)]
    confirms: Option<Value>,
    #[serde(default)]
    returns_confirm_result: Option<Value>,
    #[serde(default)]
    elicits: Option<Value>,
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
    #[serde(default)]
    emits: Option<Value>,
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
    reject_unimplemented(
        &fixture.name,
        "progress",
        fixture.progress.as_ref(),
        "streaming",
    )?;
    reject_unimplemented(
        &fixture.name,
        "confirms",
        fixture.confirms.as_ref(),
        "elicitation",
    )?;
    reject_unimplemented(
        &fixture.name,
        "returnsConfirmResult",
        fixture.returns_confirm_result.as_ref(),
        "elicitation",
    )?;
    reject_unimplemented(
        &fixture.name,
        "elicits",
        fixture.elicits.as_ref(),
        "elicitation",
    )?;

    let name = fixture.name.clone();
    let returns = Arc::new(fixture.returns);
    let assert_handler_not_called = fixture.assert_handler_not_called;
    let blocks_until_cancelled = fixture.blocks_until_cancelled;

    let mut action = Action::json(
        fixture.name,
        move |_input: Value, _context: ActionContext| {
            let returns = Arc::clone(&returns);
            let name = name.clone();
            async move {
                if assert_handler_not_called {
                    return Err(ActionError::handler(format!(
                        "the handler for {name} ran, but the fixture says it must not"
                    )));
                }
                if blocks_until_cancelled {
                    // The session answers -32001 when the cancellation arrives and
                    // drops this future; anything returned here would race it.
                    return std::future::pending::<Result<Value, ActionError>>().await;
                }
                Ok(returns.as_ref().clone())
            }
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

fn build_resource(fixture: FixtureResource) -> Result<Resource, String> {
    if fixture.emits.is_some() {
        return Err(format!(
            "resource {:?} needs pushed updates; declare subscriptions in TESSERON_CONFORMANCE_UNSUPPORTED",
            fixture.name
        ));
    }
    let value = Arc::new(fixture.value);
    Ok(Resource::new(fixture.name, move || {
        let value = Arc::clone(&value);
        async move { Ok(value.as_ref().clone()) }
    })
    .description(fixture.description)
    .subscribable(fixture.subscribable))
}

fn reject_unimplemented(
    action: &str,
    field: &str,
    present: Option<&Value>,
    capability: &str,
) -> Result<(), String> {
    if present.is_some() {
        return Err(format!(
            "action {action:?} needs {field}; declare {capability} in TESSERON_CONFORMANCE_UNSUPPORTED"
        ));
    }
    Ok(())
}
