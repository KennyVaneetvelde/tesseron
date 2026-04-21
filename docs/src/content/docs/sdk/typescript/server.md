---
title: "@tesseron/server"
description: The Node SDK. Same action surface as @tesseron/web, different transport.
---

`@tesseron/server` is what you use in a Node process - an Express server, a NestJS app, a CLI tool, a background worker. The builder API is identical to `@tesseron/web`; only the transport differs.

## When to use server vs web

| Use server when | Use web when |
|---|---|
| The handler's work lives on the backend (DB writes, queue jobs, filesystem). | The handler's work needs DOM or browser APIs. |
| You don't need the user's tab to be open. | The agent should only work while the user is viewing the page. |
| You want a headless service that Claude can drive. | You want Claude to drive the UI the user is already looking at. |

Both can run at the same time against the same MCP gateway - [multi-app coexistence](/protocol/security/#multi-app-coexistence) is first-class.

## Exports

```ts
import {
  tesseron,
  ServerTesseronClient,
  NodeWebSocketTransport,
  DEFAULT_GATEWAY_URL,   // 'ws://localhost:7475'
} from '@tesseron/server';
```

## Typical process layout

```ts
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

tesseron.app({
  id: 'notes_api',
  name: 'Notes API',
  description: 'CRUD over the notes store',
});

tesseron
  .action('createNote')
  .input(z.object({ title: z.string(), body: z.string() }))
  .handler(async ({ title, body }) => {
    return db.notes.insert({ title, body });
  });

tesseron.resource('noteCount').read(() => db.notes.count());

async function main() {
  const welcome = await tesseron.connect();
  console.log(`Tesseron ready. Claim code: ${welcome.claimCode}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

async function shutdown() {
  await tesseron.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
```

## Express example

The [`express-todo` example](/examples/express-todo/) shows the canonical "HTTP + Tesseron on one Node process" pattern. Keep the shared state outside of both entry points; each channel calls the same functions:

```ts
const todos = new Map<string, Todo>();

// REST surface
app.post('/todos', (req, res) => {
  const todo = createTodo(todos, req.body);
  res.json(todo);
});

// Tesseron surface - same underlying function
tesseron.action('addTodo')
  .input(z.object({ text: z.string() }))
  .handler(({ text }) => createTodo(todos, { text }));
```

## Transport details

`NodeWebSocketTransport` wraps the [`ws`](https://github.com/websockets/ws) npm package (v8). Differences from the browser transport:

- Accepts every frame shape `ws` hands back - `string`, `Buffer`, `Buffer[]`, `ArrayBuffer` - and coerces to UTF-8 before parsing. The browser transport is string-only.
- Tolerates the gateway sending fragmented messages; `ws` reassembles automatically.
- No auto-reconnect; see the [reconnect pattern](/sdk/typescript/web/#reconnect-pattern) from the web page - it transfers.

## Running under Docker / systemd

Two things to get right:

1. **Stdout / stderr** go to the process manager's log, not the gateway's. The claim code surfaces in *your* logs. Plan your startup flow to copy it somewhere humans can see - or, if the service is meant to be headless and always-on, log the claim code only to a file you rotate.
2. **Signal handling.** `process.on('SIGTERM', …)` to call `tesseron.disconnect()` before exit gives the gateway a clean close (code 1001) and stops the agent from seeing abrupt tool failures.

## Capabilities

Server handlers get the same `ActionContext` as browser handlers. There are two differences worth being aware of:

- `ctx.client.origin` - fabricated. Typically the string `"node:<app.id>"` or similar. Don't use it for auth.
- `ctx.client.route` - always `undefined`. There's no "current route" on the server.

Everything else - `progress`, `sample`, `elicit`, `log`, `signal` - behaves the same.
