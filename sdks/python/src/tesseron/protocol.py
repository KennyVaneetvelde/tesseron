"""The Tesseron 1.2 wire format: method names, envelope shapes, and the manifest models."""

from __future__ import annotations

from enum import StrEnum
from typing import Final

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel

from .json_types import JsonObject, JsonValue

__all__ = [
    "GATEWAY_SUBPROTOCOL",
    "JSONRPC_VERSION",
    "PROTOCOL_VERSION",
    "ActionDescriptor",
    "AgentIdentity",
    "ApplicationDescriptor",
    "Capabilities",
    "ClaimedParams",
    "HelloParams",
    "LogLevel",
    "Methods",
    "ResourceDescriptor",
    "ResumeParams",
    "WelcomeResult",
    "is_valid_application_id",
    "shares_major_version",
]

PROTOCOL_VERSION: Final = "1.2.0"
"""The protocol version this package speaks, as it appears in every handshake."""

JSONRPC_VERSION: Final = "2.0"
"""The JSON-RPC version every envelope carries."""

GATEWAY_SUBPROTOCOL: Final = "tesseron-gateway"
"""The WebSocket subprotocol the gateway sends on its upgrade request.

An upgrade without it is not a gateway dial, and the host refuses it: the endpoint exists
for the gateway, not for arbitrary local clients.
"""


class Methods:
    """The JSON-RPC method names this package sends or answers."""

    HELLO: Final = "tesseron/hello"
    RESUME: Final = "tesseron/resume"
    CLAIMED: Final = "tesseron/claimed"
    INVOKE: Final = "actions/invoke"
    CANCEL: Final = "actions/cancel"
    PROGRESS: Final = "actions/progress"
    READ: Final = "resources/read"
    SUBSCRIBE: Final = "resources/subscribe"
    UNSUBSCRIBE: Final = "resources/unsubscribe"
    UPDATED: Final = "resources/updated"
    SAMPLE: Final = "sampling/request"
    ELICIT: Final = "elicitation/request"
    LOG: Final = "log"


class LogLevel(StrEnum):
    """Severity of a ``log`` notification, matching the MCP levels the gateway forwards to."""

    DEBUG = "debug"
    INFO = "info"
    WARN = "warn"
    ERROR = "error"


class WireModel(BaseModel):
    """A model whose Python field names are snake_case and whose JSON keys are camelCase."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="ignore")


class Capabilities(WireModel):
    """What the application itself can do, sent in the handshake.

    This is the application half of the negotiation. The welcome comes back with the
    intersection of these flags and the agent's own.
    """

    streaming: bool = False
    subscriptions: bool = False
    sampling: bool = False
    elicitation: bool = False

    @classmethod
    def implemented(cls) -> Capabilities:
        """The set this package can honestly declare: everything protocol 1.2.0 defines."""
        return cls(streaming=True, subscriptions=True, sampling=True, elicitation=True)

    @classmethod
    def none(cls) -> Capabilities:
        """Nothing negotiated: the answer a handler gets before a welcome arrives."""
        return cls()

    def to_wire(self) -> JsonObject:
        """The four negotiation flags, all of them always present."""
        return {
            "streaming": self.streaming,
            "subscriptions": self.subscriptions,
            "sampling": self.sampling,
            "elicitation": self.elicitation,
        }


class ApplicationDescriptor(WireModel):
    """Who the application is, as the gateway and the agent see it."""

    id: str
    name: str
    description: str | None = None
    origin: str = "unknown"
    version: str | None = None
    icon_url: str | None = None

    def to_wire(self) -> JsonObject:
        """The descriptor, with the optional members the application did not set left out."""
        payload: JsonObject = {"id": self.id, "name": self.name, "origin": self.origin}
        if self.description is not None:
            payload["description"] = self.description
        if self.version is not None:
            payload["version"] = self.version
        if self.icon_url is not None:
            payload["iconUrl"] = self.icon_url
        return payload


class ActionDescriptor(WireModel):
    """One action as it appears in the handshake manifest."""

    name: str
    description: str = ""
    input_schema: JsonValue = Field(default_factory=dict)
    output_schema: JsonValue = None
    timeout_ms: int | None = None

    def to_wire(self) -> JsonObject:
        """The descriptor.

        ``description`` and ``inputSchema`` are always sent, even when they are empty,
        because the gateway projects both into the MCP tool definition.
        """
        payload: JsonObject = {
            "name": self.name,
            "description": self.description,
            "inputSchema": {} if self.input_schema is None else self.input_schema,
        }
        if self.output_schema is not None:
            payload["outputSchema"] = self.output_schema
        if self.timeout_ms is not None:
            payload["timeoutMs"] = self.timeout_ms
        return payload


class ResourceDescriptor(WireModel):
    """One resource as it appears in the handshake manifest."""

    name: str
    description: str = ""
    subscribable: bool = False

    def to_wire(self) -> JsonObject:
        """The descriptor. Every member is always sent."""
        return {
            "name": self.name,
            "description": self.description,
            "subscribable": self.subscribable,
        }


class AgentIdentity(WireModel):
    """Identity of the agent on the other end of the session."""

    id: str
    name: str

    @classmethod
    def pending(cls) -> AgentIdentity:
        """The placeholder identity a session carries until a claim happens."""
        return cls(id="pending", name="Awaiting agent")


class WelcomeResult(WireModel):
    """The result of ``tesseron/hello`` and of ``tesseron/resume``.

    There is no ``tesseron/welcome`` method on the wire; "welcome" is the name of this
    result shape. A gateway that omits ``capabilities`` has negotiated nothing, so the
    default is the empty set rather than what this host declared: assuming the agent can
    sample or elicit would make handlers wait on requests nobody answers.
    """

    session_id: str
    protocol_version: str
    capabilities: Capabilities = Field(default_factory=Capabilities.none)
    agent: AgentIdentity = Field(default_factory=AgentIdentity.pending)
    claim_code: str | None = None
    resume_token: str | None = None


class ClaimedParams(WireModel):
    """``tesseron/claimed`` parameters: the claim code has been redeemed."""

    agent: AgentIdentity
    claimed_at: int = 0
    agent_capabilities: JsonValue = None


class HelloParams(WireModel):
    """``tesseron/hello`` parameters: the whole application manifest."""

    protocol_version: str
    app: ApplicationDescriptor
    actions: list[ActionDescriptor]
    resources: list[ResourceDescriptor]
    capabilities: Capabilities

    def to_wire(self) -> JsonObject:
        """The manifest, with each descriptor serialised by its own rules."""
        return {
            "protocolVersion": self.protocol_version,
            "app": self.app.to_wire(),
            "actions": [action.to_wire() for action in self.actions],
            "resources": [resource.to_wire() for resource in self.resources],
            "capabilities": self.capabilities.to_wire(),
        }


class ResumeParams(HelloParams):
    """``tesseron/resume`` parameters: the manifest again, plus the credentials.

    The manifest repeats because a restarted application may have added, removed, or
    changed actions since the session was claimed; the gateway replaces its stored copy
    with whatever resume brings in.
    """

    session_id: str
    resume_token: str

    def to_wire(self) -> JsonObject:
        """The manifest plus the credentials this resume presents."""
        payload = super().to_wire()
        payload["sessionId"] = self.session_id
        payload["resumeToken"] = self.resume_token
        return payload


RESERVED_APPLICATION_IDS: Final = frozenset({"tesseron", "mcp", "system"})


def is_valid_application_id(application_id: str) -> bool:
    """Whether an application id is usable as an MCP tool prefix.

    The grammar is ``^[a-z][a-z0-9_]*$`` and three ids are reserved for the gateway's own
    tools.
    """
    if not application_id or application_id in RESERVED_APPLICATION_IDS:
        return False
    if not ("a" <= application_id[0] <= "z"):
        return False
    return all(
        ("a" <= character <= "z") or ("0" <= character <= "9") or character == "_"
        for character in application_id[1:]
    )


def shares_major_version(left: str, right: str) -> bool:
    """Whether two protocol versions agree on their major component.

    A missing major is treated as a mismatch rather than as a match, because guessing is
    how a 2.x gateway silently talks to a 1.x host.
    """
    left_major = left.split(".", 1)[0]
    right_major = right.split(".", 1)[0]
    return bool(left_major) and left_major == right_major
