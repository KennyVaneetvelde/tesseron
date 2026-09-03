# Agent guide for the Tesseron monorepo

Instructions for AI coding agents (Claude Code, Codex, OpenCode, Cursor, Copilot)
working in this repo. Human contributors should start with
[`CONTRIBUTING.md`](./CONTRIBUTING.md) — this file covers what an agent needs to
know on top of the human flow.

## Package manager

This is a pnpm workspace (`packageManager: pnpm@9.15.4` in `package.json`). Use
pnpm for every install, run, and filtered command. Do not swap to npm or yarn.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm lint
pnpm format    # writes Biome-formatted files in place
```

Run `pnpm typecheck && pnpm test` before declaring a non-trivial change done.
Lint with Biome (`pnpm lint`) — there is no ESLint or Prettier config in this
repo; do not introduce one.

## Workspace layout

- `sdks/typescript/core`: protocol types and the TypeScript SDK runtime. No bundler dependency.
- `sdks/typescript/{web,server,react,svelte,vue,vite}`: consumer SDKs.
- `sdks/typescript/examples/`: runnable TypeScript example apps. Treat them as live integration
  fixtures.
- `gateway/`: the gateway binary published as `@tesseron/mcp` (`bin: tesseron-mcp`).
- `docs-mcp/`: the docs MCP server published as `@tesseron/docs-mcp`.
- `conformance/`: language-neutral fixtures and the Node runner workspace.
- `plugin/` — the Claude Code plugin (also accepted by Codex). Skills live in
  `plugin/skills/`, the MCP wiring in `plugin/.mcp.json`, the manifest in
  `plugin/.claude-plugin/plugin.json`.
- `.claude-plugin/marketplace.json` — Claude Code marketplace listing.
- `.agents/plugins/marketplace.json` — Codex marketplace listing (same plugin
  source, Codex-preferred path).
- `docs/` — Starlight site at https://eigenwise.github.io/tesseron/.

## Plugin manifest is version-coupled

The plugin no longer ships a pre-bundled gateway. `plugin/.mcp.json` invokes
`@tesseron/mcp` and `@tesseron/docs-mcp` via `npx -y <pkg>@<version>`. Eight
surfaces move on every release, but they no longer all carry the *same* number:
the plugin's own version tracks `@tesseron/mcp`, while the two surfaces that
literally name `@tesseron/docs-mcp` track that package, which releases
independently.

| Surface | Follows |
|---|---|
| `plugin/.claude-plugin/plugin.json#version` | `@tesseron/mcp` |
| `.claude-plugin/marketplace.json#metadata.version` (Claude marketplace) | `@tesseron/mcp` |
| `.claude-plugin/marketplace.json#plugins[0].version` (Claude marketplace) | `@tesseron/mcp` |
| `.agents/plugins/marketplace.json#plugins[0].version` (Codex marketplace) | `@tesseron/mcp` |
| `plugin/.mcp.json#mcpServers.tesseron.args` | `@tesseron/mcp` |
| `plugin/.mcp.json#mcpServers.tesseron-docs.args` | `@tesseron/docs-mcp` |
| `README.md` (every literal `@tesseron/{mcp,docs-mcp}@<semver>`) | each pin's own package |
| `plugin/README.md` (same) | each pin's own package |

`scripts/sync-plugin-version.mjs` is the contract. Run `pnpm sync-plugin-version`
to fix drift, or `pnpm sync-plugin-version --check` (CI does this) to fail fast.
The release flow chains it via `pnpm version-packages` (changesets entry point).

There is no `plugin/server/` directory and no `pnpm build:plugin` script. Do not
recreate them.

## Releases

Releases are driven by Changesets. Add a changeset for any user-visible change
under `sdks/typescript/`, `gateway/`, or `docs-mcp/`:

```bash
pnpm changeset
```

`@tesseron/core`, `/mcp`, `/web`, `/server`, `/react`, `/svelte`, `/vue`,
`/vite` ship in lockstep — bump them together. They are one `fixed` group in
`.changeset/config.json`.

`@tesseron/docs-mcp` is **not** in that group. It ships the docs snapshot rather
than protocol code, so a prose correction releases on its own instead of forcing
a bump across every SDK package. Give it its own changeset. CI enforces that docs content changes
carry a `@tesseron/docs-mcp` changeset.

The release workflow at `.github/workflows/release.yml` opens a PR or publishes
via `changesets/action@v1`.

## Documentation

Public-surface changes (protocol messages, exported types, action/resource
builder APIs, ActionContext methods, transports, gateway CLI flags, React
hooks) require a corresponding update under `docs/src/content/docs/`. The
docs-mcp server snapshots these pages at build time, so stale docs ship to
end users via `@tesseron/docs-mcp`. Test-only, tooling-only, or internal
refactors do not require doc updates.

## Commits

Sign off every commit with `git commit -s` (DCO required — see
`CONTRIBUTING.md`). Keep PRs focused on one logical change. Pre-commit hooks
are not configured; rely on `pnpm typecheck && pnpm test && pnpm lint`
locally and on the CI workflow at `.github/workflows/ci.yml`.
