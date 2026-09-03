"""One gateway connection, from the socket opening to the socket closing."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
from collections.abc import Coroutine
from typing import TYPE_CHECKING, Final, TypeVar

from pydantic import ValidationError
from websockets.asyncio.server import ServerConnection
from websockets.exceptions import ConnectionClosed

from . import jsonrpc
from .action import RegisteredAction
from .context import ActionContext, Cancellation
from .errors import ActionError, ProtocolError, TesseronErrorCode
from .json_types import JsonObject, JsonValue, as_object, as_string
from .jsonrpc import Failure, Malformed, Notification, Request, RequestId, Success
from .protocol import ClaimedParams, Methods, WelcomeResult, shares_major_version
from .resource import Subscription

if TYPE_CHECKING:  # pragma: no cover - import cycle only matters to the type checker
    from .host import SharedHost

__all__ = ["serve_connection"]

logger: Final = logging.getLogger("tesseron")

TaskResult = TypeVar("TaskResult")

DEFAULT_INVOCATION_TIMEOUT_SECONDS: Final = 60.0
"""How long an invocation may run before the host answers ``-32002`` on its own.

The gateway applies the same default from its side. The host keeps its own clock so a
handler that never returns cannot pin an invocation open after the agent stopped waiting.
"""


async def serve_connection(connection: ServerConnection, host: SharedHost) -> None:
    """Serves one gateway connection until the socket closes."""
    await Session(connection, host).serve()


class Session:
    """The JSON-RPC peer behind one WebSocket connection."""

    def __init__(self, connection: ServerConnection, host: SharedHost) -> None:
        self._connection = connection
        self._host = host
        self._outgoing: asyncio.Queue[str | None] = asyncio.Queue()
        self._sending = True
        self._pending: dict[RequestId, asyncio.Future[JsonValue]] = {}
        self._invocations: dict[str, Cancellation] = {}
        self._running: set[asyncio.Task[None]] = set()
        self._subscriptions: dict[str, Subscription] = {}
        self._next_request_id = 1
        self._handshake_settled = asyncio.Event()

    async def serve(self) -> None:
        """Runs the read loop, with the writer and the handshake alongside it.

        The handshake runs as its own task because its response arrives through the same
        read loop that has to keep running to deliver it.
        """
        writer = asyncio.create_task(self._forward_outgoing())
        handshake = asyncio.create_task(self._open_session())
        try:
            await self._read_until_closed()
        finally:
            self._cancel_all_invocations()
            self._drop_all_subscriptions()
            self._fail_all_pending()
            self.stop_sending()
            await asyncio.gather(handshake, writer, return_exceptions=True)
            await self._drain_running()
            self._host.emit_disconnected()

    # The channel a running handler talks back through.

    def notify(self, method: str, params: JsonValue) -> None:
        """Writes one notification, dropping it when the socket is already gone."""
        self._send_envelope(jsonrpc.notification(method, params))

    async def call(self, method: str, params: JsonValue) -> JsonValue:
        """Sends one request and waits for the response the gateway correlates by id."""
        request_id = self._mint_request_id()
        waiting: asyncio.Future[JsonValue] = asyncio.get_running_loop().create_future()
        self._pending[request_id] = waiting
        try:
            if not self._sending:
                raise ProtocolError(
                    int(TesseronErrorCode.TRANSPORT_CLOSED),
                    "the gateway connection is closed",
                )
            self._send_envelope(jsonrpc.request(request_id, method, params))
            return await waiting
        finally:
            self._pending.pop(request_id, None)

    # Outbound plumbing.

    def _mint_request_id(self) -> RequestId:
        request_id = self._next_request_id
        self._next_request_id += 1
        return request_id

    def _send_envelope(self, envelope: JsonObject) -> None:
        if not self._sending:
            return
        self._outgoing.put_nowait(json.dumps(envelope))

    def stop_sending(self) -> None:
        """Stops the writer. Frames queued after this are dropped: the socket is going away."""
        if not self._sending:
            return
        self._sending = False
        self._outgoing.put_nowait(None)

    async def _forward_outgoing(self) -> None:
        while True:
            frame = await self._outgoing.get()
            if frame is None:
                break
            try:
                await self._connection.send(frame)
            except (ConnectionClosed, OSError):
                break
        with contextlib.suppress(ConnectionClosed, OSError):
            await self._connection.close()

    # Inbound plumbing.

    async def _read_until_closed(self) -> None:
        try:
            async for message in self._connection:
                # Binary frames are coerced and parsed anyway: relays between the gateway
                # and the host have been observed re-framing text as binary.
                text = message if isinstance(message, str) else message.decode("utf-8", "replace")
                try:
                    frame: JsonValue = json.loads(text)
                except json.JSONDecodeError as problem:
                    logger.warning("tesseron: dropping an unparsable frame: %s", problem)
                    continue
                self._dispatch(jsonrpc.classify(frame))
        except ConnectionClosed:
            return

    def _dispatch(self, frame: jsonrpc.IncomingFrame) -> None:
        match frame:
            case Success(request_id, result):
                self._resolve(request_id, result, None)
            case Failure(request_id, error):
                self._resolve(request_id, None, error)
            case Request(request_id, method, params):
                self._handle_request(request_id, method, params)
            case Notification(method, params):
                self._handle_notification(method, params)
            case Malformed(reason):
                logger.warning("tesseron: dropping a frame that is not JSON-RPC 2.0: %s", reason)

    def _resolve(
        self, request_id: RequestId, result: JsonValue, error: ProtocolError | None
    ) -> None:
        waiting = self._pending.pop(request_id, None)
        if waiting is None or waiting.done():
            return
        if error is None:
            waiting.set_result(result)
        else:
            waiting.set_exception(error)

    def _fail_all_pending(self) -> None:
        """Fails every request still waiting on a response. No answer is ever coming."""
        for waiting in list(self._pending.values()):
            if not waiting.done():
                waiting.set_exception(
                    ProtocolError(
                        int(TesseronErrorCode.TRANSPORT_CLOSED),
                        "the gateway connection closed",
                    )
                )
        self._pending.clear()

    def _handle_request(self, request_id: RequestId, method: str, params: JsonValue) -> None:
        match method:
            case Methods.INVOKE:
                self._start_invocation(request_id, params)
            case Methods.READ:
                self._start_resource_read(request_id, params)
            case Methods.SUBSCRIBE:
                self._subscribe_to_resource(request_id, params)
            case Methods.UNSUBSCRIBE:
                self._unsubscribe_from_resource(request_id, params)
            case _:
                self._refuse(
                    request_id,
                    TesseronErrorCode.METHOD_NOT_FOUND,
                    f"Method not found: {method}",
                )

    def _handle_notification(self, method: str, params: JsonValue) -> None:
        payload = as_object(params) or {}
        if method == Methods.CANCEL:
            invocation_id = as_string(payload.get("invocationId"))
            if invocation_id is not None:
                self._cancel_invocation(invocation_id)
        elif method == Methods.CLAIMED:
            try:
                claimed = ClaimedParams.model_validate(payload)
            except ValidationError as problem:
                logger.warning("tesseron: unreadable tesseron/claimed: %s", problem)
                return
            self._host.record_claim(claimed)

    # Actions.

    def _start_invocation(self, request_id: RequestId, params: JsonValue) -> None:
        payload = as_object(params)
        name = as_string(payload.get("name")) if payload is not None else None
        invocation_id = as_string(payload.get("invocationId")) if payload is not None else None
        if payload is None or name is None or invocation_id is None:
            self._refuse(
                request_id,
                TesseronErrorCode.INVALID_PARAMS,
                "Invalid actions/invoke params: name and invocationId are required strings",
            )
            return

        action = self._host.actions.get(name)
        if action is None:
            self._refuse(
                request_id, TesseronErrorCode.ACTION_NOT_FOUND, f"Action not found: {name}"
            )
            return

        client = as_object(payload.get("client")) or {}
        cancellation = Cancellation()
        self._invocations[invocation_id] = cancellation
        self._track(
            self._run_invocation(
                request_id=request_id,
                invocation_id=invocation_id,
                raw_input=payload.get("input"),
                route=as_string(client.get("route")),
                action=action,
                cancellation=cancellation,
            )
        )

    async def _run_invocation(
        self,
        *,
        request_id: RequestId,
        invocation_id: str,
        raw_input: JsonValue,
        route: str | None,
        action: RegisteredAction,
        cancellation: Cancellation,
    ) -> None:
        # The capabilities the welcome negotiated are only known once it is applied, and an
        # invocation the gateway wrote straight after the welcome reaches the read loop
        # first, so the context is assembled on the far side of this gate.
        await self._handshake_settled.wait()
        context = ActionContext(
            action_name=action.descriptor.name,
            invocation_id=invocation_id,
            cancellation=cancellation,
            channel=self,
            agent_capabilities=self._host.negotiated_capabilities(),
            agent=self._host.agent_identity(),
            origin=self._host.origin,
            route=route,
        )
        timeout = (
            action.descriptor.timeout_ms / 1000
            if action.descriptor.timeout_ms is not None
            else DEFAULT_INVOCATION_TIMEOUT_SECONDS
        )

        handler = asyncio.create_task(action.dispatch(raw_input, context))
        cancelled = asyncio.create_task(context.cancellation.wait())
        try:
            done, _pending = await asyncio.wait(
                {handler, cancelled}, timeout=timeout, return_when=asyncio.FIRST_COMPLETED
            )
        finally:
            self._invocations.pop(invocation_id, None)

        if cancelled in done:
            await _stop(handler)
            self._refuse(
                request_id,
                TesseronErrorCode.CANCELLED,
                f"Invocation {invocation_id} was cancelled",
            )
            return

        await _stop(cancelled)
        if handler not in done:
            context.cancellation.cancel()
            await _stop(handler)
            self._refuse(
                request_id,
                TesseronErrorCode.TIMEOUT,
                f"Invocation {invocation_id} exceeded {int(timeout * 1000)} ms",
            )
            return

        try:
            output = handler.result()
        except ActionError as failure:
            self._send_envelope(jsonrpc.failure(request_id, _wire_error(failure)))
            return
        except asyncio.CancelledError:
            self._refuse(
                request_id,
                TesseronErrorCode.CANCELLED,
                f"Invocation {invocation_id} was cancelled",
            )
            return
        except Exception as unexpected:  # noqa: BLE001 - a handler may raise anything
            self._send_envelope(
                jsonrpc.failure(request_id, _wire_error(ActionError.internal(unexpected)))
            )
            return
        self._send_envelope(
            jsonrpc.success(request_id, {"invocationId": invocation_id, "output": output})
        )

    def _cancel_invocation(self, invocation_id: str) -> None:
        cancellation = self._invocations.get(invocation_id)
        if cancellation is not None:
            cancellation.cancel()

    def _cancel_all_invocations(self) -> None:
        for cancellation in list(self._invocations.values()):
            cancellation.cancel()
        self._invocations.clear()

    # Resources.

    def _start_resource_read(self, request_id: RequestId, params: JsonValue) -> None:
        payload = as_object(params)
        name = as_string(payload.get("name")) if payload is not None else None
        if name is None:
            self._refuse(
                request_id,
                TesseronErrorCode.INVALID_PARAMS,
                "Invalid resources/read params: name is required",
            )
            return
        resource = self._host.resources.get(name)
        if resource is None:
            self._refuse(
                request_id,
                TesseronErrorCode.ACTION_NOT_FOUND,
                f"Resource not readable: {name}",
            )
            return
        self._track(self._read_resource(request_id, name))

    async def _read_resource(self, request_id: RequestId, name: str) -> None:
        resource = self._host.resources.get(name)
        if resource is None:
            self._refuse(
                request_id, TesseronErrorCode.ACTION_NOT_FOUND, f"Resource not readable: {name}"
            )
            return
        try:
            value = await resource.read()
        except ActionError as failure:
            self._send_envelope(jsonrpc.failure(request_id, _wire_error(failure)))
            return
        except Exception as unexpected:  # noqa: BLE001 - a reader may raise anything
            self._send_envelope(
                jsonrpc.failure(request_id, _wire_error(ActionError.internal(unexpected)))
            )
            return
        self._send_envelope(jsonrpc.success(request_id, {"value": value}))

    def _subscribe_to_resource(self, request_id: RequestId, params: JsonValue) -> None:
        """Registers a subscriber for one resource.

        The acknowledgement goes out before the subscriber runs, so a value the subscriber
        emits immediately cannot overtake the response the agent is still waiting on. Both
        halves happen inside the read loop, so an unsubscribe that follows straight after
        always finds the subscription to tear down.
        """
        payload = as_object(params)
        name = as_string(payload.get("name")) if payload is not None else None
        subscription_id = as_string(payload.get("subscriptionId")) if payload is not None else None
        if name is None or subscription_id is None:
            self._refuse(
                request_id,
                TesseronErrorCode.INVALID_PARAMS,
                "Invalid resources/subscribe params: name and subscriptionId are required",
            )
            return
        resource = self._host.resources.get(name)
        if resource is None or not resource.subscribable:
            self._refuse(
                request_id,
                TesseronErrorCode.ACTION_NOT_FOUND,
                f"Resource not subscribable: {name}",
            )
            return

        self._send_envelope(jsonrpc.success(request_id, None))

        def emit(value: JsonValue) -> None:
            self.notify(Methods.UPDATED, {"subscriptionId": subscription_id, "value": value})

        replaced = self._subscriptions.pop(subscription_id, None)
        if replaced is not None:
            replaced.stop()
        self._subscriptions[subscription_id] = resource.open_subscription(emit)

    def _unsubscribe_from_resource(self, request_id: RequestId, params: JsonValue) -> None:
        """Drops a subscription.

        An id nobody registered is not an error: the agent and the transport can race, and
        there is nothing left to tear down either way.
        """
        payload = as_object(params)
        subscription_id = as_string(payload.get("subscriptionId")) if payload is not None else None
        if subscription_id is None:
            self._refuse(
                request_id,
                TesseronErrorCode.INVALID_PARAMS,
                "Invalid resources/unsubscribe params: subscriptionId is required",
            )
            return
        subscription = self._subscriptions.pop(subscription_id, None)
        if subscription is not None:
            subscription.stop()
        self._send_envelope(jsonrpc.success(request_id, None))

    def _drop_all_subscriptions(self) -> None:
        """Tears down every subscription.

        The agent that registered them is gone, and a subscriber still holding a listener
        would emit into a closed socket for as long as the application runs.
        """
        for subscription in list(self._subscriptions.values()):
            subscription.stop()
        self._subscriptions.clear()

    # Handshake.

    async def _open_session(self) -> None:
        try:
            await self._run_handshake()
        finally:
            self._handshake_settled.set()

    async def _run_handshake(self) -> None:
        credentials = self._host.resume_credentials()
        if credentials is not None:
            session_id, resume_token = credentials
            try:
                result = await self.call(
                    Methods.RESUME, self._host.resume_params(session_id, resume_token).to_wire()
                )
            except ProtocolError as refusal:
                if refusal.named_code is TesseronErrorCode.PROTOCOL_MISMATCH:
                    self._reject_handshake(refusal)
                    return
                self._host.forget_resume_credentials()
                logger.warning("tesseron: resume refused, opening a fresh session: %s", refusal)
            else:
                self._accept_welcome(result)
                return

        try:
            result = await self.call(Methods.HELLO, self._host.hello_params().to_wire())
        except ProtocolError as refusal:
            self._reject_handshake(refusal)
            return
        self._accept_welcome(result)

    def _accept_welcome(self, result: JsonValue) -> None:
        """Takes the welcome, unless the gateway answered with a protocol this host cannot speak.

        The gateway is the side that normally rejects a major mismatch, but a welcome from a
        different major is just as unusable here, and continuing with it would surface as
        mysterious method errors later.
        """
        try:
            welcome = WelcomeResult.model_validate(result)
        except ValidationError as problem:
            self._reject_handshake(
                ProtocolError(
                    int(TesseronErrorCode.INVALID_PARAMS),
                    f"the gateway sent an unreadable welcome: {problem}",
                )
            )
            return
        if not shares_major_version(welcome.protocol_version, self._host.protocol_version):
            self._reject_handshake(
                ProtocolError(
                    int(TesseronErrorCode.PROTOCOL_MISMATCH),
                    f"the gateway speaks protocol {welcome.protocol_version}; "
                    f"this host speaks {self._host.protocol_version}",
                )
            )
            return
        self._host.record_welcome(welcome)

    def _reject_handshake(self, refusal: ProtocolError) -> None:
        """Ends the connection after a handshake the gateway refused.

        A refusal is about this application, not this socket, so retrying the same hello
        would loop. The host reports it and waits for the next dial.
        """
        if refusal.named_code is not TesseronErrorCode.TRANSPORT_CLOSED:
            self._host.emit_handshake_failed(refusal)
        self.stop_sending()

    # Task bookkeeping.

    def _track(self, work: Coroutine[object, object, None]) -> None:
        task = asyncio.create_task(work)
        self._running.add(task)
        task.add_done_callback(self._running.discard)

    async def _drain_running(self) -> None:
        for task in list(self._running):
            await _stop(task)
        self._running.clear()

    def _refuse(self, request_id: RequestId, code: TesseronErrorCode, message: str) -> None:
        self._send_envelope(jsonrpc.failure(request_id, ProtocolError(int(code), message)))


async def _stop(task: asyncio.Task[TaskResult]) -> None:
    """Cancels a task and waits for it, swallowing the cancellation it answers with."""
    task.cancel()
    with contextlib.suppress(asyncio.CancelledError, Exception):
        await task


def _wire_error(failure: ActionError) -> ProtocolError:
    """Turns a handler failure into its wire payload.

    The cause ``ActionError.internal`` deliberately keeps off the socket is reported here.
    """
    if failure.internal_source is not None:
        logger.warning(
            "tesseron: handler failed with an internal error: %s", failure.internal_source
        )
    return failure.to_protocol_error()
