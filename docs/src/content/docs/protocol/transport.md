---
title: Transport (WebSocket)
description: URL, framing, origin enforcement, reconnection, and what happens to pending work on disconnect.
related:
  - protocol/handshake
  - protocol/wire-format
  - sdk/typescript/mcp
---

## Who binds, who dials

Apps bind. The gateway dials.

Every Tesseron app hosts its own WebSocket server on a loopback port (any free port - the OS picks one). It advertises the URL by writing `~/.tesseron/tabs/<tabId>.json`:

```json
{
  "version": 1,
  "tabId": "tab-mocythay-v0hh50",
  "appName": "node-prompts",
  "wsUrl": "ws://127.0.0.1:64872/",
  "addedAt": 1777038462692
}
```

The gateway watches that directory, reads each new file, and dials the `wsUrl` with the `tesseron-gateway` WebSocket subprotocol. The app accepts that one connection; the standard handshake follows.

There is no fixed port. There is no `DEFAULT_GATEWAY_URL` the app dials out to. The gateway itself binds nothing.

Browser apps can't bind a port, so `@tesseron/vite` bridges: it serves `/@tesseron/ws` on the existing Vite dev-server port, writes the tab file pointing at that URL, and relays frames between the browser tab and the gateway that dials in. From the gateway's perspective it's the same flow - bind + announce, one gateway-subprotocol connection per session.

## Framing

- One JSON-RPC envelope per WebSocket text frame.
- `JSON.stringify` on send, `JSON.parse` on receive.
- Binary frames are coerced to UTF-8 text and parsed anyway.
- No fragmentation, no batching, no compression.

## Subprotocol handshake

The gateway sends `Sec-WebSocket-Protocol: tesseron-gateway` on its upgrade request. Apps that host a Tesseron server must advertise this subprotocol in their handshake response. Requests that don't carry the subprotocol must be rejected - the app's WebSocket endpoint is only for the gateway, not for arbitrary clients.

The Vite plugin is an exception: it accepts plain (no-subprotocol) connections from the browser tab AND a separate `tesseron-gateway` connection from the gateway, and bridges them.

## Heartbeat

There is no application-level ping. The protocol relies on TCP keep-alive and per-action timeouts (60 s default) to detect dead peers.

If your handler legitimately takes longer than 60 s, extend the timeout on the builder:

```ts
tesseron.action('bigReport').timeout({ ms: 300_000 }).input(...).handler(...);
```

## Reconnection

**Reconnection is the app's responsibility, not the SDK's.** On transport close:

- The SDK marks every pending request as failed with `TransportClosedError`.
- Active invocations have their `AbortSignal` aborted.
- Subscriptions are dropped.
- The `sessionId` the gateway issued is gone.

To recover: re-bind your WebSocket server, write a fresh tab file, wait for the gateway to dial again. You will get a **new** `sessionId` and a **new** `claimCode` - the previous claim does not carry over unless you use [`tesseron/resume`](/protocol/resume/) with a valid token.

## Failure matrix

| Event | App sees | MCP gateway does | Agent sees |
|---|---|---|---|
| Gateway shuts down cleanly | `close(1001)` | Deletes outbound sockets. | `tools/list_changed` drops those tools. |
| Tab closes / app exits | - | Session removed, in-flight invocations cancelled, tab file should be cleaned up by the app. | `tools/list_changed`. |
| Action timeout | `AbortSignal` fires with `TimeoutError`. | Error `-32002` returned. | Tool call errors with `-32002`. |
| Agent cancels | `AbortSignal` fires. | Forwards `actions/cancel`. | Receives error `-32001`. |
| Subprotocol rejected | WS upgrade fails. | Gives up on this tab file (may retry on next `fs.watch` event). | N/A - session never existed. |

Next: the [handshake and claim flow](/protocol/handshake/).
