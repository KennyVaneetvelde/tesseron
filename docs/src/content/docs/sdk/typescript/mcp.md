---
title: "@tesseron/mcp (MCP gateway)"
description: The MCP gateway process - WebSocket server + MCP stdio bridge. Bundled into the Claude Code plugin; you rarely run it by hand.
---

`@tesseron/mcp` is the MCP gateway. It:

- Runs a WebSocket server on `127.0.0.1:7475` that your app connects to.
- Runs an MCP stdio server that the agent connects to.
- Translates between the two, maintains session state, handles claim codes, enforces origin allowlist, fans out progress / sampling / elicitation across the boundary.

99% of users never invoke it directly - the Claude Code plugin spawns it automatically. This page is for the 1%.

## Running it manually

```bash
TESSERON_PORT=7475 pnpm dlx @tesseron/mcp
```

It starts, listens on stdio for MCP, and accepts WebSockets on `:7475`. Kill it with Ctrl-C.

## Environment

Configuration is environment-variable driven; there are no CLI flags.

| Env var | Default | Purpose |
|---|---|---|
| `TESSERON_PORT` | `7475` | WebSocket listen port. |
| `TESSERON_HOST` | `127.0.0.1` | Listen host. Leave localhost unless you understand the implications. |
| `TESSERON_ORIGIN_ALLOWLIST` | *(empty)* | Comma-separated extra Origins accepted. |
| `TESSERON_TOOL_SURFACE` | `both` | `dynamic` / `meta` / `both`. Controls which MCP tools the bridge advertises (per-app tools, meta-dispatcher tools, or both). |

The advertised protocol version is pinned to `PROTOCOL_VERSION` in `@tesseron/core` and is not configurable at runtime.

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
- The active WebSocket.
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

- `packages/mcp/src/cli.ts` - entry point, arg parsing.
- `packages/mcp/src/gateway.ts` - WebSocket server, session management.
- `packages/mcp/src/session.ts` - a single session's state + claim code.
- `packages/mcp/src/mcp-bridge.ts` - MCP stdio server + protocol translation.

Adding a new method (e.g., a custom `tesseron__debug_dump` tool) means editing `mcp-bridge.ts` for the MCP side and routing through `gateway.ts` if it also crosses the WebSocket. Keep new methods under a `tesseron__` prefix to avoid colliding with app action tools.

## Not for production agents

This is a local developer tool. Don't bind it to `0.0.0.0`, don't expose port 7475 to the internet, don't skip the origin allowlist. If you need remote-agent support, wait for the Phase-4 Streamable HTTP transport or build a reverse-tunnel with explicit authentication in front.
