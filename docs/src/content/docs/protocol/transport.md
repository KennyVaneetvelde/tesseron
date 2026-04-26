---
title: Transport
description: Tesseron speaks JSON-RPC 2.0 over any reliable, ordered, duplex channel. Bindings spec out concrete realisations.
related:
  - protocol/transport-bindings/ws
  - protocol/transport-bindings/uds
  - protocol/handshake
  - protocol/wire-format
  - sdk/typescript/mcp
---

## What "transport" means here

Tesseron speaks **JSON-RPC 2.0 over a reliable, ordered, bidirectional channel**. That's the protocol-level commitment. Anything below it - WebSocket frames, Unix domain sockets, named pipes, in-memory pairs - is a **binding** the implementer picks. The MCP gateway dispatches to the right binding based on what the running app advertises in its instance manifest.

This page describes the contract every binding has to honour. The per-binding pages spec the wire details:

- [WebSocket binding](/protocol/transport-bindings/ws/) - the default; browser apps use this via `@tesseron/vite`, Node apps use it via `@tesseron/server`'s `NodeWebSocketServerTransport`.
- [Unix domain socket binding](/protocol/transport-bindings/uds/) - lower-overhead local IPC for Node apps that don't need a browser bridge. Linux + macOS in 1.1; Windows tracked separately.

A new binding is a new instance-manifest discriminant plus a gateway dialer plus an SDK-side host transport. See [Port Tesseron to your language](/sdk/porting/) for the full conformance checklist.

## Who binds, who dials

Apps bind. The gateway dials.

Every Tesseron app hosts its own endpoint - whatever shape the binding requires - and announces it by writing `~/.tesseron/instances/<instanceId>.json`:

```jsonc
{
  "version": 2,
  "instanceId": "inst-mocythay-v0hh50",
  "appName": "node-prompts",
  "addedAt": 1777038462692,
  "pid": 24837,
  "transport":
    | { "kind": "ws",  "url":  "ws://127.0.0.1:64872/" }
    | { "kind": "uds", "path": "/tmp/tesseron-Xy7/sock" }
}
```

The gateway watches that directory, reads each new file, picks the dialer matching `transport.kind`, and connects. The app accepts the one inbound connection; the standard handshake follows.

`pid` is optional and identifies the SDK-side process that owns the instance. Gateways probe it with `process.kill(pid, 0)` and tombstone (unlink) manifests whose owner is gone, so a Vite dev server killed without a clean `httpServer.close` doesn't leave a corpse the gateway re-dials every poll tick. Manifests written by older SDKs (no `pid`) are still trusted.

There is no fixed gateway port. There is no `DEFAULT_GATEWAY_URL` apps dial out to. The gateway itself binds nothing.

## What every binding has to do

The session/handshake/action layer cannot tell which binding it's running on. Every binding **must** preserve:

- **Reliable, ordered delivery.** No best-effort, no reorderings, no gaps inside a session. TCP-ish guarantees.
- **One JSON-RPC envelope per logical message.** No batching, no fragmentation visible to the protocol layer.
- **Symmetric duplex.** Either side can send a request or a notification at any time; there is no fixed direction.
- **Single connection per session.** `tesseron/hello` opens; close terminates the session (or zombifies it for [resume](/protocol/resume/)).
- **Same-process / same-user threat model.** The binding is local IPC. Authentication is the [claim code](/protocol/handshake/) plus the OS's own user-isolation guarantees - origin enforcement on WS, file-mode-based UID gating on UDS.

If a binding can satisfy those, the rest of the protocol composes on top unchanged.

## Compat: pre-1.1 `tabs/` directory

Apps built against TS SDKs at 1.0.x wrote v1 manifests to `~/.tesseron/tabs/<tabId>.json`:

```json
{ "version": 1, "tabId": "tab-...", "appName": "...", "wsUrl": "ws://...", "addedAt": 1777038462692 }
```

The gateway at 1.1+ reads both `instances/` (v2) and `tabs/` (v1) for one minor version. v1 manifests are coerced to `{ kind: 'ws', url: <wsUrl> }` and dispatched to the WS dialer. New SDKs only ever write `instances/`. Drop scheduled for 2.0.

## Heartbeat

There is no application-level ping. The protocol relies on the underlying binding (TCP keep-alive on WS, kernel-level UDS lifecycle) and per-action timeouts (60 s default) to detect dead peers. If your handler legitimately takes longer than 60 s, extend the timeout on the builder:

```ts
tesseron.action('bigReport').timeout({ ms: 300_000 }).input(...).handler(...);
```

## Reconnection

**Reconnection is the app's responsibility, not the SDK's.** On transport close:

- The SDK marks every pending request as failed with `TransportClosedError`.
- Active invocations have their `AbortSignal` aborted.
- Subscriptions are dropped.
- The `sessionId` the gateway issued is gone unless the SDK resumes via [`tesseron/resume`](/protocol/resume/) inside the zombie TTL.

To recover: re-bind, write a fresh manifest, wait for the gateway to dial again. You will get a **new** `sessionId` and a **new** `claimCode` - the previous claim does not carry over unless you successfully resume.

## Failure matrix

| Event | App sees | MCP gateway does | Agent sees |
|---|---|---|---|
| Gateway shuts down cleanly | Channel close (binding-specific code) | Tears down outbound connections. | `tools/list_changed` drops those tools. |
| Tab closes / app exits | - | Session removed, in-flight invocations cancelled, manifest cleaned up by the app. | `tools/list_changed`. |
| Action timeout | `AbortSignal` fires with `TimeoutError`. | Error `-32002` returned. | Tool call errors with `-32002`. |
| Agent cancels | `AbortSignal` fires. | Forwards `actions/cancel`. | Receives error `-32001`. |
| Binding rejects connect | Bind/upgrade fails. | Gives up on this manifest (may retry on next watcher event). | N/A - session never existed. |

Next: dig into a specific binding ([WebSocket](/protocol/transport-bindings/ws/), [UDS](/protocol/transport-bindings/uds/)) or read the [handshake and claim flow](/protocol/handshake/).
