---
title: node-todo
description: Headless Node service - no HTTP, no browser. Proves the SDK isn't tied to DOM.
---

**What it teaches:** a pure-Node Tesseron integration. No Express, no web server - just a Node script that registers actions and connects. Good when you're building a CLI, a daemon, or a worker that Claude should drive.

**Source:** [`examples/node-todo`](https://github.com/KennyVaneetvelde/tesseron/tree/main/examples/node-todo)

## Run it

```bash
pnpm --filter node-todo dev
# prints the claim code to stdout; no browser
```

## What's inside

```ts title="src/index.ts (excerpt)"
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

const todos = new Map<string, Todo>();

tesseron.app({ id: 'node_todo', name: 'Node Todo' });

tesseron.action('addTodo')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    const todo = { id: newId(), text, done: false };
    todos.set(todo.id, todo);
    log(`+ addTodo: "${text}" (id=${todo.id})`);
    return todo;
  });

tesseron.resource('todoStats')
  .read(() => ({ total: todos.size, completed: [...todos.values()].filter(t => t.done).length }));

const welcome = await tesseron.connect();
log(`Tesseron ready. Claim code: ${welcome.claimCode}`);

process.on('SIGINT', async () => { await tesseron.disconnect(); process.exit(0); });
```

Features exercised: **actions, annotations, subscribable resources, `ctx.confirm` (`clearCompleted`), `ctx.elicit` with schema (`renameTodo`), `ctx.progress` (`importTodos`), `ctx.sample` (`suggestTodos`), structured logging via `log()`, signal-aware shutdown**.

The same nine actions as `vanilla-todo`, but persistence is an in-memory `Map` and there's no UI - the agent is the only way to interact.
