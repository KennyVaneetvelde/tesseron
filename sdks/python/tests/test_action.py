"""Input validation on the way in, and JSON conversion on the way out."""

from __future__ import annotations

from enum import Enum

import pytest
from pydantic import BaseModel, Field

from tesseron import (
    ActionContext,
    ActionError,
    ActionHandler,
    JsonValue,
    TesseronErrorCode,
    ValidationIssue,
)
from tesseron.action import raw_dispatch, to_json_value, typed_dispatch


class AddTodo(BaseModel):
    text: str = Field(min_length=1)
    tag: str | None = None


class Priority(Enum):
    HIGH = "high"


class Todo(BaseModel):
    id: str
    done: bool


async def accept(parsed: AddTodo, context: ActionContext) -> JsonValue:
    return {"text": parsed.text, "action": context.action_name}


def test_a_pydantic_model_is_converted_by_its_json_mode_dump() -> None:
    assert to_json_value(Todo(id="t-1", done=False)) == {"id": "t-1", "done": False}


def test_primitives_sequences_mappings_and_enums_all_have_a_json_form() -> None:
    assert to_json_value(None) is None
    assert to_json_value("done") == "done"
    assert to_json_value(Priority.HIGH) == "high"
    assert to_json_value({"todos": [Todo(id="t-1", done=True)]}) == {
        "todos": [{"id": "t-1", "done": True}]
    }


def test_a_value_with_no_json_form_fails_as_an_internal_error() -> None:
    with pytest.raises(ActionError) as failure:
        to_json_value(object())
    assert failure.value.code is TesseronErrorCode.INTERNAL_ERROR


async def test_input_that_fits_the_model_reaches_the_handler() -> None:
    dispatch = typed_dispatch(AddTodo, accept)

    output = await dispatch({"text": "buy milk"}, ActionContext.detached("addTodo"))

    assert output == {"text": "buy milk", "action": "addTodo"}


async def test_input_that_fails_the_model_is_refused_with_every_problem_it_has() -> None:
    dispatch = typed_dispatch(AddTodo, accept)

    with pytest.raises(ActionError) as refusal:
        await dispatch({"text": "", "tag": 7}, ActionContext.detached("addTodo"))

    assert refusal.value.code is TesseronErrorCode.INPUT_VALIDATION
    assert refusal.value.message == "Invalid input"
    assert _reported_paths(refusal.value.data) == {("text",), ("tag",)}


async def test_a_raw_handler_sees_the_input_unchanged_when_its_validator_passes() -> None:
    echo, seen = _echo_handler()
    dispatch = raw_dispatch(echo, lambda _input: [])

    assert await dispatch({"a": 1}, ActionContext.detached("add")) == {"a": 1}
    assert seen == [{"a": 1}]


async def test_a_raw_handler_is_never_reached_when_its_validator_refuses() -> None:
    echo, seen = _echo_handler()
    dispatch = raw_dispatch(echo, lambda _input: [ValidationIssue(message="nope", path=["a"])])

    with pytest.raises(ActionError) as refusal:
        await dispatch({"a": 1}, ActionContext.detached("add"))

    assert refusal.value.code is TesseronErrorCode.INPUT_VALIDATION
    assert _reported_paths(refusal.value.data) == {("a",)}
    assert seen == []


def _echo_handler() -> tuple[ActionHandler, list[JsonValue]]:
    """A raw handler that answers with its input, and the list of inputs it actually saw."""
    seen: list[JsonValue] = []

    async def echo(raw_input: JsonValue, context: ActionContext) -> JsonValue:
        seen.append(raw_input)
        return raw_input

    return echo, seen


def _reported_paths(data: JsonValue) -> set[tuple[str, ...]]:
    assert isinstance(data, list)
    paths: set[tuple[str, ...]] = set()
    for issue in data:
        assert isinstance(issue, dict)
        path = issue["path"]
        assert isinstance(path, list)
        paths.add(tuple(str(segment) for segment in path))
    return paths
