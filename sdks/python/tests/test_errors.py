"""The closed error-code set, and the line between a reported failure and a leaked one."""

from __future__ import annotations

from tesseron import ActionError, ProtocolError, TesseronErrorCode

WIRE_CODES = {
    -32700,
    -32600,
    -32601,
    -32602,
    -32603,
    -32000,
    -32001,
    -32002,
    -32003,
    -32004,
    -32005,
    -32006,
    -32007,
    -32008,
    -32009,
    -32010,
    -32011,
}


def test_every_documented_error_code_is_named() -> None:
    assert {int(code) for code in TesseronErrorCode} == WIRE_CODES


def test_a_code_outside_the_closed_set_stays_an_integer() -> None:
    refusal = ProtocolError(-31999, "from a newer gateway")
    assert refusal.named_code is None
    assert refusal.to_wire() == {"code": -31999, "message": "from a newer gateway"}


def test_a_handler_failure_carries_its_message_and_data_to_the_agent() -> None:
    failure = ActionError.handler("cart is empty", {"cartId": "c-1"})
    wire = failure.to_protocol_error().to_wire()
    assert wire == {
        "code": -32005,
        "message": "cart is empty",
        "data": {"cartId": "c-1"},
    }


def test_an_internal_failure_keeps_its_cause_off_the_wire() -> None:
    cause = ValueError("postgres://user:secret@localhost/db is unreachable")
    failure = ActionError.internal(cause)
    assert failure.internal_source is cause
    assert failure.to_protocol_error().to_wire() == {"code": -32603, "message": "Internal error"}


def test_a_protocol_failure_keeps_the_code_it_was_given() -> None:
    failure = ActionError.protocol(TesseronErrorCode.UNAUTHORIZED, "no claim yet")
    assert failure.code is TesseronErrorCode.UNAUTHORIZED
    assert failure.with_data({"why": "unclaimed"}).data == {"why": "unclaimed"}
