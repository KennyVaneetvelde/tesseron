<div align="center">
  <a href="https://github.com/BrainBlend-AI/tesseron">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/BrainBlend-AI/tesseron/raw/main/assets/logo/tesseron-smallcaps-dark.png">
      <img src="https://github.com/BrainBlend-AI/tesseron/raw/main/assets/logo/tesseron-smallcaps-light.png" alt="Tesseron" width="380">
    </picture>
  </a>
</div>

# @tesseron/server

Node SDK for [Tesseron](https://github.com/BrainBlend-AI/tesseron). Same Zod-style action builder as [`@tesseron/web`](https://www.npmjs.com/package/@tesseron/web), but for any Node process — a CLI, daemon, worker, Express or Fastify service. Expose typed actions to MCP-compatible AI agents without opening a browser tab.

## Install

```bash
npm install @tesseron/server
```

You also need the [`@tesseron/mcp`](https://www.npmjs.com/package/@tesseron/mcp) gateway running locally — it's bundled inside the [Claude Code plugin](https://github.com/BrainBlend-AI/tesseron/tree/main/plugin).

## Quick start

```ts
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

tesseron.app({ id: 'deployer', name: 'Deployer CLI' });

tesseron
  .action('deployService')
  .describe('Deploy a named service to the given environment.')
  .input(z.object({
    service: z.string(),
    env: z.enum(['staging', 'production']),
  }))
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async ({ service, env }, ctx) => {
    const ok = await ctx.confirm({ question: `Deploy ${service} to ${env}?` });
    if (!ok) return { deployed: false };
    ctx.progress({ message: 'Building...', percent: 10 });
    await build(service);
    ctx.progress({ message: 'Uploading...', percent: 60 });
    await upload(service, env);
    return { deployed: true, url: urlFor(service, env) };
  });

await tesseron.connect();
```

## What you get

- **Same API as `@tesseron/web`** — typed action builder, subscribable resources, full handler context (`ctx.confirm`, `ctx.elicit`, `ctx.sample`, `ctx.progress`, `ctx.log`).
- **Works in any Node process** — CLI tool, background daemon, HTTP server (Express, Fastify, plain `http`). Same action can be invoked via MCP and via your existing REST endpoints.
- **Built-in WebSocket transport** — `NodeWebSocketTransport` from `ws`, no bundler configuration needed.
- **Typed errors** — `SamplingNotAvailableError`, `ElicitationNotAvailableError`, `TimeoutError`, `CancelledError`, `TransportClosedError`.

## Dual-channel pattern

The same action store can be exposed via MCP **and** a regular HTTP API:

```ts
import express from 'express';
import { tesseron } from '@tesseron/server';

const app = express();
const store = new TodoStore();

tesseron
  .action('addTodo')
  .input(z.object({ text: z.string() }))
  .handler(({ text }) => store.add(text));

app.post('/todos', (req, res) => res.json(store.add(req.body.text)));

app.listen(3000);
await tesseron.connect();
```

Both channels mutate the same state. See [`examples/express-prompts`](https://github.com/BrainBlend-AI/tesseron/tree/main/examples/express-prompts) for a working version (prompt library with sampling and elicitation).

## Docs

| | |
|---|---|
| Main repo | <https://github.com/BrainBlend-AI/tesseron> |
| SDK reference | <https://brainblend-ai.github.io/tesseron/sdk/typescript/server/> |
| Protocol spec | <https://brainblend-ai.github.io/tesseron/protocol/> |
| Examples | <https://github.com/BrainBlend-AI/tesseron/tree/main/examples> |

## License

Reference implementation — [Business Source License 1.1](https://github.com/BrainBlend-AI/tesseron/blob/main/LICENSE) (source-available). Each release auto-converts to Apache-2.0 four years after publication.

<p align="center">
  <a href="https://brainblendai.com/">
    <img src="https://github.com/BrainBlend-AI/tesseron/raw/main/assets/brainblend-ai/logo.png" width="32" alt="BrainBlend AI">
  </a>
</p>
<p align="center">Built and maintained by <a href="https://brainblendai.com/"><b>BrainBlend AI</b></a>.</p>
