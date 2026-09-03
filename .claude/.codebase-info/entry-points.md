# Entry points

*Last Updated: 2026-09-03*

## Binaries

| Binary | Package | Source | Published |
|---|---|---|---|
| `tesseron-mcp` | `@tesseron/mcp` | `gateway/src/cli.ts` | `dist/tesseron-mcp.cjs` |
| `tesseron-docs-mcp` | `@tesseron/docs-mcp` | `docs-mcp/src/cli.ts` | `dist/tesseron-docs-mcp.cjs` |

Both declare `bin` at the raw `src/cli.ts` for repo use and swap to the bundled CJS via
`publishConfig` (`gateway/package.json:40` vs `:76`).

`tesseron-mcp` takes **no flags** — it is configured by `TESSERON_TOOL_SURFACE` and
`TESSERON_RESUME_TTL_MS` only. `tesseron-docs-mcp` takes `--snapshot <path>`.

## Library entry points

`@tesseron/core` has **five**, declared at `sdks/typescript/core/package.json:34-60` and built at
`tsup.config.ts:4-10`:

| Specifier | File | For |
|---|---|---|
| `@tesseron/core` | `src/index.ts` | the public SDK surface |
| `@tesseron/core/protocol` | `src/protocol.ts` | wire types |
| `@tesseron/core/errors` | `src/errors.ts` | error classes |
| `@tesseron/core/internal` | `src/internal.ts` | **un-versioned**, sibling packages only |
| `@tesseron/core/node` | `src/node.ts` | Node-only mint + fs helpers |

Every consumer package has a single `src/index.ts`. `@tesseron/vite` is the exception with **no
`exports` field at all** — only `main`/`module`/`types`.

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

Real examples: `sdks/typescript/examples/vanilla-todo/src/main.ts:46` (app) and `:425` (top-level await connect);
`sdks/typescript/examples/react-todo/src/app.tsx:31`; `sdks/typescript/examples/node-prompts/src/prompt-lab.ts`.

## Where execution begins internally

| Path | Begins at |
|---|---|
| Agent invokes a tool | `gateway/src/mcp-bridge.ts:376` (`CallTool`) |
| Gateway discovers an app | `gateway/src/gateway.ts:471` (`watchInstances`) |
| Gateway dials an app | `gateway/src/dialer.ts:67` / `:162` |
| App receives an invocation | `sdks/typescript/core/src/client.ts:546` (`handleInvoke`) |
| App connects | `sdks/typescript/core/src/client.ts:257` → `:356` (`doConnect`) |
| Browser tab attaches in dev | `sdks/typescript/vite/src/index.ts:500` (`upgrade` hook) |
| Node app binds | `sdks/typescript/server/src/transport.ts:142` / `uds-transport.ts:112` |

## Scripts

Root (`package.json:18-26`): `build`, `test`, `typecheck` all go through turbo. **`lint` does not** —
it is `biome check .` directly. Plus `format`, `sync-plugin-version`, `version-packages`, `docs:dev`,
`docs:build`.
