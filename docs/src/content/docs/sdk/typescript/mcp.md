---
title: "@tesseron/mcp (MCP gateway)"
description: The MCP gateway process - a transport-agnostic dialer that discovers apps via ~/.tesseron/instances/ and bridges them to an MCP stdio transport. Bundled into the Claude Code plugin; you rarely run it by hand.
related:
  - protocol/handshake
  - protocol/security
  - protocol/transport
  - protocol/transport-bindings/ws
  - protocol/transport-bindings/uds
---

`@tesseron/mcp` is the MCP gateway. It:

- Watches `~/.tesseron/instances/` (and the legacy `~/.tesseron/tabs/` for one minor) for per-app instance manifests, picks a dialer matching the manifest's `transport.kind`, and connects.
- Runs an MCP stdio server that the agent connects to.
- Translates between the two, maintains session state, handles claim codes, fans out progress / sampling / elicitation across the boundary.

The gateway itself binds no ports. It is always a transport client — apps host, the gateway dials. This is what makes the same gateway work for browser tabs (via `@tesseron/vite`), Node processes over WebSocket or Unix domain sockets (via `@tesseron/server`), and anything else that can host one of the documented [transport bindings](/protocol/transport/) and write an instance manifest.

99% of users never invoke it directly - the Claude Code plugin spawns it automatically. This page is for the 1%.

## Running it manually

```bash
pnpm dlx @tesseron/mcp
```

It starts, listens on stdio for MCP, and begins watching `~/.tesseron/instances/`. Kill it with Ctrl-C.

## Environment

| Env var | Default | Purpose |
|---|---|---|
| `TESSERON_TOOL_SURFACE` | `both` | `dynamic` / `meta` / `both`. Controls which MCP tools the bridge advertises (per-app tools, meta-dispatcher tools, or both). |

That's the whole list. No ports, no hosts, no allowlists - the gateway has nothing to bind, so it has nothing to configure.

The advertised protocol version is pinned to `PROTOCOL_VERSION` in `@tesseron/core` and is not configurable at runtime.

## Discovery

Apps announce themselves by writing a JSON v2 manifest to `~/.tesseron/instances/<instanceId>.json`:

```jsonc
{
  "version": 2,
  "instanceId": "inst-abc123",
  "appName": "vue-todo",
  "addedAt": 1777038462692,
  "pid": 24837,
  "transport":
    | { "kind": "ws",  "url":  "ws://127.0.0.1:64872/" }
    | { "kind": "uds", "path": "/tmp/tesseron-Xy7/sock" }
}
```

`pid` is optional. Gateways probe `process.kill(pid, 0)` on each manifest before dialing and tombstone manifests whose owner is gone, so a dev server killed without a clean shutdown doesn't leave a corpse the gateway re-dials forever. Older SDKs that omit the field stay trusted.

The gateway watches the directory (inotify / `fs.watch`, with a 2-second poll as a platform fallback), notices the new file, picks the dialer matching `transport.kind`, and connects. The app accepts that one connection; the standard `tesseron/hello` → `welcome` handshake follows.

For one minor version (1.1.x), the gateway also reads the legacy v1 directory `~/.tesseron/tabs/<tabId>.json` and coerces those manifests to `{ kind: 'ws', url: <wsUrl> }`. New SDKs only ever write `instances/`.

When the app process dies, the channel closes and the gateway drops the session. The app is also expected to delete its own manifest on graceful shutdown.

Shipping support for a new runtime is three steps:

1. Bind whichever [transport binding](/protocol/transport/) fits the runtime (WS, UDS, …).
2. Write `~/.tesseron/instances/<instanceId>.json` with the matching `transport` spec.
3. Accept the gateway's inbound connection and speak the [Tesseron wire protocol](/protocol/).

The SDK packages `@tesseron/vite` and `@tesseron/server` are reference implementations.

## MCP stdio channel

When an MCP client spawns the gateway, the gateway exposes:

- One built-in tool: `tesseron__claim_session`. Always present.
- One tool per registered action across all connected sessions, named `<app_id>__<action_name>`.
- One resource per registered resource, URI `tesseron://<app_id>/<resource_name>`.
- Three meta-dispatcher tools in the default `both` / `meta` surface modes:
  - `tesseron__list_actions` — enumerates every claimed session's actions and resources, plus the gateway's advertised MCP server name.
  - `tesseron__invoke_action({ app_id, action, args })` — calls any action without needing the per-app tool to be in the client's tool list.
  - `tesseron__read_resource({ app_id, name })` — reads a resource without needing the agent to know the client-side MCP server identifier (which varies by how the server is mounted; e.g. `plugin:tesseron:tesseron` under a Claude Code plugin vs. `tesseron` in a raw config). Prefer this over the generic `ReadMcpResourceTool`.
- Full MCP logging (`sendLoggingMessage`), progress (`notifications/progress`), sampling (`createMessage`), and elicitation (`elicitInput`).

Whenever a session connects, claims, or drops, the gateway emits `notifications/tools/list_changed` and `notifications/resources/list_changed`. The agent refreshes automatically.

## Multiple sessions

The gateway keeps a `Map<sessionId, Session>` internally. Each session has:

- The registered app manifest (actions + resources).
- A `pendingClaim` until claimed.
- The outbound transport the gateway dialed.
- In-flight invocation state.

Routing: `tools/call shop__searchProducts` finds the session whose `app.id === "shop"`, dispatches `actions/invoke`, waits for the response, maps it back to an MCP tool result. If the session dropped between listing and call, the gateway returns error `-32003 ActionNotFound`.

## Claim code generation

Codes are six alphanumeric characters minus confusables (no `0`, `1`, `I`, `L`, `O`), formatted `AAAA-BB`. Drawn from `Math.random()`. Stored on the session, claimed via `gateway.claimSession(code)`, cleaned on claim or session close.

Each minted code also drops a breadcrumb at `~/.tesseron/claims/<CODE>.json` so a sibling gateway (a parallel Claude Code session, a leftover dev gateway) that receives `tesseron__claim_session` for a code it doesn't own locally can surface a "claim code belongs to gateway pid N" error instead of a flat "no pending session". The breadcrumb is removed on successful claim, on unclaimed close, and on `gateway.stop()`. Embedders building their own claim UI can call `gateway.describeForeignClaim(code)` to drive the same behaviour. See the [handshake page](/protocol/handshake/#multiple-gateways-on-one-machine) for the full picture.

## Where the plugin bundles it

The Claude Code plugin at `plugin/` in the Tesseron repo bundles the gateway as `plugin/server/index.cjs`, built via:

```bash
pnpm --filter @tesseron/mcp build:plugin
```

This esbuild bundle is what ships to plugin installers. If you're hacking on the gateway, rebuild the plugin bundle before testing against Claude Code.

## Extending it

The gateway is a small codebase:

- `packages/mcp/src/cli.ts` - entry point.
- `packages/mcp/src/gateway.ts` - session management, dialer dispatcher, instances-directory watcher.
- `packages/mcp/src/dialer.ts` - per-binding dialers (`WsDialer`, `UdsDialer`).
- `packages/mcp/src/session.ts` - a single session's state + claim code.
- `packages/mcp/src/mcp-bridge.ts` - MCP stdio server + protocol translation.

Adding a new method (e.g., a custom `tesseron__debug_dump` tool) means editing `mcp-bridge.ts` for the MCP side and routing through `gateway.ts` if it also crosses the SDK channel. Keep new methods under a `tesseron__` prefix to avoid colliding with app action tools.

Adding a new **transport binding**: implement `GatewayDialer` for the new `kind`, register it in the gateway constructor, ship a host transport on the SDK side, document the wire format under `/protocol/transport-bindings/`. See [Port Tesseron to your language](/sdk/porting/) for the full rubric.

## Not for production agents

This is a local developer tool. Apps bind locally only; the gateway only dials local endpoints. If you need remote-agent support, build a reverse-tunnel with explicit authentication in front.
