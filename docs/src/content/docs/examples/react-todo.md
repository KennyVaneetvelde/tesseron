---
title: react-todo
description: React 18 + `@tesseron/react` hooks. Idiomatic integration with component lifecycle.
related:
  - sdk/typescript/react
  - sdk/typescript/web
---

**What it teaches:** declarative action registration in React. Mount = register; unmount = unregister. State is mutated through `setTodos` exactly like in a normal React app.

**Source:** [`examples/react-todo`](https://github.com/BrainBlend-AI/tesseron/tree/main/examples/react-todo)

## Run it

```bash
pnpm --filter react-todo dev
# http://localhost:5173
```

## What's inside

```tsx title="src/app.tsx (excerpt)"
import { useTesseronAction, useTesseronResource, useTesseronConnection } from '@tesseron/react';
import { z } from 'zod';
import { useState } from 'react';

export function App() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const conn = useTesseronConnection();

  useTesseronAction('addTodo', {
    description: 'Add a new todo item. Returns the created todo.',
    input: z.object({ text: z.string().min(1) }),
    handler: ({ text }) => {
      const todo = { id: newId(), text, done: false };
      setTodos((prev) => [...prev, todo]);
      return todo;
    },
  });

  useTesseronResource('todoStats', () => ({
    total: todos.length,
    completed: todos.filter((t) => t.done).length,
  }));

  return (
    <>
      {conn.claimCode && <ClaimBanner code={conn.claimCode} />}
      <TodoList todos={todos} />
    </>
  );
}
```

Features exercised: **all three React hooks (`useTesseronAction`, `useTesseronResource`, `useTesseronConnection`), annotations, Zod input, setState-driven UI reactivity, `ctx.confirm` (`clearCompleted`), `ctx.elicit` with schema (`renameTodo`), `ctx.progress` (`importTodos`), `ctx.sample` (`suggestTodos`), subscribable resources**.

See the [React adapter docs](/sdk/typescript/react/) for the full hook API.
