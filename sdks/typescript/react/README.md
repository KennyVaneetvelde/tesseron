<div align="center">
  <a href="https://github.com/eigenwise/tesseron">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-dark.png">
      <img src="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-light.png" alt="Tesseron" width="380">
    </picture>
  </a>
</div>

# @tesseron/react

React hooks adapter for [Tesseron](https://github.com/eigenwise/tesseron). Register actions, expose resources, and observe connection state from inside your components — no manual lifecycle wiring. Wraps [`@tesseron/web`](https://www.npmjs.com/package/@tesseron/web).

## Install

```bash
npm install @tesseron/react
```

Requires `react` ≥ 18. You also need the [`@tesseron/mcp`](https://www.npmjs.com/package/@tesseron/mcp) gateway running locally — bundled inside the [Claude Code plugin](https://github.com/eigenwise/tesseron/tree/main/plugin).

## Quick start

```tsx
import { useTesseronAction, useTesseronResource, useTesseronConnection } from '@tesseron/react';
import { z } from 'zod';
import { useState } from 'react';

export function TodoApp() {
  const [todos, setTodos] = useState<{ id: string; text: string; done: boolean }[]>([]);
  const { status, claimCode } = useTesseronConnection({ appId: 'todo_app', appName: 'Todo' });

  useTesseronAction('addTodo', {
    input: z.object({ text: z.string().min(1) }),
    handler: ({ text }) => {
      setTodos((t) => [...t, { id: crypto.randomUUID(), text, done: false }]);
    },
  });

  useTesseronResource('todoStats', {
    read: () => ({ total: todos.length, done: todos.filter((t) => t.done).length }),
  });

  return (
    <>
      {status === 'ready' && <p>Claim code: <code>{claimCode}</code></p>}
      <ul>{todos.map((t) => <li key={t.id}>{t.text}</li>)}</ul>
    </>
  );
}
```

Every hook tracks its registration with the active Tesseron client and cleans up on unmount. Handlers are held in refs, so closing over fresh state on every render works without re-registering.

## Hooks

| Hook | Purpose |
|---|---|
| `useTesseronConnection({ appId, appName })` | Connects (or attaches to) a client, exposes `status`, `claimCode`, `welcome`, and reconnect helpers. |
| `useTesseronAction(name, options)` | Registers an action for the component's lifetime. `options` mirrors the fluent builder (`input`, `output`, `annotations`, `timeoutMs`, `strictOutput`, `handler`). |
| `useTesseronResource(name, options)` | Registers a readable and/or subscribable resource. Pass `read`, `subscribe`, or both. |

## Pair with `@tesseron/web`

`@tesseron/react` re-exports the public surface of `@tesseron/web`, so you can mix raw calls (e.g. inside a module-level setup file) with the hooks. See [`examples/react-todo`](https://github.com/eigenwise/tesseron/tree/main/examples/react-todo) for a full app.

## Docs

| | |
|---|---|
| Main repo | <https://github.com/eigenwise/tesseron> |
| SDK reference | <https://eigenwise.github.io/tesseron/sdk/typescript/react/> |
| Protocol spec | <https://eigenwise.github.io/tesseron/protocol/> |
| Example app | <https://github.com/eigenwise/tesseron/tree/main/examples/react-todo> |

## License

Reference implementation — [Business Source License 1.1](https://github.com/eigenwise/tesseron/blob/main/LICENSE) (source-available). Each release auto-converts to Apache-2.0 four years after publication.

<p align="center">Built and maintained by <a href="https://eigenwise.io/"><b>Eigenwise</b></a>.</p>
