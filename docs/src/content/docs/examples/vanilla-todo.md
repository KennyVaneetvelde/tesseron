---
title: vanilla-todo
description: Plain Vite + TypeScript. The minimum environment for exercising the SDK.
related:
  - sdk/typescript/web
  - sdk/typescript/index
---

**What it teaches:** the raw action / resource builder API with no framework in the way. Read this before any of the framework-specific examples.

**Source:** [`examples/vanilla-todo`](https://github.com/BrainBlend-AI/tesseron/tree/main/examples/vanilla-todo)

## Run it

```bash
pnpm --filter vanilla-todo dev
# opens http://localhost:5173
```

## What's inside

```ts title="src/main.ts (excerpt)"
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

tesseron.app({ id: 'vanilla_todo', name: 'Vanilla Todo' });

tesseron
  .action('addTodo')
  .describe('Add a new todo item. Returns the created todo.')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    const todo = { id: newId(), text, done: false };
    state.todos = [...state.todos, todo];
    render();
    return todo;
  });

tesseron.action('toggleTodo')
  .input(z.object({ id: z.string() }))
  .annotate({ destructive: true })
  .handler(/* … */);

tesseron.resource('todoStats')
  .read(() => ({ total: state.todos.length, completed: state.todos.filter(t => t.done).length }));

await tesseron.connect();
```

Nine actions (`addTodo`, `toggleTodo`, `deleteTodo`, `listTodos`, `setFilter`, `clearCompleted`, `renameTodo`, `importTodos`, `suggestTodos`) and two subscribable resources (`currentFilter`, `todoStats`) - a realistic-but-contained surface for experimenting.

Features exercised: **actions, annotations (`destructive`, `requiresConfirmation`, `readOnly`), subscribable resources, Zod input validation, `ctx.confirm` (in `clearCompleted`), `ctx.elicit` with schema (in `renameTodo`), `ctx.progress` (in `importTodos`), `ctx.sample` (in `suggestTodos`), connection lifecycle**.
