---
title: "@tesseron/mcp (MCP gateway)"
description: The MCP gateway process - a WebSocket client that discovers apps via ~/.tesseron/tabs/ and bridges them to an MCP stdio transport. Bundled into the Claude Code plugin; you rarely run it by hand.
related:
  - protocol/handshake
  - protocol/security
  - protocol/transport
---

`@tesseron/mcp` is the MCP gateway. It:

- Watches `~/.tesseron/tabs/` for per-app discovery files and dials each app's WebSocket URL as a client, using the `tesseron-gateway` subprotocol.
- Runs an MCP stdio server that the agent connects to.
- Translates between the two, maintains session state, handles claim codes, fans out progress / sampling / elicitation across the boundary.

The gateway itself binds no ports. It is always a WebSocket client — apps host, the gateway dials. This is what makes the same gateway work for browser tabs (via `@tesseron/vite`), Node processes (via `@tesseron/server`), and anything else that can bind a WS server and write a tab file.

99% of users never invoke it directly - the Claude Code plugin spawns it automatically. This page is for the 1%.

## Running it manually

```bash
pnpm dlx @tesseron/mcp
```

It starts, listens on stdio for MCP, and begins watching `~/.tesseron/tabs/`. Kill it with Ctrl-C.

## Environment

| Env var | Default | Purpose |
|---|---|---|
| `TESSERON_TOOL_SURFACE` | `both` | `dynamic` / `meta` / `both`. Controls which MCP tools the bridge advertises (per-app tools, meta-dispatcher tools, or both). |

That's the whole list. No ports, no hosts, no allowlists - the gateway has nothing to bind, so it has nothing to configure.

The advertised protocol version is pinned to `PROTOCOL_VERSION` in `@tesseron/core` and is not configurable at runtime.

## Discovery

Apps announce themselves by writing a JSON file to `~/.tesseron/tabs/<tabId>.json`:

```json
{
  "version": 1,
  "tabId": "tab-abc123",
  "appName": "vue-todo",
  "wsUrl": "ws://127.0.0.1:64872/",
  "addedAt": 1777038462692
}
```

The gateway watches the directory (inotify / `fs.watch`, with a 2-second poll as a platform fallback), notices the new file, and dials `wsUrl` with subprotocol `tesseron-gateway`. The app accepts that one connection; the standard `tesseron/hello` → `welcome` handshake follows.

When the app process dies, the WebSocket closes and the gateway drops the session. The app is also expected to delete its own tab file on graceful shutdown.

Shipping support for a new runtime is three steps:

1. Bind a WebSocket server on a loopback port.
2. Write `~/.tesseron/tabs/<tabId>.json` with the URL.
3. Accept the gateway's inbound connection and speak the [Tesseron wire protocol](/protocol/).

The SDK packages `@tesseron/vite` and `@tesseron/server` are reference implementations of steps 1 and 2.

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
- The outbound WebSocket the gateway dialed.
- In-flight invocation state.

Routing: `tools/call shop__searchProducts` finds the session whose `app.id === "shop"`, dispatches `actions/invoke`, waits for the response, maps it back to an MCP tool result. If the session dropped between listing and call, the gateway returns error `-32003 ActionNotFound`.

## Claim code generation

Codes are six alphanumeric characters minus confusables (no `0`, `1`, `I`, `L`, `O`), formatted `AAAA-BB`. Drawn from `Math.random()`. Stored on the session, claimed via `gateway.claimSession(code)`, cleaned on claim or session close.

## Where the plugin bundles it

The Claude Code plugin at `plugin/` in the Tesseron repo bundles the gateway as `plugin/server/index.cjs`, built via:

```bash
pnpm --filter @tesseron/mcp build:plugin
```

This esbuild bundle is what ships to plugin installers. If you're hacking on the gateway, rebuild the plugin bundle before testing against Claude Code.

## Extending it

The gateway is a small codebase:

- `packages/mcp/src/cli.ts` - entry point.
- `packages/mcp/src/gateway.ts` - session management, outbound dialer, tabs-directory watcher.
- `packages/mcp/src/session.ts` - a single session's state + claim code.
- `packages/mcp/src/mcp-bridge.ts` - MCP stdio server + protocol translation.

Adding a new method (e.g., a custom `tesseron__debug_dump` tool) means editing `mcp-bridge.ts` for the MCP side and routing through `gateway.ts` if it also crosses the WebSocket. Keep new methods under a `tesseron__` prefix to avoid colliding with app action tools.

## Not for production agents

This is a local developer tool. Apps bind to loopback only; the gateway only dials loopback URLs. If you need remote-agent support, wait for the Phase-4 Streamable HTTP transport or build a reverse-tunnel with explicit authentication in front.
