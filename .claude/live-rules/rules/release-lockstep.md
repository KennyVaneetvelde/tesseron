---
description: Hub packages release independently; SDK releases live in their own repositories
globs: ["gateway/package.json", "docs-mcp/package.json", "conformance/runner/package.json", ".changeset/**"]
prompt: ["release", "publish", "changeset", "version bump", "ship it"]
priority: 60
---
- Keep `fixed: []` in `.changeset/config.json`. `@tesseron/mcp`,
  `@tesseron/docs-mcp`, and `@tesseron/conformance` release independently.
- Add a changeset for user-visible changes to a hub package. Docs content changes
  need a `@tesseron/docs-mcp` changeset. Only `@tesseron/docs` is ignored.
- Keep the seven TypeScript SDK packages' fixed group in `tesseron-typescript`.
  An SDK release PR is complete only after its hub docs PR has merged.
- Never hand-edit package version fields. Use `pnpm version-packages`, which runs
  Changesets, plugin version sync, and Biome.
- Publish through `.github/workflows/release.yml` and `changesets/action@v1`.
  Keep its `npm@^11.5.1` pin until the workflow's Node version supports npm 12.
