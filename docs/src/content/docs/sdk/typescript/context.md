---
title: Context API (progress, sampling, elicit)
description: Everything available on the `ctx` argument of an action handler.
related:
  - protocol/elicitation
  - protocol/sampling
  - protocol/progress-cancellation
---

Every action handler receives `(input, ctx)`. `ctx: ActionContext` is where the protocol-level capabilities are exposed as methods.

## Shape

```ts
interface ActionContext {
  // Identity
  readonly agent: { id: string; name: string };
  readonly agentCapabilities: {
    sampling: boolean;
    elicitation: boolean;
    subscriptions: boolean;
  };
  readonly client: { origin: string; route?: string; userAgent?: string };

  // Lifecycle
  readonly signal: AbortSignal;
  withTimeout<T>(value: Promise<T> | T, ms: number): Promise<T>;

  // Messaging
  progress(update: { message?: string; percent?: number; data?: unknown }): void;
  sample<T>(req: { prompt: string; schema?: StandardSchemaV1<T>; maxTokens?: number }): Promise<T>;
  confirm(req: { question: string }): Promise<boolean>;
  elicit<T>(req: {
    question: string;
    schema: StandardSchemaV1<T>;
    jsonSchema?: unknown;
  }): Promise<T | null>;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>): void;
}
```

## `ctx.signal` - cancel & timeout

Standard [`AbortSignal`](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal). Fires when the agent cancels the invocation or the action's timeout expires. The two cases are indistinguishable from the handler - cleanup and yield either way.

```ts
.handler(async (input, ctx) => {
  const res = await fetch(url, { signal: ctx.signal });
  if (ctx.signal.aborted) throw new Error('cancelled');
  return await res.json();
});
```

Pass `ctx.signal` to everything that accepts one: `fetch`, `setTimeout`, database drivers, nested `ctx.sample` calls.

The SDK guarantees the wire is freed at the deadline regardless of whether the handler observes `ctx.signal`. Once the timer fires, the agent receives `-32002 Timeout` (or `-32001 Cancelled` on agent cancellation) immediately. A handler stuck in a non-signal-aware promise keeps running orphaned — that's the app's problem to clean up, but the agent isn't held hostage. See [`ctx.withTimeout`](#ctxwithtimeout-drop-stuck-inner-promises) for the in-handler companion.

## `ctx.withTimeout(value, ms)` - drop stuck inner promises

A small race helper for handlers that wrap browser APIs which don't accept an `AbortSignal` — `modern-screenshot.domToPng`, `<canvas>.toBlob`, `<img>.decode`, `document.fonts.ready`, `Audio.play`, `MediaRecorder`. Resolves with `value` if it settles within `ms`, otherwise rejects with `TimeoutError`. Also rejects if `ctx.signal` aborts first (with the abort reason — `TimeoutError` or `CancelledError`).

```ts
.handler(async (_input, ctx) => {
  const dataUrl = await ctx.withTimeout(domToPng(document.body), 8_000);
  return { dataUrl };
});
```

The original promise keeps running orphaned; the handler moves on. Use this to bound a single problematic call without giving the whole action a tighter `.timeout({ ms })` than it actually needs.

## `ctx.progress(update)` - streaming updates

Fire-and-forget notification. Any combination of the three payload fields works:

```ts
ctx.progress({ message: 'searching' });
ctx.progress({ percent: 40 });
ctx.progress({ message: 'merging results', percent: 80, data: { batchesDone: 3 } });
```

`ctx.progress` is a fire-and-forget JSON-RPC notification; it never throws. Safe to call unconditionally - when no one is observing (agent didn't supply a `progressToken`, or the MCP client drops them), the MCP gateway just doesn't forward the notification.

Keep the rate reasonable (≤ 2/sec). Progress is rendered in the agent UI; faster rates spam without adding information.

## `ctx.sample(req)` - ask the LLM

Re-enter the agent's LLM for a reasoning step.

```ts
const { summary } = await ctx.sample({
  prompt: `Summarise these bug reports in one sentence each:\n${JSON.stringify(bugs)}`,
  schema: z.object({ summary: z.array(z.string()) }),
  maxTokens: 400,
});
```

- `schema` is optional. Without it, you get `string`. With it, the SDK validates and returns the parsed `T`.
- `maxTokens` is a hint to the agent; honoured at its discretion.
- Throws `SamplingNotAvailableError` (code `-32006`) if `agentCapabilities.sampling` is false.
- Throws `SamplingDepthExceededError` (code `-32008`) if you've nested past `maxSamplingDepth` (3).

See [the sampling protocol page](/protocol/sampling/) for wire format.

## `ctx.confirm(req)` - ask the user yes/no

For safety gates on destructive actions. Returns `true` only on explicit accept; decline, cancel, and missing elicitation capability all collapse to `false`.

```ts
const ok = await ctx.confirm({
  question: `Delete order ${order.number}? This cannot be undone.`,
});
if (!ok) return { cancelled: true };
await orders.delete(order.id);
```

- No schema - the Accept/Decline action is the answer.
- Safe to call unconditionally: when the connected MCP client doesn't advertise elicitation, `confirm` returns `false` (the safe default for destructive gates). You don't need to guard on `ctx.agentCapabilities.elicitation`.

Under the hood, `ctx.confirm` sends an elicit request with an empty-properties schema (`{ type: 'object', properties: {}, required: [] }`), so MCP clients render pure Accept/Decline without an input field.

## `ctx.elicit(req)` - ask the user for structured content

When you need a value from the user - a warehouse ID, a new filename, a grace-period choice. The agent renders a form; you get the typed value back.

```ts
import { z } from 'zod';

const nameSchema = z.object({ newName: z.string().min(1) });

const answer = await ctx.elicit({
  question: `Rename "${file.name}" to?`,
  schema: nameSchema,
  jsonSchema: z.toJSONSchema(nameSchema),
});
if (answer === null) return { cancelled: true };
await file.rename(answer.newName);
```

- `schema` is the runtime validator (any Standard Schema v1 - Zod, Valibot, ArkType, ...).
- `jsonSchema` is what the MCP client renders. Optional; if omitted, a permissive single-text-input fallback is sent. For real UX always derive it from your validator (Zod 4: `z.toJSONSchema(schema)`).
- Returns the validated value on accept, `null` on decline or cancel.
- Throws `ElicitationNotAvailableError` (code `-32007`) if the agent doesn't support elicitation - structured data has no safe default.

MCP elicit requires the `requestedSchema` to be a flat object of primitive-typed leaves (`string`, `number`, `integer`, `boolean`). The SDK asserts this at the call site and surfaces a clear `InvalidParams` (code `-32602`) error if you send a nested object, array, or `oneOf` / `anyOf` at the top level.

### Which to pick

- Yes/no on a destructive op → `ctx.confirm`.
- "Which of these?" / "What's the new name?" → `ctx.elicit` with a schema.
- Multi-step wizards → separate actions, one question each.

## `ctx.log({ level, message, meta? })` - structured logs

```ts
ctx.log({ level: 'info', message: 'imported CSV', meta: { rows: 1200, durationMs: 4830 } });
ctx.log({ level: 'warn', message: 'column name mismatch, falling back', meta: { column: 'sku_new' } });
ctx.log({ level: 'error', message: 'remote returned 500', meta: { url, status: 500 } });
```

Forwarded to MCP `sendLoggingMessage` with `logger: <app_id>`. Useful because:

- The user sees them in the agent's log panel - helpful context when the invocation succeeds but something went sideways.
- They're notifications, not requests - never back-pressure the handler.

## `ctx.agent`, `ctx.agentCapabilities`, `ctx.client`

Read-only identity + capability info.

- `ctx.agent.id` - one of `claude-code`, `claude-desktop`, `cursor`, an agent-provided identifier.
- `ctx.client.origin` - the origin of the app. On the server SDK this is typically a fabricated identifier; on the web SDK it's `window.location.origin`.
- `ctx.client.route` - the app's current route, if set at `app({})`-time. Useful for routing context into the handler.

Guard feature calls on these before using them:

```ts
if (ctx.agentCapabilities.sampling) {
  const extracted = await ctx.sample({ prompt, schema });
  return { items: extracted };
}
return { items: await fallbackSearch(...) };
```
