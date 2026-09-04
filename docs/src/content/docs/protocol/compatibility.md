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
| `1.2.0` | [`tesseron`](/sdk/python/) (Python) `>=0.1.0`. Not on PyPI yet. |
| `1.2.0` | [`tesseron`](/sdk/rust/) (Rust) `0.1.x`. Not on crates.io yet. |
| `1.2.0` | [`tesseron::tesseron`](/sdk/cpp/) (C++) `>=0.1.0`. Source-only, built through CMake `FetchContent`. |

The table starts at `1.2.0`. The history checked for this page does not prove package boundaries for earlier protocol versions.

The Python and Rust SDKs carry their own versions and move on their own. They speak the same protocol, which is the only thing that has to match. C++ releases use the same rule and get rows here as they land.

The C++ host does not mint its own claim code and does not speak a unix domain socket, so it skips the `bind/*` fixtures and `uds/file-mode` and passes every other fixture in the suite. See [C++ conformance](/sdk/cpp/conformance/).

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
