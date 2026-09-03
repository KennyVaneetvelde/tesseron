"""One action the agent can invoke, and the input contract it publishes."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Coroutine, Mapping, Sequence
from dataclasses import dataclass
from enum import Enum
from typing import TypeAlias, TypeVar

from pydantic import BaseModel, ValidationError

from .context import ActionContext
from .errors import ActionError, TesseronErrorCode
from .json_types import JsonObject, JsonValue
from .protocol import ActionDescriptor

__all__ = [
    "ActionHandler",
    "InputValidator",
    "LooseHandler",
    "RegisteredAction",
    "TypedActionHandler",
    "ValidationIssue",
    "to_json_value",
]

InputModel = TypeVar("InputModel", bound=BaseModel)

TypedActionHandler: TypeAlias = "Callable[[InputModel, ActionContext], Awaitable[object]]"
"""A handler whose first parameter is annotated with a Pydantic model."""

ActionHandler: TypeAlias = "Callable[[JsonValue, ActionContext], Awaitable[object]]"
"""A handler that takes the invocation input as raw JSON."""

LooseHandler: TypeAlias = "Callable[..., Awaitable[object]]"
"""Either handler shape.

Registration reads the handler's annotations at runtime, so the decorator cannot know
statically which of the two shapes it was handed.
"""

DispatchHandler: TypeAlias = (
    "Callable[[JsonValue, ActionContext], Coroutine[object, object, JsonValue]]"
)
"""What the session runs: input validation folded in, output already JSON.

Concretely a coroutine rather than any awaitable, because the session runs each invocation
as its own task so it can race the handler against cancellation and the timeout.
"""

InputValidator: TypeAlias = "Callable[[JsonValue], list[ValidationIssue]]"
"""Checks raw invocation input and answers every problem it finds."""


@dataclass(frozen=True)
class ValidationIssue:
    """One reason invocation input was refused, reported inside a ``-32004`` failure."""

    message: str
    path: list[str]

    def to_wire(self) -> JsonObject:
        """The issue as it appears in the error ``data`` member."""
        return {"message": self.message, "path": list(self.path)}


@dataclass(frozen=True)
class RegisteredAction:
    """An action the host has accepted, ready for the session to dispatch."""

    descriptor: ActionDescriptor
    dispatch: DispatchHandler


def to_json_value(value: object) -> JsonValue:
    """Converts handler output into the JSON the invocation result carries.

    Pydantic models, primitives, sequences, mappings, and enums are understood. Anything
    else has no defined wire shape, so it fails as an internal error rather than reaching
    the agent as a string of a repr.
    """
    if value is None or isinstance(value, bool | int | float | str):
        return value
    if isinstance(value, BaseModel):
        converted: JsonValue = value.model_dump(mode="json")
        return converted
    if isinstance(value, Enum):
        return to_json_value(value.value)
    if isinstance(value, Mapping):
        return {str(key): to_json_value(item) for key, item in value.items()}
    if isinstance(value, Sequence):
        return [to_json_value(item) for item in value]
    raise ActionError.internal(
        TypeError(f"an action returned {type(value).__name__}, which has no JSON form")
    )


def issues_from_validation_error(error: ValidationError) -> list[ValidationIssue]:
    """Normalises a Pydantic failure into the issue list a ``-32004`` failure carries."""
    return [
        ValidationIssue(message=detail["msg"], path=[str(segment) for segment in detail["loc"]])
        for detail in error.errors()
    ]


def input_validation_error(issues: list[ValidationIssue]) -> ActionError:
    """The ``-32004`` failure for input that did not satisfy the declared schema."""
    return ActionError.protocol(
        TesseronErrorCode.INPUT_VALIDATION,
        "Invalid input",
        [issue.to_wire() for issue in issues],
    )


def typed_dispatch(model: type[InputModel], handler: LooseHandler) -> DispatchHandler:
    """Wraps a model-annotated handler so the session sees one raw-JSON entry point.

    The model is validated before the handler body runs, so an action whose input does not
    fit its declared shape never reaches application code.
    """

    async def dispatch(raw_input: JsonValue, context: ActionContext) -> JsonValue:
        try:
            parsed = model.model_validate(raw_input)
        except ValidationError as problem:
            raise input_validation_error(issues_from_validation_error(problem)) from problem
        return to_json_value(await handler(parsed, context))

    return dispatch


def raw_dispatch(handler: LooseHandler, validator: InputValidator | None) -> DispatchHandler:
    """Wraps a raw-JSON handler, running the optional validator before the handler body."""

    async def dispatch(raw_input: JsonValue, context: ActionContext) -> JsonValue:
        if validator is not None:
            issues = validator(raw_input)
            if issues:
                raise input_validation_error(issues)
        return to_json_value(await handler(raw_input, context))

    return dispatch
