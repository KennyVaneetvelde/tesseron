# Onboarding

*Last Updated: 2026-09-03*

## Setup

```bash
pnpm install --frozen-lockfile
pnpm build          # needed before docs-mcp works: dist/ is gitignored
```

Use **pnpm 9.15.4**. Not npm, not yarn.

## The loop

```bash
pnpm typecheck && pnpm test    # before calling any non-trivial change done
pnpm lint                      # biome check . at the root
pnpm format                    # biome format --write .
```

CI runs exactly `pnpm typecheck` → `pnpm test` → `pnpm lint` →
`pnpm sync-plugin-version --check` (`.github/workflows/ci.yml:30-44`).

Remember `pnpm test` skips `server`, `svelte`, and `vue` entirely. See [testing.md](testing.md).

## Run something

```bash
pnpm --filter vanilla-todo dev     # port 5173, no framework
pnpm --filter react-todo dev       # port 5174, the only hooks example
pnpm --filter svelte-todo dev      # 5175
pnpm --filter vue-todo dev         # 5176
pnpm --filter node-prompts dev     # headless, sampling + elicitation
pnpm docs:dev                      # the Starlight site
```

Then point an agent at the gateway: `npx -y @tesseron/mcp@2.10.1` (or run
`gateway/src/cli.ts` directly). It will discover the running app through
`~/.tesseron/instances/` and you claim it with the code the app displays.

## Common tasks

**Add or change an action/resource API.** Touch `sdks/typescript/core/src/builder.ts` (types) and
`builder-impl.ts` (runtime) together. Add a test in `sdks/typescript/core/test/builder.test.ts`. This is
public surface, so update `docs/src/content/docs/` in the same change.

**Change the wire protocol.** `sdks/typescript/core/src/protocol.ts` is the source of truth. Bump
`PROTOCOL_VERSION` (`:11`) and check the gateway's major/minor validation
(`gateway/src/gateway.ts:1394`). Both `gateway/test/integration.test.ts` and
`protocol-version.test.ts` will tell you what you broke.

**Add a framework adapter.** Put the logic in `sdks/typescript/web/src/reactive-core.ts` and keep the
adapter to lifecycle binding only, around 120 lines. Copy the shape of
`sdks/typescript/vue/src/index.ts`.

**Touch anything under `plugin/`.** The version lives in eight places and
`scripts/sync-plugin-version.mjs` owns all of them. Run `pnpm sync-plugin-version`. See
[release-and-plugin.md](release-and-plugin.md).

**Ship a change.** `pnpm changeset`. The eight SDK packages bump together; a `@tesseron/docs-mcp`
changeset bumps only that one. Never hand-edit a version field.

## Traps that cost people time

- The gateway **dials out**; your app listens. Not the other way round.
- There is **no `tesseron/welcome` message**. Welcome is the result of `tesseron/hello`.
- Error codes are in `protocol.ts`, not `errors.ts`. There is no `ResumeFailedError` class.
- `gateway/README.md:98` documents three env vars that no longer exist.
- `ResourceBuilder.read()` and `.subscribe()` **each commit**; chaining both registers twice.
- Valibot and Zod ≤3 get **no** JSON Schema auto-derivation. Pass it explicitly.
- A docs edit does **not** invalidate `@tesseron/docs-mcp`'s turbo cache.
- A stale `packages/` or `examples/` directory on disk is untracked leftovers. Delete it.
- `sdks/typescript/examples/` is not linted or formatted by Biome.
