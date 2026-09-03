"""Readable, optionally subscribable application state the agent can pull or follow."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from typing import TypeAlias

from .json_types import JsonValue
from .protocol import ResourceDescriptor

__all__ = [
    "Emit",
    "Resource",
    "ResourceReader",
    "SubscribeCallback",
    "Subscription",
    "Unsubscribe",
]

ResourceReader: TypeAlias = "Callable[[], Awaitable[JsonValue]]"
"""Produces the resource's current value. Runs on every ``resources/read``."""

Emit: TypeAlias = "Callable[[JsonValue], None]"
"""Pushes one value to the agent that subscribed."""

Unsubscribe: TypeAlias = "Callable[[], None]"
"""Undoes whatever a subscribe callback set up."""

SubscribeCallback: TypeAlias = "Callable[[Emit], Unsubscribe | None]"
"""Starts pushing values, and answers with the cleanup that stops again."""


class Subscription:
    """One live subscription, and the cleanup that ends it."""

    def __init__(self, stop: Unsubscribe | None) -> None:
        self._stop = stop

    def stop(self) -> None:
        """Runs the cleanup once. Stopping an already-stopped subscription does nothing."""
        stop = self._stop
        self._stop = None
        if stop is not None:
            stop()


class Resource:
    """A named piece of application state the agent can read, and maybe follow.

    Registering a ``subscribe`` callback is optional: a resource is subscribable as soon as
    the application says so, because :meth:`publish` is enough on its own to push updates.
    """

    def __init__(
        self,
        name: str,
        *,
        read: ResourceReader,
        description: str = "",
        subscribable: bool = False,
        subscribe: SubscribeCallback | None = None,
    ) -> None:
        self.name = name
        self.description = description
        self.subscribable = subscribable or subscribe is not None
        self._read = read
        self._subscribe = subscribe
        self._listeners: list[Emit] = []

    @property
    def descriptor(self) -> ResourceDescriptor:
        """How this resource appears in the handshake manifest."""
        return ResourceDescriptor(
            name=self.name, description=self.description, subscribable=self.subscribable
        )

    async def read(self) -> JsonValue:
        """The resource's current value."""
        return await self._read()

    async def publish(self, value: JsonValue) -> None:
        """Pushes ``value`` to every agent currently subscribed to this resource."""
        for listener in list(self._listeners):
            listener(value)

    def open_subscription(self, emit: Emit) -> Subscription:
        """Registers one subscriber and runs the application's own subscribe callback."""
        self._listeners.append(emit)
        application_cleanup = self._subscribe(emit) if self._subscribe is not None else None

        def stop() -> None:
            if emit in self._listeners:
                self._listeners.remove(emit)
            if application_cleanup is not None:
                application_cleanup()

        return Subscription(stop)
