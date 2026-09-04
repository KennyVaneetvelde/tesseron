"""How an incoming frame is sorted, and what the outgoing envelopes look like."""

from __future__ import annotations

import pytest
from pydantic import JsonValue

from tesseron import ProtocolError
from tesseron.jsonrpc import (
    Failure,
    InvalidRequest,
    Malformed,
    Notification,
    Request,
    Success,
    classify,
    failure,
    notification,
    request,
    success,
)


def test_a_request_is_a_method_with_an_id() -> None:
    frame: JsonValue = {"jsonrpc": "2.0", "id": 7, "method": "actions/invoke", "params": {}}

    assert classify(frame) == Request(7, "actions/invoke", {})


def test_a_method_without_an_id_is_a_notification() -> None:
    frame: JsonValue = {"jsonrpc": "2.0", "method": "actions/cancel", "params": {"a": 1}}

    assert classify(frame) == Notification("actions/cancel", {"a": 1})


def test_a_method_without_jsonrpc_carries_its_id_to_an_invalid_request() -> None:
    frame: JsonValue = {"id": "missing-jsonrpc", "method": "actions/invoke", "params": {}}

    assert classify(frame) == InvalidRequest(
        "missing-jsonrpc", 'envelope is missing jsonrpc: "2.0"'
    )


def test_a_method_with_a_null_id_is_a_request() -> None:
    frame: JsonValue = {"jsonrpc": "2.0", "id": None, "method": "actions/invoke", "params": {}}

    assert classify(frame) == Request(None, "actions/invoke", {})


def test_a_response_carries_either_a_result_or_an_error() -> None:
    assert classify({"jsonrpc": "2.0", "id": "x", "result": None}) == Success("x", None)

    refused = classify({"jsonrpc": "2.0", "id": "x", "error": {"code": -32011, "message": "no"}})
    assert isinstance(refused, Failure)
    assert refused.error.code == -32011
    assert refused.error.message == "no"


def test_a_response_with_a_null_id_is_not_correlated() -> None:
    frame: JsonValue = {"jsonrpc": "2.0", "id": None, "result": {"ok": True}}

    assert classify(frame) == Success(None, {"ok": True})


def test_a_boolean_is_not_a_correlatable_id() -> None:
    # bool is a subclass of int in Python, so this has to be excluded on purpose.
    frame: JsonValue = {"jsonrpc": "2.0", "id": True, "result": None}

    assert classify(frame) == Malformed("a response must carry a correlatable id")


@pytest.mark.parametrize("identifier", [True, {}, []])
def test_an_invalid_request_id_answers_invalid_request_with_a_null_id(
    identifier: JsonValue,
) -> None:
    frame: JsonValue = {"jsonrpc": "2.0", "id": identifier, "method": "actions/invoke"}

    assert classify(frame) == InvalidRequest(None, "request id is not a string, number, or null")


def test_a_frame_that_is_not_json_rpc_two_is_refused() -> None:
    assert isinstance(classify("not-an-object"), Malformed)
    assert isinstance(classify({"id": 1, "result": None}), Malformed)
    assert isinstance(classify({"jsonrpc": "2.0", "id": 1}), Malformed)


def test_an_unreadable_error_member_still_produces_a_failure() -> None:
    refused = classify({"jsonrpc": "2.0", "id": 1, "error": "boom"})

    assert isinstance(refused, Failure)
    assert refused.error.code == -32603


def test_the_outgoing_envelopes_carry_the_version() -> None:
    assert request(1, "tesseron/hello", {"a": 1}) == {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tesseron/hello",
        "params": {"a": 1},
    }
    assert notification("log", None) == {"jsonrpc": "2.0", "method": "log", "params": None}
    assert success(1, None) == {"jsonrpc": "2.0", "id": 1, "result": None}
    assert failure(1, ProtocolError(-32001, "cancelled")) == {
        "jsonrpc": "2.0",
        "id": 1,
        "error": {"code": -32001, "message": "cancelled"},
    }
