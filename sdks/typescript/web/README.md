<div align="center">
  <a href="https://github.com/eigenwise/tesseron">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-dark.png">
      <img src="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-light.png" alt="Tesseron" width="380">
    </picture>
  </a>
</div>

# @tesseron/web

Browser SDK for [Tesseron](https://github.com/eigenwise/tesseron). Expose typed web-app actions to MCP-compatible AI agents (Claude Code, Claude Desktop, Cursor, Copilot, Codex, ...) over a local WebSocket — your real handlers run against your real state, **no browser automation, no scraping, no Playwright**.

## Install

```bash
npm install @tesseron/web
```

You also need the [`@tesseron/mcp`](https://www.npmjs.com/package/@tesseron/mcp) gateway running locally — it's bundled inside the [Claude Code plugin](https://github.com/eigenwise/tesseron/tree/main/plugin), so `/plugin install tesseron@tesseron` is a one-command setup. For other MCP clients see the [setup guide](https://github.com/eigenwise/tesseron/blob/main/examples/README.md#2-wire-the-mcp-gateway-into-your-mcp-client).

## Quick start

```ts
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

tesseron.app({ id: 'todo_app', name: 'Todo App' });

tesseron
  .action('addTodo')
  .describe('Add a todo item to the list.')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    state.todos.push({ id: newId(), text, done: false });
    render();
    return { ok: true };
  });

await tesseron.connect();
```

Your page now shows a six-character claim code. When the user types `claim session XXXX-XX` in their MCP agent, your actions appear as native tools in that agent. Every invocation runs your real handler against your real state.

## What you get

- **Typed actions** — `tesseron.action(name)` fluent builder backed by Zod or any [Standard Schema](https://standardschema.dev) validator. Type inference flows through `input`, `output`, and `handler`.
- **Subscribable resources** — `tesseron.resource(name).read(fn)` for one-shot reads, `.subscribe(fn)` for push updates when state changes.
- **Rich handler context** — `ctx.confirm` (yes/no), `ctx.elicit` (schema-validated prompts), `ctx.sample` (agent-LLM calls from inside the handler), `ctx.progress` (streaming updates), `ctx.log` (structured logs forwarded to the MCP logging channel), cancellation via `ctx.signal`.
- **Typed errors** — `SamplingNotAvailableError`, `ElicitationNotAvailableError`, `TimeoutError`, `CancelledError`, etc., each mapped to a specific MCP error code for clean capability fallbacks.
- **Automatic reconnection** — transport handles WebSocket lifecycle; your handlers keep working across reconnects.

## Pair with a framework

- **React** — use [`@tesseron/react`](https://www.npmjs.com/package/@tesseron/react) for `useTesseronAction` / `useTesseronResource` / `useTesseronConnection` hooks. They wrap `@tesseron/web` and manage registration lifecycle per component.
- **Svelte, Vue, vanilla TS** — use `@tesseron/web` directly. Handlers mutate your reactive state (`$state`, `ref`, plain object + `render()`) and the user sees the change live.
- **Any framework** — the same Zod-style builder works everywhere. See the [examples directory](https://github.com/eigenwise/tesseron/tree/main/examples) for full apps in vanilla TS, React, Svelte, Vue, and more.

## Client compatibility

Not every MCP client supports every capability. Before calling `ctx.sample` or `ctx.elicit`, consult `ctx.agentCapabilities` and the [official MCP client compatibility matrix](https://modelcontextprotocol.io/clients). Tesseron throws a typed `SamplingNotAvailableError` / `ElicitationNotAvailableError` when the capability is missing — `ctx.confirm` collapses to `false` as the safe default.

## Docs

| | |
|---|---|
| Main repo | <https://github.com/eigenwise/tesseron> |
| SDK reference | <https://eigenwise.github.io/tesseron/sdk/typescript/web/> |
| Protocol spec | <https://eigenwise.github.io/tesseron/protocol/> |
| Examples | <https://github.com/eigenwise/tesseron/tree/main/examples> |
| Discussions | <https://github.com/eigenwise/tesseron/discussions> |

## License

Reference implementation — [Business Source License 1.1](https://github.com/eigenwise/tesseron/blob/main/LICENSE) (source-available). Each release auto-converts to Apache-2.0 four years after publication.

<p align="center">Built and maintained by <a href="https://eigenwise.io/"><b>Eigenwise</b></a>.</p>
