"""A gateway double the host tests drive their sessions from.

The real gateway dials the application, so a test that wants a live session has to do the
dialling too. This double speaks raw frames on purpose: asserting on the JSON is what proves
the wire format, and reusing the SDK's own models to build it would hide a mistake in them.
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from websockets.asyncio.client import ClientConnection, connect
from websockets.typing import Subprotocol

from tesseron import (
    GATEWAY_SUBPROTOCOL,
    JsonObject,
    JsonValue,
    ManifestPublication,
    TesseronApp,
    TesseronHost,
)

SESSION_ID = "s_test_0001"
RESUME_TOKEN = "rt_test_0001"
CLAIM_CODE = "AB3X-7K"

ALL_CAPABILITIES: JsonObject = {
    "streaming": True,
    "subscriptions": True,
    "sampling": True,
    "elicitation": True,
}


def application(*, name: str = "Test application") -> TesseronApp:
    """An app that publishes no manifest, because a test must not touch ``~/.tesseron``."""
    return TesseronApp(
        id="testapp",
        name=name,
        origin="tesseron-test://python",
        manifest=ManifestPublication.disabled(),
    )


class GatewayDouble:
    """One dialled connection, read and written as raw JSON-RPC frames."""

    def __init__(self, connection: ClientConnection) -> None:
        self._connection = connection

    async def receive(self) -> JsonObject:
        """The next frame the host wrote."""
        frame = await self._connection.recv()
        text = frame.decode("utf-8") if isinstance(frame, bytes) else frame
        decoded: JsonValue = json.loads(text)
        if not isinstance(decoded, dict):
            raise AssertionError(f"expected a JSON-RPC object, got {text}")
        return decoded

    async def send(self, frame: JsonObject) -> None:
        """Writes one frame to the host."""
        await self._connection.send(json.dumps(frame))

    async def answer(self, request: JsonObject, result: JsonValue) -> None:
        """Answers a request the host sent, correlating by its id."""
        await self.send({"jsonrpc": "2.0", "id": request.get("id"), "result": result})

    async def refuse(self, request: JsonObject, code: int, message: str) -> None:
        """Refuses a request the host sent."""
        await self.send(
            {
                "jsonrpc": "2.0",
                "id": request.get("id"),
                "error": {"code": code, "message": message},
            }
        )

    async def accept_handshake(self, *, claim_code: str | None = CLAIM_CODE) -> JsonObject:
        """Welcomes whatever handshake the host opened with, and answers with its params."""
        handshake = await self.receive()
        welcome: JsonObject = {
            "sessionId": SESSION_ID,
            "protocolVersion": "1.2.0",
            "capabilities": ALL_CAPABILITIES,
            "agent": {"id": "agent_test", "name": "test-runner"},
            "resumeToken": RESUME_TOKEN,
        }
        if claim_code is not None:
            welcome["claimCode"] = claim_code
        await self.answer(handshake, welcome)
        return handshake

    async def invoke(self, name: str, *, request_id: str, input_value: JsonValue) -> None:
        """Sends one ``actions/invoke``."""
        await self.send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "actions/invoke",
                "params": {"name": name, "input": input_value, "invocationId": request_id},
            }
        )


@asynccontextmanager
async def dial(host: TesseronHost) -> AsyncIterator[GatewayDouble]:
    """Opens one gateway connection to a listening host."""
    async with connect(host.url, subprotocols=[Subprotocol(GATEWAY_SUBPROTOCOL)]) as connection:
        yield GatewayDouble(connection)


@asynccontextmanager
async def listening(app: TesseronApp) -> AsyncIterator[TesseronHost]:
    """Runs a host for the body of the test and shuts it down afterwards."""
    host = await app.listen()
    try:
        yield host
    finally:
        await host.shutdown()


def members(frame: JsonObject, key: str) -> JsonObject:
    """The object under ``key``, asserting it is one."""
    value = frame.get(key)
    if not isinstance(value, dict):
        raise AssertionError(f"expected {key} to be an object, got {value!r}")
    return value


def entries(frame: JsonObject, key: str) -> list[JsonValue]:
    """The array under ``key``, asserting it is one."""
    value = frame.get(key)
    if not isinstance(value, list):
        raise AssertionError(f"expected {key} to be an array, got {value!r}")
    return value
