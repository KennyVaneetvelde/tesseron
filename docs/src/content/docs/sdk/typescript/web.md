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
  // WebSocket transport (WS client; dials the Vite plugin's bridge endpoint).
  BrowserWebSocketTransport,
  // Default endpoint — same-origin `/@tesseron/ws`, derived from `location.origin`.
  // Served by the `@tesseron/vite` plugin. In a dev browser this resolves to e.g.
  // `ws://localhost:5173/@tesseron/ws` when the page is served from Vite on :5173.
  DEFAULT_GATEWAY_URL,
  // Default localStorage key used for auto-persist resume credentials.
  DEFAULT_RESUME_STORAGE_KEY,
  // Persistence backend interface for custom resume storage.
  type ResumeStorage,
  // Extended ConnectOptions accepted by WebTesseronClient.connect.
  type WebConnectOptions,
} from '@tesseron/web';

// The full `@tesseron/core` surface is also re-exported.
```

Browsers can't bind ports, so `@tesseron/web` is a WebSocket **client**. It dials the [`@tesseron/vite`](/sdk/typescript/vite/) plugin at the same origin; the plugin bridges the connection to the gateway that dialed in with the `tesseron-gateway` subprotocol.

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
| `undefined` | Dials `<location.origin>/@tesseron/ws` - the endpoint exposed by the `@tesseron/vite` plugin. |
| `string` (URL) | Dials that URL. |
| `Transport` | Uses the supplied transport - mostly for tests. |

Browser apps need the [`@tesseron/vite`](/sdk/typescript/vite/) plugin in their `vite.config.ts` to serve `/@tesseron/ws`. Without it, `tesseron.connect()` will fail with a WebSocket error. If you use another dev server, pass a URL explicitly or build your own transport.

### Auto-persist resume

The optional second argument is `WebConnectOptions`. Its `resume` field controls whether the SDK persists the session credentials across reloads:

| `resume` value | Behaviour |
|---|---|
| omitted or `true` (default) | Persist `{ sessionId, resumeToken }` in `localStorage` under `tesseron:resume`. On the next `connect()` the SDK reads them, sends `tesseron/resume`, saves the rotated token. On `ResumeFailed` it clears storage and falls back to a fresh `tesseron/hello`. |
| `false` | No persistence. Every connect is a fresh hello with a new claim code. |
| `string` | Same as `true` but with this `localStorage` key. Useful when you run multiple Tesseron clients on one page. |
| [`ResumeStorage`](#custom-resume-backend) | Custom backend - OS keychain, Electron store, IPC bridge, anything implementing the interface. |
| [`ResumeCredentials`](/protocol/resume/) literal | Caller-managed creds. SDK uses them as-is and does **not** auto-persist. |

The default keeps casual refreshes from costing the user a fresh claim code — the most common reason resume was hand-wired in apps before. See [protocol/resume](/protocol/resume/) for the gateway-side TTL semantics (default 4 hours, configurable via `TESSERON_RESUME_TTL_MS`).

Transport-form `tesseron.connect(customTransport, ...)` only accepts `ResumeCredentials` or `false` for `resume`; the storage-aware shapes require the URL form (the SDK constructs and owns the transport so it can retry the handshake on `ResumeFailed`).

#### Custom resume backend

```ts
import { tesseron, type ResumeStorage } from '@tesseron/web';

const keychain: ResumeStorage = {
  load: () => electronAPI.invoke('tesseron:load'),
  save: (creds) => electronAPI.invoke('tesseron:save', creds),
  clear: () => electronAPI.invoke('tesseron:clear'),
};

await tesseron.connect(undefined, { resume: keychain });
```

Throws inside `load`/`save`/`clear` are non-fatal: the SDK treats a thrown `load()` as no saved creds, and thrown `save()` / `clear()` as silent best-effort. Storage misbehaviour can't fail-close the connection.

### Re-entry safety

`tesseron.connect()` is idempotent against re-entry. Two concurrent calls to the URL form with the same URL and the same `resume` credentials share a single in-flight promise (and a single WebSocket); the second caller does not open a parallel socket. This matters under React 18 StrictMode (mount → cleanup → remount), Vite HMR re-running module-scope `connect()`, and any flow that flips a connection-gating boolean rapidly. Without de-dup, the gateway would receive two `tesseron/resume` requests carrying the same single-shot token; the first would consume the zombie session and rotate, and the second would invariably fail with `ResumeFailed`. Connect-after-connect (a fresh call against an already-open transport) eagerly closes the prior socket, waits for its close handler to drain, and only then starts the new handshake — so dispatcher state never overlaps between the dying and the new transport.

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
