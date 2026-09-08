# Release and the plugin version contract

*Last Updated: 2026-09-08*

Two contracts. Both have a script or a workflow that owns them. Neither should be edited by hand.

## Three hub packages, each released alone

`.changeset/config.json` has `fixed: []` since SQ-52. The hub publishes three packages and each moves
on its own changeset:

| Package | Version | Cadence |
|---|---|---|
| `@tesseron/mcp` (`gateway/`) | 2.10.2 | gateway code changes |
| `@tesseron/docs-mcp` (`docs-mcp/`) | 2.10.2 | any docs content change (the build-time snapshot ships prose) |
| `@tesseron/conformance` (`conformance/runner/`) | 1.2.1 | runner or fixture changes; tracks the protocol version |

The seven SDK packages (`@tesseron/core`, `/web`, `/server`, `/react`, `/svelte`, `/vue`, `/vite`)
keep their fixed group in `tesseron-typescript` and release from that repo's `release.yml`. The
gateway consumes `@tesseron/core` from npm at a caret range (`gateway/package.json:51`), so a gateway
release no longer implies a core release or the reverse. `.claude/live-rules/rules/release-lockstep.md`
is the always-on statement of this.

`@tesseron/docs-mcp` needs its own changeset for every prose change; `pnpm check-docs-changeset`
(CI's last step) refuses a docs edit without one. Verify with `pnpm changeset status`: a docs-only
changeset should list exactly one package. `ignore` list: `@tesseron/docs` only.

Rules:

- Any user-visible change under `gateway/`, `docs-mcp/`, or `conformance/` needs `pnpm changeset`.
- **Never hand-edit a `version` field** in a package's `package.json`. `changeset version` owns it,
  through `pnpm version-packages`, which also runs the plugin version sync and Biome
  (`package.json:26`).
- `.github/workflows/release.yml` publishes through `changesets/action@v1` with npm trusted
  publishing. Do not publish by hand. It pins `npm@^11.5.1` rather than `npm@latest`: npm 12 dropped
  Node 20, and `@latest` broke every release from 2026-06-10 until it was noticed on 2026-08-20.
- An SDK release PR in `tesseron-typescript` counts as complete only after its docs PR here has
  merged (the docs for all four SDKs live under `docs/src/content/docs/sdk/`).

## The plugin version lives in eight places, following two packages

`plugin/` ships **no bundled gateway**. `plugin/.mcp.json` reaches the published servers through
`npx -y <pkg>@<version>`. Drift on any one surface ships a plugin that fetches the wrong server.

The eight surfaces do not all carry the same number, because docs-mcp releases on its own:

| # | Surface | Follows |
|---|---|---|
| 1 | `plugin/.claude-plugin/plugin.json#version` | `@tesseron/mcp` |
| 2 | `.claude-plugin/marketplace.json#metadata.version` | `@tesseron/mcp` |
| 3 | `.claude-plugin/marketplace.json#plugins[0].version` | `@tesseron/mcp` |
| 4 | `.agents/plugins/marketplace.json#plugins[0].version` | `@tesseron/mcp` |
| 5 | `plugin/.mcp.json#mcpServers.tesseron.args` | `@tesseron/mcp` |
| 6 | `plugin/.mcp.json#mcpServers.tesseron-docs.args` | `@tesseron/docs-mcp` |
| 7 | `README.md` (every `@tesseron/{mcp,docs-mcp}@<semver>` literal) | each pin's own package |
| 8 | `plugin/README.md` (same) | each pin's own package |

`scripts/sync-plugin-version.mjs` owns all eight. `pnpm sync-plugin-version` rewrites them from the
two package.json files; `--check` (CI, and `pnpm gate`) fails on drift. `pnpm version-packages`
chains it after `changeset version`, so a normal release never drifts. Editing a version literal in
any of those files by hand is the one way to break it.

## The docs snapshot coupling

`@tesseron/docs-mcp` bakes `docs/src/content/docs/` into `dist/docs-index.json` at build time, and
turbo does **not** invalidate that cache when `docs/` changes. See
[gateway.md](gateway.md#the-build-time-snapshot-and-its-coupling). Stale prose therefore ships to end
users through the published docs server, which is why a public-surface change in the gateway or in
any SDK repo requires the matching page update here. CI enforces the other direction too:
`pnpm check-docs-changeset` refuses a docs content edit that carries no `@tesseron/docs-mcp`
changeset.
