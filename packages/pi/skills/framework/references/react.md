# React hooks (`@tesseron/react`)

## Contents
- What the hooks wrap
- `useTesseronConnection`
- `useTesseronAction`
- `useTesseronResource`
- The ref pattern for stable registration
- Where to mount each hook
- Common mistakes

## What the hooks wrap

`@tesseron/react` re-exports the `@tesseron/web` singleton and wraps it in three React hooks so actions and resources can be registered from component bodies:

```ts
import {
  useTesseronAction,
  useTesseronResource,
  useTesseronConnection,
} from '@tesseron/react';
```

Under the hood each hook calls the same `tesseron.action(...).handler(...)` / `tesseron.resource(...).read(...)` / `tesseron.connect(...)` on the singleton, with a `useEffect` for registration and another for cleanup on unmount.

Every hook accepts an optional custom client as the last argument — omit it unless you're running multiple independent sessions:

```ts
useTesseronAction('addTodo', options /*, customClient */);
```

## `useTesseronConnection`

Opens (and maintains) the session. Call **once**, at the app root.

```ts
interface UseTesseronConnectionOptions {
  url?: string;      // override DEFAULT_GATEWAY_URL
  enabled?: boolean; // default true; set false to defer connection
}

interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  claimCode?: string;
  error?: Error;
}
```

```tsx
import { useTesseronConnection } from '@tesseron/react';

function App() {
  const conn = useTesseronConnection();

  if (conn.status === 'connecting') return <div>Connecting...</div>;
  if (conn.status === 'error') return <div>Connection failed: {conn.error?.message}</div>;
  if (conn.claimCode) {
    return (
      <div>
        In Claude, say: <code>claim session {conn.claimCode}</code>
      </div>
    );
  }
  return <Todos />;
}
```

**Register actions and resources before this hook runs.** The manifest announced in `tesseron/hello` is a snapshot at the moment of connect. Any `useTesseronAction` / `useTesseronResource` hooks that mount *after* `useTesseronConnection` are announced via `actions/list_changed` / `resources/list_changed` updates — valid, but slower to reach the agent.

The simplest guarantee is mounting your action/resource-declaring components as descendants of the component that holds `useTesseronConnection`, and rendering them unconditionally.

## `useTesseronAction`

Registers an action for the component's lifetime.

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
  handler: (input: I, ctx: ActionContext) => Promise<O> | O;
}

function useTesseronAction<I, O>(
  name: string,
  options: UseTesseronActionOptions<I, O>,
  client?: WebTesseronClient,
): void;
```

```tsx
import { useTesseronAction } from '@tesseron/react';
import { z } from 'zod';

function TodoList() {
  const [todos, setTodos] = useState<Todo[]>([]);

  useTesseronAction('addTodo', {
    description: 'Add a new todo item to the list. Returns the created todo.',
    input: z.object({ text: z.string().min(1), tag: z.string().optional() }),
    handler: ({ text, tag }) => {
      const todo = { id: crypto.randomUUID(), text, done: false, tag };
      setTodos((current) => [...current, todo]);
      return todo;
    },
  });

  useTesseronAction('completeTodo', {
    description: 'Mark a todo as completed.',
    input: z.object({ id: z.string() }),
    annotations: { destructive: false },
    handler: ({ id }) => {
      setTodos((current) =>
        current.map((t) => (t.id === id ? { ...t, done: true } : t)),
      );
      return { completed: true };
    },
  });

  return <ul>{todos.map(/* ... */)}</ul>;
}
```

On unmount, the hook calls `tesseron.removeAction(name)` automatically — no cleanup code in your component.

## `useTesseronResource`

Registers a resource for the component's lifetime. Accepts either a function (shorthand, read-only) or an options object.

```ts
interface UseTesseronResourceOptions<T> {
  description?: string;
  output?: StandardSchemaV1<T>;
  outputJsonSchema?: unknown;
  read?: () => T | Promise<T>;
  subscribe?: (emit: (value: T) => void) => () => void;
}

function useTesseronResource<T>(
  name: string,
  optionsOrReader: UseTesseronResourceOptions<T> | (() => T | Promise<T>),
  client?: WebTesseronClient,
): void;
```

**Shorthand** (read-only resource):

```tsx
useTesseronResource('todoCount', () => todos.length);
```

**Full form** with subscribe:

```tsx
function Dashboard({ todos }: { todos: Todo[] }) {
  const subscribers = useRef(new Set<(stats: Stats) => void>());

  // Notify subscribers whenever todos change
  useEffect(() => {
    for (const emit of subscribers.current) emit(computeStats(todos));
  }, [todos]);

  useTesseronResource('stats', {
    description: 'Todo statistics — total, completed, pending.',
    output: z.object({ total: z.number(), completed: z.number(), pending: z.number() }),
    subscribe: (emit) => {
      emit(computeStats(todos));
      subscribers.current.add(emit);
      return () => subscribers.current.delete(emit);
    },
  });

  return <StatsView />;
}
```

The `useRef<Set<...>>(new Set())` pattern gives the subscriber closure a stable reference to a subscriber registry whose membership is edited on mount/unmount and whose entries are invoked on state change.

## The ref pattern for stable registration

Both `useTesseronAction` and `useTesseronResource` store the incoming handler in a `useRef` internally. Every render updates the ref; registration itself happens only on mount and is never replayed for a fresh closure.

This is why **you do not need `useCallback` or `useMemo`** around the handler:

```tsx
// Both of these are equivalent from Tesseron's perspective.
// The hook only re-registers when `name` changes.

useTesseronAction('addTodo', {
  handler: ({ text }) => { /* reads latest state */ },
});

useTesseronAction('addTodo', {
  handler: useCallback(({ text }) => { /* same */ }, [/* deps */]),
});
```

The handler you pass on every render closes over the latest state; the hook makes sure the action always calls the *latest* handler. This sidesteps the classic stale-closure pitfall of registering a handler once on mount and then seeing old state when it fires.

## Where to mount each hook

- `useTesseronConnection` — once, at the root. Multiple connection hooks create multiple sessions, each with its own claim code.
- `useTesseronAction` — wherever the owning state lives. A component that owns `todos` state should own `addTodo` / `completeTodo`.
- `useTesseronResource` — wherever the state being exposed lives. Usually the same component as the related actions.

For app-wide actions that don't belong to a specific component (e.g. `logout`), mount them in a thin wrapper component that sits near the root:

```tsx
function TesseronActions() {
  const { logout } = useAuth();
  useTesseronAction('logout', {
    description: 'Log the user out.',
    annotations: { destructive: true, requiresConfirmation: true },
    handler: () => logout(),
  });
  return null; // no UI
}
```

## Common mistakes

- **Multiple `useTesseronConnection` hooks.** Each opens its own session; only one claim code is useful. Put it at the root.
- **`useCallback` / `useMemo` around the handler.** Unnecessary. The hook stores the handler in a ref; passing a fresh closure on every render is the intended API.
- **Conditional hook calls.** `if (...) useTesseronAction(...)` violates the rules of hooks. Use `enabled: false` on the connection hook to defer the whole session; for per-action toggles, render or skip a dedicated wrapper component.
- **Forgetting the cleanup function in `subscribe`.** Required. The hook's unmount path calls it — but only if you return it.
- **Mounting action hooks conditionally under a `useTesseronConnection` that's already open.** Those actions announce via `actions/list_changed`, which Claude honors but some agents don't. Prefer mounting actions above/beside the connection hook so they're in the initial manifest.
- **Closing over stale state without the ref pattern.** The built-in ref pattern handles this — don't manually `useRef` around the handler to "fix" it; just write the handler inline and it will see the latest state.
- **Using `useTesseronResource` for truly static values.** If a value never changes, just pass a function returning a constant — but consider whether the resource is earning its keep.
