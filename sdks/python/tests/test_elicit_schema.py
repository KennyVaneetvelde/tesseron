"""The shape rules an elicitation schema has to satisfy before the request is sent."""

from __future__ import annotations

import pytest
from pydantic import JsonValue

from tesseron import ActionError, TesseronErrorCode
from tesseron.elicit_schema import confirmation_schema, permissive_schema, validate


@pytest.mark.parametrize(
    "schema",
    [
        confirmation_schema(),
        permissive_schema(),
        {"type": "object"},
        {"type": "object", "properties": {"quantity": {"type": "integer"}}},
        # A type array declares alternatives; 1.2.0 checks only the first entry.
        {"type": "object", "properties": {"note": {"type": ["string", "null"]}}},
        # A property with no usable type is accepted unchanged.
        {"type": "object", "properties": {"note": {"minLength": 1}}},
    ],
)
def test_a_renderable_schema_is_accepted(schema: JsonValue) -> None:
    validate(schema)


@pytest.mark.parametrize(
    "schema",
    [
        "not-an-object",
        {"type": "string"},
        {"type": "object", "oneOf": [{"type": "object"}]},
        {"type": "object", "anyOf": [{"type": "object"}]},
        {"type": "object", "allOf": [{"type": "object"}]},
        {"type": "object", "not": {"type": "object"}},
        {"type": "object", "properties": {"cart": {"type": "object"}}},
        {"type": "object", "properties": {"items": {"type": "array"}}},
    ],
)
def test_a_schema_mcp_cannot_render_is_refused_with_invalid_params(schema: JsonValue) -> None:
    with pytest.raises(ActionError) as refusal:
        validate(schema)
    assert refusal.value.code is TesseronErrorCode.INVALID_PARAMS
