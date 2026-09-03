# Release and the plugin version contract

*Last Updated: 2026-09-03*

Two coupled contracts. Both have a script that owns them. Neither should be edited by hand.

## Eight packages release as one; docs-mcp releases alone

`.changeset/config.json` puts these in a single `fixed` group, so they share a version and bump
together:

`@tesseron/core`, `/web`, `/server`, `/react`, `/mcp`, `/svelte`, `/vue`, `/vite`

All at **2.10.1**. You cannot ship one alone, and removing a package from the group is a public API
decision rather than a cleanup.

**`@tesseron/docs-mcp` is deliberately outside the group.** It ships the build-time docs snapshot
rather than protocol code, and prose changes on a completely different cadence than the wire format.
While it was in the group, correcting a typo in a spec page cost a version bump across all nine
packages. It now carries its own version and needs its own changeset. Verify with
`pnpm changeset status`: a docs-only changeset should list exactly one package.

`ignore` list: `@tesseron/docs` and the six examples. They never get changesets.

Rules:

- Any user-visible change under `sdks/typescript/`, `gateway/`, or `docs-mcp/` needs `pnpm changeset`.
- **Never hand-edit a `version` field** in a package's `package.json`. `changeset version` owns it,
  through `pnpm version-packages`, which also runs the plugin version sync and Biome
  (`package.json:25`).
- `.github/workflows/release.yml` publishes through `changesets/action@v1` with npm trusted
  publishing. Do not publish by hand. It pins `npm@^11.5.1` rather than `npm@latest`: npm 12 dropped
  Node 20, and `@latest` broke every release from 2026-06-10 until it was noticed on 2026-08-20.

## The plugin version lives in eight places, following two packages

`plugin/` ships **no bundled gateway**. `plugin/.mcp.json` reaches the published servers through
`npx -y <pkg>@<version>`. Drift on any one surface ships a plugin that fetches the wrong server.

The eight surfaces no longer all carry the same number, because docs-mcp left the fixed group:

| # | Surface | Follows |
|---|---|---|
| 1 | `plugin/.claude-plugin/plugin.json#version` | `@tesseron/mcp` |
| 2 | `.claude-plugin/marketplace.json#metadata.version` | `@tesseron/mcp` |
| 3 | `.claude-plugin/marketplace.json#plugins[0].version` | `@tesseron/mcp` |
| 4 | `.agents/plugins/marketplace.json#plugins[0].version` | `@tesseron/mcp` |
| 5 | `plugin/.mcp.json#mcpServers.tesseron.args` | `@tesseron/mcp` |
| 6 | `plugin/.mcp.json#mcpServers.tesseron-docs.args` | **`@tesseron/docs-mcp`** |
| 7 | every literal `@tesseron/{mcp,docs-mcp}@<semver>` in `README.md` | each pin's own package |
| 8 | the same in `plugin/README.md` | each pin's own package |

The script resolves these through a `versionByPackage` map (`sync-plugin-version.mjs`), so a
docs-mcp pin at a different version than the plugin is correct, not drift.

`scripts/sync-plugin-version.mjs` is the contract. `pnpm sync-plugin-version` fixes drift;
`pnpm sync-plugin-version --check` verifies and is what CI runs (`.github/workflows/ci.yml:40`).

`.claude-plugin/marketplace.json` is the Claude Code listing; `.agents/plugins/marketplace.json` is
the Codex listing for the same plugin source.

**There is no `plugin/server/` directory and no `pnpm build:plugin` script. Do not recreate them.**
The matching `plugin/server/**` entry in `biome.json`'s ignore list has been removed too, so nothing
in the repo still implies that directory exists.

## The docs coupling

`@tesseron/docs-mcp` bakes `docs/src/content/docs/` into `dist/docs-index.json` at build time, and
turbo does **not** invalidate that cache when `docs/` changes. See
[gateway.md](gateway.md#the-build-time-snapshot-and-its-coupling). Stale prose therefore ships to end
users through the published docs server, which is why a public-surface change under
`sdks/typescript/` or `gateway/` requires the matching page update in the same change. CI enforces
the other direction too: `pnpm check-docs-changeset` refuses a docs content edit that carries no
`@tesseron/docs-mcp` changeset.
