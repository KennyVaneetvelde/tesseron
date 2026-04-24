# Gateway (`@tesseron/mcp`)

## Contents
- What the gateway does
- Discovery via `~/.tesseron/tabs/`
- Environment variables
- Tool naming convention
- Tool surface modes
- Meta tools (dispatcher fallback)
- Multi-app sessions
- Running as a plugin (default) vs standalone
- Common mistakes

## What the gateway does

`@tesseron/mcp` is the bridge between Tesseron apps and MCP clients:

- **SDK side**: the gateway is a WebSocket *client*. It watches `~/.tesseron/tabs/` for per-app discovery files and dials each app's loopback endpoint. Apps never need to know the gateway's address — the gateway finds them.
- **MCP side**: exposes the joined app manifests as MCP tools and resources to a host (Claude Code, Claude Desktop, Cursor, etc.) over stdio.
- **Routes both directions**: agent tool calls become `actions/invoke` on the SDK; SDK-side `ctx.sample` / `ctx.elicit` round-trip to the agent as MCP sampling / elicitation; `ctx.progress` and `ctx.log` become MCP notifications.

When installed as a Claude Code plugin, the gateway is started automatically by the plugin's `.mcp.json` — users don't run it by hand. Running standalone is useful for development or for integrating with clients that are not auto-managed.

## Discovery via `~/.tesseron/tabs/`

Each app process writes a JSON file when it calls `tesseron.connect()`:

```jsonc
// ~/.tesseron/tabs/tab-mocythay-v0hh50.json
{
  "version": 1,
  "tabId": "tab-mocythay-v0hh50",
  "appName": "node-prompts",
  "wsUrl": "ws://127.0.0.1:64872/",
  "addedAt": 1777038462692
}
```

The gateway polls + `fs.watch`es the directory and dials the `wsUrl` of each new tab. The app's WebSocket server only accepts upgrades on the `tesseron-gateway` subprotocol, so nothing else on loopback can impersonate a gateway.

When an app disconnects (process exits, `sdk.disconnect()`), the tab file is deleted and the gateway's WebSocket client notices the socket close.

## Environment variables

Read at gateway startup:

| Variable | Default | Purpose |
|---|---|---|
| `TESSERON_TOOL_SURFACE` | `both` | `dynamic` \| `meta` \| `both` (see below) |

v2.0 removed `TESSERON_PORT`, `TESSERON_HOST`, `TESSERON_ORIGIN_ALLOWLIST`, `DEFAULT_GATEWAY_PORT`, and `DEFAULT_GATEWAY_HOST`. The gateway no longer binds a port or accepts inbound connections, so none of those options apply.

## Tool naming convention

Every Tesseron action becomes an MCP tool named:

```
<app_id>__<action_name>
```

- `todos__addTodo`
- `shop__refundOrder`
- `crm__createLead`

This prefix makes multi-app sessions safe: `shop__refundOrder` and `crm__refundOrder` don't collide even if both apps are connected to the same gateway at the same time.

Resources follow an analogous convention as MCP URIs:

```
tesseron://<app_id>/<resource_name>
```

e.g. `tesseron://todos/stats`.

## Tool surface modes

`TESSERON_TOOL_SURFACE` controls which tools the gateway exposes to the MCP client.

```ts
type ToolSurfaceMode = 'dynamic' | 'meta' | 'both';
```

### `dynamic` (spec-pure)

Per-app tools + the claim-session tool, announced via `notifications/tools/list_changed` when apps connect/disconnect or register/remove actions. Best for agents that honor list-changed (Claude does).

### `meta` (dispatcher fallback)

No per-app tools. Instead, four fixed tools that mediate everything:

- `tesseron__claim_session({ code })`
- `tesseron__list_actions()` → manifests of all connected apps
- `tesseron__invoke_action({ app_id, action, args })`
- `tesseron__read_resource({ app_id, name })`

Use this mode for clients that freeze their tool list at startup and never refresh — invocations still work, they just go through the dispatcher instead of appearing as first-class tools.

### `both` (default)

Per-app tools AND meta dispatcher tools. Maximum compatibility. Most users should leave this alone.

## Meta tools

Even in `dynamic` mode the gateway ships `tesseron__claim_session` as the entry point for the pairing handshake. When an SDK connects, it receives a 6-character claim code (`ABCD-XY`); the user tells the agent `claim session ABCD-XY` and the agent invokes:

```jsonc
{ "name": "tesseron__claim_session", "arguments": { "code": "ABCD-XY" } }
```

The gateway pairs the MCP session with the Tesseron session and the per-app tools appear (or become dispatcher-accessible).

## Multi-app sessions

Multiple Tesseron apps can connect to the same gateway simultaneously. Each gets its own `sessionId` and claim code. A single MCP client can pair with one or many of them — once paired, invocations route by `app_id` prefix.

Use cases:
- Developing a frontend + backend that both expose actions.
- Claiming several sub-apps of a single product (shop + admin + CRM).
- Running an admin dashboard alongside the app it's inspecting.

Apps disconnect independently; the gateway emits `actions/list_changed` / `resources/list_changed` on each event.

## Running as a plugin (default)

The default install path — the Tesseron Claude Code plugin — ships `server/index.cjs` and declares `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "tesseron": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.cjs"]
    }
  }
}
```

Claude Code starts the gateway automatically on session launch. Nothing to configure — the gateway picks up tab files as apps announce themselves.

## Running standalone

For development or non-Claude-Code integrations:

```bash
# From the monorepo:
pnpm --filter @tesseron/mcp start

# Or launch the binary:
npx @tesseron/mcp
```

Combined with a custom MCP client, this lets you iterate on the SDK without running through Claude Code. See `packages/mcp/src/cli.ts` for the reference bootstrap.

## Common mistakes

- **Expecting the gateway to accept an inbound WebSocket.** It doesn't — the architecture inverted in v2.0. Apps bind loopback WebSocket servers; the gateway dials them. Old code that connected an SDK to `ws://localhost:7475` will fail because no such server exists.
- **Setting `TESSERON_PORT` / `TESSERON_HOST` / `TESSERON_ORIGIN_ALLOWLIST`.** These env vars no longer exist in v2.0. They're silently ignored.
- **Changing the app `id` across releases.** Agents cache tool names `<app_id>__<action>`; renaming breaks their memory of which tool does what. Pick a stable `id` early.
- **Relying on `TESSERON_TOOL_SURFACE=dynamic` alone with clients that don't honor list-changed.** If you know the target client freezes tools at startup, use `both` (default) or `meta`.
- **Pasting the claim code into the terminal instead of the agent.** The claim code is consumed by the MCP client (Claude) calling `tesseron__claim_session`, not by the shell.
- **Persisting the claim code.** It's one-shot; it expires quickly after the welcome handshake. Use the resume token for reconnection, not the claim code.
- **Expecting a single gateway to route to SDKs on a different host.** The gateway only reads `~/.tesseron/tabs/` on the local filesystem and only dials loopback URLs. Remote apps need their own gateway or a WebSocket tunnel.
