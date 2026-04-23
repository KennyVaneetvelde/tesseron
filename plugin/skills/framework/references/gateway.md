# Gateway (`@tesseron/mcp`)

## Contents
- What the gateway does
- Environment variables
- Tool naming convention
- Tool surface modes
- Meta tools (dispatcher fallback)
- Multi-app sessions
- Origin allowlist and security
- Running as a plugin (default) vs standalone
- Common mistakes

## What the gateway does

`@tesseron/mcp` is the bridge between Tesseron apps and MCP clients:

- **SDK side**: listens on `ws://host:port` for app connections speaking the `tesseron/*` JSON-RPC protocol.
- **MCP side**: exposes the joined app manifests as MCP tools and resources to a host (Claude Code, Claude Desktop, Cursor, etc.) over stdio.
- **Routes both directions**: agent tool calls become `actions/invoke` on the SDK; SDK-side `ctx.sample` / `ctx.elicit` round-trip to the agent as MCP sampling / elicitation; `ctx.progress` and `ctx.log` become MCP notifications.

When installed as a Claude Code plugin, the gateway is started automatically by the plugin's `.mcp.json` — users don't run it by hand. Running standalone is useful for development or for integrating with clients that are not auto-managed.

## Environment variables

Read at gateway startup:

| Variable | Default | Purpose |
|---|---|---|
| `TESSERON_PORT` | `7475` | WebSocket server port the SDK connects to |
| `TESSERON_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only with an explicit allowlist |
| `TESSERON_ORIGIN_ALLOWLIST` | *(none)* | Comma-separated origins beyond localhost (e.g. `https://app.example,https://staging.example`) |
| `TESSERON_TOOL_SURFACE` | `both` | `dynamic` \| `meta` \| `both` (see below) |

The companion constants are exported from `@tesseron/mcp`:

```ts
export const DEFAULT_GATEWAY_PORT = 7475;
export const DEFAULT_GATEWAY_HOST = '127.0.0.1';
export const DEFAULT_RESUME_TTL_MS = 90_000; // zombie-session retention for resume
```

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
- Running the showcase admin dashboard alongside the app it's inspecting.

Apps disconnect independently; the gateway emits `actions/list_changed` / `resources/list_changed` on each event.

## Origin allowlist and security

The gateway is a local WebSocket server. Default bind is `127.0.0.1` — no LAN or external access. This is deliberately restrictive.

**If you bind to a non-localhost interface (`TESSERON_HOST=0.0.0.0`)**, always pair with `TESSERON_ORIGIN_ALLOWLIST`:

```
TESSERON_HOST=0.0.0.0
TESSERON_ORIGIN_ALLOWLIST=https://myapp.internal,https://staging.myapp.internal
```

Requests with an `Origin` header not in the allowlist are rejected with HTTP 403 before the WebSocket upgrades. `null` origins (file://, some embeds) are rejected unconditionally unless `null` is explicitly allowlisted.

**Do not disable the allowlist "temporarily for testing".** A gateway bound to `0.0.0.0` with no allowlist lets any browser on the network invoke any handler.

The allowlist is origin-prefix-matching — it compares the `Origin` header to each entry exactly; there's no wildcard support. For dynamic preview environments, configure the allowlist at gateway start (from config) rather than whitelisting `*`.

## Running as a plugin (default)

The default install path — the Tesseron Claude Code plugin — ships `server/index.cjs` and declares `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "tesseron": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/server/index.cjs"],
      "env": {
        "TESSERON_PORT": "${TESSERON_PORT:-7475}",
        "TESSERON_HOST": "${TESSERON_HOST:-127.0.0.1}"
      }
    }
  }
}
```

Claude Code starts the gateway automatically on session launch. The user's Claude Code `.env` / shell can override `TESSERON_PORT`, `TESSERON_HOST`, `TESSERON_ORIGIN_ALLOWLIST`, and `TESSERON_TOOL_SURFACE`.

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

- **`TESSERON_HOST=0.0.0.0` without `TESSERON_ORIGIN_ALLOWLIST`.** Exposes the gateway to anything on the network that can reach that interface. Always pair them.
- **Changing the app `id` across releases.** Agents cache tool names `<app_id>__<action>`; renaming breaks their memory of which tool does what. Pick a stable `id` early.
- **Relying on `TESSERON_TOOL_SURFACE=dynamic` alone with clients that don't honor list-changed.** If you know the target client freezes tools at startup, use `both` (default) or `meta`.
- **Pasting the claim code into the terminal instead of the agent.** The claim code is consumed by the MCP client (Claude) calling `tesseron__claim_session`, not by the shell.
- **Persisting the claim code.** It's one-shot; it expires quickly after the welcome handshake. Use the resume token for reconnection, not the claim code.
- **Expecting a single gateway to route to SDKs on a different host.** The gateway is local-only by design. For remote apps, run a gateway on the remote host or tunnel the WebSocket (and still set an origin allowlist).
