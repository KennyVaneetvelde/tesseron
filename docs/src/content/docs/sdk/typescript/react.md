---
title: "@tesseron/react"
description: Hooks for declarative action and resource registration inside React components.
related:
  - sdk/typescript/web
  - sdk/typescript/action-builder
---

`@tesseron/react` wraps `@tesseron/web` in three hooks. Registration becomes a declarative part of your component tree; unmount tears down cleanly.

No `<Provider>` is required - the hooks use the `tesseron` singleton from `@tesseron/web` by default. Pass an explicit client as the last argument if you need multiple clients in one tree.

## Exports

```ts
import {
  useTesseronAction,
  useTesseronResource,
  useTesseronConnection,
  // Option types
  UseTesseronActionOptions,
  UseTesseronResourceOptions,
  UseTesseronConnectionOptions,
  // State
  TesseronConnectionState,
} from '@tesseron/react';
```

The full `@tesseron/web` surface is re-exported too.

## `useTesseronConnection`

Manages the WebSocket for the component's lifetime.

```tsx
function App() {
  const { status, claimCode, welcome, error } = useTesseronConnection();

  if (status === 'connecting') return <p>Connecting to Tesseron…</p>;
  if (status === 'error')      return <p>Gateway unavailable: {error?.message}</p>;
  if (status === 'open')       return <ClaimBanner code={claimCode!} />;
  return null;
}
```

State shape:

```ts
interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  claimCode?: string;
  error?: Error;
}
```

Options:

```ts
interface UseTesseronConnectionOptions {
  url?: string;     // defaults to `<location.origin>/@tesseron/ws` (served by @tesseron/vite)
  enabled?: boolean; // gate the connect, e.g. only when logged in
}
```

Only one component should call `useTesseronConnection` per client - it owns the WebSocket. Most apps put it at the root.

## `useTesseronAction`

Registers a typed action for the component's lifetime.

```tsx
useTesseronAction('addTodo', {
  description: 'Add a new todo',
  input: z.object({ text: z.string().min(1) }),
  handler: ({ text }) => {
    const todo = { id: uuid(), text, done: false };
    setTodos((prev) => [...prev, todo]);
    return todo;
  },
});
```

Options:

```ts
interface UseTesseronActionOptions<I, O> {
  description?: string;
  input?: StandardSchemaV1<I>;
  inputJsonSchema?: unknown;
  output?: StandardSchemaV1<O>;
  outputJsonSchema?: unknown;
  annotations?: ActionAnnotations;
  timeoutMs?: number;
  strictOutput?: boolean;
  handler: (input: I, ctx: ActionContext) => O | Promise<O>;
}
```

Notes:

- The handler is held via a ref internally, so calling state setters from inside works without stale closures.
- The action is registered on mount and unregistered on unmount. Be aware that agents cache tool lists - rapidly mounting/unmounting actions produces `tools/list_changed` spam.
- The hook returns nothing. The action is invoked by the agent, not by your component.

## `useTesseronResource`

Registers a resource for the component's lifetime. Two call shapes, same result.

```tsx
// Short form - read-only resource
useTesseronResource('todoStats', () => ({
  total: todos.length,
  completed: todos.filter((t) => t.done).length,
}));
```

```tsx
// Full form - with description + subscribe
useTesseronResource('filterState', {
  description: 'Current todo filter',
  read: () => ({ search, onlyDone }),
  subscribe: (emit) => {
    const onChange = () => emit({ search, onlyDone });
    store.on('filter', onChange);
    return () => store.off('filter', onChange);
  },
});
```

Options:

```ts
interface UseTesseronResourceOptions<T> {
  description?: string;
  output?: StandardSchemaV1<T>;
  outputJsonSchema?: unknown;
  read?: () => T | Promise<T>;
  subscribe?: (emit: (value: T) => void) => () => void;
}
```

## Conditional registration

`useTesseronAction` / `useTesseronResource` both run every render; they're no-ops when the connection isn't `open`. To register an action only for authenticated users, gate the hook by mounting / unmounting the component:

```tsx
return (
  <>
    {user && <ActionsForLoggedInUsers />}
    <GlobalActions />
  </>
);
```

Don't try to conditionally call the hooks themselves - that breaks the Rules of Hooks.

## Full component example

Pulled from `examples/react-todo/src/app.tsx`:

```tsx
import { useTesseronAction, useTesseronConnection, useTesseronResource } from '@tesseron/react';
import { z } from 'zod';
import { useState } from 'react';

type Todo = { id: string; text: string; done: boolean };

export function TodoApp() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const conn = useTesseronConnection();

  useTesseronAction('addTodo', {
    description: 'Add a new todo item. Returns the created todo.',
    input: z.object({ text: z.string().min(1) }),
    handler: ({ text }) => {
      const todo = { id: crypto.randomUUID(), text, done: false };
      setTodos((prev) => [...prev, todo]);
      return todo;
    },
  });

  useTesseronAction('toggleTodo', {
    input: z.object({ id: z.string() }),
    annotations: { destructive: true },
    handler: ({ id }) => {
      setTodos((prev) =>
        prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)),
      );
      return { id };
    },
  });

  useTesseronResource('todoStats', () => ({
    total: todos.length,
    completed: todos.filter((t) => t.done).length,
  }));

  return (
    <>
      {conn.status === 'open' && conn.claimCode && (
        <ClaimBanner code={conn.claimCode} />
      )}
      <TodoList todos={todos} />
    </>
  );
}
```
