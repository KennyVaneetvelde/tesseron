<div align="center">
  <a href="https://github.com/eigenwise/tesseron">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-dark.png">
      <img src="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-light.png" alt="Tesseron" width="380">
    </picture>
  </a>
</div>

# @tesseron/mcp

The [Tesseron](https://github.com/eigenwise/tesseron) **MCP gateway** — a local CLI that bridges [`@tesseron/web`](https://www.npmjs.com/package/@tesseron/web) / [`@tesseron/server`](https://www.npmjs.com/package/@tesseron/server) apps to any MCP-compatible AI agent (Claude Code, Claude Desktop, Cursor, Copilot, Codex, ...).

> **Most users don't install this directly.** Use the Claude Code plugin — it bundles the gateway and auto-spawns it:
>
> ```text
> /plugin marketplace add eigenwise/tesseron
> /plugin install tesseron@tesseron
> ```
>
> Install `@tesseron/mcp` directly only when you want to run the gateway standalone (for development, log inspection, or to wire into a non-Claude MCP client).

## What it does

- Listens on `ws://127.0.0.1:7475` for Tesseron SDK connections (your app).
- Speaks MCP over stdio to the agent.
- Dynamically registers each claimed app's actions as MCP tools.
- Bridges `ctx.sample` / `ctx.elicit` / `ctx.progress` / resource subscribes between the two protocols.
- Ships a `tesseron__read_resource` meta-tool for MCP clients that don't yet speak native resources, plus `tesseron__claim_session`, `tesseron__list_actions`, and `tesseron__invoke_action` for maximum client compat.

## Install

```bash
npm install -g @tesseron/mcp
```

Or run on demand without installing:

```bash
npx @tesseron/mcp
```

## Run it standalone

```bash
tesseron-mcp
```

Output:

```
[tesseron] gateway listening on ws://127.0.0.1:7475
[tesseron] MCP stdio bridge ready
[tesseron] new session "My App" (s_...) — claim code: ABCD-XY
```

## Wire it into an MCP client

### Claude Code

Edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "tesseron": {
      "command": "npx",
      "args": ["@tesseron/mcp"]
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "tesseron": {
      "command": "npx",
      "args": ["@tesseron/mcp"]
    }
  }
}
```

Same pattern works for Cursor, Codex, VS Code + Copilot, goose, and fast-agent.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TESSERON_PORT` | `7475` | WebSocket port for SDK connections. |
| `TESSERON_HOST` | `127.0.0.1` | Bind address. |
| `TESSERON_ORIGIN_ALLOWLIST` | *(localhost only)* | Comma-separated origin allowlist for non-localhost apps. |
| `TESSERON_TOOL_SURFACE` | `both` | `dynamic` \| `meta` \| `both` — how actions are exposed to the agent. `dynamic` for spec-compliant clients, `meta` for clients that freeze their tool list, `both` for maximum compat. |

## Docs

| | |
|---|---|
| Main repo | <https://github.com/eigenwise/tesseron> |
| SDK reference | <https://eigenwise.github.io/tesseron/sdk/typescript/mcp/> |
| Protocol spec | <https://eigenwise.github.io/tesseron/protocol/> |
| Architecture | <https://eigenwise.github.io/tesseron/overview/architecture/> |

## License

Reference implementation — [Business Source License 1.1](https://github.com/eigenwise/tesseron/blob/main/LICENSE) (source-available). You may embed Tesseron in your own apps, run this gateway locally, fork, and redistribute. You may **not** offer Tesseron or a substantial portion of it as a hosted or managed service to third parties. Each release auto-converts to Apache-2.0 four years after publication.

<p align="center">Built and maintained by <a href="https://eigenwise.io/"><b>Eigenwise</b></a>.</p>
