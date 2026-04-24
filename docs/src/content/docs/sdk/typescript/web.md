---
title: "@tesseron/web"
description: The browser SDK. Singleton client, WebSocket transport, framework-agnostic.
related:
  - sdk/typescript/core
  - protocol/transport
  - sdk/typescript/action-builder
---

The package for anything running in a browser tab - vanilla TS, Vite, Next, Svelte, Vue. If you use React, the [@tesseron/react](/sdk/typescript/react/) adapter is the ergonomic wrapper on top of this.

## Exports

```ts
import {
  // Singleton client - pre-constructed, use directly.
  tesseron,
  // Class (if you need multiple clients, e.g. for multiple apps in one tab).
  WebTesseronClient,
  // WebSocket transport.
  BrowserWebSocketTransport,
  // Default gateway URL.
  DEFAULT_GATEWAY_URL,   // 'ws://localhost:7475'
} from '@tesseron/web';

// The full `@tesseron/core` surface is also re-exported.
```

## Singleton usage

```ts
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

tesseron.app({ id: 'shop', name: 'Shop' });

tesseron.action('search')
  .input(z.object({ query: z.string() }))
  .handler(({ query }) => store.search(query));

const welcome = await tesseron.connect();
console.log('claim code:', welcome.claimCode);
```

`tesseron.connect()` accepts:

| Argument | Behaviour |
|---|---|
| `undefined` | Connects to `ws://localhost:7475`. |
| `string` (URL) | Connects to that URL. |
| `Transport` | Uses the supplied transport - mostly for tests. |

Returns `WelcomeResult`:

```ts
interface WelcomeResult {
  sessionId: string;
  protocolVersion: string;
  capabilities: TesseronCapabilities;   // { streaming, subscriptions, sampling, elicitation }
  agent: { id: string; name: string };
  claimCode?: string;
}
```

The SDK's own agreed-side capabilities (advertised in `tesseron/hello`) live in `SDK_CAPABILITIES`. The `welcome.capabilities` above describe what the *agent side* supports. Inside a handler the narrower `ctx.agentCapabilities` surface (`{ sampling, elicitation, subscriptions }`) is the one to branch on.

## Multiple clients in one page

The singleton is convenient, but if you need two apps in one tab:

```ts
import { WebTesseronClient } from '@tesseron/web';

const shop = new WebTesseronClient();
shop.app({ id: 'shop', name: 'Shop' });
shop.action('search').input(...).handler(...);
await shop.connect();

const admin = new WebTesseronClient();
admin.app({ id: 'admin', name: 'Admin' });
admin.action('ban').input(...).handler(...);
await admin.connect();
```

Each `WebTesseronClient` holds its own WebSocket to the MCP gateway. Two sessions, two claim codes. Tools don't collide because they're namespaced by `app.id`.

## Custom transport

The built-in transport uses the browser's `WebSocket`. If you need something else (a service worker relaying to an extension, a shared worker, a BroadcastChannel for tests), pass a `Transport` directly:

```ts
const custom: Transport = {
  send: (msg) => postMessage(msg),
  onMessage: (h) => addEventListener('message', (e) => h(e.data)),
  onClose: (h) => { /* ... */ },
  close: () => { /* ... */ },
};
await tesseron.connect(custom);
```

## Frame handling quirks

- The transport only handles string frames (`typeof ev.data === 'string'`). Non-string frames from the gateway are dropped - in practice the gateway always sends text, so this never fires.
- Messages that fail `JSON.parse` are dropped silently.
- The `open` event resolves `connect()`. If the WebSocket's `error` fires before `open`, `connect()` rejects with `WebSocket connection failed: <url>`.

## Disconnect

```ts
await tesseron.disconnect();
```

Sends WebSocket close frame, rejects pending requests with `TransportClosedError`, aborts in-flight invocations. Safe to call multiple times.

## Reconnect pattern

There is no built-in reconnect. Pattern:

```ts
async function connectWithRetry(attempt = 0) {
  try {
    const welcome = await tesseron.connect();
    surfaceClaimCode(welcome.claimCode);
  } catch (err) {
    const delay = Math.min(30_000, 500 * 2 ** attempt);
    setTimeout(() => connectWithRetry(attempt + 1), delay);
  }
}
connectWithRetry();
```

Don't reconnect automatically in a hot loop - if the gateway is down (plugin disabled), hammering the port wastes CPU. Back off, cap at ~30 s, surface the state to the user.
