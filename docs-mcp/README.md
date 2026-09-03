# @tesseron/docs-mcp

[Tesseron](https://eigenwise.github.io/tesseron) documentation as an MCP server. Search and read the full protocol + SDK docs from any MCP-compatible AI client: Claude Code, Claude Desktop, Cursor, Windsurf, Zed, and anything else that speaks the [Model Context Protocol](https://modelcontextprotocol.io).

No network, no vector store, no API keys. The docs snapshot is bundled in the npm package at publish time. Search runs locally with BM25 over in-memory text.

## Why

If you are writing a Tesseron app, your AI assistant should know Tesseron. This server exposes the canonical Tesseron docs as three MCP tools (`list_docs`, `search_docs`, `read_doc`) plus `tesseron-docs://<slug>` resources so the agent can retrieve exact spec text before answering instead of guessing from training data.

## Install

Nothing to install. Use `npx`.

## Configure your AI client

### Claude Code / Claude Desktop

Add to `~/.claude.json` or `~/.config/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "tesseron-docs": {
      "command": "npx",
      "args": ["-y", "@tesseron/docs-mcp"]
    }
  }
}
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tesseron-docs": {
      "command": "npx",
      "args": ["-y", "@tesseron/docs-mcp"]
    }
  }
}
```

### Windsurf / Zed / any other MCP client

Point the client at `npx -y @tesseron/docs-mcp`. stdio transport, Node ≥ 20.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `list_docs` | `{}` | `{ count, docs: Array<{ slug, title, section, description, related }> }` |
| `search_docs` | `{ query: string, limit?: number (1-20, default 8) }` | `{ query, count, hits: Array<{ slug, title, description, section, score, snippet }> }` |
| `read_doc` | `{ slug: string }` | `{ slug, title, description, section, related, body }` (body is full markdown) |

Slug format: `<section>/<basename>` without extension. Examples: `protocol/handshake`, `sdk/typescript/action-builder`, `examples/react-todo`.

## Resources

Each docs page is also exposed as an MCP resource at `tesseron-docs://<slug>`. Clients that prefer the resource surface over tools (Claude Desktop is one) get full listing via `list_resources` and full markdown bodies via `read_resource`.

## Search behaviour

- BM25 index via [minisearch](https://www.npmjs.com/package/minisearch).
- Fields: `title` (weight 3), `description` (weight 2), `bodyText` (weight 1).
- Fuzzy matching (`0.15`) and prefix matching are both on.
- Snippets are ~240 chars centred on the best match, with ellipses added when truncated.

## Dev / local use

Point the server at a local snapshot or set the env var:

```bash
# Build fresh snapshot from the monorepo docs tree.
pnpm --filter @tesseron/docs-mcp build:snapshot

# Run from source with a custom snapshot file.
pnpm --filter @tesseron/docs-mcp start -- --snapshot ./dist/docs-index.json

# Or via env var.
TESSERON_DOCS_SNAPSHOT=/abs/path/to/docs-index.json npx @tesseron/docs-mcp
```

The snapshot is rebuilt on every `pnpm build` (via `pnpm build:snapshot && tsup`) and on `prepublishOnly`.

## Versioning

`@tesseron/docs-mcp` versions track the docs snapshot, not the SDK. A new publish means the bundled docs were updated. It is unscoped from the `@tesseron/{core,web,server,react,mcp}` fixed-version bundle so SDK releases do not churn the docs package.

## License

BUSL-1.1. See [LICENSE](./LICENSE).
