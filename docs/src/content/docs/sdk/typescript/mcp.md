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
| `TESSERON_RESUME_TTL_MS` | `14_400_000` (4 hours) | How long a closed session is retained as a resumable zombie before the gateway evicts it. Non-negative integer milliseconds; `0` disables resume entirely. Invalid values log a warning to stderr and fall through to the default. Matches the `resumeTtlMs` constructor option for embedders. |

No ports, no hosts, no allowlists - the gateway has nothing to bind, so it has nothing to configure beyond the two surface knobs above.

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

A v1.2-aware host (the `@tesseron/vite` plugin since 2.2.0) writes two extra optional fields alongside the v2 baseline: `helloHandledByHost: true` and `hostMintedClaim: { code, sessionId, mintedAt, boundAgent }`. The gateway treats these as the signal "don't auto-dial; wait for `tesseron__claim_session`". When the user pastes the host-minted code, the gateway scans every host-mint manifest for a matching `hostMintedClaim.code`, dials only that one with a `tesseron-bind.<code>` subprotocol element on the upgrade, and the host validates the bind in constant time before accepting. v1.1 gateways ignore the new fields and fall back to legacy auto-dial; v1.2 hosts paired with v1.1 gateways detect the absent bind subprotocol and serve the legacy gateway-mints flow. See [tesseron#60](https://github.com/eigenwise/tesseron/issues/60).

When the app process dies, the channel closes and the gateway drops the session. The app is also expected to delete its own manifest on graceful shutdown.

Discovery and dial outcomes (connect successes, connect failures, stale-manifest tombstones, foreign-claim probe results) are forwarded to the connected MCP client via `notifications/message` (`logger: "tesseron.discovery"`), so a developer running Claude Code sees them inline rather than having to grep `~/.claude/`. Set the level on the client side via `logging/setLevel` to filter. Stderr still receives the same lines for grep-ability.

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
- Four meta-dispatcher tools in the default `both` / `meta` surface modes:
  - `tesseron__list_actions` — enumerates every claimed session's actions and resources, plus the gateway's advertised MCP server name.
  - `tesseron__invoke_action({ app_id, action, args })` — calls any action without needing the per-app tool to be in the client's tool list.
  - `tesseron__read_resource({ app_id, name })` — reads a resource without needing the agent to know the client-side MCP server identifier (which varies by how the server is mounted; e.g. `plugin:tesseron:tesseron` under a Claude Code plugin vs. `tesseron` in a raw config). Prefer this over the generic `ReadMcpResourceTool`.
  - `tesseron__list_pending_claims` — lists every claim code the gateway can currently redeem (gateway-minted sessions waiting for claim, plus host-minted manifests with an unconsumed code). Recovery path when a previously-claimed session is invalidated mid-conversation (browser refresh, dev-server reload, resume failure) and a tools/call returns "No claimed session found" — call this, pick the entry whose `app_id` matches, then call `tesseron__claim_session({ code })` to re-pair without asking the user to read the new code from the app UI. See [tesseron#69](https://github.com/eigenwise/tesseron/issues/69).
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

Codes are six alphanumeric characters minus confusables (no `0`, `1`, `I`, `L`, `O`), formatted `AAAA-BB`. Drawn from the platform CSPRNG (`crypto.getRandomValues`) with rejection sampling so the distribution across the 31-character alphabet is uniform. Stored on the session, claimed via `gateway.claimSession(code)`, cleaned on claim or session close.

Each minted code also drops a breadcrumb at `~/.tesseron/claims/<CODE>.json` so a sibling gateway (a parallel Claude Code session, a leftover dev gateway) that receives `tesseron__claim_session` for a code it doesn't own locally can surface a "claim code belongs to gateway pid N" error instead of a flat "no pending session". The breadcrumb is removed on successful claim, on unclaimed close, and on `gateway.stop()`. Embedders building their own claim UI can call `gateway.describeForeignClaim(code)` to drive the same behaviour. See the [handshake page](/protocol/handshake/#multiple-gateways-on-one-machine) for the full picture.

## How the plugin gets it

The Claude Code plugin at `plugin/` in the Tesseron repo ships no bundled gateway. `plugin/.mcp.json` fetches the published package instead, pinned to the plugin's own version:

```json
{
  "mcpServers": {
    "tesseron": { "type": "stdio", "command": "npx", "args": ["-y", "@tesseron/mcp@2.10.1"] }
  }
}
```

That pin is one of eight surfaces carrying the plugin version, all owned by `scripts/sync-plugin-version.mjs`. Run `pnpm sync-plugin-version` to fix drift; CI runs `--check`.

If you're hacking on the gateway, point the plugin at your checkout rather than editing the pin.

## Extending it

The gateway is a small codebase:

- `gateway/src/cli.ts` - entry point.
- `gateway/src/gateway.ts` - session management, dialer dispatcher, instances-directory watcher.
- `gateway/src/dialer.ts` - per-binding dialers (`WsDialer`, `UdsDialer`).
- `gateway/src/session.ts` - a single session's state + claim code.
- `gateway/src/mcp-bridge.ts` - MCP stdio server + protocol translation.

Adding a new method (e.g., a custom `tesseron__debug_dump` tool) means editing `mcp-bridge.ts` for the MCP side and routing through `gateway.ts` if it also crosses the SDK channel. Keep new methods under a `tesseron__` prefix to avoid colliding with app action tools.

Adding a new **transport binding**: implement `GatewayDialer` for the new `kind`, register it in the gateway constructor, ship a host transport on the SDK side, document the wire format under `/protocol/transport-bindings/`. See [Port Tesseron to your language](/sdk/porting/) for the full rubric.

## Not for production agents

This is a local developer tool. Apps bind locally only; the gateway only dials local endpoints. If you need remote-agent support, build a reverse-tunnel with explicit authentication in front.
