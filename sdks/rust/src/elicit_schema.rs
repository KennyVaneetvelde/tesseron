//! The shape rules an `elicitation/request` schema has to satisfy.
//!
//! MCP renders an elicit prompt as a flat form, so the protocol constrains the
//! schema to a single object of primitive leaves. The host checks on the send
//! path, before the frame leaves, so the failure lands at the `ctx.elicit` call
//! site instead of surfacing as a gateway rejection three hops later.

use serde_json::{Map, Value};

use crate::error::{ActionError, TesseronErrorCode};

/// The types an elicited property may declare.
const PRIMITIVE_TYPES: [&str; 4] = ["string", "number", "integer", "boolean"];

/// Keywords that would ask the agent to render more than one shape.
const COMPOSITION_KEYWORDS: [&str; 4] = ["oneOf", "anyOf", "allOf", "not"];

/// The schema [`crate::ActionContext::confirm`] sends: an object with no
/// properties, which MCP clients render as a bare accept-or-decline prompt.
#[must_use]
pub(crate) fn confirmation_schema() -> Value {
    serde_json::json!({ "type": "object", "properties": {}, "required": [] })
}

/// The fallback for an elicit request that declares no schema of its own. One
/// text field, which is the least a client can render.
#[must_use]
pub(crate) fn permissive_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": { "response": { "type": "string", "description": "Your response" } },
        "required": ["response"]
    })
}

/// Checks a schema against the protocol 1.2.0 elicitation rules.
///
/// # Errors
///
/// Returns `-32602 InvalidParams` naming the first rule the schema breaks.
pub(crate) fn validate(schema: &Value) -> Result<(), ActionError> {
    let Value::Object(members) = schema else {
        return Err(rejection("elicit jsonSchema must be a JSON Schema object."));
    };
    if members.get("type") != Some(&Value::String("object".to_owned())) {
        return Err(rejection(format!(
            "elicit jsonSchema must be {{ type: \"object\" }} at the top level; got type={}. \
             Compose a flat object of primitives.",
            members.get("type").unwrap_or(&Value::Null)
        )));
    }
    for keyword in COMPOSITION_KEYWORDS {
        if members.get(keyword).is_some_and(is_truthy) {
            return Err(rejection(
                "elicit jsonSchema must not use top-level oneOf/anyOf/allOf/not: MCP elicit \
                 clients require a single flat object shape.",
            ));
        }
    }
    if let Some(Value::Object(properties)) = members.get("properties") {
        validate_properties(properties)?;
    }
    Ok(())
}

fn validate_properties(properties: &Map<String, Value>) -> Result<(), ActionError> {
    for (name, property) in properties {
        let Value::Object(members) = property else {
            continue;
        };
        // A `type` array declares alternatives the client may pick between, and
        // 1.2.0 checks only the first entry. Tightening that would reject
        // schemas that pass today, so it waits for a future minor.
        let declared = match members.get("type") {
            Some(Value::Array(alternatives)) => alternatives.first().unwrap_or(&Value::Null),
            Some(other) => other,
            None => continue,
        };
        // A property with no usable type is accepted unchanged: the validator
        // does not infer one from the property's other keywords.
        if !is_truthy(declared) {
            continue;
        }
        if declared
            .as_str()
            .is_some_and(|name| PRIMITIVE_TYPES.contains(&name))
        {
            continue;
        }
        return Err(rejection(format!(
            "elicit jsonSchema property {name:?} has unsupported type {declared}. MCP \
             elicitation requires primitive-typed leaves (string, number, integer, boolean)."
        )));
    }
    Ok(())
}

/// JavaScript truthiness, because the rule is written against what the
/// TypeScript validator accepts and an empty array or object is truthy there.
fn is_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

fn rejection(message: impl Into<String>) -> ActionError {
    ActionError::protocol(TesseronErrorCode::InvalidParams, message, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rejects(schema: Value) -> ActionError {
        validate(&schema).expect_err("this schema breaks an elicitation rule")
    }

    #[test]
    fn the_confirmation_and_permissive_defaults_pass_their_own_rules() {
        assert!(validate(&confirmation_schema()).is_ok());
        assert!(validate(&permissive_schema()).is_ok());
    }

    #[test]
    fn the_documented_rejection_matrix_answers_invalid_params() {
        for schema in [
            serde_json::json!("not-an-object"),
            serde_json::json!({ "type": "string" }),
            serde_json::json!({ "type": "object", "oneOf": [{ "type": "object" }] }),
            serde_json::json!({ "type": "object", "anyOf": [{ "type": "object" }] }),
            serde_json::json!({ "type": "object", "allOf": [{ "type": "object" }] }),
            serde_json::json!({ "type": "object", "not": { "type": "object" } }),
            serde_json::json!({ "type": "object", "properties": { "v": { "type": "object" } } }),
            serde_json::json!({ "type": "object", "properties": { "v": { "type": "array" } } }),
            serde_json::json!({
                "type": "object",
                "properties": { "v": { "type": { "unsupported": true } } }
            }),
            serde_json::json!({
                "type": "object",
                "properties": { "v": { "type": ["object", "string"] } }
            }),
        ] {
            assert_eq!(rejects(schema).code(), TesseronErrorCode::InvalidParams);
        }
    }

    #[test]
    fn a_property_without_a_type_is_accepted_unchanged() {
        assert!(
            validate(&serde_json::json!({
                "type": "object",
                "properties": { "value": { "minLength": 1 } }
            }))
            .is_ok()
        );
    }

    #[test]
    fn a_primitive_first_entry_carries_a_type_array() {
        assert!(
            validate(&serde_json::json!({
                "type": "object",
                "properties": { "value": { "type": ["string", "object"] } }
            }))
            .is_ok()
        );
    }

    #[test]
    fn a_falsy_declared_type_is_left_alone_like_a_missing_one() {
        for declared in [
            serde_json::json!(null),
            serde_json::json!(false),
            serde_json::json!(0),
            serde_json::json!(""),
            serde_json::json!([]),
        ] {
            assert!(
                validate(&serde_json::json!({
                    "type": "object",
                    "properties": { "value": { "type": declared } }
                }))
                .is_ok(),
                "{declared} should be treated as no declared type"
            );
        }
    }

    #[test]
    fn a_falsy_composition_keyword_is_not_a_composition() {
        assert!(validate(&serde_json::json!({ "type": "object", "not": false })).is_ok());
    }
}
