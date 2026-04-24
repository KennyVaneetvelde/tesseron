---
title: "@tesseron/server"
description: The Node SDK. Binds a loopback WebSocket server, announces itself via ~/.tesseron/tabs/, and waits for the gateway to dial in.
related:
  - sdk/typescript/core
  - protocol/transport
  - sdk/typescript/action-builder
---

`@tesseron/server` is what you use in a Node process - an Express server, a NestJS app, a CLI tool, a background worker, an Electron main process. The builder API is identical to `@tesseron/web`; the transport is what's different.

## How it connects

Unlike the browser SDK, Node can bind ports. `@tesseron/server` uses that directly:

1. On `tesseron.connect()` it creates a WebSocket server on `127.0.0.1` with an OS-picked port.
2. Writes `~/.tesseron/tabs/<tabId>.json` with the URL it bound.
3. Waits for the gateway to dial in with the `tesseron-gateway` subprotocol.
4. On the first and only accepted connection, sends `tesseron/hello` and runs the normal Tesseron handshake.

No environment variables, no fixed ports, no client URL. The discovery file does everything.

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
  // Singleton client - pre-constructed, use directly.
  tesseron,
  // Class (if you need multiple clients per process).
  ServerTesseronClient,
  // Transport — WS server + tab file writer.
  NodeWebSocketServerTransport,
  // Transport options (appName, host, port).
  type NodeWebSocketServerTransportOptions,
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

## Customising the bind

Pass options to `connect()` if you need them:

```ts
await tesseron.connect({ appName: 'notes_api', host: '127.0.0.1', port: 0 });
```

- `appName` - stamped into the tab discovery file so the gateway log names your app usefully. Defaults to `'node'`.
- `host` - always `127.0.0.1` in practice; exposed for tests that need `::1`.
- `port` - `0` (OS picks) is almost always what you want. Setting a fixed port only matters if you're reverse-tunnelling the transport.

Pass a `Transport` instead to bypass bind-and-announce entirely - useful in tests or when you're piping frames through some other channel.

## Express example

The [`express-prompts` example](/examples/express-prompts/) shows the canonical "HTTP + Tesseron on one Node process" pattern. Keep the shared state outside both entry points; each channel calls the same functions:

```ts
const prompts = new Map<string, Prompt>();

// REST surface
app.post('/prompts', (req, res) => {
  const p = createPrompt(prompts, req.body);
  res.status(201).json(p);
});

// Tesseron surface - same underlying function
tesseron.action('addPrompt')
  .input(z.object({ name: z.string(), template: z.string() }))
  .handler((input) => createPrompt(prompts, input));
```

## Transport details

`NodeWebSocketServerTransport` wraps the [`ws`](https://github.com/websockets/ws) npm package (v8). It:

- Binds a WebSocket server via Node's built-in `http.createServer`.
- Accepts exactly one upgrade request that advertises the `tesseron-gateway` subprotocol; every other upgrade attempt is destroyed.
- Tolerates every frame shape `ws` hands back - `string`, `Buffer`, `Buffer[]`, `ArrayBuffer` - and coerces to UTF-8 before parsing.
- Writes its tab file on `listen()` and deletes it on `close()`.

## Running under Docker / systemd

Two things to get right:

1. **Same HOME dir as the gateway.** The gateway reads `~/.tesseron/tabs/`; your Node process has to write there. In containers, mount `~/.tesseron` into the container's `$HOME`.
2. **Signal handling.** `process.on('SIGTERM', …)` to call `tesseron.disconnect()` before exit cleans up the tab file and gives the gateway a clean close (code 1001) so the agent doesn't see abrupt tool failures.

Claim codes surface on stdout/stderr of your Node process, not the gateway's. Plan how you expose them to humans - a web UI endpoint, a file you rotate, whatever fits.

## Capabilities

Server handlers get the same `ActionContext` as browser handlers. Two differences to know:

- `ctx.client.origin` - fabricated. Typically the string `"node:<app.id>"` or similar. Don't use it for auth.
- `ctx.client.route` - always `undefined`. There's no "current route" on the server.

Everything else - `progress`, `sample`, `elicit`, `log`, `signal` - behaves the same.
