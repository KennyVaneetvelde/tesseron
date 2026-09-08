# Directory structure

*Last Updated: 2026-09-08*

This repo is the **hub**: the language-neutral pieces (spec, gateway, docs server, conformance,
docs site, plugin) and nothing else. The four language SDKs lived under `sdks/<language>/` from
2026-09-03 (commit 4ca98ea) until 2026-09-08, when SQ-52 (commit 45a9e1b) deleted that tree; each now
lives in its own repo (`Eigenwise/tesseron-{typescript,rust,python,cpp}`, linked from `AGENTS.md:41`
and `README.md:197`). 284 tracked files remain here; the TypeScript source is `gateway/src`,
`docs-mcp/src`, and `conformance/runner/src`.

```
tesseron/
├── gateway/                  @tesseron/mcp 2.10.2 — the gateway, bin tesseron-mcp
│   ├── src/                  cli, gateway, dialer, mcp-bridge, session store
│   ├── test/                 13 Vitest files; setup.ts is the shared harness
│   └── scripts/              e2e-browser-claim.mjs, e2e-issue-69.mjs (manual, not in the suite)
├── docs-mcp/                 @tesseron/docs-mcp 2.10.2 — docs server, bin tesseron-docs-mcp
├── docs/                     Astro + Starlight → eigenwise.github.io/tesseron/
│   └── src/content/docs/     64 pages. sdk/{typescript,rust,python,cpp}/ document the four repos;
│       │                     docs-mcp bakes all of it in at build time.
│       └── protocol/         CC BY 4.0, licensed separately from the implementation
│                             compatibility.md is the version-negotiation contract
├── conformance/              language-neutral fixture corpus for the SDK repos, plus its runner
│   ├── fixtures/             39 scripted JSON exchanges. no deps on this workspace.
│   ├── validate.mjs          zero-dep fixture linter, `pnpm conformance:validate`
│   ├── run-reference.mjs     launches the runner against a host you name: `--host` is required (:22),
│   │                         `--unsupported` optional, `--fixtures` always the live corpus
│   └── runner/               @tesseron/conformance 1.2.1, bin tesseron-conformance, depends on ws only
├── plugin/                   the Claude Code plugin (also accepted by Codex)
│   ├── skills/
│   ├── .mcp.json             npx -y @tesseron/{mcp,docs-mcp}@<version>
│   └── .claude-plugin/plugin.json
├── .claude-plugin/           Claude Code marketplace listing
├── .agents/plugins/          Codex marketplace listing, same plugin source
├── scripts/                  sync-plugin-version.mjs (8 version surfaces), check-docs-changeset.mjs,
│                             sync-labels.mjs (pushes .github/labels.json to GitHub)
├── .changeset/               config.json: `fixed: []`, only @tesseron/docs ignored
├── .release/unreleased/      one Sidequest release fragment per shipped ticket
├── .github/workflows/        ci.yml, docs.yml, release.yml, label-by-area.yml
│   └── labels.json           the `area: *` label set the issue templates and label workflow use
├── AGENTS.md                 the real conventions. CLAUDE.md just @-includes it.
├── turbo.json  biome.json  tsconfig.base.json  pnpm-workspace.yaml
└── .claude/                  this map, live rules, the docs-index hook, project skills
```

`pnpm-workspace.yaml` lists exactly `gateway`, `docs-mcp`, `conformance/runner`, and `docs`.

## Organizing principle

By **published artifact**. Each of `gateway/`, `docs-mcp/`, and `conformance/runner/` is one npm
package with its own `package.json`, `tsup.config.ts`, `tsconfig.json`, and `test/` dir.

The dependency shape now crosses the registry. `@tesseron/core` is published from
`tesseron-typescript`; the gateway consumes it like any other consumer:

```
   tesseron-typescript (npm)          this hub
   @tesseron/core ──────────────────▶ @tesseron/mcp        (dependency ^2.10.2, gateway/package.json:51)
   @tesseron/server ────────────────▶ @tesseron/mcp tests  (devDependency ^2.10.2, :56)
                                      @tesseron/docs-mcp   (no core dependency)
                                      @tesseron/conformance (ws only, no core dependency)
```

A gateway change that needs a new core export therefore ships in two steps: release
`tesseron-typescript` first, then bump the range here. There is no `workspace:*` left in the hub.

## Things that are not where you would guess

- The protocol source of truth (`protocol.ts`, error codes at `:60`) is in `tesseron-typescript/core/src/`,
  not in this repo. The hub's `docs/src/content/docs/protocol/` pages describe it; `conformance/fixtures/`
  pins it executably.
- `conformance/fixtures/` is deliberately outside every `pnpm-workspace.yaml` glob so an SDK repo can
  vendor it or run `npx @tesseron/conformance` against it with nothing else installed.
- Runtime state lives outside the repo in `~/.tesseron/`: `instances/` (discovery manifests),
  `tabs/` (v1 compat), `claims/` (cross-gateway breadcrumbs).
- `run-reference.mjs` has no default host any more (`:22-27` exits 2 without `--host`); the TypeScript
  reference host moved to `tesseron-typescript/conformance-host/`.
- `biome.json:4` ignores only `dist`, `node_modules`, `.turbo`, `.astro`, `assets/diagrams`, and
  `.claude`. Everything else on disk gets walked, which is why leftover SDK build output matters (next
  point).
- A checkout that built the SDKs before 2026-09-08 still has gitignored residue under `sdks/`
  (`rust/target`, `cpp/build/_deps`, `python/.venv`, `node_modules`). Git tracks nothing there, but
  Biome walks it and overflows its stack on `pnpm lint`. Delete the directory. Same story for the
  older `packages/` and `examples/` leftovers.
