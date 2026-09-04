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
    "InvalidRequest",
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

RequestId: TypeAlias = "str | int | float | None"
"""What JSON-RPC allows as an id, including null for requests that expect a null response."""


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
class InvalidRequest:
    """A malformed request-shaped envelope that must receive an error response."""

    id: RequestId
    reason: str


@dataclass(frozen=True)
class Malformed:
    """A frame that is not a JSON-RPC 2.0 message this host can act on."""

    reason: str


IncomingFrame: TypeAlias = "Success | Failure | Request | Notification | InvalidRequest | Malformed"


def classify(frame: JsonValue) -> IncomingFrame:
    """Sorts one decoded frame into the shapes the session knows how to handle."""
    if not isinstance(frame, dict):
        return Malformed("a JSON-RPC envelope must be an object")

    method = frame.get("method")
    if frame.get("jsonrpc") != JSONRPC_VERSION:
        if not isinstance(method, str):
            return Malformed(f"jsonrpc must be {JSONRPC_VERSION!r}")
        identifier = _read_id(frame["id"]) if "id" in frame else None
        request_id = None if isinstance(identifier, _InvalidRequestId) else identifier
        return InvalidRequest(request_id, 'envelope is missing jsonrpc: "2.0"')

    if isinstance(method, str):
        params = frame.get("params")
        if "id" not in frame:
            return Notification(method, params)
        identifier = _read_id(frame["id"])
        if isinstance(identifier, _InvalidRequestId):
            return InvalidRequest(None, "request id is not a string, number, or null")
        return Request(identifier, method, params)

    if "id" not in frame:
        return Malformed("a response must carry a correlatable id")
    identifier = _read_id(frame["id"])
    if isinstance(identifier, _InvalidRequestId):
        return Malformed("a response must carry a correlatable id")
    if "error" in frame:
        return Failure(identifier, _read_error(frame["error"]))
    if "result" in frame:
        return Success(identifier, frame["result"])
    return Malformed("a response must carry either result or error")


@dataclass(frozen=True)
class _InvalidRequestId:
    pass


_INVALID_REQUEST_ID = _InvalidRequestId()


def _read_id(raw_id: JsonValue) -> RequestId | _InvalidRequestId:
    """Reads a JSON-RPC id without confusing a null id with an invalid one."""
    if raw_id is None:
        return None
    if isinstance(raw_id, bool) or not isinstance(raw_id, str | int | float):
        return _INVALID_REQUEST_ID
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
