# Agent guide for the Tesseron hub

Instructions for AI coding agents (Claude Code, Codex, OpenCode, Cursor, Copilot)
working in this repo. Human contributors should start with
[`CONTRIBUTING.md`](./CONTRIBUTING.md). This file covers what an agent needs to
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

Run `pnpm gate` before declaring a non-trivial change done. It is the CI floor:
typecheck, test, lint, plugin version check, conformance fixture validation, docs
changeset check.
Lint with Biome (`pnpm lint`). There is no ESLint or Prettier config in this
repo; do not introduce one.

## Workspace layout

- `gateway/`: the gateway published as `@tesseron/mcp` (`tesseron-mcp` CLI). It
  depends on the published `@tesseron/core` package.
- `docs-mcp/`: the docs MCP server published as `@tesseron/docs-mcp`.
- `conformance/`: language-neutral fixtures and the `conformance/runner` workspace,
  published as `@tesseron/conformance`.
- `docs/`: the Starlight site at https://eigenwise.github.io/tesseron/.
- `plugin/`: the Claude Code and Codex plugin. Skills live in `plugin/skills/`,
  MCP wiring in `plugin/.mcp.json`, and the manifest in
  `plugin/.claude-plugin/plugin.json`.
- `.claude-plugin/marketplace.json`: the Claude Code marketplace listing.
- `.agents/plugins/marketplace.json`: the Codex marketplace listing for the same plugin.

## Language SDK repositories

| Language | Repository |
|---|---|
| TypeScript | [Eigenwise/tesseron-typescript](https://github.com/Eigenwise/tesseron-typescript) |
| Rust | [Eigenwise/tesseron-rust](https://github.com/Eigenwise/tesseron-rust) |
| Python | [Eigenwise/tesseron-python](https://github.com/Eigenwise/tesseron-python) |
| C++ | [Eigenwise/tesseron-cpp](https://github.com/Eigenwise/tesseron-cpp) |

SDK source, examples, tests, and conformance hosts live in those repositories.
Follow each repository's contributor guide and run its own checks there.
Protocol fixtures, all language docs, and issue tracking stay in this hub.
An SDK release PR is complete only after its corresponding hub docs PR has merged.

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
under `gateway/`, `docs-mcp/`, or `conformance/runner/`:

```bash
pnpm changeset
```

`@tesseron/mcp`, `@tesseron/docs-mcp`, and `@tesseron/conformance` release
independently. The hub has no Changesets fixed group. The seven TypeScript SDK
packages keep their fixed group in `tesseron-typescript`.

Docs content changes need their own `@tesseron/docs-mcp` changeset because that
package ships the docs snapshot. CI enforces this. `@tesseron/docs` is private
and stays in the Changesets ignore list.

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

Sign off every commit with `git commit -s` (DCO required, see
`CONTRIBUTING.md`). Keep PRs focused on one logical change. Pre-commit hooks
are not configured; rely on `pnpm gate`
locally and on the CI workflow at `.github/workflows/ci.yml`.
