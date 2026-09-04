"""The JSON Schema keywords this adapter can enforce.

Fixture ``inputSchema`` documents are raw JSON, so something has to check invocation input
against them. Rather than pull a full JSON Schema implementation into a test-only adapter,
this module covers the keywords the corpus actually uses and refuses, at registration time,
any schema that needs more. A fixture that would otherwise pass because a keyword was
silently ignored fails the run instead.
"""

from __future__ import annotations

import json
from typing import Final

from pydantic import JsonValue

from tesseron import ValidationIssue

from . import UnsupportedFixtureError

__all__ = ["assert_enforceable", "check"]

SUPPORTED_KEYWORDS: Final = frozenset(
    {
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
    }
)


def assert_enforceable(schema: JsonValue) -> None:
    """Refuses a schema using a keyword this module cannot enforce.

    Raises:
        UnsupportedFixtureError: naming the first keyword that has no enforcement here.
    """
    if not isinstance(schema, dict):
        raise UnsupportedFixtureError(f"a schema must be a JSON object, got {json.dumps(schema)}")
    for keyword in schema:
        if keyword not in SUPPORTED_KEYWORDS:
            raise UnsupportedFixtureError(
                f"this adapter cannot enforce the JSON Schema keyword {keyword!r}"
            )
    properties = schema.get("properties")
    if isinstance(properties, dict):
        for property_schema in properties.values():
            assert_enforceable(property_schema)
    if "items" in schema:
        assert_enforceable(schema["items"])


def check(schema: JsonValue, value: JsonValue) -> list[ValidationIssue]:
    """Reports every way ``value`` fails ``schema``."""
    issues: list[ValidationIssue] = []
    _collect(schema, value, [], issues)
    return issues


def _collect(
    schema: JsonValue,
    value: JsonValue,
    path: list[str],
    issues: list[ValidationIssue],
) -> None:
    if not isinstance(schema, dict):
        return

    if "type" in schema and not _matches_type(schema["type"], value):
        issues.append(
            ValidationIssue(
                message=f"expected type {json.dumps(schema['type'])}, got {_type_name(value)}",
                path=list(path),
            )
        )
        # A value of the wrong type fails every deeper rule too, and one issue per
        # mismatch reads better than a cascade of them.
        return

    allowed = schema.get("enum")
    if isinstance(allowed, list) and not any(_json_equal(entry, value) for entry in allowed):
        issues.append(
            ValidationIssue(message=f"expected one of {json.dumps(allowed)}", path=list(path))
        )
    if "const" in schema and not _json_equal(schema["const"], value):
        issues.append(
            ValidationIssue(message=f"expected {json.dumps(schema['const'])}", path=list(path))
        )

    if isinstance(value, dict):
        _collect_object(schema, value, path, issues)
    items = schema.get("items")
    if isinstance(value, list) and items is not None:
        for index, entry in enumerate(value):
            path.append(str(index))
            _collect(items, entry, path, issues)
            path.pop()


def _collect_object(
    schema: dict[str, JsonValue],
    fields: dict[str, JsonValue],
    path: list[str],
    issues: list[ValidationIssue],
) -> None:
    required = schema.get("required")
    if isinstance(required, list):
        for name in required:
            if isinstance(name, str) and name not in fields:
                path.append(name)
                issues.append(
                    ValidationIssue(message="required property is missing", path=list(path))
                )
                path.pop()

    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return
    if schema.get("additionalProperties") is False:
        for name in fields:
            if name not in properties:
                path.append(name)
                issues.append(ValidationIssue(message="unexpected property", path=list(path)))
                path.pop()
    for name, property_schema in properties.items():
        if name in fields:
            path.append(name)
            _collect(property_schema, fields[name], path, issues)
            path.pop()


def _matches_type(expected: JsonValue, value: JsonValue) -> bool:
    if isinstance(expected, str):
        return _matches_type_name(expected, value)
    if isinstance(expected, list):
        return any(_matches_type(name, value) for name in expected)
    # A `type` that is neither a name nor a list of names constrains nothing here.
    return True


def _matches_type_name(name: str, value: JsonValue) -> bool:
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "boolean":
        return isinstance(value, bool)
    if name == "null":
        return value is None
    return True


def _type_name(value: JsonValue) -> str:
    if value is None:
        return "null"
    # Ahead of the number check, because bool is a subclass of int in Python.
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        return "array"
    return "object"


def _json_equal(left: JsonValue, right: JsonValue) -> bool:
    """JSON equality, which parts ``true`` from ``1`` the way Python's ``==`` does not."""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left is right
    if isinstance(left, list) and isinstance(right, list):
        return len(left) == len(right) and all(
            _json_equal(one, other) for one, other in zip(left, right, strict=True)
        )
    if isinstance(left, dict) and isinstance(right, dict):
        return left.keys() == right.keys() and all(
            _json_equal(entry, right[name]) for name, entry in left.items()
        )
    if isinstance(left, list | dict) or isinstance(right, list | dict):
        return False
    return left == right
