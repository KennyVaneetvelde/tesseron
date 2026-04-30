# Transports

## Contents
- The `Transport` interface
- `BrowserWebSocketTransport`
- `NodeWebSocketTransport`
- `DEFAULT_GATEWAY_URL`
- Session resume
- Writing a custom transport
- In-memory transport for tests
- Common mistakes

## The `Transport` interface

A transport is a bidirectional, JSON-object channel. The SDK and the gateway exchange JSON-RPC 2.0 messages; the transport shuttles them back and forth.

```ts
interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(reason?: string): void;
}
```

**Contract notes.**

- `send(message)` is called with a plain JavaScript object (already parsed). Implementations that ship over a wire call `JSON.stringify(message)` before writing.
- `onMessage(handler)` / `onClose(handler)` are called **exactly once** by the client — don't re-register.
- Messages delivered to `onMessage(...)` are expected as parsed objects, not strings. If your underlying channel delivers strings (WebSocket, stdio), call `JSON.parse(...)` inside the transport before invoking the handler.
- `close(...)` is idempotent-safe — calling close on an already-closed transport must not throw.

## `BrowserWebSocketTransport`

```ts
import { BrowserWebSocketTransport } from '@tesseron/web';

const transport = new BrowserWebSocketTransport('ws://localhost:7475');
await transport.ready(); // resolves when WebSocket.readyState === OPEN
await tesseron.connect(transport);
```

Usually you do **not** need to construct a transport explicitly — `tesseron.connect()` with no arguments creates a `BrowserWebSocketTransport(DEFAULT_GATEWAY_URL)` for you:

```ts
await tesseron.connect(); // equivalent to connect(new BrowserWebSocketTransport(DEFAULT_GATEWAY_URL))
```

Pass a string to override the URL without constructing the transport yourself:

```ts
await tesseron.connect('ws://staging.internal:7475');
```

## `NodeWebSocketTransport`

```ts
import { NodeWebSocketTransport } from '@tesseron/server';

const transport = new NodeWebSocketTransport('ws://localhost:7475');
await transport.ready();
await tesseron.connect(transport);
```

Wraps the `ws` npm package. Handles `Buffer`/`ArrayBuffer` incoming messages by decoding to UTF-8 before parsing JSON. Same no-arg + string-URL shortcuts apply:

```ts
await tesseron.connect();              // default gateway
await tesseron.connect('ws://host:7475'); // override URL
```

## `DEFAULT_GATEWAY_URL`

```ts
import { DEFAULT_GATEWAY_URL } from '@tesseron/web'; // or '@tesseron/server'

console.log(DEFAULT_GATEWAY_URL); // 'ws://localhost:7475'
```

Exported from both `@tesseron/web` and `@tesseron/server`. Use this constant rather than hardcoding the URL — when the gateway ships on a different port in the future (or you need to swap for HTTPS/WSS), one import site changes.

## Session resume

`ConnectOptions.resume` carries the credentials from a previous session:

```ts
import type { ResumeCredentials } from '@tesseron/core';

interface ConnectOptions {
  resume?: ResumeCredentials;
}

interface ResumeCredentials {
  sessionId: string;
  resumeToken: string;
}
```

Typical flow:

```ts
// First connect — store credentials
const welcome = await tesseron.connect();
localStorage.setItem('tesseron-session', JSON.stringify({
  sessionId: welcome.sessionId,
  resumeToken: welcome.resumeToken,
}));

// Later (page reload, network drop) — reconnect
try {
  const stored = localStorage.getItem('tesseron-session');
  const resume = stored ? JSON.parse(stored) as ResumeCredentials : undefined;
  const newWelcome = await tesseron.connect(undefined, { resume });

  // Token rotates on every successful resume — write back the fresh one
  localStorage.setItem('tesseron-session', JSON.stringify({
    sessionId: newWelcome.sessionId,
    resumeToken: newWelcome.resumeToken,
  }));
} catch (e) {
  if (e instanceof ResumeFailedError) {
    localStorage.removeItem('tesseron-session');
    await tesseron.connect(); // fresh claim-code flow
  } else {
    throw e;
  }
}
```

Resume semantics are covered in depth in `protocol.md`.

## Writing a custom transport

Any object implementing `Transport` works. The SDK only interacts with the four methods.

**postMessage transport** (iframe ↔ parent):

```ts
import type { Transport } from '@tesseron/core';

class PostMessageTransport implements Transport {
  private messageHandlers: Array<(m: unknown) => void> = [];
  private closeHandlers: Array<(r?: string) => void> = [];
  private listener: (e: MessageEvent) => void;
  private closed = false;

  constructor(private target: Window, private targetOrigin: string) {
    this.listener = (e) => {
      if (e.origin !== this.targetOrigin) return;
      if (this.closed) return;
      for (const h of this.messageHandlers) h(e.data);
    };
    window.addEventListener('message', this.listener);
  }

  send(message: unknown): void {
    if (this.closed) return;
    this.target.postMessage(message, this.targetOrigin);
  }
  onMessage(handler: (m: unknown) => void): void { this.messageHandlers.push(handler); }
  onClose(handler: (r?: string) => void): void { this.closeHandlers.push(handler); }
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    window.removeEventListener('message', this.listener);
    for (const h of this.closeHandlers) h(reason);
  }
}
```

**stdio transport** (Node child process):

```ts
import type { Transport } from '@tesseron/core';
import { createInterface } from 'node:readline';

class StdioTransport implements Transport {
  private messageHandlers: Array<(m: unknown) => void> = [];
  private closeHandlers: Array<(r?: string) => void> = [];
  private rl = createInterface({ input: process.stdin });

  constructor() {
    this.rl.on('line', (line) => {
      try {
        const msg = JSON.parse(line);
        for (const h of this.messageHandlers) h(msg);
      } catch {
        // Ignore malformed lines
      }
    });
    this.rl.on('close', () => {
      for (const h of this.closeHandlers) h('stdin closed');
    });
  }

  send(message: unknown): void {
    process.stdout.write(JSON.stringify(message) + '\n');
  }
  onMessage(handler: (m: unknown) => void): void { this.messageHandlers.push(handler); }
  onClose(handler: (r?: string) => void): void { this.closeHandlers.push(handler); }
  close(reason?: string): void {
    this.rl.close();
    for (const h of this.closeHandlers) h(reason);
  }
}
```

## In-memory transport for tests

Paired transports that deliver to each other — useful for integration tests that exercise the full handshake without a real WebSocket:

```ts
import type { Transport } from '@tesseron/core';

class InMemoryTransport implements Transport {
  peer?: InMemoryTransport;
  private messageHandlers: Array<(m: unknown) => void> = [];
  private closeHandlers: Array<(r?: string) => void> = [];

  send(message: unknown): void {
    setTimeout(() => this.peer?.deliver(message), 0);
  }
  private deliver(message: unknown): void {
    for (const h of this.messageHandlers) h(message);
  }
  onMessage(handler: (m: unknown) => void): void { this.messageHandlers.push(handler); }
  onClose(handler: (r?: string) => void): void { this.closeHandlers.push(handler); }
  close(reason?: string): void {
    for (const h of this.closeHandlers) h(reason);
  }
}

// Usage:
const clientSide = new InMemoryTransport();
const serverSide = new InMemoryTransport();
clientSide.peer = serverSide;
serverSide.peer = clientSide;
```

Feed one to `tesseron.connect(...)` and the other to your fake gateway.

## Common mistakes

- **Calling `send(...)` with a string instead of an object.** The SDK hands the transport the parsed message — transports call `JSON.stringify(...)` *themselves* before writing to the wire.
- **Calling `onMessage(...)` with an unparsed string.** Transports deliver parsed objects — call `JSON.parse(...)` inside the transport before invoking the handler.
- **Registering `onMessage` / `onClose` handlers more than once.** The client calls each exactly once. If a transport accumulates handlers, message delivery skews.
- **Forgetting `transport.close()` on teardown.** Leaks the underlying resource (WebSocket, child process, message listener). The TesseronClient calls `close()` on `disconnect()`.
- **Mixing `BrowserWebSocketTransport` in Node or `NodeWebSocketTransport` in the browser.** Runtime error — one expects the `WebSocket` global, the other uses the `ws` package.
- **Hardcoding `ws://localhost:7475` instead of importing `DEFAULT_GATEWAY_URL`.** A future gateway move requires changing every import site.
- **Retrying `send(...)` in a tight loop after a `onClose` fires.** The transport is dead; reject pending requests and reconnect.
