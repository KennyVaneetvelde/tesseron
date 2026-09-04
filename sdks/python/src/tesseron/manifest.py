"""The instance manifest a running application writes so the gateway can find it."""

from __future__ import annotations

import itertools
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from .errors import HostError, ManifestError
from .json_types import JsonObject

__all__ = [
    "InstanceManifest",
    "ManifestPublication",
    "default_instance_directory",
    "mint_instance_id",
    "publish",
    "withdraw",
]

DIRECTORY_MODE: Final = 0o700
"""Instance manifests live in a private directory: owner read, write, execute."""

FILE_MODE: Final = 0o600
"""The manifest itself is owner-only: it names an endpoint anyone who can read it may dial."""

MANIFEST_VERSION: Final = 2
"""Released gateways compare this strictly, so it does not move when optional fields are added."""

_instance_counter = itertools.count()


@dataclass(frozen=True)
class InstanceManifest:
    """How the gateway can reach a running application.

    This release writes the ``ws`` transport only. A new binding means a new field here and
    a new dialer in the gateway.
    """

    instance_id: str
    app_name: str
    url: str

    def to_wire(self) -> JsonObject:
        """The manifest document as the gateway reads it."""
        return {
            "version": MANIFEST_VERSION,
            "instanceId": self.instance_id,
            "appName": self.app_name,
            "addedAt": _unix_milliseconds(),
            "pid": os.getpid(),
            "transport": {"kind": "ws", "url": self.url},
        }


@dataclass(frozen=True)
class ManifestPublication:
    """Where, or whether, a host publishes its instance manifest.

    Disabling publication is what a test harness wants: the conformance runner dials the
    host directly and must never touch the developer's ``~/.tesseron/instances``.
    """

    enabled: bool = True
    directory: Path | None = None

    @classmethod
    def default_directory(cls) -> ManifestPublication:
        """Publish to ``~/.tesseron/instances``, where the gateway watches."""
        return cls()

    @classmethod
    def in_directory(cls, directory: Path) -> ManifestPublication:
        """Publish to a directory chosen by the caller."""
        return cls(directory=directory)

    @classmethod
    def disabled(cls) -> ManifestPublication:
        """Publish nothing. The instance is only reachable by an address the caller hands out."""
        return cls(enabled=False)


def mint_instance_id() -> str:
    """Mints an identifier unique among the instances one process runs.

    Uniqueness only has to hold inside one user's ``~/.tesseron/instances``, and process id
    plus start time plus a counter gives that without pulling in a random number generator.
    """
    return f"inst-{os.getpid():x}-{_unix_milliseconds():x}-{next(_instance_counter):x}"


def default_instance_directory() -> Path:
    """Resolves ``~/.tesseron/instances`` from the environment.

    ``USERPROFILE`` comes first on Windows because a shell such as Git Bash also exports
    ``HOME``, pointing at an emulation root the gateway never scans.
    """
    names = ("USERPROFILE", "HOME") if os.name == "nt" else ("HOME", "USERPROFILE")
    for name in names:
        value = os.environ.get(name)
        if value:
            return Path(value) / ".tesseron" / "instances"
    raise HostError("could not resolve a home directory for ~/.tesseron")


def publish(manifest: InstanceManifest, directory: Path) -> Path:
    """Writes the manifest into ``directory`` and answers with the file it created.

    The write is atomic through a rename so a gateway watching the directory never reads a
    half-written file, and the staging file is created with the final mode so the endpoint
    is never briefly world-readable. POSIX modes are advisory on Windows, where the user
    account is the gate.
    """
    try:
        directory.mkdir(parents=True, exist_ok=True)
        _tighten_directory(directory)
        destination = directory / f"{manifest.instance_id}.json"
        staging = directory / f"{manifest.instance_id}.json.partial"
        encoded = json.dumps(manifest.to_wire()).encode("utf-8")
        descriptor = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, FILE_MODE)
        with os.fdopen(descriptor, "wb") as file:
            file.write(encoded)
            file.flush()
            os.fsync(file.fileno())
        staging.replace(destination)
    except OSError as problem:
        raise ManifestError(f"could not publish the instance manifest: {problem}") from problem
    return destination


def withdraw(path: Path) -> None:
    """Removes a published manifest.

    A manifest that is already gone is a success: the goal is that nothing is left behind,
    not that this call did the removing.
    """
    try:
        path.unlink(missing_ok=True)
    except OSError as problem:
        raise ManifestError(f"could not remove the instance manifest: {problem}") from problem


def _tighten_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    directory.chmod(DIRECTORY_MODE)


def _unix_milliseconds() -> int:
    return int(time.time() * 1000)
