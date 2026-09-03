"""Turns a conformance fixture document into registered actions and resources.

The grammar is the one ``conformance/README.md`` documents under "Fixture adapter grammar".
Anything in that grammar this release cannot serve is refused here rather than ignored.
"""

from __future__ import annotations

import asyncio
from typing import Final

from pydantic import BaseModel, ConfigDict, Field, JsonValue, ValidationError
from pydantic.alias_generators import to_camel

from tesseron import (
    ActionContext,
    ActionError,
    Emit,
    InputValidator,
    TesseronApp,
    Unsubscribe,
    ValidationIssue,
)

from . import UnsupportedFixtureError, schema_subset

__all__ = ["register"]

UPDATE_SPACING_SECONDS: Final = 0.025
"""How far apart queued resource updates are pushed.

The runner stamps a frame's arrival and compares it with the moment the labeled step
finished, so an update written into the same socket flush as the subscription
acknowledgement can land too early to satisfy ``notBefore``. Spacing the updates out is what
a fixture's ``afterStep`` is asking for.
"""


class AdapterModel(BaseModel):
    """The half of a fixture document the host reads, refusing anything it does not know."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class FixtureElicitation(AdapterModel):
    """One ``elicits`` block."""

    question: str
    json_schema: JsonValue = None
    """Handed to the SDK exactly as written, including the shapes the protocol rejects:
    these fixtures exist to prove the SDK does the rejecting."""


class FixtureAction(AdapterModel):
    """One action the fixture declares, and the script its handler follows."""

    name: str
    description: str = ""
    returns: JsonValue = None
    input_schema: JsonValue = None
    assert_handler_not_called: bool = False
    blocks_until_cancelled: bool = False
    progress: list[dict[str, JsonValue]] = Field(default_factory=list)
    """Kept as raw objects so an entry carrying an explicit ``"data": null`` stays
    distinguishable from one that omits the key."""
    confirms: str | None = None
    returns_confirm_result: bool = False
    elicits: FixtureElicitation | None = None


class FixtureResource(AdapterModel):
    """One resource the fixture declares, and the updates its subscribers receive."""

    name: str
    description: str = ""
    value: JsonValue = None
    subscribable: bool = False
    emits: list[dict[str, JsonValue]] = Field(default_factory=list)
    """Each entry is ``{ afterStep, value }``. ``afterStep`` names the runner step the update
    has to land behind, which the runner checks on its own side."""


class FixtureApplication(AdapterModel):
    """The application the fixture wants the host to stand up."""

    actions: list[FixtureAction] = Field(default_factory=list)
    resources: list[FixtureResource] = Field(default_factory=list)
    host_minted_claim: JsonValue = None


class FixtureDocument(BaseModel):
    """The whole fixture file.

    Only the adapter's half is read; ``steps`` is the runner's script and never reaches the
    host, so unknown members are ignored here rather than refused.
    """

    model_config = ConfigDict(extra="ignore")

    requires: list[str] = Field(default_factory=list)
    fixture: FixtureApplication


def register(app: TesseronApp, document: str) -> None:
    """Reads a fixture document and registers everything it declares.

    Raises:
        UnsupportedFixtureError: when the fixture needs behaviour this release does not
            implement, or when its ``inputSchema`` uses a keyword the adapter cannot enforce.
    """
    try:
        parsed = FixtureDocument.model_validate_json(document)
    except ValidationError as problem:
        raise UnsupportedFixtureError(f"unreadable fixture: {problem}") from problem

    if "uds" in parsed.requires:
        raise UnsupportedFixtureError(
            "this host speaks WebSocket only; declare uds in TESSERON_CONFORMANCE_UNSUPPORTED"
        )
    if parsed.fixture.host_minted_claim is not None:
        raise UnsupportedFixtureError(
            "this host uses gateway-minted claims; declare host-minted-claim in "
            "TESSERON_CONFORMANCE_UNSUPPORTED"
        )

    for action in parsed.fixture.actions:
        _register_action(app, action)
    for resource in parsed.fixture.resources:
        _register_resource(app, resource)


def _register_action(app: TesseronApp, fixture: FixtureAction) -> None:
    validator: InputValidator | None = None
    schema = fixture.input_schema
    if schema is not None:
        try:
            schema_subset.assert_enforceable(schema)
        except UnsupportedFixtureError as problem:
            raise UnsupportedFixtureError(f"action {fixture.name!r}: {problem}") from problem

        def validate(raw_input: JsonValue) -> list[ValidationIssue]:
            return schema_subset.check(schema, raw_input)

        validator = validate

    async def run(raw_input: JsonValue, context: ActionContext) -> JsonValue:
        return await _run_action(fixture, context)

    app.action(
        fixture.name,
        description=fixture.description,
        input_schema=schema,
        validate=validator,
    )(run)


async def _run_action(fixture: FixtureAction, context: ActionContext) -> JsonValue:
    """Applies the fixture's behaviours in the order ``conformance/README.md`` fixes.

    Refuse an unexpected call, wait to be cancelled, stream progress, confirm, elicit, then
    answer with the canned value.
    """
    if fixture.assert_handler_not_called:
        raise ActionError.handler(
            f"the handler for {fixture.name} ran, but the fixture says it must not"
        )
    if fixture.blocks_until_cancelled:
        # The session answers -32001 when the cancellation arrives and drops this task;
        # anything returned here would race it.
        await asyncio.Event().wait()

    for entry in fixture.progress:
        await context.progress(
            percent=_progress_percent(entry),
            message=_progress_message(entry),
            data=entry.get("data"),
        )

    if fixture.confirms is not None:
        confirmed = await context.confirm(fixture.confirms)
        if fixture.returns_confirm_result:
            return {"confirmed": confirmed}

    if fixture.elicits is not None:
        await context.elicit(fixture.elicits.question, json_schema=fixture.elicits.json_schema)

    return fixture.returns


def _progress_percent(entry: dict[str, JsonValue]) -> int | None:
    percent = entry.get("percent")
    if isinstance(percent, bool) or not isinstance(percent, int | float):
        return None
    return int(percent)


def _progress_message(entry: dict[str, JsonValue]) -> str | None:
    message = entry.get("message")
    return message if isinstance(message, str) else None


def _register_resource(app: TesseronApp, fixture: FixtureResource) -> None:
    updates = _queued_updates(fixture)

    async def read() -> JsonValue:
        return fixture.value

    def start_updates(emit: Emit) -> Unsubscribe:
        return _start_updates(updates, emit)

    app.resource(
        fixture.name,
        read=read,
        description=fixture.description,
        subscribable=fixture.subscribable,
        subscribe=start_updates if fixture.subscribable else None,
    )


def _queued_updates(fixture: FixtureResource) -> list[JsonValue]:
    values: list[JsonValue] = []
    for index, update in enumerate(fixture.emits):
        if "value" not in update:
            raise UnsupportedFixtureError(f"resource {fixture.name!r}: emits[{index}] has no value")
        values.append(update["value"])
    return values


def _start_updates(updates: list[JsonValue], emit: Emit) -> Unsubscribe:
    pushing = [
        asyncio.create_task(_push_later(UPDATE_SPACING_SECONDS * (index + 1), value, emit))
        for index, value in enumerate(updates)
    ]

    def stop() -> None:
        for update in pushing:
            update.cancel()

    return stop


async def _push_later(delay: float, value: JsonValue, emit: Emit) -> None:
    await asyncio.sleep(delay)
    emit(value)
