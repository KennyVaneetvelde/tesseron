use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::context::ActionContext;
use crate::error::{ActionError, TesseronErrorCode};
use crate::protocol::ActionDescriptor;

type HandlerFuture = Pin<Box<dyn Future<Output = Result<Value, ActionError>> + Send>>;

/// The erased form of an action handler: JSON in, JSON out, cancellable.
///
/// Typed handlers registered with [`Action::typed`] are wrapped into this shape
/// once, at registration, so the session dispatch loop stays free of generics.
#[derive(Clone)]
pub(crate) struct ActionHandler {
    call: Arc<dyn Fn(Value, ActionContext) -> HandlerFuture + Send + Sync>,
}

impl ActionHandler {
    pub(crate) fn invoke(&self, input: Value, context: ActionContext) -> HandlerFuture {
        (self.call)(input, context)
    }
}

impl fmt::Debug for ActionHandler {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("ActionHandler")
    }
}

/// One thing an invocation input got wrong, as it appears in the `data` member
/// of a `-32004 InputValidation` failure.
#[derive(Clone, Debug, Serialize)]
pub struct ValidationIssue {
    /// Human-readable explanation of what is wrong.
    pub message: String,
    /// Location of the problem inside the input, outermost key first. Empty
    /// when the whole input is wrong.
    pub path: Vec<String>,
}

impl ValidationIssue {
    /// Reports a problem at a location inside the input.
    #[must_use]
    pub fn new(message: impl Into<String>, path: Vec<String>) -> Self {
        Self {
            message: message.into(),
            path,
        }
    }

    /// Reports a problem with the input as a whole.
    #[must_use]
    pub fn at_root(message: impl Into<String>) -> Self {
        Self::new(message, Vec::new())
    }
}

/// Runtime check applied to `actions/invoke` input before the handler runs.
///
/// Actions registered with [`Action::typed`] get this for free from their input
/// type. Actions registered with [`Action::json`] declare a schema for the
/// manifest and supply a validator here when the schema has to be enforced;
/// without one, whatever the gateway sends reaches the handler.
pub trait InputValidator: Send + Sync + 'static {
    /// Returns every problem with the input, or an empty result when it passes.
    fn validate(&self, input: &Value) -> Result<(), Vec<ValidationIssue>>;
}

impl<F> InputValidator for F
where
    F: Fn(&Value) -> Result<(), Vec<ValidationIssue>> + Send + Sync + 'static,
{
    fn validate(&self, input: &Value) -> Result<(), Vec<ValidationIssue>> {
        self(input)
    }
}

/// One action the agent can invoke.
///
/// Two registration shapes, one wire behaviour. [`Action::typed`] derives the
/// manifest schema from the input type and validates by deserialising into it;
/// [`Action::json`] hands raw JSON to the handler and takes its schema and its
/// validator separately.
pub struct Action {
    name: String,
    description: String,
    input_schema: Value,
    typed_input_schema: Option<Value>,
    typed_input_type_name: Option<&'static str>,
    output_schema: Option<Value>,
    timeout: Option<Duration>,
    validator: Option<Arc<dyn InputValidator>>,
    handler: ActionHandler,
}

impl Action {
    /// Registers a handler that takes and returns raw JSON.
    ///
    /// The declared input schema defaults to the permissive `{}`; set a real
    /// one with [`Action::input_schema`] so the agent knows what to send, and
    /// add [`Action::validate_with`] when it must be enforced.
    pub fn json<F, Fut>(name: impl Into<String>, handler: F) -> Self
    where
        F: Fn(Value, ActionContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, ActionError>> + Send + 'static,
    {
        Self {
            name: name.into(),
            description: String::new(),
            input_schema: Value::Object(serde_json::Map::new()),
            typed_input_schema: None,
            typed_input_type_name: None,
            output_schema: None,
            timeout: None,
            validator: None,
            handler: ActionHandler {
                call: Arc::new(move |input, context| Box::pin(handler(input, context))),
            },
        }
    }

    /// Registers a handler over a typed input and a serialisable output.
    ///
    /// The input type is the single source of truth: its [`JsonSchema`] derive
    /// becomes the manifest schema the agent sees, and deserialising into it is
    /// the runtime check, so the published contract and the enforced one cannot
    /// drift apart. Input the type rejects answers `-32004` and the handler
    /// never runs, which is why typed actions need no separate
    /// [`Action::validate_with`].
    pub fn typed<Input, Output, F, Fut>(name: impl Into<String>, handler: F) -> Self
    where
        Input: DeserializeOwned + JsonSchema + Send + 'static,
        Output: Serialize + Send + 'static,
        F: Fn(Input, ActionContext) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Output, ActionError>> + Send + 'static,
    {
        let handler = Arc::new(handler);
        let derived_input_schema = json_schema_for::<Input>();
        Self {
            name: name.into(),
            description: String::new(),
            input_schema: derived_input_schema.clone(),
            typed_input_schema: Some(derived_input_schema),
            typed_input_type_name: Some(std::any::type_name::<Input>()),
            output_schema: None,
            timeout: None,
            validator: None,
            handler: ActionHandler {
                call: Arc::new(move |input, context| {
                    let handler = Arc::clone(&handler);
                    Box::pin(async move {
                        let typed = serde_json::from_value::<Input>(input).map_err(|problem| {
                            ActionError::protocol(
                                TesseronErrorCode::InputValidation,
                                "Invalid input",
                                Some(issues_payload(&[ValidationIssue::at_root(
                                    problem.to_string(),
                                )])),
                            )
                        })?;
                        let output = handler(typed, context).await?;
                        serde_json::to_value(output).map_err(ActionError::internal)
                    })
                }),
            },
        }
    }

    /// Sets the description the agent reads when it picks a tool.
    #[must_use]
    pub fn description(mut self, description: impl Into<String>) -> Self {
        self.description = description.into();
        self
    }

    /// Overrides the JSON Schema published for the input.
    #[must_use]
    pub fn input_schema(mut self, schema: Value) -> Self {
        self.input_schema = schema;
        self
    }

    /// Publishes a JSON Schema for the output. Informational: this crate does
    /// not check handler output against it.
    #[must_use]
    pub fn output_schema(mut self, schema: Value) -> Self {
        self.output_schema = Some(schema);
        self
    }

    /// Publishes the JSON Schema 2020-12 document derived from the action's
    /// output type.
    ///
    /// Supply the same type the handler returns. The schema is manifest metadata
    /// for the agent and does not add runtime output validation.
    #[must_use]
    pub fn output_schema_from_type<Output: JsonSchema>(mut self) -> Self {
        self.output_schema = Some(json_schema_for::<Output>());
        self
    }

    /// Overrides the gateway's 60-second invocation timeout for this action.
    #[must_use]
    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    /// Installs the runtime check applied before the handler runs.
    #[must_use]
    pub fn validate_with(mut self, validator: impl InputValidator) -> Self {
        self.validator = Some(Arc::new(validator));
        self
    }

    /// The registered name, before the gateway prefixes it with the app id.
    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn validate_configuration(&self) -> Result<(), crate::error::HostError> {
        let Some((derived_input_schema, input_type_name)) = self
            .typed_input_schema
            .as_ref()
            .zip(self.typed_input_type_name)
        else {
            return Ok(());
        };
        if has_object_schema(derived_input_schema) && has_object_schema(&self.input_schema) {
            return Ok(());
        }
        Err(crate::error::HostError::InvalidTypedActionInputSchema {
            action_name: self.name.clone(),
            input_type_name,
        })
    }

    pub(crate) fn into_parts(
        self,
    ) -> (
        ActionDescriptor,
        Option<Arc<dyn InputValidator>>,
        ActionHandler,
    ) {
        let descriptor = ActionDescriptor {
            name: self.name,
            description: self.description,
            input_schema: self.input_schema,
            output_schema: self.output_schema,
            timeout_ms: self
                .timeout
                .map(|timeout| u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX)),
        };
        (descriptor, self.validator, self.handler)
    }
}

fn has_object_schema(schema: &Value) -> bool {
    schema
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|schema_type| schema_type == "object")
        && schema.get("properties").is_none_or(Value::is_object)
}

impl fmt::Debug for Action {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Action")
            .field("name", &self.name)
            .field("description", &self.description)
            .finish_non_exhaustive()
    }
}

/// Turns a list of issues into the `data` member of a `-32004` failure.
///
/// The array is the payload, not an object wrapping it, because that is the
/// shape the error catalog pins for `InputValidation`.
pub(crate) fn issues_payload(issues: &[ValidationIssue]) -> Value {
    serde_json::to_value(issues).unwrap_or(Value::Null)
}

/// Generates the JSON Schema 2020-12 document schemars derives for a type.
pub(crate) fn json_schema_for<T: JsonSchema>() -> Value {
    SchemaSettings::draft2020_12()
        .into_generator()
        .into_root_schema_for::<T>()
        .to_value()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize, JsonSchema)]
    struct AddInput {
        first: i64,
        second: i64,
    }

    #[derive(serde::Deserialize, JsonSchema)]
    struct EmptyInput {}

    #[derive(serde::Deserialize, JsonSchema)]
    struct NestedSettings {
        enabled: bool,
    }

    #[derive(serde::Deserialize, JsonSchema)]
    #[serde(rename_all = "snake_case")]
    enum TicketState {
        Todo,
        Done,
    }

    #[derive(serde::Deserialize, JsonSchema)]
    #[serde(rename_all = "camelCase")]
    struct StructuredInput {
        optional_label: Option<String>,
        nested_settings: NestedSettings,
        current_state: TicketState,
    }

    #[derive(serde::Serialize, JsonSchema)]
    struct Added {
        id: u64,
    }

    #[derive(serde::Deserialize, JsonSchema)]
    enum SearchScope {
        Current,
        All,
    }

    #[tokio::test]
    async fn a_typed_action_publishes_its_derived_schema() {
        let action = Action::typed(
            "add",
            |input: AddInput, _context: ActionContext| async move {
                Ok(serde_json::json!({ "sum": input.first + input.second }))
            },
        );
        let (descriptor, validator, _handler) = action.into_parts();
        assert_eq!(descriptor.name, "add");
        assert_eq!(descriptor.input_schema["type"], "object");
        assert!(descriptor.input_schema["properties"]["first"].is_object());
        assert!(validator.is_none(), "the input type is the check");
    }

    #[tokio::test]
    async fn a_json_action_defaults_to_a_permissive_schema_and_no_validator() {
        let action = Action::json(
            "passthrough",
            |input: Value, _context: ActionContext| async move { Ok(input) },
        );
        let (descriptor, validator, handler) = action.into_parts();
        assert_eq!(descriptor.input_schema, serde_json::json!({}));
        assert!(validator.is_none());
        let context = ActionContext::detached("passthrough", "i-1");
        let output = handler
            .invoke(serde_json::json!({ "kept": true }), context)
            .await
            .unwrap();
        assert_eq!(output, serde_json::json!({ "kept": true }));
    }

    #[tokio::test]
    async fn a_typed_handler_rejects_input_its_type_cannot_hold() {
        let action = Action::typed(
            "add",
            |input: AddInput, _context: ActionContext| async move { Ok(input.first + input.second) },
        );
        let (_descriptor, _validator, handler) = action.into_parts();
        let context = ActionContext::detached("add", "i-1");
        let error = handler
            .invoke(serde_json::json!({ "first": "one", "second": 2 }), context)
            .await
            .expect_err("a string is not an i64");
        assert_eq!(error.code(), TesseronErrorCode::InputValidation);
        assert!(error.data().is_some_and(Value::is_array));
    }

    #[test]
    fn a_typed_action_uses_a_2020_12_object_schema_for_structured_input() {
        let StructuredInput {
            optional_label,
            nested_settings,
            current_state,
        } = StructuredInput {
            optional_label: None,
            nested_settings: NestedSettings { enabled: true },
            current_state: TicketState::Todo,
        };
        assert!(optional_label.is_none());
        assert!(nested_settings.enabled);
        assert!(matches!(current_state, TicketState::Todo));

        let schema = json_schema_for::<StructuredInput>();
        assert_eq!(
            schema,
            serde_json::json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "title": "StructuredInput",
                "type": "object",
                "properties": {
                    "optionalLabel": {
                        "type": ["string", "null"]
                    },
                    "nestedSettings": { "$ref": "#/$defs/NestedSettings" },
                    "currentState": { "$ref": "#/$defs/TicketState" }
                },
                "required": ["nestedSettings", "currentState"],
                "$defs": {
                    "NestedSettings": {
                        "type": "object",
                        "properties": { "enabled": { "type": "boolean" } },
                        "required": ["enabled"]
                    },
                    "TicketState": {
                        "type": "string",
                        "enum": ["todo", "done"]
                    }
                }
            })
        );
    }

    #[test]
    fn an_output_schema_is_absent_until_the_action_opts_in() {
        let action = Action::typed(
            "add",
            |input: AddInput, _context: ActionContext| async move {
                Ok(Added {
                    id: input.first as u64,
                })
            },
        );
        let (descriptor, _validator, _handler) = action.into_parts();
        assert!(descriptor.output_schema.is_none());
    }

    #[test]
    fn an_output_schema_is_published_when_the_action_opts_in() {
        let action = Action::typed(
            "add",
            |input: AddInput, _context: ActionContext| async move {
                Ok(Added {
                    id: input.first as u64,
                })
            },
        )
        .output_schema_from_type::<Added>();
        let (descriptor, _validator, _handler) = action.into_parts();
        assert_eq!(
            descriptor.output_schema,
            Some(serde_json::json!({
                "$schema": "https://json-schema.org/draft/2020-12/schema",
                "title": "Added",
                "type": "object",
                "properties": { "id": { "type": "integer", "format": "uint64", "minimum": 0 } },
                "required": ["id"]
            }))
        );
    }

    #[tokio::test]
    async fn listen_accepts_a_typed_empty_struct_input() {
        let action = Action::typed(
            "empty",
            |_input: EmptyInput, _context: ActionContext| async move { Ok(()) },
        );
        let (descriptor, _validator, _handler) = action.into_parts();
        assert_eq!(descriptor.input_schema["type"], "object");
        assert!(descriptor.input_schema.get("properties").is_none());

        let action = Action::typed(
            "empty",
            |_input: EmptyInput, _context: ActionContext| async move { Ok(()) },
        );
        crate::Tesseron::builder()
            .application("test", "Test")
            .manifest(crate::ManifestPublication::Disabled)
            .action(action)
            .listen()
            .await
            .expect("the listener must accept an empty struct input schema")
            .shutdown()
            .await
            .expect("the accepted listener must shut down");
    }

    #[tokio::test]
    async fn listen_rejects_typed_inputs_without_an_object_schema() {
        assert_invalid_typed_input_schema(
            "string",
            "String",
            Action::typed(
                "string",
                |input: String, _context: ActionContext| async move { Ok(input) },
            ),
        )
        .await;
        assert_invalid_typed_input_schema(
            "enum",
            "SearchScope",
            Action::typed(
                "enum",
                |input: SearchScope, _context: ActionContext| async move {
                    Ok(match input {
                        SearchScope::Current => "current".to_owned(),
                        SearchScope::All => "all".to_owned(),
                    })
                },
            ),
        )
        .await;
        assert_invalid_typed_input_schema(
            "list",
            "Vec",
            Action::typed(
                "list",
                |input: Vec<String>, _context: ActionContext| async move { Ok(input) },
            ),
        )
        .await;
        assert_invalid_typed_input_schema(
            "overridden",
            "AddInput",
            Action::typed(
                "overridden",
                |input: AddInput, _context: ActionContext| async move {
                    Ok(Added {
                        id: input.first as u64,
                    })
                },
            )
            .input_schema(serde_json::json!({ "type": "string" })),
        )
        .await;
    }

    async fn assert_invalid_typed_input_schema(
        expected_action_name: &str,
        expected_input_type_name: &str,
        action: Action,
    ) {
        let error = crate::Tesseron::builder()
            .application("test", "Test")
            .manifest(crate::ManifestPublication::Disabled)
            .action(action)
            .listen()
            .await
            .expect_err("the listener must reject a scalar typed input schema");
        let message = error.to_string();
        assert!(message.contains(expected_action_name));
        assert!(message.contains(expected_input_type_name));
        match error {
            crate::HostError::InvalidTypedActionInputSchema {
                action_name,
                input_type_name,
            } => {
                assert_eq!(action_name, expected_action_name);
                assert!(input_type_name.contains(expected_input_type_name));
            }
            other => panic!("expected a typed-input configuration error, got {other}"),
        }
    }
}
