"""JSON-RPC 2.0 envelopes: how this package writes them and how it reads the gateway's."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TypeAlias

from .errors import ProtocolError
from .json_types import JsonObject, JsonValue
from .protocol import JSONRPC_VERSION

__all__ = [
    "Failure",
    "IncomingFrame",
    "Malformed",
    "Notification",
    "Request",
    "RequestId",
    "Success",
    "classify",
    "failure",
    "notification",
    "request",
    "success",
]

RequestId: TypeAlias = "str | int | float"
"""What JSON-RPC allows as a correlation id. Null ids are not correlated, so not accepted."""


def request(request_id: RequestId, method: str, params: JsonValue) -> JsonObject:
    """One outgoing request envelope."""
    return {"jsonrpc": JSONRPC_VERSION, "id": request_id, "method": method, "params": params}


def notification(method: str, params: JsonValue) -> JsonObject:
    """One outgoing notification envelope. Notifications carry no id and get no answer."""
    return {"jsonrpc": JSONRPC_VERSION, "method": method, "params": params}


def success(request_id: RequestId, result: JsonValue) -> JsonObject:
    """One outgoing success response."""
    return {"jsonrpc": JSONRPC_VERSION, "id": request_id, "result": result}


def failure(request_id: RequestId, error: ProtocolError) -> JsonObject:
    """One outgoing failure response."""
    return {"jsonrpc": JSONRPC_VERSION, "id": request_id, "error": error.to_wire()}


@dataclass(frozen=True)
class Success:
    """A response to something this host asked for."""

    id: RequestId
    result: JsonValue


@dataclass(frozen=True)
class Failure:
    """A refusal of something this host asked for."""

    id: RequestId
    error: ProtocolError


@dataclass(frozen=True)
class Request:
    """Something the gateway wants this host to answer."""

    id: RequestId
    method: str
    params: JsonValue


@dataclass(frozen=True)
class Notification:
    """Something the gateway is telling this host, with no answer expected."""

    method: str
    params: JsonValue


@dataclass(frozen=True)
class Malformed:
    """A frame that is not a JSON-RPC 2.0 message this host can act on."""

    reason: str


IncomingFrame: TypeAlias = "Success | Failure | Request | Notification | Malformed"


def classify(frame: JsonValue) -> IncomingFrame:
    """Sorts one decoded frame into the four shapes the session knows how to handle."""
    if not isinstance(frame, dict):
        return Malformed("a JSON-RPC envelope must be an object")
    if frame.get("jsonrpc") != JSONRPC_VERSION:
        return Malformed(f"jsonrpc must be {JSONRPC_VERSION!r}")

    identifier = _read_id(frame.get("id"))
    method = frame.get("method")

    if isinstance(method, str):
        params = frame.get("params")
        if identifier is None:
            return Notification(method, params)
        return Request(identifier, method, params)

    if identifier is None:
        return Malformed("a response must carry a correlatable id")
    if "error" in frame:
        return Failure(identifier, _read_error(frame["error"]))
    if "result" in frame:
        return Success(identifier, frame["result"])
    return Malformed("a response must carry either result or error")


def _read_id(raw_id: JsonValue) -> RequestId | None:
    """The correlatable id, or ``None`` for an envelope that carries no usable one.

    JSON-RPC allows a string, a number, or null. ``true`` is not a number here even though
    Python's ``bool`` is a subclass of ``int``.
    """
    if isinstance(raw_id, bool) or not isinstance(raw_id, str | int | float):
        return None
    return raw_id


def _read_error(payload: JsonValue) -> ProtocolError:
    """Reads an error member, tolerating a gateway that sends less than the spec asks for."""
    if not isinstance(payload, dict):
        return ProtocolError(-32603, "the gateway sent an unreadable error member")
    raw_code = payload.get("code")
    code = raw_code if isinstance(raw_code, int) and not isinstance(raw_code, bool) else -32603
    raw_message = payload.get("message")
    message = raw_message if isinstance(raw_message, str) else "the gateway sent no error message"
    return ProtocolError(code, message, payload.get("data"))
