"""What a handler is told about the invocation it is running, and what it can send back."""

from __future__ import annotations

import asyncio
import json
from typing import Protocol, TypeVar

from pydantic import BaseModel, ValidationError

from . import elicit_schema
from .errors import ActionError, ProtocolError, TesseronErrorCode
from .json_types import JsonObject, JsonValue, as_object, as_string
from .protocol import AgentIdentity, Capabilities, LogLevel, Methods

__all__ = ["ActionContext", "Cancellation", "DetachedChannel", "GatewayChannel"]

AnswerModel = TypeVar("AnswerModel", bound=BaseModel)

MINIMUM_PERCENT = 0
MAXIMUM_PERCENT = 100


class GatewayChannel(Protocol):
    """The connection a running handler talks back through.

    The session implements this. Keeping it a protocol is what lets the context live in
    this module without reaching into the session's private state, and what lets a detached
    context answer honestly instead of hanging.
    """

    def notify(self, method: str, params: JsonValue) -> None:
        """Writes one fire-and-forget notification, dropping it when the socket is gone."""
        ...

    async def call(self, method: str, params: JsonValue) -> JsonValue:
        """Sends one request and waits for the response the gateway correlates by id.

        Raises:
            ProtocolError: when the gateway refuses, or when the transport closes first.
        """
        ...


class DetachedChannel:
    """The channel a context gets when there is no live connection behind it.

    Notifications go nowhere, which is what a fire-and-forget frame does on a closed socket
    anyway, and every request answers ``-32010`` rather than hanging.
    """

    def notify(self, method: str, params: JsonValue) -> None:
        """Drops the notification."""

    async def call(self, method: str, params: JsonValue) -> JsonValue:
        """Refuses immediately, because nothing is going to answer."""
        raise ProtocolError(
            int(TesseronErrorCode.TRANSPORT_CLOSED),
            "this invocation has no gateway connection",
        )


class Cancellation:
    """A cancellation signal shared between the session and one running handler.

    The gateway cancels with a notification rather than a request, so nothing answers
    ``actions/cancel``; the invocation it names answers ``-32001`` instead. A handler that
    ignores this signal still gets its answer replaced and its task cancelled, so long
    handlers should await :meth:`wait` alongside their own work.
    """

    def __init__(self) -> None:
        self._requested = asyncio.Event()

    @property
    def is_cancelled(self) -> bool:
        """Whether cancellation has already been requested."""
        return self._requested.is_set()

    def cancel(self) -> None:
        """Records the cancellation."""
        self._requested.set()

    async def wait(self) -> None:
        """Resolves as soon as cancellation is requested, immediately if it already was."""
        await self._requested.wait()


class ActionContext:
    """Everything one invocation knows and everything it can send while it runs."""

    def __init__(
        self,
        *,
        action_name: str,
        invocation_id: str,
        cancellation: Cancellation,
        channel: GatewayChannel,
        agent_capabilities: Capabilities,
        agent: AgentIdentity,
        origin: str,
        route: str | None = None,
    ) -> None:
        self.action_name = action_name
        self.invocation_id = invocation_id
        self.cancellation = cancellation
        self.agent_capabilities = agent_capabilities
        self.agent = agent
        self.origin = origin
        self.route = route
        self._channel = channel
        self._highest_percent: int | None = None

    @classmethod
    def detached(cls, action_name: str, invocation_id: str = "detached") -> ActionContext:
        """A context with no connection behind it, for exercising a handler from a test."""
        return cls(
            action_name=action_name,
            invocation_id=invocation_id,
            cancellation=Cancellation(),
            channel=DetachedChannel(),
            agent_capabilities=Capabilities.none(),
            agent=AgentIdentity(id="unknown", name="unknown"),
            origin="unknown",
        )

    @property
    def is_cancelled(self) -> bool:
        """Whether the agent has cancelled this invocation."""
        return self.cancellation.is_cancelled

    async def progress(
        self,
        *,
        percent: int | None = None,
        message: str | None = None,
        data: JsonValue = None,
    ) -> None:
        """Streams one progress update to the agent.

        Percent is an integer clamped into 0 to 100 and never allowed to fall below a value
        already sent for this invocation: an agent rendering a progress bar treats a
        backwards jump as a restart, and the message and data are worth more than the
        regression. Message and data travel unchanged.
        """
        params: JsonObject = {"invocationId": self.invocation_id}
        if message is not None:
            params["message"] = message
        if percent is not None:
            params["percent"] = self._raise_ceiling(percent)
        if data is not None:
            params["data"] = data
        self._channel.notify(Methods.PROGRESS, params)

    async def sample(
        self,
        prompt: str,
        *,
        json_schema: JsonValue = None,
        max_tokens: int | None = None,
    ) -> JsonValue:
        """Asks the agent's model to answer ``prompt``.

        Sampling depth is not a field in any Tesseron frame: the gateway owns
        ``maxSamplingDepth`` and answers ``-32008`` itself, so the host forwards the request
        without counting.

        Raises:
            ActionError: ``-32006 SamplingNotAvailable`` when the agent did not negotiate
                sampling, and whatever the gateway answered otherwise.
        """
        if not self.agent_capabilities.sampling:
            raise ActionError.protocol(
                TesseronErrorCode.SAMPLING_NOT_AVAILABLE,
                "the connected agent did not negotiate sampling",
            )
        params: JsonObject = {"invocationId": self.invocation_id, "prompt": prompt}
        if json_schema is not None:
            params["schema"] = json_schema
        if max_tokens is not None:
            params["maxTokens"] = max_tokens
        answer = await self._call(Methods.SAMPLE, params)
        result = as_object(answer)
        if result is None:
            raise ActionError.protocol(
                TesseronErrorCode.HANDLER_ERROR,
                "the gateway sent an unreadable sampling result",
            )
        return result.get("content")

    async def sample_as(
        self,
        model: type[AnswerModel],
        prompt: str,
        *,
        max_tokens: int | None = None,
    ) -> AnswerModel:
        """:meth:`sample`, with the output schema derived from ``model`` and decoded into it.

        A model asked for structured output answers with the JSON as text, so a string
        result is parsed before it is decoded.

        Raises:
            ActionError: everything :meth:`sample` raises, plus ``-32005 HandlerError`` when
                the answer does not decode.
        """
        content = await self.sample(
            prompt,
            json_schema=model.model_json_schema(mode="validation"),
            max_tokens=max_tokens,
        )
        text = as_string(content)
        if text is not None:
            try:
                content = json.loads(text)
            except json.JSONDecodeError as problem:
                raise ActionError.protocol(
                    TesseronErrorCode.HANDLER_ERROR,
                    f"the sampling result was not valid JSON: {problem}",
                    {"raw": text},
                ) from problem
        try:
            return model.model_validate(content)
        except ValidationError as problem:
            raise ActionError.protocol(
                TesseronErrorCode.HANDLER_ERROR,
                f"the sampling result did not match the expected shape: {problem}",
            ) from problem

    async def confirm(self, question: str) -> bool:
        """Asks the user a yes-or-no question through the agent.

        ``True`` only on an explicit accept. A decline, a cancel, and an agent that never
        negotiated elicitation all answer ``False``, which is the safe reading for the
        destructive-operation gates this exists for.

        Raises:
            ActionError: whatever the gateway answered when the prompt itself failed. The
                user's answer is never an error.
        """
        if not self.agent_capabilities.elicitation:
            return False
        answer = await self._request_elicitation(question, elicit_schema.confirmation_schema())
        return answer.get("action") == "accept"

    async def elicit(self, question: str, *, json_schema: JsonValue = None) -> JsonValue | None:
        """Asks the user for structured content through the agent.

        ``None`` on a decline or a cancel. Unlike :meth:`confirm` a missing capability is an
        error, because structured content has no safe default and the handler has to branch
        on it explicitly.

        Raises:
            ActionError: ``-32007 ElicitationNotAvailable`` when the agent did not negotiate
                elicitation, ``-32602 InvalidParams`` when the schema is not one MCP can
                render, and whatever the gateway answered otherwise.
        """
        if not self.agent_capabilities.elicitation:
            raise ActionError.protocol(
                TesseronErrorCode.ELICITATION_NOT_AVAILABLE,
                "the connected agent did not negotiate elicitation",
            )
        schema = elicit_schema.permissive_schema() if json_schema is None else json_schema
        elicit_schema.validate(schema)
        answer = await self._request_elicitation(question, schema)
        if answer.get("action") != "accept":
            return None
        return answer.get("value")

    async def elicit_as(self, model: type[AnswerModel], question: str) -> AnswerModel | None:
        """:meth:`elicit`, with the form schema derived from ``model`` and decoded into it.

        Raises:
            ActionError: everything :meth:`elicit` raises, plus ``-32005 HandlerError`` when
                the accepted answer does not decode.
        """
        value = await self.elicit(question, json_schema=model.model_json_schema(mode="validation"))
        if value is None:
            return None
        try:
            return model.model_validate(value)
        except ValidationError as problem:
            raise ActionError.protocol(
                TesseronErrorCode.HANDLER_ERROR,
                f"the elicited answer did not match the expected shape: {problem}",
            ) from problem

    async def log(
        self,
        message: str,
        *,
        level: LogLevel = LogLevel.INFO,
        meta: JsonObject | None = None,
    ) -> None:
        """Forwards one log line to the agent. Fire-and-forget."""
        params: JsonObject = {
            "invocationId": self.invocation_id,
            "level": str(level),
            "message": message,
        }
        if meta is not None:
            params["meta"] = meta
        self._channel.notify(Methods.LOG, params)

    async def _request_elicitation(self, question: str, schema: JsonValue) -> JsonObject:
        answer = await self._call(
            Methods.ELICIT,
            {"invocationId": self.invocation_id, "question": question, "schema": schema},
        )
        result = as_object(answer)
        if result is None:
            raise ActionError.protocol(
                TesseronErrorCode.HANDLER_ERROR,
                "the gateway sent an unreadable elicitation result",
            )
        return result

    async def _call(self, method: str, params: JsonValue) -> JsonValue:
        try:
            return await self._channel.call(method, params)
        except ProtocolError as refusal:
            code = refusal.named_code or TesseronErrorCode.INTERNAL_ERROR
            raise ActionError.protocol(code, refusal.message, refusal.data) from refusal

    def _raise_ceiling(self, requested: int) -> int:
        """Returns the percent this update may report, and remembers it."""
        bounded = max(MINIMUM_PERCENT, min(MAXIMUM_PERCENT, requested))
        if self._highest_percent is not None and self._highest_percent > bounded:
            bounded = self._highest_percent
        self._highest_percent = bounded
        return bounded
