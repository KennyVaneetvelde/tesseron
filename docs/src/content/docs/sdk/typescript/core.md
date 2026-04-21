---
title: "@tesseron/core"
description: The protocol types, builder, JSON-RPC dispatcher, and abstract client that every runtime adapter extends.
---

`@tesseron/core` is the runtime-independent layer. It has **zero runtime dependencies beyond Standard Schema spec types**. If you're writing a custom transport - Bun, Deno, a browser extension background worker, a native WebSocket implementation - you extend `core` directly.

Most consumers don't need this package; they use `@tesseron/web`, `/server`, or `/react`. Use `core` when those don't fit.

## Exports

```ts
import {
  // The abstract client (extended by @tesseron/web and @tesseron/server).
  TesseronClient,
  // Builders.
  ActionBuilder, ResourceBuilder,
  RegisteredAction, RegisteredResource,
  // Per-invocation context.
  ActionContext, AgentCapabilities,
  SampleRequest, ConfirmRequest, ElicitRequest,
  // JSON-RPC plumbing.
  JsonRpcDispatcher,
  JsonRpcRequest, JsonRpcNotification, JsonRpcResponse,
  // Transport contract.
  Transport,
  // Error model.
  TesseronError,
  SamplingNotAvailableError, ElicitationNotAvailableError, SamplingDepthExceededError,
  CancelledError, TimeoutError,
  TesseronErrorCode,   // numeric enum: InputValidation = -32004, etc.
  // Protocol constants & types.
  PROTOCOL_VERSION,    // '0.2.0'
  SDK_CAPABILITIES,    // { streaming: true, ... }
  HelloParams, WelcomeResult, TesseronCapabilities,
  ActionAnnotations,
  ActionInvokeParams, ActionProgressParams, ActionCancelParams,
  ResourceReadParams, ResourceSubscribeParams, ResourceUpdatedParams,
} from '@tesseron/core';
```

## `TesseronClient` (abstract)

`@tesseron/web` and `@tesseron/server` each extend this with a transport. The base class's `connect(transport)` takes a concrete `Transport`. The web / server subclasses override it to accept `Transport | string | undefined` so users can pass a URL (or nothing) and get a default WebSocket transport. The subclassing contract:

```ts
class MyTesseronClient extends TesseronClient {
  override async connect(target?: Transport | string): Promise<WelcomeResult> {
    if (target && typeof target !== 'string') return super.connect(target);
    const transport = new MyTransport(target ?? DEFAULT_GATEWAY_URL);
    await transport.ready();
    return super.connect(transport);
  }
}
```

`super.connect(transport)` wires the dispatcher, sends `tesseron/hello`, handles `actions/invoke`, and returns the `welcome` result.

## `Transport`

```ts
interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(reason?: string): void;
}
```

The core client assumes the transport passes objects (not strings). If your transport is string-oriented, JSON.parse / stringify at the boundary. WebSocket-based transports in `@tesseron/web` and `@tesseron/server` already do this.

## `JsonRpcDispatcher`

Low-level bidirectional JSON-RPC router:

```ts
interface JsonRpcDispatcher {
  on<M>(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void;
  onNotification<N>(method: string, handler: (params: unknown) => void): void;
  request<R>(method: string, params?: unknown, options?: { timeoutMs?: number }): Promise<R>;
  notify(method: string, params?: unknown): void;
  receive(message: unknown): void;
}
```

You typically only use this directly when implementing extension methods. Day-to-day use of Tesseron goes through the builder, not the dispatcher.

## `TesseronError`

```ts
class TesseronError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown);
}
```

The dispatcher maps it to / from the `{ code, message, data }` JSON-RPC error object automatically. Throw it from handlers to produce a specific JSON-RPC error:

```ts
import { TesseronError, TesseronErrorCode } from '@tesseron/core';

.handler(async ({ orderId }, ctx) => {
  const order = await orders.find(orderId);
  if (!order) throw new TesseronError(TesseronErrorCode.ActionNotFound, `no order ${orderId}`, { orderId });
  // …
});
```

Catching `TesseronError` is also useful around `ctx.sample` / `ctx.elicit` to pivot on capability errors (note: `ctx.confirm` doesn't throw — it returns `false` when elicitation isn't available, which is the safe default for destructive gates):

```ts
import { SamplingNotAvailableError, TesseronError, TesseronErrorCode } from '@tesseron/core';

try {
  const r = await ctx.sample({ prompt });
} catch (err) {
  if (err instanceof SamplingNotAvailableError) return fallback();
  // equivalent by code:
  if (err instanceof TesseronError && err.code === TesseronErrorCode.SamplingNotAvailable) {
    return fallback();
  }
  throw err;
}
```

## Bringing your own transport

A minimal example, for clarity - a loopback transport pair for tests:

```ts
import { Transport, TesseronClient } from '@tesseron/core';

function pair(): [Transport, Transport] {
  const aInbox: Array<(m: unknown) => void> = [];
  const bInbox: Array<(m: unknown) => void> = [];
  const a: Transport = {
    send: (m) => bInbox.forEach((h) => h(m)),
    onMessage: (h) => aInbox.push(h),
    onClose: () => {},
    close: () => {},
  };
  const b: Transport = {
    send: (m) => aInbox.forEach((h) => h(m)),
    onMessage: (h) => bInbox.push(h),
    onClose: () => {},
    close: () => {},
  };
  return [a, b];
}
```

You can attach a `TesseronClient` subclass to one side and a mock gateway to the other. Both `@tesseron/mcp` and the SDK test suites rely on patterns like this.
