---
title: "@tesseron/vite"
description: Vite plugin that exposes `/@tesseron/ws` on your dev server and bridges browser tabs to the Tesseron gateway.
related:
  - sdk/typescript/web
  - protocol/transport
  - overview/architecture
---

`@tesseron/vite` is the bridge that lets `@tesseron/web` (and `@tesseron/react`, `@tesseron/svelte`, `@tesseron/vue`) connect without a separate port.

## Why it exists

Browsers can't bind TCP ports. The gateway needs a WebSocket endpoint to dial. The Vite dev server is already listening on a port - the plugin piggybacks on it.

When a browser tab opens your dev URL, it dials `/@tesseron/ws` on the same origin. The plugin:

1. Accepts the browser connection (no subprotocol).
2. Writes `~/.tesseron/tabs/<tabId>.json` with a per-tab URL pointing at `/@tesseron/ws/<tabId>` on your dev server.
3. Waits for the gateway to dial the per-tab URL with the `tesseron-gateway` subprotocol.
4. Bridges frames between the two sockets, buffering browser → gateway traffic if the browser starts talking before the gateway dials in.

One tab → one tab file → one gateway connection → one Tesseron session. Multiple tabs coexist cleanly.

## Install

```bash
pnpm add -D @tesseron/vite
```

Peer: `vite >= 4`. No runtime dependencies on your framework plugin.

## Register

```ts title="vite.config.ts"
import { defineConfig } from 'vite';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [
    // ...your framework plugin (vue(), svelte(), react(), etc.)
    tesseron(),
  ],
});
```

With your framework plugin:

```ts title="vite.config.ts (Vue)"
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [vue(), tesseron({ appName: 'vue-todo' })],
});
```

## Options

```ts
tesseron({
  appName: 'my-app',   // Optional. Written into the tab discovery file so the
                       // gateway log names your app usefully. Defaults to the
                       // Vite project directory name.
});
```

That's the whole API surface. There's nothing to configure about ports, paths, or subprotocols - those are wire-level details.

## How the browser reaches it

The client-side `@tesseron/web` defaults to `<location.origin>/@tesseron/ws`, so no URL config is needed in your app code:

```ts
import { tesseron } from '@tesseron/web';
tesseron.app({ id: 'shop', name: 'Shop' });
// ...declare actions...
await tesseron.connect();   // dials ws://localhost:5173/@tesseron/ws
```

If your Vite server runs on a non-default port (e.g. `5175`), `location.origin` already reflects that - the connection still lands on the plugin.

## Multiple tabs

Each browser tab gets its own `tabId`, its own tab file, and its own gateway connection. Session claiming is per-tab - open three tabs of the same app and you get three claim codes, each independent.

## Production builds

The plugin only runs under `vite dev`. Production builds (`vite build`) don't serve WebSocket endpoints, so a static `dist/` deployed to a CDN won't have `/@tesseron/ws` available.

For production Tesseron use with a browser SPA, you need a host process. Options:

- **Electron / Tauri** - the native shell can run `@tesseron/server` in its main process and route `/@tesseron/ws` requests to it from the renderer.
- **A custom reverse proxy in front of your SPA** that terminates `/@tesseron/ws` and bridges to a Node process running `@tesseron/server`.
- **A separate Node service** that uses `@tesseron/server` if your prod topology already has one.

The Vite plugin is strictly for dev-time workflows.

## What it doesn't do

- **Not a framework adapter.** You still import from `@tesseron/web` / `@tesseron/react` / `@tesseron/svelte` / `@tesseron/vue` for the declarative API.
- **Not a bundler plugin.** It only runs `configureServer`; no build-time transforms.
- **Not a production tool.** See above.

## Writing your own bridge

If you use a dev server other than Vite (webpack-dev-server, Rsbuild, Next.js dev, a custom Express-based HMR setup), the same three steps work:

1. On WebSocket upgrade at `/@tesseron/ws` - accept the browser and assign a `tabId`.
2. Write `~/.tesseron/tabs/<tabId>.json` with `{ version: 1, tabId, appName, wsUrl, addedAt }`, where `wsUrl` points at a tab-specific path like `/@tesseron/ws/<tabId>`.
3. On WebSocket upgrade at that per-tab path with subprotocol `tesseron-gateway` - accept the gateway and relay frames between the two sockets. Buffer browser traffic until the gateway arrives.

`@tesseron/vite`'s ~150-line source is the reference; adapt it to whatever dev server you run.
