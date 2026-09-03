# Directory structure

*Last Updated: 2026-09-04*

Monorepo laid out as a **hub**: the language-neutral pieces (spec, gateway, conformance, docs, plugin)
sit at the top level, and each language SDK lives under `sdks/<language>/`. TypeScript and Rust
exist today. 56 tracked TypeScript source files under `sdks/typescript/*/src`, `gateway/src`, and
`docs-mcp/src`, plus ~4k lines of Rust under `sdks/rust/`.
The layout landed on 2026-09-03 (commit 4ca98ea); it is the in-place precursor to per-language
repos, so nothing under `sdks/typescript/` should reach up to `gateway/` except through
`@tesseron/core`.

```
tesseron/
├── gateway/                  @tesseron/mcp — the gateway, bin tesseron-mcp (was packages/mcp)
├── docs-mcp/                 @tesseron/docs-mcp — docs server, bin tesseron-docs-mcp
├── sdks/
│   └── typescript/           the TypeScript SDK; the seven packages below share one version
│       ├── core/             @tesseron/core  — the whole protocol (19 src files, 8 tests)
│       │   └── src/node/     Node-only: claim minting, bind gating, fs hygiene
│       ├── web/              @tesseron/web — browser SDK + reactive-core.ts (the shared payload)
│       ├── server/           @tesseron/server — Node, binds and announces (no tests)
│       ├── react/            @tesseron/react — 1 file, 3 hooks
│       ├── svelte/           @tesseron/svelte — 1 file, 3 primitives (no tests)
│       ├── vue/              @tesseron/vue — 1 file, 3 primitives (no tests)
│       ├── vite/             @tesseron/vite — dev-server plugin, 959 lines, 1 hook
│       ├── conformance-host/ private reference host for the conformance suite, bin tesseron-conformance-host
│       └── examples/         6 runnable integration fixtures, all private, all workspace:*
│           ├── vanilla-todo/     @tesseron/web, no framework          port 5173
│           ├── react-todo/       @tesseron/react — the ONLY hooks user  port 5174
│           ├── svelte-todo/      @tesseron/svelte                      port 5175
│           ├── vue-todo/         @tesseron/vue                         port 5176
│           ├── express-prompts/  @tesseron/server + express, sampling/elicitation heavy
│           └── node-prompts/     @tesseron/server, headless, has validate:e2e
│   └── rust/                 cargo workspace: crate `tesseron` 0.1.0 is the ROOT package (not a
│       │                     virtual manifest, so `cargo fmt --manifest-path` has a target)
│       ├── src/              protocol, jsonrpc, error, manifest, host, session, action, resource, context, elicit_schema
│       ├── tests/            gateway_session.rs: 19 WebSocket integration tests playing the gateway
│       ├── conformance-host/ member crate, private bin tesseron-conformance-host
│       └── examples/         todo/ and prompts/ (headless daemons, canonical action set, workspace members)
│                             validate-e2e.mjs drives both through the real gateway: `pnpm example:rust:e2e`
├── docs/                     Astro + Starlight → eigenwise.github.io/tesseron/
│   └── src/content/docs/     44 pages. docs-mcp bakes these in at build time.
│       └── protocol/         CC BY 4.0, licensed separately from the implementation
│                             compatibility.md (new 2026-09-03) is the version-negotiation contract
├── conformance/              language-neutral fixture corpus for SDK ports, plus its runner
│   ├── fixtures/             36 scripted JSON exchanges. no deps on this workspace.
│   ├── validate.mjs          zero-dep fixture linter, `pnpm conformance:validate`
│   ├── run-reference.mjs     `pnpm conformance:run` (TS host) / `conformance:run:rust`; takes --host, --unsupported,
│   │                         always passes --fixtures so the live corpus runs, never the copy in runner/dist
│   └── runner/               @tesseron/conformance 1.2.x, bin tesseron-conformance, depends on ws only
├── plugin/                   the Claude Code plugin (also accepted by Codex)
│   ├── skills/
│   ├── .mcp.json             npx -y @tesseron/{mcp,docs-mcp}@<version>
│   └── .claude-plugin/plugin.json
├── .claude-plugin/           Claude Code marketplace listing
├── .agents/plugins/          Codex marketplace listing, same plugin source
├── scripts/                  sync-plugin-version.mjs (8 version surfaces), check-docs-changeset.mjs,
│                             sync-labels.mjs (pushes .github/labels.json to GitHub)
├── .changeset/               config.json holds the 8-package fixed group (docs-mcp is out)
├── .github/workflows/        ci.yml, docs.yml, release.yml, label-by-area.yml
│   └── labels.json           the `area: *` label set the issue templates and label workflow use
├── AGENTS.md                 the real conventions. CLAUDE.md just @-includes it.
├── turbo.json  biome.json  tsconfig.base.json  pnpm-workspace.yaml
└── .claude/                  this map, live rules, the docs-index hook, project skills
```

## Organizing principle

By **published artifact**, not by layer or feature. Each package directory (`sdks/typescript/*`,
`gateway/`, `docs-mcp/`) is one npm package
with its own `package.json`, `tsup.config.ts`, `tsconfig.json`, and `test/` dir.

The dependency shape is a fan, not a chain:

```
                    @tesseron/core
                    ┌─────┴─────────────────┬──────────┐
              @tesseron/web          @tesseron/server   @tesseron/mcp
              ┌─────┼─────┐                             (+ docs-mcp,
           react  svelte  vue          @tesseron/vite    independent)
```

`web` sits between core and the three framework adapters because `reactive-core.ts` lives there.
`server` and `vite` depend on core directly and never on `web`.

## Things that are not where you would guess

- Error **codes** are in `sdks/typescript/core/src/protocol.ts:60`, not `errors.ts`.
- `TransportClosedError` is in `transport.ts:50`, not `errors.ts`.
- `transport-spec.ts` is addressing and the on-disk manifest shape, **not** a conformance suite
  despite the name. The conformance corpus is the root-level `conformance/`, which is deliberately
  outside every `pnpm-workspace.yaml` glob so another language's repo can vendor it.
- Runtime state lives outside the repo in `~/.tesseron/`: `instances/` (discovery manifests),
  `tabs/` (v1 compat), `claims/` (cross-gateway breadcrumbs).
- `sdks/typescript/vite/tsconfig.json` is the only one that does not extend `tsconfig.base.json`.
- `sdks/typescript/examples/` is in the pnpm workspace but **excluded from Biome** (`biome.json:8`), so example code
  is neither linted nor formatted.
- `sdks/rust/` must never reference a path above its own prefix; it is lifted into its own repo
  at the split milestone. `conformance/` may reference `sdks/`, the reverse is forbidden.
- `packages/` and `examples/` may still exist on disk in an old checkout. They are untracked
  leftovers (`node_modules/`, `.turbo/`) from before the move; git holds nothing there. Delete them.
