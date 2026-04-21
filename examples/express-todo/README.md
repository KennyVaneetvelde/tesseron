# express-todo

The same todo domain as [`vanilla-todo`](../vanilla-todo) / [`react-todo`](../react-todo) / [`svelte-todo`](../svelte-todo) / [`vue-todo`](../vue-todo) — but **server-side**, with a real Express REST API backing the same state.

This is the example to read if you want to give Claude operational access to a backend service. The same todo store is served two ways:

- **HTTP:** `GET/POST/PATCH/DELETE /todos` for any HTTP client (curl, another service, a frontend).
- **MCP:** the same actions exposed to Claude via [`@tesseron/server`](../../packages/server).

Both channels mutate the same in-memory `Map`. Claude and your frontend see each other's writes.

## What you'll see live

There's no UI — it's a backend. Observe effects in two places:

- **Server stdout.** Each claim / connect logs a line.
- **curl.** Before-and-after `curl http://localhost:3001/todos` shows the state Claude is mutating.

## Quick start

> One-time MCP-client setup: [examples/README.md](../README.md#one-time-setup).

```bash
pnpm --filter express-todo dev
```

You'll see something like:

```
[todo] Express HTTP API on http://localhost:3001
[todo] connected to gateway. session=s_… claim=ABCD-XY
[todo] tell Claude: "claim session ABCD-XY"
```

In Claude:

```
claim session ABCD-XY
```

## Try these prompts

- *"What todo tools do you have?"* — Claude lists `express_todo__addTodo`, `…__toggleTodo`, `…__deleteTodo`, `…__clearCompleted`, `…__listTodos`, `…__setFilter`.
- *"Add a todo for buying milk."* — calls `express_todo__addTodo({ text: 'buy milk' })`. The returned `id` is now available on the REST API too.
- In another terminal: `curl http://localhost:3001/todos` — the todo Claude added is there. Same state, two access channels.
- *"Mark the todo you just added as done."* — `express_todo__toggleTodo({ id: 't1' })` (the list starts empty, so the first added todo is `t1`). Then: `curl -X PATCH -H 'content-type: application/json' -d '{"done":false}' http://localhost:3001/todos/t1` — you just undid what Claude did; if you ask Claude to list again it sees the new state.
- *"Clear completed todos."* — `express_todo__clearCompleted`. Annotated `destructive + requiresConfirmation`, so compliant MCP clients prompt first.
- *"Read tesseron://express_todo/todoStats."* — resource read of the aggregate counts.

## Tools and resources exposed

| Tool name | Annotations | What it does |
|---|---|---|
| `express_todo__addTodo` | — | Append a todo. |
| `express_todo__toggleTodo` | — | Flip `done`. |
| `express_todo__deleteTodo` | destructive | Remove a todo. |
| `express_todo__clearCompleted` | destructive, requiresConfirmation | Remove all done; gates on `ctx.confirm`. |
| `express_todo__renameTodo` | — | Rename a todo via `ctx.elicit` with a schema. |
| `express_todo__importTodos` | — | Bulk-import; streams `ctx.progress` per item. |
| `express_todo__suggestTodos` | — | Ask the agent LLM via `ctx.sample` for a themed list. |
| `express_todo__listTodos` | readOnly | Snapshot, optionally filtered. |
| `express_todo__setFilter` | — | Change the default filter for `GET /todos`. |

| Resource URI (subscribable) | What it returns |
|---|---|
| `tesseron://express_todo/currentFilter` | `'all' \| 'active' \| 'completed'` |
| `tesseron://express_todo/todoStats` | `{ total, completed, pending }` |

| REST endpoint | Behavior |
|---|---|
| `GET /todos?filter=…` | List todos (filter defaults to the current `setFilter` value). |
| `POST /todos {text}` | Create. |
| `PATCH /todos/:id {text?, done?}` | Update. |
| `DELETE /todos/:id` | Remove. |
| `GET /healthz` | `{ ok: true }`. |

## How it works

[`src/index.ts`](./src/index.ts) is a single file. The Tesseron setup is inline with the Express app — they share the same `Map<string, Todo>`:

```ts
import express from 'express';
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

const todos = new Map<string, Todo>();

// HTTP
const app = express();
app.get('/todos', (_req, res) => res.json(Array.from(todos.values())));
app.post('/todos', (req, res) => { /* ... */ });

// MCP on the SAME map
tesseron.app({ id: 'express_todo', name: 'Express Todo Backend', origin: '...' });

tesseron
  .action('addTodo')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    const todo = { id: newId(), text, done: false };
    todos.set(todo.id, todo);
    return todo;
  });

app.listen(PORT, async () => {
  const welcome = await tesseron.connect();
  console.log(`[todo] tell Claude: "claim session ${welcome.claimCode}"`);
});
```

`@tesseron/server` connects out to the local MCP gateway over a Node WebSocket (the `ws` package). From there everything is identical to the browser SDK — same builder API, same handler context, same JSON-RPC envelope.

## Troubleshooting

- **`failed to connect to gateway`:** the MCP gateway isn't running. Check your MCP client config (it should spawn it), or run `pnpm --filter @tesseron/mcp start` standalone.
- **Port 3001 in use:** override with `PORT=4000 pnpm --filter express-todo dev`.

## Adapt it

- Swap the `Map` for a real database call (Prisma, Drizzle, raw SQL) — handlers are plain async functions.
- `importTodos` already shows `ctx.progress({ message, percent })` streaming per-item updates; the gateway forwards them as MCP `notifications/progress`.
- `suggestTodos` already shows `ctx.sample({ prompt, schema })` asking the agent's LLM to produce structured data — no API key needed on this side.
- `renameTodo` already shows structured `ctx.elicit({ question, schema, jsonSchema })`; adapt the pattern for any destructive-but-parameterless action.
