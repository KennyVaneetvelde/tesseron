"""Application ids, version comparison, and the descriptor shapes the handshake carries."""

from __future__ import annotations

import pytest

from tesseron import ActionDescriptor, ApplicationDescriptor, Capabilities, ResourceDescriptor
from tesseron.protocol import is_valid_application_id, shares_major_version


@pytest.mark.parametrize(
    "application_id",
    ["todo", "t", "todo_app", "a1", "cart_2"],
)
def test_a_usable_application_id_is_accepted(application_id: str) -> None:
    assert is_valid_application_id(application_id)


@pytest.mark.parametrize(
    "application_id",
    ["", "Todo", "1todo", "todo-app", "todo app", "tesseron", "mcp", "system"],
)
def test_an_unusable_application_id_is_refused(application_id: str) -> None:
    assert not is_valid_application_id(application_id)


def test_versions_agree_only_on_a_shared_major() -> None:
    assert shares_major_version("1.2.0", "1.9.3")
    assert not shares_major_version("1.2.0", "2.0.0")
    assert not shares_major_version("", "1.2.0")


def test_an_action_descriptor_always_sends_a_description_and_an_input_schema() -> None:
    wire = ActionDescriptor(name="add").to_wire()
    assert wire == {"name": "add", "description": "", "inputSchema": {}}


def test_an_action_descriptor_sends_the_optional_members_it_was_given() -> None:
    wire = ActionDescriptor(
        name="add",
        description="Add two numbers",
        input_schema={"type": "object"},
        output_schema={"type": "number"},
        timeout_ms=5000,
    ).to_wire()
    assert wire["outputSchema"] == {"type": "number"}
    assert wire["timeoutMs"] == 5000


def test_a_resource_descriptor_sends_every_member() -> None:
    assert ResourceDescriptor(name="cart").to_wire() == {
        "name": "cart",
        "description": "",
        "subscribable": False,
    }


def test_an_application_descriptor_leaves_out_what_it_was_not_given() -> None:
    wire = ApplicationDescriptor(id="todo", name="Todo", origin="http://127.0.0.1").to_wire()
    assert wire == {"id": "todo", "name": "Todo", "origin": "http://127.0.0.1"}


def test_the_declared_capabilities_are_everything_this_release_implements() -> None:
    assert Capabilities.implemented().to_wire() == {
        "streaming": True,
        "subscriptions": True,
        "sampling": True,
        "elicitation": True,
    }
    assert Capabilities.none().to_wire() == {
        "streaming": False,
        "subscriptions": False,
        "sampling": False,
        "elicitation": False,
    }
