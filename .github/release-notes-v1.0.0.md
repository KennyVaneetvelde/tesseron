## Tesseron v1.0.0 — initial public release

Tesseron is a TypeScript SDK + matching MCP gateway that exposes typed web-app actions to MCP-compatible AI agents (Claude Code, Claude Desktop, Cursor, Copilot, Codex, goose, fast-agent, ...) over a local WebSocket. Your real handler runs against your real state — no browser automation, no scraping, no Playwright.

### What shipped

- **Protocol 1.0.0.** JSON-RPC 2.0 over WebSocket between app and gateway, MCP stdio between gateway and agent. Click-to-connect session handshake via a six-character claim code.
- **Action builder.** Fluent, typed, Zod or any [Standard Schema](https://standardschema.dev) validator. `ctx.confirm`, `ctx.elicit` (schema-validated), `ctx.sample`, `ctx.progress`, `ctx.log`.
- **Subscribable resources.** Live reads plus `resources.subscribe` for pushing updates to agents that advertise the capability.
- **`tesseron__read_resource` meta-tool.** Covers MCP clients that don't speak native resources yet — agents can read tagged resources without needing to know the client-side namespacing.
- **Claude Code plugin.** One-command install via the plugin marketplace; the gateway is bundled inside it, so no separate install step.
- **SDK packages** (all at 1.0.0, all on npm):
  - [`@tesseron/core`](https://www.npmjs.com/package/@tesseron/core) — protocol types + action builder
  - [`@tesseron/web`](https://www.npmjs.com/package/@tesseron/web) — browser SDK
  - [`@tesseron/server`](https://www.npmjs.com/package/@tesseron/server) — Node SDK
  - [`@tesseron/react`](https://www.npmjs.com/package/@tesseron/react) — React hooks adapter
  - [`@tesseron/mcp`](https://www.npmjs.com/package/@tesseron/mcp) — MCP gateway CLI
- **Six example apps** covering vanilla TS, React, Svelte, Vue, Express, and plain Node.
- **65 tests** across core + gateway.

### Install

```text
/plugin marketplace add KennyVaneetvelde/tesseron
/plugin install tesseron@tesseron
```

Then in your app:

```ts
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

tesseron.app({ id: 'todo_app', name: 'Todo App' });
tesseron
  .action('addTodo')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    state.todos.push({ id: newId(), text, done: false });
    render();
    return { ok: true };
  });
await tesseron.connect();
```

See the [README](https://github.com/KennyVaneetvelde/tesseron#readme) for the full client compatibility matrix and the [docs site](https://kennyvaneetvelde.github.io/tesseron/) for the protocol reference, SDK API, and walkthroughs.

### License

- **Reference implementation** — Business Source License 1.1. Embedding, internal use, forks, and redistribution are all permitted; offering Tesseron as a hosted or managed service is reserved. Each release auto-converts to Apache-2.0 four years after publication.
- **Protocol specification** — CC BY 4.0. Compatible reimplementations in any language, for any purpose including commercial, are explicitly encouraged.

### Next

Phase 4 items (Streamable HTTP transport, devtools UI, `create-tesseron` scaffolder) will land in 1.x releases.

---

**Full changelog:** see the per-package `CHANGELOG.md` files or [compare view](https://github.com/KennyVaneetvelde/tesseron/commits/main).
