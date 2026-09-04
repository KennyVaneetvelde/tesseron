# Testing and verification

*Last Updated: 2026-09-04*

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
`e2e-issue-69.mjs`. `sdks/typescript/examples/node-prompts` carries `validate:e2e`, and
`sdks/rust/examples/validate-e2e.mjs` (`pnpm example:rust:e2e`) builds the two Rust examples, starts
the gateway from `gateway/src/cli.ts`, claims with the printed code, and asserts 15 invariants
(canonical action sets and schemas, one progress per imported item, resource read, a subscription
update on delete, `not_found`, the sampling and confirm responders).

## The conformance corpus is not part of `pnpm test`

`conformance/fixtures/` holds 37 scripted JSON exchanges (6 actions, 9 bind, 13 elicitation, 4 handshake,
3 resources, 1 resume, 1 uds) that pin protocol behavior for **other languages'** SDK ports. Plain JSON, no Vitest, no dependency on this workspace, deliberately outside
every `pnpm-workspace.yaml` glob so a port can vendor the directory.

`pnpm conformance:validate` (`conformance/validate.mjs`, zero deps, wired into `ci.yml`) only lints
the fixtures: id matches path, spec anchor present, matcher vocabulary valid, no `~ref` before its
`~capture`. **It never opens a socket and never exercises any SDK.** A green run means the
corpus is well-formed, not that anything conforms.

`pnpm conformance:run` (`conformance/run-reference.mjs`) is the executable half: it launches the
`@tesseron/conformance` runner (`conformance/runner/`, 7 unit tests for the matcher and step
engine against an in-process fake host) with `--host` pointing at the private TypeScript reference
host (`sdks/typescript/conformance-host/`, built on `@tesseron/server`). Per fixture the runner
spawns the host with `TESSERON_CONFORMANCE_FIXTURE`, reads the `tesseron-conformance-url=` line,
dials, walks the steps, and prints PASS/FAIL/SKIP per fixture; exit 1 on any failure, 2 on a
runner error. Fixtures whose `requires` the host lacks (declared via
`TESSERON_CONFORMANCE_UNSUPPORTED`) are skipped. On Windows the six `uds` fixtures skip because
`run-reference.mjs` declares `uds` unsupported there; CI on Linux is the zero-skip check.

The Rust host runs the same corpus: `pnpm conformance:run:rust`, which is `run-reference.mjs --host
"sdks/rust/target/debug/tesseron-conformance-host" --unsupported host-minted-claim` (the script
takes `--host` and `--unsupported` since SQ-16; with no arguments it drives the TS host). Expected
on Windows: TS host 31 passed / 6 skipped, Rust host 27 passed / 10 skipped (9 `bind/*` plus
`uds/file-mode`), 0 failed; on Linux only the 9 `bind/*` skip for Rust and nothing for TS.

The Python host is the third: `pnpm conformance:run:python` runs
`uv run --locked --directory sdks/python python -m conformance_host` with
`--unsupported host-minted-claim,uds`, so it skips the same 10 on every platform (WS-only by
design). Its own suite is `uv run --locked pytest` (98 tests), `mypy --strict src conformance_host
tests`, and `ruff check .`, all from `sdks/python/`. A fixture added after a port's last run is the
usual way a host goes red: rerun every host at HEAD after any corpus change.

Trap: `conformance/runner/scripts/copy-fixtures.mjs` copies the corpus into `runner/dist/fixtures`
at build time (that copy is what `npx @tesseron/conformance` ships), and turbo does not list
`../fixtures` as a build input, so a cached build keeps an old copy. `run-reference.mjs` therefore
passes `--fixtures conformance/fixtures` on every hub run; a bare `tesseron-conformance` invocation
after a fixture-only change reads the stale copy until the runner is rebuilt. A `--host` that is only a path is resolved to its absolute native form
(`conformance/runner/src/runner.ts` `resolveHostCommand`, 7 tests in `test/host-command.test.ts`),
because cmd.exe otherwise splits a relative forward-slash path at the first slash. Every `bind/*`
fixture requires `host-minted-claim`, which the Rust SDK skips by design (gateway-minted claims
only). Both
packages must be built first (`pnpm -r --filter "@tesseron/*" --filter "!@tesseron/docs" build`). The format and runner
contract are in `conformance/README.md`.

## The command to run

```bash
pnpm typecheck && pnpm test        # what CI gates on, minus lint
pnpm lint                          # biome check . at the root, not via turbo
pnpm sync-plugin-version --check   # CI runs this too; see release-and-plugin.md
pnpm conformance:validate          # lints conformance/fixtures/, does not run them
pnpm conformance:run               # runs them against the TS reference host (build first)
cargo test --manifest-path sdks/rust/Cargo.toml --workspace   # Rust: 44 unit + 25 integration + 3 host + 1 doctest
cd sdks/python && uv run --locked pytest -q                   # Python: 98 tests; mypy --strict and ruff check alongside
pnpm conformance:run:python        # the Python host against the corpus (needs uv on PATH)
pnpm conformance:run:rust          # the corpus against the Rust host
```
