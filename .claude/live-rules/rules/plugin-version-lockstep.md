---
description: Plugin version moves across nine surfaces, following two different packages
globs: ["plugin/**", ".claude-plugin/marketplace.json", ".agents/plugins/marketplace.json", "README.md"]
priority: 60
---
The plugin ships no bundled gateway. `plugin/.mcp.json` reaches `@tesseron/mcp` and
`@tesseron/docs-mcp` through `npx -y <pkg>@<version>`, so a version that drifts on any one surface
ships a plugin that fetches the wrong server.

Nine places carry a version, and they do **not** all carry the same one. The plugin's own version
tracks `@tesseron/mcp`. The two surfaces that literally
name `@tesseron/docs-mcp` track that package, which releases independently.

Follows `@tesseron/mcp`:

- `plugin/.claude-plugin/plugin.json#version`
- `.claude-plugin/marketplace.json#metadata.version` and `#plugins[0].version`
- `.agents/plugins/marketplace.json#plugins[0].version`
- `plugin/.mcp.json#mcpServers.tesseron.args`

Follows `@tesseron/docs-mcp`:

- `plugin/.mcp.json#mcpServers.tesseron-docs.args`

Follows whichever package each pin names:

- every literal `@tesseron/{mcp,docs-mcp}@<semver>` in `README.md`, `plugin/README.md`, and
  `docs/src/content/docs/sdk/typescript/mcp.md`

Never hand-edit these one at a time, and never "correct" a docs-mcp pin to match the plugin version.
`scripts/sync-plugin-version.mjs` owns all nine: run `pnpm sync-plugin-version` to fix drift and
`pnpm sync-plugin-version --check` to verify, which is what CI runs. `pnpm version-packages` chains
the sync, so a changesets release keeps them aligned on its own.

There is no `plugin/server/` directory and no `pnpm build:plugin` script. Don't recreate them.
