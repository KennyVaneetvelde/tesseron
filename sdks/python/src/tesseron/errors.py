"""Every failure the Tesseron wire protocol can carry, and the two ways a handler reports one."""

from __future__ import annotations

from enum import IntEnum

from .json_types import JsonValue

__all__ = [
    "ActionError",
    "DuplicateNameError",
    "HostError",
    "InvalidApplicationIdError",
    "ManifestError",
    "MissingApplicationError",
    "ProtocolError",
    "TesseronErrorCode",
]


class TesseronErrorCode(IntEnum):
    """Every error code the Tesseron wire protocol defines, named.

    The set is closed. A gateway that sends an integer outside it speaks a protocol this
    package does not implement, so :class:`ProtocolError` keeps the raw integer and
    :attr:`ProtocolError.named_code` answers ``None`` rather than inventing a member.
    """

    PARSE_ERROR = -32700
    INVALID_REQUEST = -32600
    METHOD_NOT_FOUND = -32601
    INVALID_PARAMS = -32602
    INTERNAL_ERROR = -32603
    PROTOCOL_MISMATCH = -32000
    CANCELLED = -32001
    TIMEOUT = -32002
    ACTION_NOT_FOUND = -32003
    INPUT_VALIDATION = -32004
    HANDLER_ERROR = -32005
    SAMPLING_NOT_AVAILABLE = -32006
    ELICITATION_NOT_AVAILABLE = -32007
    SAMPLING_DEPTH_EXCEEDED = -32008
    UNAUTHORIZED = -32009
    TRANSPORT_CLOSED = -32010
    RESUME_FAILED = -32011

    @classmethod
    def from_wire_code(cls, code: int) -> TesseronErrorCode | None:
        """Names a wire integer, or answers ``None`` for a code this version does not define."""
        try:
            return cls(code)
        except ValueError:
            return None


class ProtocolError(Exception):
    """The ``error`` member of a JSON-RPC failure response, exactly as it travels.

    The code stays a plain integer so an envelope from a newer gateway round-trips without
    loss; read :attr:`named_code` when the enum member is what you want.
    """

    def __init__(self, code: int, message: str, data: JsonValue = None) -> None:
        super().__init__(f"{message} ({code})")
        self.code = code
        self.message = message
        self.data = data

    @property
    def named_code(self) -> TesseronErrorCode | None:
        """The named code, or ``None`` when the peer used an integer outside the closed set."""
        return TesseronErrorCode.from_wire_code(self.code)

    def to_wire(self) -> dict[str, JsonValue]:
        """The JSON-RPC ``error`` member for this failure."""
        payload: dict[str, JsonValue] = {"code": self.code, "message": self.message}
        if self.data is not None:
            payload["data"] = self.data
        return payload


class ActionError(Exception):
    """What an action handler raises when it cannot produce its output.

    The distinction that matters on the wire is deliberate: :meth:`handler` and
    :meth:`protocol` send their message and data to the agent, while :meth:`internal` keeps
    the cause on this side of the socket and answers with a bare ``-32603``.
    """

    def __init__(
        self,
        code: TesseronErrorCode,
        message: str,
        data: JsonValue = None,
        internal_source: BaseException | None = None,
    ) -> None:
        super().__init__(f"{message} ({code.name} {code.value})")
        self.code = code
        self.message = message
        self.data = data
        self.internal_source = internal_source

    @classmethod
    def handler(cls, message: str, data: JsonValue = None) -> ActionError:
        """A domain failure the agent is meant to read. Answers ``-32005 HandlerError``."""
        return cls(TesseronErrorCode.HANDLER_ERROR, message, data)

    @classmethod
    def protocol(cls, code: TesseronErrorCode, message: str, data: JsonValue = None) -> ActionError:
        """A failure that must carry one specific protocol code, keeping its code and data."""
        return cls(code, message, data)

    @classmethod
    def internal(cls, source: BaseException) -> ActionError:
        """An unexpected failure.

        The cause is kept locally and reported through :attr:`internal_source`; the agent
        only ever sees ``-32603`` with a fixed message, because a stack trace or a database
        URL in a handler error is a leak.
        """
        return cls(TesseronErrorCode.INTERNAL_ERROR, "Internal error", None, source)

    def with_data(self, data: JsonValue) -> ActionError:
        """Attaches structured detail the agent can branch on."""
        return ActionError(self.code, self.message, data, self.internal_source)

    def to_protocol_error(self) -> ProtocolError:
        """The payload to put in the JSON-RPC failure response.

        Pure: reporting the held-back cause is the caller's job.
        """
        return ProtocolError(int(self.code), self.message, self.data)


class HostError(Exception):
    """Why a host could not start, publish itself, or shut down."""


class MissingApplicationError(HostError):
    """No application descriptor was registered before ``listen``."""


class InvalidApplicationIdError(HostError):
    """The application id is reserved or does not match ``^[a-z][a-z0-9_]*$``."""


class DuplicateNameError(HostError):
    """Two actions, or two resources, were registered under one name.

    The manifest has to stay unambiguous because the gateway projects each name into a
    distinct MCP tool.
    """


class ManifestError(HostError):
    """The instance manifest could not be written or removed."""
