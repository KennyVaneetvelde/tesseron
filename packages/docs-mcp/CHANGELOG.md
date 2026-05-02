# @tesseron/docs-mcp

## 2.8.0

## 2.7.0

### Minor Changes

- [#82](https://github.com/BrainBlend-AI/tesseron/pull/82) [`cba7894`](https://github.com/BrainBlend-AI/tesseron/commit/cba7894a3a90fb6b2de7f2a1955ca842a514100b) by Kenny - feat: add `@tesseron/pi` Pi coding-agent plugin

  New workspace package shipping a Pi extension (`@mariozechner/pi-coding-agent`) that exposes the Tesseron MCP gateway and docs server as eight typed Pi tools (`tesseron_claim_session`, `tesseron_list_actions`, `tesseron_list_pending_claims`, `tesseron_invoke_action`, `tesseron_read_resource`, `tesseron_docs_list`, `tesseron_docs_search`, `tesseron_docs_read`) plus the same five-skill bundle the Claude/Codex plugin ships. Install with `pi install -l npm:@tesseron/pi@<v>`.

  The Pi extension uses a hand-rolled stdio JSON-RPC client (no `@modelcontextprotocol/sdk` dep) to spawn `npx -y @tesseron/{mcp,docs-mcp}@<version>` as child processes and forward `tools/call` requests. Pinned `@tesseron/mcp` version stays in lockstep with the rest of the SDK fixed group via an extension to `scripts/sync-plugin-version.mjs`, which now also mirrors `plugin/skills/` → `packages/pi/skills/` and fails CI on any drift.

## 2.6.1

## 2.6.0

## 2.5.1

## 2.5.0

## 2.4.0

## 2.3.1

## 2.3.0

## 2.2.2

## 2.2.1

## 2.2.0

## 2.1.1

## 2.1.0

## 2.0.0

## 0.2.0

### Minor Changes

- [#14](https://github.com/BrainBlend-AI/tesseron/pull/14) [`5545ff4`](https://github.com/BrainBlend-AI/tesseron/commit/5545ff42d552a7d0b7fb9d588f8288f771251565) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Initial release of `@tesseron/docs-mcp`: a stdio MCP server that exposes the Tesseron documentation as three tools (`list_docs`, `search_docs`, `read_doc`) and `tesseron-docs://<slug>` resources. The docs snapshot (37 pages) is bundled in the package at publish time; search runs locally via minisearch BM25. Distribute via `npx @tesseron/docs-mcp`.
