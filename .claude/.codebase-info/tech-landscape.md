# Tech landscape

*Last Updated: 2026-09-08*

| Concern | Choice | Source of truth |
|---|---|---|
| Language | TypeScript 5.7, ES2022 target | `tsconfig.base.json:3` |
| Runtime | Node >= 20 | `package.json:12` |
| Package manager | **pnpm 9.15.4**, workspace | `package.json:14`, `pnpm-workspace.yaml` |
| Task runner | turbo 2.3 | `turbo.json` |
| Bundler | tsup 8.5, ESM+CJS, `dts: true` | per-package `tsup.config.ts` |
| Lint **and** format | **Biome 1.9.4** | `biome.json` |
| Tests | **Vitest 2.x** | per-package `test: "vitest run"` |
| Release | Changesets, `fixed: []` | `.changeset/config.json` |
| Docs site | Astro + Starlight | `docs/astro.config.mjs` |
| Validation | Standard Schema (peer contract) | `@standard-schema/spec` |
| License | BUSL-1.1; `gateway/`, `docs-mcp/`, and `plugin/` ship a copy of the root `LICENSE` | `package.json:7`, `LICENSE` |

The SDK toolchains (cargo, uv, CMake) left with the SDKs. Each repo's own `CONTRIBUTING.md` and
`.github/workflows/ci.yml` state them: `tesseron-rust` (edition 2024, MSRV 1.85, tokio + tungstenite,
`unwrap_used` denied), `tesseron-python` (>= 3.11, pydantic 2 + websockets, uv, ruff, mypy --strict),
`tesseron-cpp` (CMake >= 3.24, C++20, Boost.Asio/Beast + nlohmann/json + Catch2 via FetchContent at
pinned hashes).

There is **no ESLint and no Prettier** in this repo. Do not add either. `pnpm lint` is Biome.

## Workspace

`pnpm-workspace.yaml` lists `gateway`, `docs-mcp`, `conformance/runner`, and `docs`. Cross-package
resolution is pure pnpm linking — **there are no TypeScript path aliases anywhere** — but no hub
package depends on another hub package any more, so nothing is linked in practice.

`conformance/fixtures/` stays outside the workspace on purpose: it is a JSON corpus meant to be
vendored or `npx`-run by the SDK repos. `conformance/runner/` (the `@tesseron/conformance` CLI)
depends on `ws` alone, never on `@tesseron/core`, so an SDK repo's CI can `npx @tesseron/conformance`
with nothing else from this repo installed. Its version (1.2.1) tracks the protocol version and moves
through its own changesets.

## TypeScript strictness

`tsconfig.base.json` sets `strict: true` plus four beyond-strict flags: `noUncheckedIndexedAccess`
`:8`, `noImplicitOverride` `:9`, `noPropertyAccessFromIndexSignature` `:10`,
`noFallthroughCasesInSwitch` `:11`. Also `verbatimModuleSyntax: true` `:16`, which is why every
import is split into `import type {…}` and `import {…}`.

Per-package tsconfigs only `extends` the base and set `include: ["src"]`. **That means test
directories are not typechecked** by `tsc --noEmit`.

## Dependencies that matter

Runtime dependencies are deliberately thin:

- `@tesseron/mcp` — `@modelcontextprotocol/sdk`, `ws`, and **`@tesseron/core ^2.10.2` from npm**
  (`gateway/package.json:51`). `@tesseron/server ^2.10.2` is a devDependency for the tests (`:56`).
- `@tesseron/docs-mcp` — `@modelcontextprotocol/sdk`, `minisearch` ^7.1, `gray-matter`, `zod`.
- `@tesseron/conformance` — `ws`.

The registry dependency is the seam between the two repos: a gateway feature that needs a core
change waits for a `tesseron-typescript` release, then bumps the caret here. `pnpm install
--frozen-lockfile` pulls core and server from the shared pnpm store, not from source.

## CI

Four workflows in `.github/workflows/`:

- **`ci.yml`** — PR and push to main, cancels in-flight PR runs. One job, `test` (`:13`): pnpm
  9.15.4 + Node 20, `pnpm install --frozen-lockfile`, then `pnpm typecheck` → `pnpm test` →
  `pnpm lint` → `pnpm sync-plugin-version --check` → `pnpm conformance:validate` → build the hub
  packages → `pnpm check-docs-changeset` (`:29-59`). No conformance *run* happens here any more; the
  SDK repos run the published runner against their hosts. The last step
  (`scripts/check-docs-changeset.mjs`) fails a PR that edits `docs/src/content/docs/` without a
  changeset naming `@tesseron/docs-mcp`, since the docs server ships that prose. `pnpm gate` at the
  root is the same sequence minus the build.
- **`label-by-area.yml`** — on issue open, reads the `### Area` field the two issue templates
  collect and applies the matching `area: *` label from `.github/labels.json` (`area: sdk-<language>`
  labels route SDK issues, which the SDK repos' issue templates point back here).
  `pnpm sync-labels` pushes that file to GitHub.
- **`docs.yml`** — push to main, manual, plus a weekly cron `0 6 * * 1`. Builds Starlight, deploys to
  GitHub Pages.
- **`release.yml`** — push to main and manual. Upgrades to **`npm@^11.5.1`** because Node 20's npm 10
  cannot do trusted-publish OIDC (`:49`), builds the hub packages, re-runs typecheck and test, then
  `changesets/action@v1`. The pin is deliberate: this step said `npm@latest` until 2026-08-21, and
  once npm 12 dropped Node 20 (`engines: ^22.22.2 || ^24.15.0 || >=26.0.0`) every release died at
  EBADENGINE. It failed silently from 2026-06-10 because nothing tried to release. Publishes via
  **npm trusted publishing / OIDC** — `NODE_AUTH_TOKEN` is deliberately unset and
  `NPM_CONFIG_PROVENANCE: "true"` (`:81`). The seven `@tesseron/*` SDK packages publish from
  `tesseron-typescript`'s own release workflow, not from here.
