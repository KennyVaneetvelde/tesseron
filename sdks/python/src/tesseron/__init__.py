"""Tesseron: expose typed application actions to MCP-compatible AI agents over WebSocket.

The application listens and the gateway dials in. Build a :class:`TesseronApp`, register
actions and resources on it, ``await app.listen()``, and hand the gateway the manifest the
host writes.
"""

from __future__ import annotations

from .action import ActionHandler, InputValidator, TypedActionHandler, ValidationIssue
from .context import ActionContext, Cancellation
from .errors import (
    ActionError,
    DuplicateNameError,
    HostError,
    InvalidApplicationIdError,
    ManifestError,
    MissingApplicationError,
    ProtocolError,
    TesseronErrorCode,
)
from .host import (
    ClaimedEvent,
    DisconnectedEvent,
    HandshakeFailedEvent,
    HostEvent,
    HostEventListener,
    TesseronApp,
    TesseronHost,
    WelcomeEvent,
)
from .json_types import JsonObject, JsonValue
from .manifest import InstanceManifest, ManifestPublication
from .protocol import (
    GATEWAY_SUBPROTOCOL,
    PROTOCOL_VERSION,
    ActionDescriptor,
    AgentIdentity,
    ApplicationDescriptor,
    Capabilities,
    ClaimedParams,
    LogLevel,
    ResourceDescriptor,
    WelcomeResult,
)
from .resource import (
    Emit,
    Resource,
    ResourceReader,
    SubscribeCallback,
    Subscription,
    Unsubscribe,
)

__all__ = [
    "GATEWAY_SUBPROTOCOL",
    "PROTOCOL_VERSION",
    "ActionContext",
    "ActionDescriptor",
    "ActionError",
    "ActionHandler",
    "AgentIdentity",
    "ApplicationDescriptor",
    "Cancellation",
    "Capabilities",
    "ClaimedEvent",
    "ClaimedParams",
    "DisconnectedEvent",
    "DuplicateNameError",
    "Emit",
    "HandshakeFailedEvent",
    "HostError",
    "HostEvent",
    "HostEventListener",
    "InputValidator",
    "InstanceManifest",
    "InvalidApplicationIdError",
    "JsonObject",
    "JsonValue",
    "LogLevel",
    "ManifestError",
    "ManifestPublication",
    "MissingApplicationError",
    "ProtocolError",
    "Resource",
    "ResourceDescriptor",
    "ResourceReader",
    "SubscribeCallback",
    "Subscription",
    "TesseronApp",
    "TesseronErrorCode",
    "TesseronHost",
    "TypedActionHandler",
    "Unsubscribe",
    "ValidationIssue",
    "WelcomeEvent",
    "WelcomeResult",
]
