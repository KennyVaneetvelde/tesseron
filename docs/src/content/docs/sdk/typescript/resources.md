---
title: Resources
description: Declaring readable and subscribable state for the agent to observe.
---

A resource is a named piece of app state. The agent can read it on demand and, if your resource supports it, subscribe for live updates.

See the [protocol resources page](/protocol/resources/) for wire format. This page focuses on the builder API.

## Builder shape

```ts
interface ResourceBuilder<T> {
  describe(description: string): ResourceBuilder<T>;
  output<NewT>(schema: StandardSchemaV1<NewT>, jsonSchema?: unknown): ResourceBuilder<NewT>;
  read(fn: () => T | Promise<T>): ResourceBuilder<T>;
  subscribe(setup: (emit: (value: T) => void) => () => void): ResourceBuilder<T>;
}
```

Either `.read()` or `.subscribe()` commits the resource to the client's registry - you can call both (in any order) and the registered entry is updated in place. The agent sees the resource as subscribable as soon as `.subscribe()` is called.

## Read-only resource

```ts
tesseron.resource('currentRoute')
  .describe('The URL path the user is viewing')
  .read(() => window.location.pathname);
```

The agent calls `resources/read tesseron://<app_id>/currentRoute` whenever it wants the value. `.read()` runs on each request.

## Subscribable resource

```ts
tesseron.resource('currentRoute')
  .describe('The URL path the user is viewing')
  .read(() => window.location.pathname)
  .subscribe((emit) => {
    const onChange = () => emit(window.location.pathname);
    window.addEventListener('popstate', onChange);
    return () => window.removeEventListener('popstate', onChange);
  });
```

- `setup` runs once, at subscription time.
- Call `emit(value)` whenever the value changes.
- Return an unsubscribe function; the SDK calls it on `resources/unsubscribe` or when the session closes.
- `.subscribe()` does not terminate the builder - it returns `ResourceBuilder<T>` so you can keep chaining if you want.

## Patterns

### Debounce emissions

The agent can't usefully consume 60 emissions per second. Debounce:

```ts
.subscribe((emit) => {
  let t: ReturnType<typeof setTimeout> | null = null;
  const push = () => {
    if (t) clearTimeout(t);
    t = setTimeout(() => emit(stateSnapshot()), 200);
  };
  store.on('change', push);
  return () => { if (t) clearTimeout(t); store.off('change', push); };
});
```

### Memoise the read

If `.read()` is expensive and you also have `.subscribe()`, hold the latest emitted value and serve `.read()` from it:

```ts
let latest = initialValue();

tesseron.resource('filterState')
  .read(() => latest)
  .subscribe((emit) => {
    const onChange = () => { latest = compute(); emit(latest); };
    store.on('change', onChange);
    return () => store.off('change', onChange);
  });
```

### Typed schema

Schemas on resources feed into the MCP descriptor, same as actions:

```ts
.output(z.object({ search: z.string(), onlyDone: z.boolean() }))
.read(() => ({ search: state.search, onlyDone: state.onlyDone }))
```

Reads are not schema-validated at runtime by default - the schema is documentation. If you need enforcement, do it yourself inside `.read()` and `.subscribe()` emit.

## What to expose (and what not to)

Good resources:

- User's current route, selected item, filter state.
- "What's on screen right now" - the agent uses these to reason before acting.
- Counts and summaries - `todoStats`, `unreadCount`.
- Document content the agent is editing.

Bad resources:

- Credentials, session tokens, PII the user hasn't consented to share.
- Full database dumps - reads happen on demand and can be expensive.
- High-frequency streams (mouse position, scroll offset) - debounce or expose a summary instead.

## React adapter

`@tesseron/react` wraps the same builder as a hook:

```tsx
import { useTesseronResource } from '@tesseron/react';

useTesseronResource('currentRoute', () => window.location.pathname);
// or with options:
useTesseronResource('currentRoute', {
  description: 'Route',
  read: () => window.location.pathname,
  subscribe: (emit) => { /* … */ return () => {}; },
});
```

See [the react adapter page](/sdk/typescript/react/) for full hook docs.
