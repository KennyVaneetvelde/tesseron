# Resources (`ResourceBuilder` + `ResourceDefinition`)

## Contents
- Read-only vs subscribable
- The builder chain
- Shape of a resource definition
- The subscribe contract (emit + cleanup)
- Combining read and subscribe
- Removing resources at runtime
- Common mistakes

## Read-only vs subscribable

Resources expose app state to the agent in two modes:

- **Read** — the agent calls `resources/read` on demand; the handler returns the current snapshot.
- **Subscribe** — the agent registers for pushes; the handler emits whenever state changes.

A resource can support one mode or both. Use read-only for expensive or rarely-changing values (user profile, static config, current auth state). Use subscribe for anything the agent benefits from seeing in real time (current selection, counters, active tab, streaming metrics).

## The builder chain

```ts
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

// Read-only resource
tesseron
  .resource('todoCount')
  .describe('Total number of todo items.')
  .output(z.number().int().nonnegative())
  .read(() => todos.length);

// Subscribable resource
tesseron
  .resource('stats')
  .describe('Todo statistics — total, completed, pending.')
  .output(z.object({
    total: z.number(),
    completed: z.number(),
    pending: z.number(),
  }))
  .subscribe((emit) => {
    emit(currentStats());

    const callback = () => emit(currentStats());
    statsSubscribers.add(callback);
    return () => statsSubscribers.delete(callback);
  });

// Both — the agent can read on demand AND subscribe to pushes
tesseron
  .resource('currentUser')
  .describe('The currently signed-in user.')
  .output(z.object({ id: z.string(), email: z.string() }))
  .read(() => getCurrentUser())
  .subscribe((emit) => {
    emit(getCurrentUser());
    return authStore.onChange(() => emit(getCurrentUser()));
  });
```

Unlike `ActionBuilder`, which commits only on `.handler(...)`, `ResourceBuilder` registers on the first terminal call (`.read(...)` or `.subscribe(...)`). Chaining both is explicitly supported.

## Shape of a resource definition

```ts
interface ResourceDefinition<T> {
  name: string;
  description: string;
  outputSchema?: StandardSchemaV1<T>;
  reader?: ResourceReader<T>;
  subscriber?: ResourceSubscriber<T>;
}

type ResourceReader<T> = () => T | Promise<T>;
type ResourceSubscriber<T> = (emit: (value: T) => void) => () => void;
```

Once registered, the resource is announced in `tesseron/hello` and exposed to the agent as an MCP resource at `tesseron://<app_id>/<resource_name>`.

## The subscribe contract

The subscriber receives an `emit` function and **must return a cleanup function**:

```ts
(emit: (value: T) => void) => () => void
```

Canonical pattern:

```ts
.subscribe((emit) => {
  // 1. Emit the current value immediately.
  emit(snapshot());

  // 2. Register an internal callback that emits on change.
  const callback = (next: T) => emit(next);
  subscribers.add(callback);

  // 3. Return a cleanup that unregisters the callback.
  return () => subscribers.delete(callback);
});
```

**Why the initial emit matters.** The first `resources/read` that an agent performs after subscribing waits for a value. Without an initial `emit(...)`, the read hangs until some app state changes — which may be never.

**Why cleanup must be idempotent.** Unsubscribe can race with session end; cleanup may be invoked more than once. Use `.delete(callback)` / check-before-remove patterns. Do not throw.

**Emitting promises is not supported.** `emit(...)` takes a resolved value, not a `Promise`. Await inside the subscriber if needed:

```ts
.subscribe((emit) => {
  let cancelled = false;
  void (async () => {
    const value = await loadInitialValue();
    if (!cancelled) emit(value);
  })();
  store.onChange((v) => emit(v));
  return () => { cancelled = true; };
});
```

## Combining read and subscribe

A resource with both `.read(...)` and `.subscribe(...)` is exposed as a readable resource with push updates. The agent can call `resources/read` at any time (runs the reader) and register `resources/subscribe` to get notifications (runs the subscriber).

The two handlers operate independently — reads do not consume subscriber events; subscriber pushes do not trigger the reader. Both are expected to reflect the same underlying state.

```ts
tesseron
  .resource('filter')
  .describe('Active filter: "all" | "active" | "completed".')
  .output(z.enum(['all', 'active', 'completed']))
  .read(() => state.filter)
  .subscribe((emit) => {
    emit(state.filter);
    return state.onFilterChange((f) => emit(f));
  });
```

## Removing resources at runtime

```ts
tesseron.removeResource('stats');
```

Sends `resources/list_changed` so the agent can refresh, and automatically calls every active subscriber's cleanup. Useful when a resource becomes unavailable (e.g. on logout, on feature-flag change).

## Common mistakes

- **`.subscribe((emit) => { ... })` without a return.** The subscription runs forever. Even if the subscriber does nothing to tear down, return a no-op (`() => {}`) so the framework's cleanup path still fires.
- **Forgetting the initial `emit(...)`.** The first agent read after subscription hangs waiting for a push that may never come. Always emit the current value before returning.
- **Throwing from the cleanup function.** Cleanup is invoked during session teardown and must not throw; wrap disposal in `try/catch` if the underlying store can throw.
- **Mutating shared state inside the reader.** `.read(...)` should be pure with respect to observable state; mutations break idempotency and confuse the agent.
- **Leaking secrets or PII in resource output.** Resource values flow verbatim to the agent and are surfaced in the MCP transcript. Scrub before emitting.
- **Emitting a `Promise` instead of a value.** `emit` expects a resolved value; wrap async work in a `(async () => { ... })()` IIFE and `emit(...)` after the await.
- **Registering subscribers in the reader.** The reader returns a snapshot; the subscriber owns its own subscription lifecycle. Keep them separate.
