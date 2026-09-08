# Entry points

*Last Updated: 2026-09-08*

## Binaries

| Binary | Package | Source | Published |
|---|---|---|---|
| `tesseron-mcp` | `@tesseron/mcp` | `gateway/src/cli.ts` | `dist/tesseron-mcp.cjs` |
| `tesseron-docs-mcp` | `@tesseron/docs-mcp` | `docs-mcp/src/cli.ts` | `dist/tesseron-docs-mcp.cjs` |
| `tesseron-conformance` | `@tesseron/conformance` | `conformance/runner/src/bin.ts` | `dist/tesseron-conformance.cjs` |

The conformance hosts the runner drives are not in this repo any more: TypeScript
(`tesseron-typescript/conformance-host/src/bin.ts`), Rust (`tesseron-rust/conformance-host/src/main.rs`),
Python (`tesseron-python/conformance_host/__main__.py`), and C++
(`tesseron-cpp/conformance-host/main.cpp`) each run the published runner in their own CI.

The two hub binaries declare `bin` at the raw `src/cli.ts` for repo use and swap to the bundled CJS via
`publishConfig` (`gateway/package.json:40` vs `:76`).

`tesseron-mcp` takes **no flags** — it is configured by `TESSERON_TOOL_SURFACE` and
`TESSERON_RESUME_TTL_MS` only (`--help` just starts the stdio bridge). `tesseron-docs-mcp` takes
`--snapshot <path>`.

## Library entry points

`@tesseron/core` has **five**, declared at `tesseron-typescript/core/package.json:34-60` and built at
`tsup.config.ts:4-10`:

| Specifier | File | For |
|---|---|---|
| `@tesseron/core` | `src/index.ts` | the public SDK surface |
| `@tesseron/core/protocol` | `src/protocol.ts` | wire types |
| `@tesseron/core/errors` | `src/errors.ts` | error classes |
| `@tesseron/core/internal` | `src/internal.ts` | **un-versioned**, sibling packages only |
| `@tesseron/core/node` | `src/node.ts` | Node-only mint + fs helpers |

The gateway imports `@tesseron/core` and `@tesseron/core/internal` from the registry
(`gateway/package.json:51`); `gateway/src/index.ts` re-exports all of core plus the gateway types.

## Where an app starts

The canonical shape, at module scope of the entry file:

```ts
tesseron.app({ id: 'my_app', name: 'My App' });
tesseron.action('do_thing').describe('…').input(schema).handler(async (input, ctx) => { … });
tesseron.resource('some_state').describe('…').read(() => state);
await tesseron.connect();
```

`tesseron` is a **singleton exported per consumer package**, not from core. Core only ships the
`TesseronClient` class. Pick by environment:

| Environment | Import | Notes |
|---|---|---|
| Browser, Vite dev | `@tesseron/web` + the `@tesseron/vite` plugin | plugin serves `/@tesseron/ws` |
| React | `@tesseron/react` | re-exports all of `web` |
| Svelte / Vue | `@tesseron/svelte` / `@tesseron/vue` | same three primitives |
| Node | `@tesseron/server` | binds a WS or UDS listener |

Real examples live in `tesseron-typescript/examples/` (`vanilla-todo/src/main.ts`, `react-todo/src/app.tsx`,
`node-prompts/src/prompt-lab.ts`); the docs pages under `docs/src/content/docs/examples/` link them.

## Where execution begins internally

| Path | Begins at |
|---|---|
| Agent invokes a tool | `gateway/src/mcp-bridge.ts:376` (`CallTool`) |
| Gateway discovers an app | `gateway/src/gateway.ts:471` (`watchInstances`) |
| Gateway dials an app | `gateway/src/dialer.ts:67` / `:162` |
| App receives an invocation | `tesseron-typescript/core/src/client.ts:546` (`handleInvoke`) |
| App connects | `tesseron-typescript/core/src/client.ts:257` → `:356` (`doConnect`) |
| Browser tab attaches in dev | `tesseron-typescript/vite/src/index.ts:500` (`upgrade` hook) |
| Node app binds | `tesseron-typescript/server/src/transport.ts:142` / `uds-transport.ts:112` |

## Scripts

Root (`package.json:17-30`): `build`, `test`, `typecheck` go through turbo. **`lint` does not** —
it is `biome check .` directly. `gate` (`:22`) chains typecheck, test, lint, `sync-plugin-version
--check`, `conformance:validate`, and `check-docs-changeset`: the one local CI floor. Plus `format`,
`sync-labels`, `version-packages`, `docs:dev`, `docs:build`. The old `conformance:run*`,
`example:*:e2e`, and `split:sdk` scripts left with the SDK trees; run `node conformance/run-reference.mjs
--host <command>` by hand when you need the corpus against a locally built host.
