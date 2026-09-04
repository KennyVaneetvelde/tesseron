"""What a handler can send while it runs, and what it gets back when nothing is listening."""

from __future__ import annotations

import pytest
from pydantic import BaseModel

from tesseron import (
    ActionContext,
    ActionError,
    AgentIdentity,
    Cancellation,
    Capabilities,
    JsonValue,
    LogLevel,
    TesseronErrorCode,
)
from tesseron.context import DetachedChannel


class RecordingChannel:
    """A channel that keeps every notification and answers requests from a script."""

    def __init__(self, answers: dict[str, JsonValue] | None = None) -> None:
        self.notifications: list[tuple[str, JsonValue]] = []
        self.calls: list[tuple[str, JsonValue]] = []
        self._answers = answers or {}

    def notify(self, method: str, params: JsonValue) -> None:
        self.notifications.append((method, params))

    async def call(self, method: str, params: JsonValue) -> JsonValue:
        self.calls.append((method, params))
        return self._answers[method]


def context_with(
    channel: RecordingChannel | DetachedChannel,
    *,
    capabilities: Capabilities | None = None,
) -> ActionContext:
    return ActionContext(
        action_name="addTodo",
        invocation_id="i-1",
        cancellation=Cancellation(),
        channel=channel,
        agent_capabilities=capabilities or Capabilities.implemented(),
        agent=AgentIdentity(id="agent_test", name="test-runner"),
        origin="tesseron-test://python",
        route="/cart",
    )


def sent_percent(notification: tuple[str, JsonValue]) -> JsonValue:
    _method, params = notification
    assert isinstance(params, dict)
    return params.get("percent")


async def test_progress_clamps_an_out_of_range_percent_into_the_wire_range() -> None:
    channel = RecordingChannel()
    context = context_with(channel)

    await context.progress(percent=-40)
    await context.progress(percent=400)

    assert [sent_percent(entry) for entry in channel.notifications] == [0, 100]


async def test_progress_never_falls_below_a_percent_already_sent() -> None:
    channel = RecordingChannel()
    context = context_with(channel)

    await context.progress(percent=60)
    await context.progress(percent=10, message="still working")

    assert [sent_percent(entry) for entry in channel.notifications] == [60, 60]
    _method, params = channel.notifications[1]
    assert isinstance(params, dict)
    assert params["message"] == "still working"


async def test_progress_without_a_percent_carries_only_the_message() -> None:
    channel = RecordingChannel()
    context = context_with(channel)

    await context.progress(message="reading", data={"step": 1})

    method, params = channel.notifications[0]
    assert method == "actions/progress"
    assert params == {"invocationId": "i-1", "message": "reading", "data": {"step": 1}}


async def test_a_log_line_carries_its_level_and_meta() -> None:
    channel = RecordingChannel()
    context = context_with(channel)

    await context.log("saved", level=LogLevel.WARN, meta={"todoId": "t-1"})

    method, params = channel.notifications[0]
    assert method == "log"
    assert params == {
        "invocationId": "i-1",
        "level": "warn",
        "message": "saved",
        "meta": {"todoId": "t-1"},
    }


async def test_confirm_is_false_when_the_agent_never_negotiated_elicitation() -> None:
    channel = RecordingChannel()
    context = context_with(channel, capabilities=Capabilities.none())

    assert await context.confirm("Delete everything?") is False
    assert channel.calls == []


async def test_confirm_is_true_only_on_an_explicit_accept() -> None:
    accepting = RecordingChannel({"elicitation/request": {"action": "accept"}})
    declining = RecordingChannel({"elicitation/request": {"action": "decline"}})

    assert await context_with(accepting).confirm("Delete everything?") is True
    assert await context_with(declining).confirm("Delete everything?") is False


async def test_elicit_without_the_capability_is_an_error_rather_than_a_default() -> None:
    context = context_with(RecordingChannel(), capabilities=Capabilities.none())

    with pytest.raises(ActionError) as refusal:
        await context.elicit("How many?")
    assert refusal.value.code is TesseronErrorCode.ELICITATION_NOT_AVAILABLE


async def test_a_declined_elicit_answers_none() -> None:
    channel = RecordingChannel({"elicitation/request": {"action": "decline"}})

    assert await context_with(channel).elicit("How many?") is None


async def test_elicit_as_decodes_an_accepted_answer() -> None:
    class Quantity(BaseModel):
        count: int

    channel = RecordingChannel({"elicitation/request": {"action": "accept", "value": {"count": 3}}})

    answer = await context_with(channel).elicit_as(Quantity, "How many?")

    assert answer == Quantity(count=3)


async def test_sampling_without_the_capability_is_refused_before_a_frame_goes_out() -> None:
    channel = RecordingChannel()
    context = context_with(channel, capabilities=Capabilities.none())

    with pytest.raises(ActionError) as refusal:
        await context.sample("Summarise the cart")
    assert refusal.value.code is TesseronErrorCode.SAMPLING_NOT_AVAILABLE
    assert channel.calls == []


async def test_sampling_answers_with_the_content_the_gateway_returned() -> None:
    channel = RecordingChannel({"sampling/request": {"content": "two items"}})

    assert await context_with(channel).sample("Summarise the cart") == "two items"


async def test_a_detached_context_drops_notifications_and_refuses_requests() -> None:
    context = context_with(DetachedChannel())

    await context.progress(percent=50)

    with pytest.raises(ActionError) as refusal:
        await context.sample("Summarise the cart")
    assert refusal.value.code is TesseronErrorCode.TRANSPORT_CLOSED


async def test_a_detached_context_carries_the_placeholder_identity() -> None:
    context = ActionContext.detached("addTodo")

    assert context.agent_capabilities == Capabilities.none()
    assert context.is_cancelled is False
    context.cancellation.cancel()
    assert context.is_cancelled is True
