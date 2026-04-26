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
  resumeStatus?: 'none' | 'resumed' | 'failed';
}
```

`resumeStatus` is set when `status === 'open'`:

- `'none'` - no resume was attempted (no stored creds, or `resume` disabled).
- `'resumed'` - `tesseron/resume` succeeded; the prior session was reattached.
- `'failed'` - resume was attempted but the gateway rejected it; the hook fell back to a fresh `tesseron/hello` and persisted the new credentials. Useful for telemetry, and for UIs that want to show "your previous session expired" instead of silently switching to a new claim code.

`claimCode` clears automatically once the session has been claimed by an agent. The gateway sends a `tesseron/claimed` notification (see [protocol/handshake](/protocol/handshake/)) and the hook updates `claimCode` to `undefined` and merges the new `agent` identity into `welcome.agent` on the next render. Render the claim banner with `connection.claimCode != null` (rather than from a snapshot taken at mount time) and it will disappear on its own after the agent claims.

Options:

```ts
interface UseTesseronConnectionOptions {
  url?: string;      // defaults to `<location.origin>/@tesseron/ws` (served by @tesseron/vite)
  enabled?: boolean; // gate the connect, e.g. only when logged in
  resume?: boolean | string | ResumeStorage;
}
```

Only one component should call `useTesseronConnection` per client - it owns the WebSocket. Most apps put it at the root.

### Surviving page refresh / HMR with `resume`

By default, every page load of an app that uses `useTesseronConnection` starts a brand-new session, which means a brand-new claim code on every refresh. For most local-dev React apps that's exactly the wrong default - flip `resume: true` and the hook persists the `sessionId` / `resumeToken` from each handshake in `localStorage`, then sends `tesseron/resume` instead of `tesseron/hello` on the next page load. The agent stays paired across refreshes, HMR reloads, and brief network blips:

```tsx
const conn = useTesseronConnection({ resume: true });
```

The hook handles the backing protocol details for you - token rotation, the [`ResumeFailed`](/protocol/resume/) fallback to a fresh hello when the gateway zombie has expired, and clearing stale credentials. Inspect `conn.resumeStatus` to tell whether the current session was resumed (`'resumed'`), is a fallback after a rejected resume (`'failed'`), or was a plain hello (`'none'`). See [Session resume](/protocol/resume/) for the underlying primitives.

The `resume` option accepts three forms:

| Form | Behaviour |
|---|---|
| `true` | Persist in `localStorage` under `'tesseron:resume'`. |
| `string` | Persist in `localStorage` under that exact key. Use a per-app value if you mount multiple `WebTesseronClient` instances on one page. |
| `ResumeStorage` | Custom `{ load, save, clear }` callbacks (sync or async). Use this when `localStorage` is not available - Electron with strict CSP, an iframe partition, the OS keychain, etc. |

```ts
interface ResumeStorage {
  load: () =>
    | ResumeCredentials
    | null
    | undefined
    | Promise<ResumeCredentials | null | undefined>;
  save: (credentials: ResumeCredentials) => void | Promise<void>;
  clear: () => void | Promise<void>;
}
```

Resume tokens are one-shot - the gateway rotates the token on every successful handshake (hello or resume), so the hook always overwrites the stored value with the freshest token. After a successful resume `welcome.claimCode` is `undefined`, since the session is already claimed.

Resume re-establishes the session, **not** its `resources/subscribe` bindings. `useTesseronResource` re-registers subscriptions naturally on remount, so apps using the provided hooks see no behavioural difference; if you wire subscriptions by hand against the lower-level client, re-subscribe after each connect.

Storage failures (private mode, quota exceeded, a throwing custom backend) are non-fatal: the hook treats them as a no-op for save/clear, and as "no saved session" for load. The connection itself is never failed by storage problems.

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
