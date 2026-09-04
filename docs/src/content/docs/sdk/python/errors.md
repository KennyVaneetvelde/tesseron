---
title: Errors (Python)
description: The closed error-code set, the three ways a handler fails, and the host errors that never reach the wire.
related:
  - sdk/python/actions
  - sdk/python/index
  - protocol/errors
---

## Envelope errors

The host follows the wire-format ID rules. A request with `id: null` is answered with `id: null`; only an absent `id` is a notification. A frame without `jsonrpc: "2.0"` is answered with `-32600 Invalid Request`, carrying the readable request id through or using `null` when there is no usable id.

`TesseronErrorCode` is an `IntEnum` carrying every code the protocol defines. The set is closed: a gateway that sends an integer outside it speaks a protocol this package does not implement, so `ProtocolError` keeps the raw integer and `named_code` answers `None` rather than inventing a member.

| Code | Member | When |
| --- | --- | --- |
| `-32700` | `PARSE_ERROR` | The peer sent something that is not JSON. |
| `-32600` | `INVALID_REQUEST` | Not a JSON-RPC 2.0 envelope. |
| `-32601` | `METHOD_NOT_FOUND` | A method this host does not answer. |
| `-32602` | `INVALID_PARAMS` | Params the method cannot use, including an elicit schema MCP cannot render. |
| `-32603` | `INTERNAL_ERROR` | Anything unexpected. Never carries detail. |
| `-32000` | `PROTOCOL_MISMATCH` | The two sides speak different protocol majors. |
| `-32001` | `CANCELLED` | The agent cancelled the invocation. |
| `-32002` | `TIMEOUT` | The invocation passed its deadline. |
| `-32003` | `ACTION_NOT_FOUND` | No such action, or no such readable or subscribable resource. |
| `-32004` | `INPUT_VALIDATION` | Input did not satisfy the declared schema. |
| `-32005` | `HANDLER_ERROR` | A domain failure the handler reported on purpose. |
| `-32006` | `SAMPLING_NOT_AVAILABLE` | The agent never negotiated sampling. |
| `-32007` | `ELICITATION_NOT_AVAILABLE` | The agent never negotiated elicitation. |
| `-32008` | `SAMPLING_DEPTH_EXCEEDED` | The gateway's own sampling-depth guard. |
| `-32009` | `UNAUTHORIZED` | The session is not claimed, or the claim does not cover this. |
| `-32010` | `TRANSPORT_CLOSED` | The connection went away with a request still in flight. |
| `-32011` | `RESUME_FAILED` | The gateway refused the resume credentials. |

`TesseronErrorCode.from_wire_code(code)` names a wire integer, or answers `None` for one this version does not define.

## The three ways a handler fails

```python
from tesseron import ActionError, TesseronErrorCode


raise ActionError.handler("Todo not found", {"kind": "not_found"})
raise ActionError.protocol(
    TesseronErrorCode.UNAUTHORIZED, "this agent cannot charge cards"
)
raise ActionError.internal(RuntimeError("database unavailable"))
```

The distinction that matters is what crosses the socket. `handler` and `protocol` send their message and data to the agent. `internal` keeps the cause on your side, reachable through `internal_source`, and answers with a bare `-32603 Internal error`: a stack trace or a database URL in a handler error is a leak.

An exception that is not an `ActionError` is turned into `ActionError.internal` automatically, so an unhandled failure in a handler never spills detail either. `with_data(data)` attaches structured detail the agent can branch on.

## ProtocolError

`ProtocolError` is the `error` member of a JSON-RPC failure, exactly as it travels: `code`, `message`, `data`. It is what the SDK raises when the gateway refuses something the host asked for, and what `to_wire()` produces for a failure the host is sending.

## Host errors

These never reach the wire. They are how the host tells you it cannot start.

| Exception | When |
| --- | --- |
| `HostError` | The base. A handler that is not a coroutine function, or that does not take `(input_data, context)`. |
| `InvalidApplicationIdError` | The application id is reserved or does not match `^[a-z][a-z0-9_]*$`. |
| `DuplicateNameError` | Two actions, or two resources, under one name. |
| `ManifestError` | The instance manifest could not be written or removed. |
| `MissingApplicationError` | No application descriptor was registered before `listen`. |
