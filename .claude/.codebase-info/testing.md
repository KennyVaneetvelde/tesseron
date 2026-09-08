# Testing and verification

*Last Updated: 2026-09-08*

Vitest 2.x everywhere. Every `test` script is literally `vitest run`. No Jest, no `node:test`.

## What `pnpm test` actually covers

`pnpm test` → `turbo run test` over the three hub packages (152 tests, 5 skipped on Windows):

| Package | Files | Tests | Location |
|---|---|---|---|
| mcp | 13 | 112 + 5 UDS skips on Windows | `gateway/test/` |
| docs-mcp | 3 | 21 | `docs-mcp/test/` |
| conformance | 4 | 19 | `conformance/runner/test/` |

The SDK suites (core, web, react, vite, and the Rust, Python, and C++ ones) run in their own repos
now. A green hub `pnpm test` says nothing about them; the gateway tests exercise the published
`@tesseron/server` 2.10.2 from `node_modules`, not SDK source.

Per-package tsconfigs use `include: ["src"]`, so **test files are not typechecked**.

## Config

`docs-mcp/vitest.config.ts` (node, 15 s timeout, `include: ['test/**/*.test.ts']`) is the only
config; `mcp` and `conformance` use Vitest's default include glob. `globals: false` everywhere, so
tests import `describe`/`it`/`expect` explicitly.

Tests always live in a `test/` dir at the package root. Never co-located, never `__tests__`.

## What the good suites actually assert

`gateway/test/setup.ts` is the shared harness: a per-suite sandbox `$HOME`, SDK binds a port,
gateway dials in.

Worth reading before changing the corresponding area:

- `gateway/test/integration.test.ts` (1408 lines) — the full resume matrix (issue, rotate, bad
  token, unknown id, cross-app reject), app-id validation, all four meta tools, tool-surface modes,
  pending-claim recovery (tesseron#69).
- `gateway/test/phase3.test.ts` (750 lines) — progress monotonicity, cancellation, sampling,
  elicitation, `ctx.confirm`, signal-aborted elicit, resource subscribe.
- `gateway/test/dead-session-tiebreak.test.ts` — the tesseron#92 liveness filter.
- `gateway/test/session-tokens.test.ts` — scans source text for `Math.random` (the SDK twin is
  `tesseron-typescript/core/test/claim-mint.test.ts:19`).
- `conformance/runner/test/run-reference.test.ts` — the launcher: rejects a missing or blank
  `--host` with exit 2, forwards host, live fixtures, options, and unsupported tags, and passes the
  runner's exit status through.

Two manual e2e scripts are not part of the suite: `gateway/scripts/e2e-browser-claim.mjs` and
`e2e-issue-69.mjs`. The example e2e drivers (`examples/validate-e2e.mjs` in each SDK repo, 15 PASS
lines through the real gateway) run in the SDK repos.

## The conformance corpus is not part of `pnpm test`

`conformance/fixtures/` holds 39 scripted JSON exchanges (6 actions, 9 bind, 13 elicitation, 6 handshake,
3 resources, 1 resume, 1 uds) that pin protocol behavior for every SDK. Plain JSON, no Vitest, no
dependency on this workspace, deliberately outside every `pnpm-workspace.yaml` glob so a repo can
vendor the directory.

`pnpm conformance:validate` (`conformance/validate.mjs`, zero deps, wired into `ci.yml:51`) only lints
the fixtures: id matches path, spec anchor present, matcher vocabulary valid, no `~ref` before its
`~capture`. **It never opens a socket and never exercises any SDK.** A green run means the
corpus is well-formed, not that anything conforms.

`node conformance/run-reference.mjs --host "<command>" [--unsupported tag,tag]` is the executable
half: it launches the `@tesseron/conformance` runner (`conformance/runner/`, matcher and step engine
tested against an in-process fake host) with `--host` pointing at a conformance host you built
yourself, always with `--fixtures conformance/fixtures` so the live corpus runs. `--host` is
required (`:22-27`, exit 2); there is no default host in the hub since SQ-52. Per fixture the runner
spawns the host with `TESSERON_CONFORMANCE_FIXTURE`, reads the `tesseron-conformance-url=` line,
dials, walks the steps, and prints PASS/FAIL/SKIP per fixture; exit 1 on any failure, 2 on a
runner error. Fixtures whose `requires` the host lacks (declared via `--unsupported` or
`TESSERON_CONFORMANCE_UNSUPPORTED`) are skipped, and `uds` is added on Windows automatically (`:19`).

Where the hosts run now:

| Host | Repo and command | Expected |
|---|---|---|
| TypeScript | `tesseron-typescript` CI: `npx @tesseron/conformance@1.2.1 --host` its private `conformance-host` | 39 passed on Linux; 33 / 6 `uds` skips on Windows |
| Rust | `tesseron-rust` CI, `TESSERON_CONFORMANCE_UNSUPPORTED=host-minted-claim,uds` | 29 passed / 10 skipped |
| Python | `tesseron-python` CI, same tags | 29 / 10 |
| C++ | `tesseron-cpp` CI, same tags | 29 / 10 |

The three ports are WS-only and gateway-minted-claim-only by design, so the nine `bind/*` fixtures
(all require `host-minted-claim`) and `uds/file-mode` skip everywhere. A fixture added here reaches
the SDK repos only through a `@tesseron/conformance` release (next paragraph), and a host that has
not caught up is the usual way one goes red.

A `send` step may carry `raw: true` to write a deliberately malformed envelope verbatim (no
`jsonrpc` member, say); `validate.mjs` and the runner otherwise refuse a send without
`jsonrpc: "2.0"`. `conformance/README.md` documents the step DSL and the runner contract.

Trap: `conformance/runner/scripts/copy-fixtures.mjs` copies the corpus into `runner/dist/fixtures`
at build time (that copy is what `npx @tesseron/conformance` ships), and turbo does not list
`../fixtures` as a build input, so a cached build keeps an old copy. `run-reference.mjs` therefore
passes `--fixtures conformance/fixtures` on every hub run; the SDK repos see a fixture change only
after a `@tesseron/conformance` release. A `--host` that is only a path is resolved to its absolute
native form (`conformance/runner/src/runner.ts` `resolveHostCommand`, 7 tests in
`test/host-command.test.ts`), because cmd.exe otherwise splits a relative forward-slash path at the
first slash. Build the runner first (`pnpm -r --filter "@tesseron/*" --filter "!@tesseron/docs" build`).

## The command to run

```bash
pnpm gate                          # typecheck, test, lint, plugin sync check, fixture lint, docs-changeset check: the CI floor
pnpm typecheck && pnpm test        # the two slow halves on their own
pnpm lint                          # biome check . at the root, not via turbo
pnpm conformance:validate          # lints conformance/fixtures/, does not run them
node conformance/run-reference.mjs --host "<built host command>" --unsupported host-minted-claim,uds
```
