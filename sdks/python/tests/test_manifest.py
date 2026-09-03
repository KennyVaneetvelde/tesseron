"""What the instance manifest says, and how tightly it is written."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from tesseron import InstanceManifest, ManifestPublication
from tesseron.manifest import FILE_MODE, MANIFEST_VERSION, mint_instance_id, publish, withdraw


def read_manifest(path: Path) -> dict[str, object]:
    decoded = json.loads(path.read_text(encoding="utf-8"))
    assert isinstance(decoded, dict)
    return decoded


def test_a_published_manifest_names_the_endpoint_the_gateway_should_dial(tmp_path: Path) -> None:
    document = InstanceManifest(instance_id="i_test_1", app_name="Todo", url="ws://127.0.0.1:5051/")

    path = publish(document, tmp_path / "instances")

    written = read_manifest(path)
    assert written["version"] == MANIFEST_VERSION
    assert written["instanceId"] == "i_test_1"
    assert written["appName"] == "Todo"
    assert written["transport"] == {"kind": "ws", "url": "ws://127.0.0.1:5051/"}
    assert written["pid"] == os.getpid()


def test_a_manifest_is_written_where_only_its_owner_can_read_it(tmp_path: Path) -> None:
    document = InstanceManifest(instance_id="i_test_2", app_name="Todo", url="ws://127.0.0.1:1/")

    path = publish(document, tmp_path / "instances")

    if os.name != "nt":
        # POSIX modes are advisory on Windows, where the user account is the gate.
        assert stat.S_IMODE(path.stat().st_mode) == FILE_MODE
        assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700


def test_withdrawing_a_manifest_twice_is_not_an_error(tmp_path: Path) -> None:
    document = InstanceManifest(instance_id="i_test_3", app_name="Todo", url="ws://127.0.0.1:1/")
    path = publish(document, tmp_path)

    withdraw(path)
    withdraw(path)

    assert not path.exists()


def test_instance_ids_are_unique_within_one_process() -> None:
    assert len({mint_instance_id() for _ in range(50)}) == 50


def test_publication_can_be_pointed_somewhere_else_or_switched_off(tmp_path: Path) -> None:
    assert ManifestPublication.disabled().enabled is False
    chosen = ManifestPublication.in_directory(tmp_path)
    assert chosen.enabled is True
    assert chosen.directory == tmp_path
    assert ManifestPublication.default_directory().directory is None
