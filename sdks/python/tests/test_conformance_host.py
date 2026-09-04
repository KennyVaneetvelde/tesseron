"""The fixture adapter the conformance runner drives.

It lives beside the package rather than inside it, so nothing here is part of the published
wheel. It is still checked and typechecked with everything else, because a silently broken
adapter turns a failed protocol into a passing run.
"""

from __future__ import annotations

import json

import pytest
from conformance_host import UnsupportedFixtureError, fixture, schema_subset
from pydantic import JsonValue

from tesseron import ManifestPublication, TesseronApp

ADD_SCHEMA: JsonValue = {
    "type": "object",
    "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
    "required": ["a", "b"],
}


def application() -> TesseronApp:
    return TesseronApp(
        id="conformance",
        name="Tesseron Python conformance host",
        origin="tesseron-conformance://python",
        manifest=ManifestPublication.disabled(),
    )


def document(fixture_body: JsonValue, requires: list[str] | None = None) -> str:
    return json.dumps({"requires": requires or [], "fixture": fixture_body, "steps": []})


def test_a_wrong_property_type_and_a_missing_property_are_both_reported() -> None:
    issues = schema_subset.check(ADD_SCHEMA, {"a": "not-a-number"})

    assert {tuple(issue.path) for issue in issues} == {("a",), ("b",)}


def test_valid_input_reports_nothing() -> None:
    assert schema_subset.check(ADD_SCHEMA, {"a": 1, "b": 2}) == []


def test_a_boolean_never_satisfies_a_number() -> None:
    issues = schema_subset.check(ADD_SCHEMA, {"a": True, "b": 2})

    assert [issue.path for issue in issues] == [["a"]]


def test_an_unexpected_property_is_reported_when_the_schema_closes_the_object() -> None:
    closed: JsonValue = {
        "type": "object",
        "properties": {"a": {"type": "number"}},
        "additionalProperties": False,
    }

    issues = schema_subset.check(closed, {"a": 1, "b": 2})

    assert [issue.path for issue in issues] == [["b"]]


def test_a_keyword_this_adapter_cannot_enforce_is_refused_up_front() -> None:
    schema_subset.assert_enforceable(ADD_SCHEMA)

    with pytest.raises(UnsupportedFixtureError, match="oneOf"):
        schema_subset.assert_enforceable({"oneOf": []})


def test_a_fixture_that_needs_unix_sockets_is_refused_at_launch() -> None:
    with pytest.raises(UnsupportedFixtureError, match="uds"):
        fixture.register(application(), document({}, requires=["uds"]))


def test_a_fixture_that_mints_its_own_claim_is_refused_at_launch() -> None:
    body: JsonValue = {"hostMintedClaim": {"code": "AB3X-7K"}}

    with pytest.raises(UnsupportedFixtureError, match="host-minted-claim"):
        fixture.register(application(), document(body))


def test_a_fixture_member_the_adapter_does_not_know_fails_rather_than_being_ignored() -> None:
    body: JsonValue = {"actions": [{"name": "add", "invented": True}]}

    with pytest.raises(UnsupportedFixtureError, match="unreadable fixture"):
        fixture.register(application(), document(body))


def test_an_action_input_schema_the_adapter_cannot_enforce_names_the_action() -> None:
    body: JsonValue = {"actions": [{"name": "add", "inputSchema": {"oneOf": []}}]}

    with pytest.raises(UnsupportedFixtureError, match="'add'"):
        fixture.register(application(), document(body))


def test_a_resource_update_without_a_value_is_refused() -> None:
    body: JsonValue = {
        "resources": [
            {"name": "cart", "subscribable": True, "emits": [{"afterStep": "subscribed"}]}
        ]
    }

    with pytest.raises(UnsupportedFixtureError, match="emits\\[0\\]"):
        fixture.register(application(), document(body))
