"""The application half of the protocol: register actions, listen, let the gateway dial in."""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Final, TypeAlias, TypeVar, get_type_hints

from pydantic import BaseModel, ValidationError
from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.datastructures import Headers
from websockets.http11 import Request, Response
from websockets.typing import Subprotocol

from .action import (
    InputValidator,
    LooseHandler,
    RegisteredAction,
    raw_dispatch,
    typed_dispatch,
)
from .errors import (
    DuplicateNameError,
    HostError,
    InvalidApplicationIdError,
    ProtocolError,
)
from .json_types import JsonValue
from .manifest import (
    InstanceManifest,
    ManifestPublication,
    default_instance_directory,
    mint_instance_id,
    publish,
    withdraw,
)
from .protocol import (
    GATEWAY_SUBPROTOCOL,
    PROTOCOL_VERSION,
    ActionDescriptor,
    AgentIdentity,
    ApplicationDescriptor,
    Capabilities,
    ClaimedParams,
    HelloParams,
    ResourceDescriptor,
    ResumeParams,
    WelcomeResult,
    is_valid_application_id,
)
from .resource import Resource, ResourceReader, SubscribeCallback
from .session import serve_connection

__all__ = [
    "ClaimedEvent",
    "DisconnectedEvent",
    "HandshakeFailedEvent",
    "HostEvent",
    "HostEventListener",
    "SharedHost",
    "TesseronApp",
    "TesseronHost",
    "WelcomeEvent",
]

logger: Final = logging.getLogger("tesseron")

Handler = TypeVar("Handler", bound=LooseHandler)


@dataclass(frozen=True)
class WelcomeEvent:
    """The gateway accepted the handshake. Carries the claim code on a fresh session."""

    welcome: WelcomeResult


@dataclass(frozen=True)
class ClaimedEvent:
    """An agent redeemed the claim code; the session now has an identity."""

    claimed: ClaimedParams


@dataclass(frozen=True)
class HandshakeFailedEvent:
    """The gateway refused the handshake. The host waits for the next dial."""

    error: ProtocolError


@dataclass(frozen=True)
class DisconnectedEvent:
    """The gateway connection closed."""


HostEvent: TypeAlias = "WelcomeEvent | ClaimedEvent | HandshakeFailedEvent | DisconnectedEvent"
HostEventListener: TypeAlias = "Callable[[HostEvent], None]"


class SharedHost:
    """The registry and the session state every gateway connection reads and updates."""

    protocol_version: Final = PROTOCOL_VERSION

    def __init__(
        self,
        application: ApplicationDescriptor,
        capabilities: Capabilities,
        actions: dict[str, RegisteredAction],
        resources: dict[str, Resource],
        listeners: list[HostEventListener],
    ) -> None:
        self.application = application
        self.capabilities = capabilities
        self.actions = actions
        self.resources = resources
        self._listeners = listeners
        self._welcome: WelcomeResult | None = None
        self._claim: ClaimedParams | None = None
        self._resume: tuple[str, str] | None = None

    @property
    def origin(self) -> str:
        """The origin the application declared."""
        return self.application.origin

    @property
    def welcome(self) -> WelcomeResult | None:
        """The most recent welcome, with any claim already merged into it."""
        return self._welcome

    def hello_params(self) -> HelloParams:
        """The manifest a fresh ``tesseron/hello`` publishes."""
        return HelloParams(
            protocol_version=PROTOCOL_VERSION,
            app=self.application,
            actions=self._action_descriptors(),
            resources=self._resource_descriptors(),
            capabilities=self.capabilities,
        )

    def resume_params(self, session_id: str, resume_token: str) -> ResumeParams:
        """The manifest plus credentials a ``tesseron/resume`` presents."""
        return ResumeParams(
            protocol_version=PROTOCOL_VERSION,
            app=self.application,
            actions=self._action_descriptors(),
            resources=self._resource_descriptors(),
            capabilities=self.capabilities,
            session_id=session_id,
            resume_token=resume_token,
        )

    def resume_credentials(self) -> tuple[str, str] | None:
        """The session id and one-shot token from the freshest welcome, when there is one."""
        return self._resume

    def forget_resume_credentials(self) -> None:
        """Drops stale credentials so the next handshake opens a fresh session."""
        self._resume = None

    def record_welcome(self, welcome: WelcomeResult) -> None:
        """Stores the welcome and rotates the resume token it carried."""
        self._welcome = welcome
        self._resume = (
            (welcome.session_id, welcome.resume_token) if welcome.resume_token is not None else None
        )
        if self._claim is not None:
            self._apply_claim(self._claim)
        self._emit(WelcomeEvent(welcome))

    def record_claim(self, claimed: ClaimedParams) -> None:
        """Stores the claim and merges the agent identity into the welcome."""
        self._claim = claimed
        self._apply_claim(claimed)
        self._emit(ClaimedEvent(claimed))

    def negotiated_capabilities(self) -> Capabilities:
        """The intersection the gateway reported, or nothing when no welcome has landed."""
        return self._welcome.capabilities if self._welcome is not None else Capabilities.none()

    def agent_identity(self) -> AgentIdentity:
        """Who is invoking. ``pending`` until the session is claimed."""
        return self._welcome.agent if self._welcome is not None else AgentIdentity.pending()

    def emit_handshake_failed(self, error: ProtocolError) -> None:
        """Reports a handshake the gateway refused."""
        self._emit(HandshakeFailedEvent(error))

    def emit_disconnected(self) -> None:
        """Reports the gateway connection closing."""
        self._emit(DisconnectedEvent())

    def _apply_claim(self, claimed: ClaimedParams) -> None:
        welcome = self._welcome
        if welcome is None:
            return
        negotiated = _read_capabilities(claimed.agent_capabilities)
        self._welcome = welcome.model_copy(
            update={
                "agent": claimed.agent,
                "claim_code": None,
                "capabilities": negotiated if negotiated is not None else welcome.capabilities,
            }
        )

    def _emit(self, event: HostEvent) -> None:
        for listener in list(self._listeners):
            try:
                listener(event)
            # One bad listener must not break the session it was told about.
            except Exception:
                logger.exception("tesseron: a host event listener raised")

    def _action_descriptors(self) -> list[ActionDescriptor]:
        return [action.descriptor for action in self.actions.values()]

    def _resource_descriptors(self) -> list[ResourceDescriptor]:
        return [resource.descriptor for resource in self.resources.values()]


def _read_capabilities(payload: JsonValue) -> Capabilities | None:
    if payload is None:
        return None
    try:
        return Capabilities.model_validate(payload)
    except ValidationError:
        return None


class TesseronApp:
    """One application the gateway can dial: a descriptor, its actions, and its resources."""

    def __init__(
        self,
        *,
        id: str,  # noqa: A002 - "id" is the field name the protocol uses
        name: str,
        description: str | None = None,
        origin: str = "unknown",
        version: str | None = None,
        icon_url: str | None = None,
        manifest: ManifestPublication | None = None,
        bind_host: str = "127.0.0.1",
        bind_port: int = 0,
    ) -> None:
        self.descriptor = ApplicationDescriptor(
            id=id,
            name=name,
            description=description,
            origin=origin,
            version=version,
            icon_url=icon_url,
        )
        self.manifest = (
            manifest if manifest is not None else ManifestPublication.default_directory()
        )
        self.bind_host = bind_host
        self.bind_port = bind_port
        self._actions: dict[str, RegisteredAction] = {}
        self._resources: dict[str, Resource] = {}
        self._listeners: list[HostEventListener] = []

    def action(
        self,
        name: str,
        *,
        description: str = "",
        input_schema: JsonValue = None,
        output_schema: JsonValue = None,
        timeout_ms: int | None = None,
        validate: InputValidator | None = None,
    ) -> Callable[[Handler], Handler]:
        """Registers one action, taking its input contract from the handler's annotation.

        A first parameter annotated with a Pydantic model publishes that model's
        validation-mode JSON Schema and is validated with ``model_validate`` before the
        handler body runs. Any other annotation means the handler takes raw JSON, in which
        case ``input_schema`` is what the manifest publishes and ``validate`` is what
        enforces it.
        """

        def register(handler: Handler) -> Handler:
            # Held in a local so the type guard does not narrow the handler away from the
            # type variable the decorator has to give back unchanged.
            handler_is_async = inspect.iscoroutinefunction(handler)
            if not handler_is_async:
                raise HostError(f"the handler for {name!r} must be an async function")
            model = _input_model(handler)
            if model is not None:
                dispatch = typed_dispatch(model, handler)
                schema = (
                    model.model_json_schema(mode="validation")
                    if input_schema is None
                    else input_schema
                )
            else:
                dispatch = raw_dispatch(handler, validate)
                schema = {} if input_schema is None else input_schema
            descriptor = ActionDescriptor(
                name=name,
                description=description,
                input_schema=schema,
                output_schema=output_schema,
                timeout_ms=timeout_ms,
            )
            if name in self._actions:
                raise DuplicateNameError(f"action {name!r} was registered more than once")
            self._actions[name] = RegisteredAction(descriptor=descriptor, dispatch=dispatch)
            return handler

        return register

    def resource(
        self,
        name: str,
        *,
        read: ResourceReader,
        description: str = "",
        subscribable: bool = False,
        subscribe: SubscribeCallback | None = None,
    ) -> Resource:
        """Registers one resource and answers with the handle its updates are published on."""
        if name in self._resources:
            raise DuplicateNameError(f"resource {name!r} was registered more than once")
        resource = Resource(
            name,
            read=read,
            description=description,
            subscribable=subscribable,
            subscribe=subscribe,
        )
        self._resources[name] = resource
        return resource

    def add_event_listener(self, listener: HostEventListener) -> None:
        """Watches the session lifecycle: welcome, claim, refused handshake, disconnect."""
        self._listeners.append(listener)

    async def listen(self) -> TesseronHost:
        """Binds the loopback endpoint, publishes the manifest, and waits for the gateway.

        Raises:
            HostError: when the application id is unusable or the manifest cannot be written.
        """
        if not is_valid_application_id(self.descriptor.id):
            raise InvalidApplicationIdError(
                f"application id {self.descriptor.id!r} must match ^[a-z][a-z0-9_]*$ "
                "and must not be reserved"
            )
        shared = SharedHost(
            application=self.descriptor,
            capabilities=Capabilities.implemented(),
            actions=dict(self._actions),
            resources=dict(self._resources),
            listeners=self._listeners,
        )
        # One gateway at a time: the protocol gives a session one connection, and a second
        # dial that raced the first would negotiate against half-applied state.
        gateway = asyncio.Lock()

        async def handle(connection: ServerConnection) -> None:
            async with gateway:
                await serve_connection(connection, shared)

        server = await serve(
            handle,
            self.bind_host,
            self.bind_port,
            subprotocols=[Subprotocol(GATEWAY_SUBPROTOCOL)],
            process_request=_require_gateway_subprotocol,
        )
        url = f"ws://{_bound_address(server)}/"
        manifest_path = self._publish_manifest(url)
        return TesseronHost(url=url, server=server, shared=shared, manifest_path=manifest_path)

    def _publish_manifest(self, url: str) -> Path | None:
        if not self.manifest.enabled:
            return None
        directory = self.manifest.directory or default_instance_directory()
        document = InstanceManifest(
            instance_id=mint_instance_id(), app_name=self.descriptor.name, url=url
        )
        return publish(document, directory)


class TesseronHost:
    """A listening application. The gateway dials it; nothing here dials out."""

    def __init__(
        self,
        *,
        url: str,
        server: Server,
        shared: SharedHost,
        manifest_path: Path | None,
    ) -> None:
        self.url = url
        self.instance_manifest_path = manifest_path
        self._server = server
        self._shared = shared

    @property
    def welcome(self) -> WelcomeResult | None:
        """The most recent welcome, or ``None`` before a gateway has connected."""
        return self._shared.welcome

    async def shutdown(self) -> None:
        """Stops listening, drops the connection, and removes the published manifest."""
        self._server.close()
        await self._server.wait_closed()
        if self.instance_manifest_path is not None:
            withdraw(self.instance_manifest_path)


def _require_gateway_subprotocol(connection: ServerConnection, request: Request) -> Response | None:
    """Refuses an upgrade that is not a gateway dial.

    The endpoint exists for the gateway. A browser tab or a stray client that reaches the
    loopback port gets a 400 instead of a session.
    """
    if GATEWAY_SUBPROTOCOL in _offered_subprotocols(request.headers):
        return None
    return connection.respond(
        400, f"this endpoint requires the {GATEWAY_SUBPROTOCOL} subprotocol\n"
    )


def _offered_subprotocols(headers: Headers) -> set[str]:
    offered: set[str] = set()
    for value in headers.get_all("Sec-WebSocket-Protocol"):
        offered.update(token.strip() for token in value.split(","))
    return offered


def _bound_address(server: Server) -> str:
    for socket in server.sockets:
        address = socket.getsockname()
        if isinstance(address, tuple) and len(address) >= 2:
            return f"{address[0]}:{address[1]}"
    raise HostError("the loopback listener reported no address")


def _input_model(handler: LooseHandler) -> type[BaseModel] | None:
    """The Pydantic model a handler's first parameter declares, when it declares one."""
    parameters = list(inspect.signature(handler).parameters.values())
    if len(parameters) < 2:
        raise HostError("an action handler takes (input, context)")
    annotations: dict[str, object] = dict(get_type_hints(handler))
    declared = annotations.get(parameters[0].name)
    if isinstance(declared, type) and issubclass(declared, BaseModel):
        return declared
    return None
