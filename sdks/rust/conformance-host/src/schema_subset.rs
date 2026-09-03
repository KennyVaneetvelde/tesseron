//! The JSON Schema keywords this adapter can enforce.
//!
//! Fixture `inputSchema` documents are raw JSON, so something has to check
//! invocation input against them. Rather than pull a full JSON Schema
//! implementation into a test binary, this module covers the keywords the
//! corpus actually uses and refuses, at registration time, any schema that
//! needs more. A fixture that would otherwise pass because a keyword was
//! silently ignored fails the run instead.

use serde_json::Value;
use tesseron::ValidationIssue;

const SUPPORTED_KEYWORDS: [&str; 10] = [
    "$schema",
    "additionalProperties",
    "const",
    "default",
    "description",
    "enum",
    "items",
    "properties",
    "required",
    "type",
];

/// Rejects a schema using a keyword this module cannot enforce.
pub fn assert_enforceable(schema: &Value) -> Result<(), String> {
    let Value::Object(members) = schema else {
        return Err(format!("a schema must be a JSON object, got {schema}"));
    };
    for keyword in members.keys() {
        if !SUPPORTED_KEYWORDS.contains(&keyword.as_str()) {
            return Err(format!(
                "this adapter cannot enforce the JSON Schema keyword {keyword:?}"
            ));
        }
    }
    if let Some(Value::Object(properties)) = members.get("properties") {
        for property in properties.values() {
            assert_enforceable(property)?;
        }
    }
    if let Some(items) = members.get("items") {
        assert_enforceable(items)?;
    }
    Ok(())
}

/// Reports every way `value` fails `schema`.
pub fn check(schema: &Value, value: &Value) -> Result<(), Vec<ValidationIssue>> {
    let mut issues = Vec::new();
    collect(schema, value, &mut Vec::new(), &mut issues);
    if issues.is_empty() {
        Ok(())
    } else {
        Err(issues)
    }
}

fn collect(
    schema: &Value,
    value: &Value,
    path: &mut Vec<String>,
    issues: &mut Vec<ValidationIssue>,
) {
    let Value::Object(members) = schema else {
        return;
    };

    if let Some(expected) = members.get("type") {
        if !matches_type(expected, value) {
            issues.push(ValidationIssue::new(
                format!("expected type {expected}, got {}", type_name(value)),
                path.clone(),
            ));
            return;
        }
    }
    if let Some(Value::Array(allowed)) = members.get("enum") {
        if !allowed.contains(value) {
            issues.push(ValidationIssue::new(
                format!("expected one of {}", Value::Array(allowed.clone())),
                path.clone(),
            ));
        }
    }
    if let Some(expected) = members.get("const") {
        if expected != value {
            issues.push(ValidationIssue::new(
                format!("expected {expected}"),
                path.clone(),
            ));
        }
    }

    if let Value::Object(fields) = value {
        if let Some(Value::Array(required)) = members.get("required") {
            for name in required {
                if let Value::String(name) = name {
                    if !fields.contains_key(name) {
                        path.push(name.clone());
                        issues.push(ValidationIssue::new(
                            "required property is missing",
                            path.clone(),
                        ));
                        path.pop();
                    }
                }
            }
        }
        if let Some(Value::Object(properties)) = members.get("properties") {
            if members.get("additionalProperties") == Some(&Value::Bool(false)) {
                for name in fields.keys() {
                    if !properties.contains_key(name) {
                        path.push(name.clone());
                        issues.push(ValidationIssue::new("unexpected property", path.clone()));
                        path.pop();
                    }
                }
            }
            for (name, property) in properties {
                if let Some(field) = fields.get(name) {
                    path.push(name.clone());
                    collect(property, field, path, issues);
                    path.pop();
                }
            }
        }
    }

    if let (Value::Array(entries), Some(items)) = (value, members.get("items")) {
        for (index, entry) in entries.iter().enumerate() {
            path.push(index.to_string());
            collect(items, entry, path, issues);
            path.pop();
        }
    }
}

fn matches_type(expected: &Value, value: &Value) -> bool {
    match expected {
        Value::String(name) => matches_type_name(name, value),
        Value::Array(names) => names.iter().any(|name| matches_type(name, value)),
        _ => true,
    }
}

fn matches_type_name(name: &str, value: &Value) -> bool {
    match name {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_schema() -> Value {
        serde_json::json!({
            "type": "object",
            "properties": { "a": { "type": "number" }, "b": { "type": "number" } },
            "required": ["a", "b"]
        })
    }

    #[test]
    fn a_wrong_property_type_and_a_missing_property_are_both_reported() {
        let issues = check(&add_schema(), &serde_json::json!({ "a": "not-a-number" }))
            .expect_err("the input is invalid twice over");
        assert_eq!(issues.len(), 2);
        assert!(
            issues
                .iter()
                .any(|issue| issue.path == vec!["a".to_owned()])
        );
        assert!(
            issues
                .iter()
                .any(|issue| issue.path == vec!["b".to_owned()])
        );
    }

    #[test]
    fn valid_input_passes() {
        assert!(check(&add_schema(), &serde_json::json!({ "a": 1, "b": 2 })).is_ok());
    }

    #[test]
    fn a_keyword_this_module_cannot_enforce_is_refused_up_front() {
        assert!(assert_enforceable(&add_schema()).is_ok());
        let problem = assert_enforceable(&serde_json::json!({ "oneOf": [] }))
            .expect_err("oneOf is not enforceable here");
        assert!(problem.contains("oneOf"));
    }
}
