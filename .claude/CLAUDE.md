# Claude Code setup for this repo

What's enabled here, at which scope, and the few things that bite. Project conventions live in
[`AGENTS.md`](../AGENTS.md); this file is only about the tooling around them.

## Scopes

Two files decide what loads, and they mean different things:

| File | Tracked? | What belongs in it |
|---|---|---|
| `.claude/settings.json` | yes, public | plugins a contributor needs to make sense of what's committed |
| `.claude/settings.local.json` | no, gitignored | Kenny's personal workflow plugins and the gateway env |

**Project scope** carries `live-rules` and `codebase-mapper` from `eigenwise-toolshed`, because both
write artifacts that are committed (`.claude/live-rules/`, `.claude/.codebase-info/`) and are
useless to a contributor who can't load the plugin that reads them. Also here: `typescript-lsp`,
`mcp-server-dev`, `skill-creator`, `plugin-dev`, `developer-kit-typescript`, `model-gateway` (wires
`ANTHROPIC_BASE_URL` at `127.0.0.1:18764`; a contributor without the gateway running should disable it
locally), and `ponytail`.

**Local scope** carries `tesseron@tesseron` (this repo dogfooding its own plugin through a
`directory` marketplace pointed at the repo root), plus `pr-review-toolkit`, `sidequest`,
`observability`, and `quartermaster`. None of that should ship to contributors.

There is no user-scope layer for this repo anymore. `~/.claude/settings.json` holds nothing this project
depends on; everything is either committed here or in the gitignored local file.

### Two dead entries

`.claude/settings.json` still enables `opendesign@opendata-skills` and
`superpowers-developing-for-claude-code@superpowers-marketplace`. Neither marketplace is known to
this machine and neither is declared in `extraKnownMarketplaces`, so both are inert: their skills
never appear in the session. Either add the marketplaces or drop the lines.

## Hooks

`.claude/hooks/inject-docs-index.py` runs on `UserPromptSubmit`. It injects the docs index plus a
mandatory instruction: read the relevant page under `docs/src/content/docs/` before answering
protocol or SDK questions, and sync docs after any public-surface change under `sdks/typescript/`,
`gateway/`, or `docs-mcp/`. That hook is why there is no live rule restating the docs contract.

`codebase-mapper` injects `.claude/.codebase-info/INDEX.md` at session start once the map exists.
It's already in context, so don't re-derive the layout with Glob and Grep before reading it.

## Live rules

Three, in `.claude/live-rules/rules/`, injected by scope rather than always:

- `plugin-version-lockstep.md` fires on `plugin/**`, the two marketplace manifests, and `README.md`.
  Eight surfaces carry a version and they follow two different packages;
  `scripts/sync-plugin-version.mjs` owns all of them.
- `release-lockstep.md` fires on `sdks/typescript/*/package.json`, `gateway/package.json`, and
  `.changeset/**`. Eight packages are a changesets `fixed` group and bump as one;
  `@tesseron/docs-mcp` sits outside it on purpose.
- `self-improvement.md` is global.

Rules restating pnpm-only, DCO sign-off, or docs-sync would duplicate `AGENTS.md` (always in
context) or the docs hook, so they aren't here. Add a rule only when it needs just-in-time,
glob-scoped injection that always-on context can't give.

## typescript-lsp on Windows

Install the language server with **bun**, not npm:

```bash
bun add -g typescript-language-server typescript
npm uninstall -g typescript-language-server typescript
```

The `LSP` tool spawns through libuv's raw `uv_spawn`. npm's global dir holds a bare unix shell-script
shim (`#!/bin/sh`) that Windows can't exec, and even with that removed, Node's CVE-2024-27980 fix
blocks `.cmd` shim resolution without `shell: true`. bun writes a real
`typescript-language-server.exe`, which resolves cleanly. If both are installed, npm's dir sorts
earlier in PATH and wins, so uninstall it.

Diagnostic when `LSP` returns `ENOENT ... uv_spawn 'typescript-language-server'`:

```bash
node -e "require('child_process').spawn('typescript-language-server',['--version'],{shell:false}).on('error',console.log)"
```

ENOENT there means the shim chain is broken. Anything else (including a nonzero exit) means it
spawns fine.

Prefer `LSP` over grep for "where is this defined / used / implemented" in TypeScript. Grep is for
string and regex patterns.

`workbench` also ships a `code-intel` MCP server with `definition`, `references`, and `diagnostics`.
It overlaps typescript-lsp; either works.

## developer-kit-typescript

Its hooks need **Python 3 on PATH** or the whole enforcement layer is silently inert. `ts-quality-gate`
runs on `Stop` and can block session exit on `tsc` or ESLint failures. Note this repo lints with
Biome and has no ESLint config, so treat that gate's ESLint half as noise. Its rules are not
auto-copied; they only apply if present in `.claude/rules/`, and they are not.

## Project skills

In `.claude/skills/`: `update-docs`, `tesseron-diagram`, `architecture-diagram`. `reddit-author` is
gitignored and local-only.

## Guardrails

- `.claude/settings.local.json` is gitignored and holds the gateway env. Keep it that way.
- The `tesseron` marketplace is a `directory` source pointing at this repo, so plugin edits under
  `plugin/` take effect after `/reload-plugins`. Version bumps still go through
  `pnpm sync-plugin-version`.
- Don't re-run `map-codebase` when `update-codebase-map` will do.
