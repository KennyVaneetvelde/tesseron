"""The JSON shapes that cross the wire, and the narrowing helpers that keep them typed."""

from __future__ import annotations

from typing import TypeAlias

from pydantic import JsonValue

__all__ = ["JsonObject", "JsonValue", "as_object", "as_string"]

JsonObject: TypeAlias = "dict[str, JsonValue]"
"""A JSON object, which is what every Tesseron `params` and `result` member is."""


def as_object(value: JsonValue) -> JsonObject | None:
    """The value as a JSON object, or ``None`` when it is anything else."""
    return value if isinstance(value, dict) else None


def as_string(value: JsonValue) -> str | None:
    """The value as a string, or ``None`` when it is anything else."""
    return value if isinstance(value, str) else None
