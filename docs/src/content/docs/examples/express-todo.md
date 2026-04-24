---
title: express-todo
description: REST API + Tesseron on the same Node process, backed by the same state.
related:
  - sdk/typescript/server
  - examples/node-todo
---

**What it teaches:** how to expose the same backend operations via two channels at once - HTTP for human / programmatic clients, Tesseron for the agent. Neither knows the other exists.

**Source:** [`examples/express-todo`](https://github.com/BrainBlend-AI/tesseron/tree/main/examples/express-todo)

## Run it

```bash
pnpm --filter express-todo dev
# REST on http://localhost:3001
# WS -> gateway on ws://127.0.0.1:7475
```

## Pattern: shared state, two interfaces

```ts title="src/index.ts (excerpt)"
import express from 'express';
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

const todos = new Map<string, Todo>();

// --- REST ---
const app = express();
app.post('/todos', (req, res) => {
  const todo = { id: newId(), text: req.body.text, done: false };
  todos.set(todo.id, todo);
  res.json(todo);
});
// GET /todos, PATCH /todos/:id, DELETE /todos/:id ...

// --- Tesseron ---
tesseron.app({ id: 'express_todo', name: 'Express Todo' });

tesseron.action('addTodo')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    const todo = { id: newId(), text, done: false };
    todos.set(todo.id, todo);
    return todo;
  });

// start both
app.listen(3001);
const welcome = await tesseron.connect();
console.log('Tesseron claim code:', welcome.claimCode);
```

Features exercised: **actions, annotations, subscribable resources, `ctx.confirm` (`clearCompleted`), `ctx.elicit` with schema (`renameTodo`), `ctx.progress` (`importTodos`), `ctx.sample` (`suggestTodos`), coexistence with an HTTP server in one process**.

## When this pattern fits

- You already have a backend and want Claude to drive it without duplicating business logic.
- You want a single source of truth (the `Map`, in this example - a database, in real life).
- You want the two channels to stay out of each other's way - no HTTP calls pretending to be agent calls, no awkward "AI mode" in your REST routes.
