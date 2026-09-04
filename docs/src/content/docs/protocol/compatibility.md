---
title: Compatibility
description: Which protocol versions work together, and which package ranges speak them.
related:
  - protocol/handshake
  - protocol/transport
  - sdk/porting
---

## The rule

Protocol version decides compatibility. Package version numbers do not need to match across SDKs or the gateway.

A host speaking protocol `1.x` works with a gateway speaking protocol `1.y`, as long as the major version is the same. The [`tesseron/hello` handshake](/protocol/handshake/) negotiates minor differences. A newer minor can add fields, and an older peer can ignore fields it does not know.

## Protocol support

| Protocol version | Packages that speak it |
| --- | --- |
| `1.2.0` | `@tesseron/core`, `@tesseron/web`, `@tesseron/server`, `@tesseron/react`, `@tesseron/svelte`, `@tesseron/vue`, `@tesseron/vite`, and `@tesseron/mcp` `>=2.10.0` |

The table starts at `1.2.0`. The history checked for this page does not prove package boundaries for earlier protocol versions.

## Other implementations

These are not published packages. You build them from source, and their versions move independently of the TypeScript group.

| Implementation | Protocol | What it leaves out |
| --- | --- | --- |
| `tesseron::tesseron` (C++, [`sdks/cpp/`](https://github.com/Eigenwise/tesseron/tree/main/sdks/cpp)) | `1.2.0` | host-minted claim codes, unix domain sockets |

The C++ host declares all four handshake capabilities and passes 24 of the 34 conformance fixtures; the 10 it skips are the nine `bind/*` fixtures and `uds/file-mode`, which are exactly the two things in that last column. See [Conformance](/sdk/cpp/conformance/).

Rust and Python SDKs get rows here when they ship.

## TypeScript package versions

The TypeScript packages are one fixed release group. They share a version and should be installed at the same version. Mixing them is an install footgun, not a protocol error. The [release section in `AGENTS.md`](https://github.com/eigenwise/tesseron/blob/main/AGENTS.md#releases) explains why the group moves together.

## When the handshake fails

A host and gateway with different protocol majors get this JSON-RPC error from the gateway:

```text
Gateway speaks protocol 1.2.0; SDK sent 2.0.0. Major version mismatch. See https://eigenwise.github.io/tesseron/protocol/compatibility/
```

Use a host and gateway that speak the same protocol major.

A legacy gateway that dials a host-minted WebSocket session without a bind subprotocol gets `HTTP/1.1 426 Upgrade Required` with this response body:

```text
This Tesseron host requires a v1.2-compatible gateway (tesseron-bind subprotocol). Upgrade @tesseron/mcp to >= 2.4.0.
```

Upgrade `@tesseron/mcp` to `>=2.4.0`.
