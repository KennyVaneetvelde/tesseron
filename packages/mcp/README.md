# @tesseron/mcp

The Tesseron gateway. Bridges WebSocket SDK connections to MCP-compatible AI agents (Claude Code, Claude Desktop, Cursor, …) over stdio.

Run via the `tesseron-mcp` bin (`npx @tesseron/mcp` / `tsx src/cli.ts`) or wire it into your agent's MCP config.

## Tool surface

The bridge exposes one meta-tool for claiming sessions (`tesseron__claim_session`) and, depending on `TESSERON_TOOL_SURFACE`, either per-app tools (`<app_id>__<action>`), a meta dispatcher (`tesseron__list_actions`, `tesseron__invoke_action`, `tesseron__read_resource`), or both. Modes: `dynamic`, `meta`, `both` (default). The meta dispatcher is the workaround for MCP clients that freeze their tool list at startup and ignore `notifications/tools/list_changed`.

## Environment variables

- `TESSERON_PORT` — WebSocket port for the SDK-facing gateway (default `7475`).
- `TESSERON_HOST` — bind host (default `127.0.0.1`).
- `TESSERON_ORIGIN_ALLOWLIST` — comma-separated extra origins beyond `localhost` / `127.0.0.1`.
- `TESSERON_TOOL_SURFACE` — `dynamic` | `meta` | `both` (default `both`).
