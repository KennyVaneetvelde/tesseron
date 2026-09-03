"""The shape rules an ``elicitation/request`` schema has to satisfy.

MCP renders an elicit prompt as a flat form, so the protocol constrains the schema to a
single object of primitive leaves. The host checks on the send path, before the frame
leaves, so the failure lands at the ``context.elicit`` call site instead of surfacing as a
gateway rejection three hops later.
"""

from __future__ import annotations

from typing import Final

from .errors import ActionError, TesseronErrorCode
from .json_types import JsonObject, JsonValue

__all__ = ["confirmation_schema", "permissive_schema", "validate"]

PRIMITIVE_TYPES: Final = frozenset({"string", "number", "integer", "boolean"})
"""The types an elicited property may declare."""

COMPOSITION_KEYWORDS: Final = ("oneOf", "anyOf", "allOf", "not")
"""Keywords that would ask the agent to render more than one shape."""


def confirmation_schema() -> JsonObject:
    """The schema ``ActionContext.confirm`` sends.

    An object with no properties, which MCP clients render as a bare accept-or-decline
    prompt.
    """
    return {"type": "object", "properties": {}, "required": []}


def permissive_schema() -> JsonObject:
    """The fallback for an elicit request that declares no schema of its own.

    One text field, which is the least a client can render.
    """
    return {
        "type": "object",
        "properties": {"response": {"type": "string", "description": "Your response"}},
        "required": ["response"],
    }


def validate(schema: JsonValue) -> None:
    """Checks a schema against the protocol 1.2.0 elicitation rules.

    Raises:
        ActionError: ``-32602 InvalidParams`` naming the first rule the schema breaks.
    """
    if not isinstance(schema, dict):
        raise _rejection("elicit jsonSchema must be a JSON Schema object.")
    if schema.get("type") != "object":
        raise _rejection(
            'elicit jsonSchema must be { type: "object" } at the top level; '
            f"got type={schema.get('type')!r}. Compose a flat object of primitives."
        )
    for keyword in COMPOSITION_KEYWORDS:
        if _is_truthy(schema.get(keyword)):
            raise _rejection(
                "elicit jsonSchema must not use top-level oneOf/anyOf/allOf/not: MCP elicit "
                "clients require a single flat object shape."
            )
    properties = schema.get("properties")
    if isinstance(properties, dict):
        _validate_properties(properties)


def _validate_properties(properties: JsonObject) -> None:
    for name, property_schema in properties.items():
        if not isinstance(property_schema, dict):
            continue
        declared = property_schema.get("type")
        # A `type` array declares alternatives the client may pick between, and 1.2.0
        # checks only the first entry. Tightening that would reject schemas that pass
        # today, so it waits for a future minor.
        if isinstance(declared, list):
            declared = declared[0] if declared else None
        # A property with no usable type is accepted unchanged: the validator does not
        # infer one from the property's other keywords.
        if not _is_truthy(declared):
            continue
        if isinstance(declared, str) and declared in PRIMITIVE_TYPES:
            continue
        raise _rejection(
            f"elicit jsonSchema property {name!r} has unsupported type {declared!r}. MCP "
            "elicitation requires primitive-typed leaves (string, number, integer, boolean)."
        )


def _is_truthy(value: JsonValue) -> bool:
    """JavaScript truthiness.

    The rule is written against what the TypeScript validator accepts, where an empty array
    or object is truthy.
    """
    if isinstance(value, list | dict):
        return True
    return bool(value)


def _rejection(message: str) -> ActionError:
    return ActionError.protocol(TesseronErrorCode.INVALID_PARAMS, message)
