# @tesseron/pi

## 2.7.0

### Minor Changes

- [#82](https://github.com/BrainBlend-AI/tesseron/pull/82) [`cba7894`](https://github.com/BrainBlend-AI/tesseron/commit/cba7894a3a90fb6b2de7f2a1955ca842a514100b) by Kenny - feat: add `@tesseron/pi` Pi coding-agent plugin

  New workspace package shipping a Pi extension (`@mariozechner/pi-coding-agent`) that exposes the Tesseron MCP gateway and docs server as eight typed Pi tools (`tesseron_claim_session`, `tesseron_list_actions`, `tesseron_list_pending_claims`, `tesseron_invoke_action`, `tesseron_read_resource`, `tesseron_docs_list`, `tesseron_docs_search`, `tesseron_docs_read`) plus the same five-skill bundle the Claude/Codex plugin ships. Install with `pi install -l npm:@tesseron/pi@<v>`.

  The Pi extension uses a hand-rolled stdio JSON-RPC client (no `@modelcontextprotocol/sdk` dep) to spawn `npx -y @tesseron/{mcp,docs-mcp}@<version>` as child processes and forward `tools/call` requests. Pinned `@tesseron/mcp` version stays in lockstep with the rest of the SDK fixed group via an extension to `scripts/sync-plugin-version.mjs`, which now also mirrors `plugin/skills/` → `packages/pi/skills/` and fails CI on any drift.
