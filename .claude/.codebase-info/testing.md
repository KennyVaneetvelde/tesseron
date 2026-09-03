# Testing and verification

*Last Updated: 2026-09-03*

Vitest 2.x everywhere. Every `test` script is literally `vitest run`. No Jest, no `node:test`.

## What `pnpm test` actually covers

`pnpm test` → `turbo run test`, and **only six packages define a `test` script**:

| Package | Tests | Location |
|---|---|---|
| core | 8 files | `sdks/typescript/core/test/` |
| mcp | 11 files | `gateway/test/` |
| docs-mcp | 3 files | `docs-mcp/test/` |
| vite | 3 files | `sdks/typescript/vite/test/` |
| web | 1 file | `sdks/typescript/web/test/` |
| react | 1 file | `sdks/typescript/react/test/` |

**`@tesseron/server`, `@tesseron/svelte`, and `@tesseron/vue` have no `test` script at all.** A green
`pnpm test` says nothing about them. Worth knowing before you trust a passing suite on a change that
touches those three.

Known coverage gaps beyond that:

- `sdks/typescript/react/test/` covers **only `useTesseronConnection`**. `useTesseronAction` and
  `useTesseronResource` are untested.
- The Svelte and Vue registration primitives (`tesseronAction`, `tesseronResource`) have **zero
  example coverage too** — `sdks/typescript/examples/svelte-todo` and `sdks/typescript/examples/vue-todo` reach past them to the raw
  core builder (`sdks/typescript/examples/svelte-todo/src/app.svelte:57`, `sdks/typescript/examples/vue-todo/src/app.vue:53`). Only
  `tesseronConnection` is exercised.
- Per-package tsconfigs use `include: ["src"]`, so **test files are not typechecked**.

## Config

Only three `vitest.config.ts` files exist: `sdks/typescript/web` (jsdom), `sdks/typescript/react`
(jsdom), and `docs-mcp` (node, 15 s timeout, `include: ['test/**/*.test.ts']`). `core`, `mcp`, and `vite`
have no config and use Vitest's default include glob. `globals: false` everywhere, so tests import
`describe`/`it`/`expect` explicitly.

Tests always live in a `test/` dir at the package root. Never co-located, never `__tests__`.

## What the good suites actually assert

`gateway/test/setup.ts` is the shared harness: a per-suite sandbox `$HOME`, SDK binds a port,
gateway dials in.

Worth reading before changing the corresponding area:

- `sdks/typescript/core/test/client.test.ts` (736 lines) — handshake, claim code, invoke routing,
  `ActionNotFound`, send-throws-closes-transport, `-32002` on a signal-deaf handler, and four
  tesseron#88 connect re-entry regressions at `:300`, `:411`, `:515`, `:571`.
- `gateway/test/integration.test.ts` (1408 lines) — the full resume matrix (issue, rotate, bad
  token, unknown id, cross-app reject), app-id validation, all four meta tools, tool-surface modes,
  pending-claim recovery (tesseron#69).
- `gateway/test/phase3.test.ts` (750 lines) — progress monotonicity, cancellation, sampling,
  elicitation, `ctx.confirm`, signal-aborted elicit, resource subscribe.
- `gateway/test/dead-session-tiebreak.test.ts` — the tesseron#92 liveness filter.
- `sdks/typescript/web/test/auto-persist.test.ts` — every `resume` shape, URL-form dedup, transport-form
  rejection.

Two invariant tests scan source text rather than behavior: no `Math.random` in
`sdks/typescript/core/test/claim-mint.test.ts:19` and `gateway/test/session-tokens.test.ts`. A
statistical no-short-circuit timing check lives at `sdks/typescript/core/test/timing-safe.test.ts:65`.

Two manual e2e scripts are not part of the suite: `gateway/scripts/e2e-browser-claim.mjs` and
`e2e-issue-69.mjs`. `sdks/typescript/examples/node-prompts` carries `validate:e2e`.

## The conformance corpus is not part of `pnpm test`

`conformance/fixtures/` holds 12 scripted JSON exchanges that pin protocol behavior for **other
languages'** SDK ports. Plain JSON, no Vitest, no dependency on this workspace, deliberately outside
every `pnpm-workspace.yaml` glob so a port can vendor the directory.

`pnpm conformance:validate` (`conformance/validate.mjs`, zero deps, wired into `ci.yml`) only lints
the fixtures: id matches path, spec anchor present, matcher vocabulary valid, no `~ref` before its
`~capture`. **It never opens a socket and never exercises any SDK.** A green run means the
corpus is well-formed, not that anything conforms. The runner (`@tesseron/conformance` at
`conformance/runner/`, plus a private reference host at `sdks/typescript/conformance-host/`) is
being built under SQ-13 and will add `pnpm conformance:run` to CI. The format and runner
contract are in `conformance/README.md`.

## The command to run

```bash
pnpm typecheck && pnpm test        # what CI gates on, minus lint
pnpm lint                          # biome check . at the root, not via turbo
pnpm sync-plugin-version --check   # CI runs this too; see release-and-plugin.md
pnpm conformance:validate          # lints conformance/fixtures/, does not run them
```
