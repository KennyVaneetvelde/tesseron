# Tesseron examples

**The same todo app in six environments.** Tesseron is a protocol SDK — these examples show the same action surface (`addTodo`, `toggleTodo`, `deleteTodo`, `listTodos`, `setFilter`, plus `clearCompleted` for `ctx.confirm`, `renameTodo` for `ctx.elicit` with a schema, `importTodos` for `ctx.progress`, and `suggestTodos` for `ctx.sample`) plus the same two subscribable resources (`currentFilter`, `todoStats`) implemented in every runtime the SDK targets. Read any two side-by-side to see what the SDK abstracts and what stays idiomatic per stack.

They all talk to the same official MCP gateway, [`@tesseron/mcp`](../packages/mcp), and prove the same point: **what the AI does on the other end of MCP shows up live in your real app, no browser automation involved.**

| Example | Side | Stack | What's different about this flavor |
|---|---|---|---|
| [`vanilla-todo`](./vanilla-todo) | client | Vite + vanilla TS | Zero-framework baseline. Hand-rolled `render()`. Read this first. |
| [`react-todo`](./react-todo) | client | Vite + React 18 + [`@tesseron/react`](../packages/react) | Hook-based integration: `useTesseronAction`, `useTesseronConnection`, `useTesseronResource`. |
| [`svelte-todo`](./svelte-todo) | client | Vite + Svelte 5 (runes) | `$state` + `$derived` reactivity from handlers. |
| [`vue-todo`](./vue-todo) | client | Vite + Vue 3 composition API | `ref` + `computed`, composition-style. |
| [`express-todo`](./express-todo) | server | Node + Express + [`@tesseron/server`](../packages/server) | Same todo store served two ways: MCP actions for Claude **and** REST endpoints for curl/other services. Both channels mutate the same `Map`. |
| [`node-todo`](./node-todo) | server | Plain Node script + `@tesseron/server` | No HTTP, no framework — shows that any Node process (CLI, daemon, worker) can expose actions. |

---

## How the pieces fit together

<p align="center">
  <img src="../assets/diagrams/pieces-fit-together.png" alt="USER prompts the agent; YOUR APP (browser or Node, using @tesseron/web or /server) connects over WebSocket to the MCP GATEWAY (@tesseron/mcp on :7475); the MCP GATEWAY bridges to the MCP CLIENT (Claude Code, Desktop, Cursor) over MCP stdio." width="900">
</p>

The MCP gateway dynamically registers each app's actions as MCP tools so the agent can invoke them — and each invocation runs your real handler against your real state.

---

## One-time setup

### 0. Prerequisites

- **Node ≥ 20** (this monorepo declares `engines.node: ">=20"`).
- **pnpm ≥ 9** (`npm i -g pnpm` if you don't have it).
- A working install of an MCP-aware agent: **Claude Code** ([install](https://claude.com/claude-code)), **Claude Desktop**, or **Cursor**. Examples assume Claude.

### 1. Install dependencies

From the repo root:

```bash
pnpm install
```

This wires up the workspace so `@tesseron/web`, `/server`, `/react`, and `/mcp` resolve to the local source.

### 2. Wire the MCP gateway into your MCP client

Pick one. Each option spawns the gateway when the agent starts and shuts it down when the agent stops.

#### Option A — Claude Code

Edit `~/.claude/settings.json` (create the file if needed) and add:

```json
{
  "mcpServers": {
    "tesseron": {
      "command": "pnpm",
      "args": ["--filter", "@tesseron/mcp", "start"],
      "cwd": "/absolute/path/to/this/repo"
    }
  }
}
```

Replace `/absolute/path/to/this/repo` with the actual path (e.g. `C:\\dev\\bridge-sdk` on Windows or `/Users/you/dev/bridge-sdk` on macOS — JSON requires escaping back-slashes). Restart Claude Code.

You can also add it scoped to **just this project**: drop the same `mcpServers` block in `<repo>/.claude/settings.json`.

#### Option B — Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tesseron": {
      "command": "pnpm",
      "args": ["--filter", "@tesseron/mcp", "start"],
      "cwd": "/absolute/path/to/this/repo"
    }
  }
}
```

Restart Claude Desktop. The agent should now show **tesseron** as a connected MCP server with one tool, `tesseron__claim_session`, until you run an example.

#### Option C — run the MCP gateway standalone (for development / log inspection)

Useful if you want to watch the gateway's stderr while developing. The agent spawn + standalone modes can't both run on the same port simultaneously.

```bash
pnpm --filter @tesseron/mcp start
```

Output looks like:

```
[tesseron] gateway listening on ws://127.0.0.1:7475
[tesseron] MCP stdio bridge ready
[tesseron] new session "Svelte Counter" (s_…) — claim code: ABCD-XY
```

> The gateway listens on `ws://127.0.0.1:7475` by default. Override with `TESSERON_PORT`, `TESSERON_HOST`, and `TESSERON_ORIGIN_ALLOWLIST` env vars (comma-separated origins).

### Tool surface modes

The MCP bridge exposes its actions in one of three modes, selected via `TESSERON_TOOL_SURFACE`:

| Mode | Tools exposed | When to use |
|---|---|---|
| `dynamic` | `tesseron__claim_session` + per-app `<app_id>__<action>` tools | Spec-compliant clients that honor `notifications/tools/list_changed` (e.g. Cursor, future fixed Claude Code) |
| `meta` | `tesseron__claim_session`, `tesseron__list_actions`, `tesseron__invoke_action` | Clients that freeze their tool list at startup ([anthropics/claude-code#50515](https://github.com/anthropics/claude-code/issues/50515)). Actions are invoked through the dispatcher: `tesseron__invoke_action({app_id, action, args})`. |
| `both` (default) | everything above | Maximum compatibility. If the client refreshes, users get per-app tools; if not, they can still use the meta dispatcher. |

The meta dispatcher is a **workaround** for clients that ignore `notifications/tools/list_changed`. Once that upstream bug is fixed, set `TESSERON_TOOL_SURFACE=dynamic` for a clean per-app tool surface.

---

## The flow you'll repeat for every browser example

1. **Start the example app** (`pnpm --filter <example> dev`).
2. **Open the page** in your browser at the URL the dev server prints.
3. The page shows a **6-character claim code** like `ABCD-XY`.
4. In your MCP agent, type **"claim session ABCD-XY"** (literal command — the agent will call `tesseron__claim_session({code: 'ABCD-XY'})`).
5. The agent now sees this app's tools (`<app_id>__<action_name>`) in its tool list.
6. Ask the agent to do something. Watch the page update in real time.

Each example's README has concrete prompts to try.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Connection refused` in the browser | MCP gateway isn't running | Check Claude Code/Desktop's MCP server status, or run `pnpm --filter @tesseron/mcp start` standalone |
| Browser console error: `WebSocket connection failed` to `ws://localhost:7475` | Same as above, OR port collision | Change port via `TESSERON_PORT=…` for the gateway and pass the same URL to `tesseron.connect('ws://localhost:…')` |
| Claude doesn't see new tools after claim | MCP client cached the tool list. Tracked upstream: [anthropics/claude-code#50515](https://github.com/anthropics/claude-code/issues/50515) — Claude Code CLI ignores `notifications/tools/list_changed` even though it honors `notifications/resources/list_changed`. | Use `tesseron__invoke_action({app_id, action, args})` — it's statically registered and always reachable. `tesseron__list_actions` enumerates what's available. |
| Action call returns `Tool "x" is not a Tesseron-prefixed action.` | Agent is calling a tool that doesn't exist for any claimed session | List the active tools in your agent and call by exact name (`<app_id>__<action_name>`) |
| Origin-allowlist error in gateway logs | App served from non-localhost origin | Set `TESSERON_ORIGIN_ALLOWLIST=https://your-host.example` when starting the gateway |

---

## Writing your own example

The shortest path is to copy `vanilla-todo`, change the `id` in `tesseron.app({...})`, define your actions, and you're done. The same pattern works in any framework: handlers mutate your reactive state (React `useState`, Svelte `$state`, Vue `ref`), and the user sees the change live. For a server-side example copy `node-todo` (minimal) or `express-todo` (with HTTP).
