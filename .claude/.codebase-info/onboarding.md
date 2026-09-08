# Onboarding

*Last Updated: 2026-09-08*

## Setup

```bash
pnpm install --frozen-lockfile   # pulls @tesseron/core and @tesseron/server from npm
pnpm build                       # needed before docs-mcp works: dist/ is gitignored
```

Use **pnpm 9.15.4**. Not npm, not yarn. No cargo, uv, or CMake here any more; those belong to the
SDK repos (`AGENTS.md:41`).

## The loop

```bash
pnpm gate       # typecheck, test, lint, plugin version check, fixture lint, docs-changeset check
pnpm format     # biome format --write .
```

`pnpm gate` is the CI floor (`.github/workflows/ci.yml:29-59` runs the same steps plus a build).
Run it before calling any non-trivial change done.

## Run something

```bash
pnpm docs:dev                      # the Starlight site
node gateway/src/cli.ts            # the gateway, stdio MCP, no flags
```

An app to point it at lives in an SDK repo: `pnpm --filter vanilla-todo dev` in `tesseron-typescript`,
`cargo run -p todo` in `tesseron-rust`, `python -m examples.todo` in `tesseron-python`. Or install
the published plugin: `npx -y @tesseron/mcp@2.10.2`. The gateway discovers the running app through
`~/.tesseron/instances/` and you claim it with the code the app displays.

## Common tasks

**Change the gateway.** `gateway/src/` plus a test in `gateway/test/`; the tests dial a real
`@tesseron/server` 2.10.2 from `node_modules`. If the change needs a new core export, land it in
`tesseron-typescript` first, wait for its release, then bump `gateway/package.json:51`.

**Change the wire protocol.** The source of truth is `tesseron-typescript/core/src/protocol.ts`. Here
you update `docs/src/content/docs/protocol/` and add or adjust fixtures under `conformance/fixtures/`
(then `pnpm conformance:validate`), and release `@tesseron/conformance` so the SDK repos' CI sees
the new corpus.

**Add or change an SDK API.** Not in this repo. Open the language repo; keep the docs page under
`docs/src/content/docs/sdk/<language>/` in sync here, with a `@tesseron/docs-mcp` changeset.

**Touch anything under `plugin/`.** The version lives in eight places and
`scripts/sync-plugin-version.mjs` owns all of them. Run `pnpm sync-plugin-version`. See
[release-and-plugin.md](release-and-plugin.md).

**Ship a change.** `pnpm changeset`, one package per changeset (`fixed: []`). A docs content edit
needs a `@tesseron/docs-mcp` changeset or CI refuses it. Never hand-edit a version field.

## Traps that cost people time

- The gateway **dials out**; your app listens. Not the other way round.
- There is **no `tesseron/welcome` message**. Welcome is the result of `tesseron/hello`.
- Error codes are in `protocol.ts`, not `errors.ts`. There is no `ResumeFailedError` class.
- `gateway/README.md:98` documents three env vars that no longer exist.
- `ResourceBuilder.read()` and `.subscribe()` **each commit**; chaining both registers twice.
- Valibot and Zod ≤3 get **no** JSON Schema auto-derivation. Pass it explicitly.
- A docs edit does **not** invalidate `@tesseron/docs-mcp`'s turbo cache.
- A checkout that built the SDKs before 2026-09-08 keeps gitignored residue under `sdks/` (Rust
  `target`, C++ `build/_deps`, Python `.venv`, `node_modules`). Git tracks nothing there, but Biome
  now walks it and overflows its stack on `pnpm lint`. Delete `sdks/` (and any older `packages/` or
  `examples/` leftovers). `grep -r` over such residue hangs too; use the Grep tool, `rg`, or
  `git grep`, which honor `.gitignore`.
- `node conformance/run-reference.mjs` without `--host` exits 2. There is no default host in the hub.
