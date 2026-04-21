---
title: Transport (WebSocket)
description: URL, framing, origin enforcement, reconnection, and what happens to pending work on disconnect.
---

## Endpoint

Default gateway URL: `ws://127.0.0.1:7475`.

Overridable via environment:

| Variable | Default | Purpose |
|---|---|---|
| `TESSERON_PORT` | `7475` | MCP gateway listen port. |
| `TESSERON_HOST` | `127.0.0.1` | Listen host. |
| `TESSERON_ORIGIN_ALLOWLIST` | *(empty)* | Comma-separated extra origins allowed beyond localhost. |

No subprotocol is negotiated. Standard RFC 6455 `Upgrade: websocket` handshake.

## Origin allowlist

The MCP gateway verifies the `Origin` header during the upgrade handshake:

- `http://localhost:*` and `http://127.0.0.1:*` - accepted unconditionally.
- Any origin in `TESSERON_ORIGIN_ALLOWLIST` - accepted.
- Everything else - `cb(false, 403)` rejects the upgrade.

This is a defence-in-depth measure, **not** a substitute for the claim code. Both layers must pass before an agent can invoke actions.

## Framing

- One JSON-RPC envelope per WebSocket text frame.
- `JSON.stringify` on send, `JSON.parse` on receive.
- Binary frames are coerced to UTF-8 text and parsed anyway.
- No fragmentation, no batching, no compression.

## Heartbeat

There is no application-level ping. The protocol relies on TCP keep-alive and per-action timeouts (60 s default) to detect dead peers.

If your handler legitimately takes longer than 60 s, extend the timeout on the builder:

```ts
tesseron.action('bigReport').timeout(300_000).input(...).handler(...);
```

## Reconnection

**Reconnection is the app's responsibility, not the SDK's.** On transport close:

- The SDK marks every pending request as failed with `TransportClosedError`.
- Active invocations have their `AbortSignal` aborted.
- Subscriptions are dropped.
- The `sessionId` the gateway issued is gone.

To recover: call `tesseron.connect()` again. You will get a **new** `sessionId` and a **new** `claimCode` - the previous claim does not carry over. If your agent is still alive on its side, it must re-claim.

Why no auto-reconnect? Because a reclaimed session invalidates cached tool lists on the agent. An app-level reconnect lets you coordinate with UI (e.g., surface the new claim code) instead of silently rebinding.

## Failure matrix

| Event | App sees | MCP gateway does | Agent sees |
|---|---|---|---|
| MCP gateway shuts down cleanly | `close(1001)` | - | `tools/list_changed` drops those tools. |
| Tab closes | - | Session removed, in-flight invocations cancelled. | `tools/list_changed`. |
| Action timeout | `AbortSignal` fires with `TimeoutError`. | Error `-32002` returned. | Tool call errors with `-32002`. |
| Agent cancels | `AbortSignal` fires. | Forwards `actions/cancel`. | Receives error `-32001`. |
| Origin rejected | `close(1008)` before any app message. | Upgrade refused 403. | N/A - never connected. |

Next: the [handshake and claim flow](/protocol/handshake/).
