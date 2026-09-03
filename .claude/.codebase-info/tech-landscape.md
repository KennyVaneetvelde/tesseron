# Tech landscape

*Last Updated: 2026-09-03*

| Concern | Choice | Source of truth |
|---|---|---|
| Language | TypeScript 5.7, ES2022 target | `tsconfig.base.json:3` |
| Runtime | Node >= 20 | `package.json:12` |
| Package manager | **pnpm 9.15.4**, workspace | `package.json:14`, `pnpm-workspace.yaml` |
| Task runner | turbo 2.3 | `turbo.json` |
| Bundler | tsup 8.5, ESM+CJS, `dts: true` | per-package `tsup.config.ts` |
| Lint **and** format | **Biome 1.9.4** | `biome.json` |
| Tests | **Vitest 2.x** | per-package `test: "vitest run"` |
| Release | Changesets | `.changeset/config.json` |
| Docs site | Astro + Starlight | `docs/astro.config.mjs` |
| Validation | Standard Schema (peer contract) | `@standard-schema/spec` |
| License | BUSL-1.1 | `package.json:7` |

There is **no ESLint and no Prettier** in this repo. Do not add either. `pnpm lint` is Biome.

## Workspace

`pnpm-workspace.yaml` lists `sdks/typescript/*`, `sdks/typescript/examples/*`, `gateway`,
`docs-mcp`, `conformance/runner`, and `docs`. Cross-package resolution is pure pnpm linking — **there are no TypeScript path aliases anywhere**.

`conformance/fixtures/` stays outside the workspace on purpose: it is a JSON corpus meant to be
vendored by other languages' SDK repos. Only `conformance/runner/` (the `@tesseron/conformance`
CLI, being built under SQ-13) is a workspace package, and it depends on `ws` alone, never on
`@tesseron/core`.

## TypeScript strictness

`tsconfig.base.json` sets `strict: true` plus four beyond-strict flags: `noUncheckedIndexedAccess`
`:8`, `noImplicitOverride` `:9`, `noPropertyAccessFromIndexSignature` `:10`,
`noFallthroughCasesInSwitch` `:11`. Also `verbatimModuleSyntax: true` `:16`, which is why every
import is split into `import type {…}` and `import {…}`.

Per-package tsconfigs only `extends` the base and set `include: ["src"]`. **That means test
directories are not typechecked** by `tsc --noEmit`. `sdks/typescript/vite/tsconfig.json` is the sole
exception: it does not extend the base and hand-rolls `module: NodeNext`, dropping every extra
strictness flag.

## Dependencies that matter

Runtime dependencies are deliberately thin:

- `@tesseron/core` — `@standard-schema/spec` only.
- `@tesseron/server`, `@tesseron/vite` — `ws`.
- `@tesseron/mcp` — `@modelcontextprotocol/sdk`, plus core.
- `@tesseron/docs-mcp` — `@modelcontextprotocol/sdk`, `minisearch` ^7.1, `gray-matter`, `zod`.
- `@tesseron/web` — core only, **no peer dependencies**.

Framework packages carry peers, not deps: `react >=18`, `svelte >=4.0.0`, `vue >=3.0.0`,
`vite >=4.0.0`, each alongside `@standard-schema/spec ^1.0.0`.

Sibling packages always use `workspace:*`.

## CI

Four workflows in `.github/workflows/`:

- **`ci.yml`** — PR and push to main, cancels in-flight PR runs. One job: pnpm 9.15.4 + Node 20,
  `pnpm install --frozen-lockfile`, then `pnpm typecheck` → `pnpm test` → `pnpm lint` →
  `pnpm sync-plugin-version --check` → `pnpm conformance:validate` → `pnpm check-docs-changeset`
  (`:29-56`). The conformance step lints the fixture corpus that out-of-repo SDK ports consume; see
  [testing.md](testing.md). The last step (`scripts/check-docs-changeset.mjs`) fails a PR that edits
  `docs/src/content/docs/` without a changeset naming `@tesseron/docs-mcp`, since the docs server
  ships that prose.
- **`label-by-area.yml`** — on issue open, reads the `### Area` field the two issue templates
  collect and applies the matching `area: *` label from `.github/labels.json`.
  `pnpm sync-labels` pushes that file to GitHub.
- **`docs.yml`** — push to main, manual, plus a weekly cron `0 6 * * 1`. Builds Starlight, deploys to
  GitHub Pages.
- **`release.yml`** — push to main and manual. Upgrades to **`npm@^11.5.1`** because Node 20's npm 10
  cannot do trusted-publish OIDC (`:38`), builds `@tesseron/*` excluding docs, re-runs typecheck and
  test, then `changesets/action@v1`. The pin is deliberate: this step said `npm@latest` until
  2026-08-21, and once npm 12 dropped Node 20 (`engines: ^22.22.2 || ^24.15.0 || >=26.0.0`) every
  release died at EBADENGINE. It failed silently from 2026-06-10 because nothing tried to release. Publishes via **npm trusted publishing / OIDC** —
  `NODE_AUTH_TOKEN` is deliberately unset and `NPM_CONFIG_PROVENANCE: "true"` (`:68`).
