# node-todo

The same todo domain as the other examples — but in **a plain Node script**. No Express, no HTTP server, no browser, no framework.

This is the example to read if you want to give Claude actions on a Node CLI, daemon, cron worker, or background process. The SDK doesn't care what kind of Node process you run it from — it just needs an outgoing WebSocket to the MCP gateway.

## Quick start

> One-time MCP-client setup: [examples/README.md](../README.md#one-time-setup).

```bash
pnpm --filter node-todo dev
```

You'll see something like:

```
[14:12:07] node-todo starting up
[14:12:07] state: 3 todos (1 done, 2 pending), filter=all
[14:12:07] connected to gateway. session=s_…
[14:12:07] claim code: ABCD-XY
[14:12:07] tell Claude: "claim session ABCD-XY"
[14:12:07] watching for actions. Ctrl-C to exit.
```

In Claude:

```
claim session ABCD-XY
```

Then watch the terminal. Every Claude invocation logs a line so you can correlate prompts with state changes.

## Try these prompts

- *"Add a todo for buying milk."* — calls `node_todo__addTodo({ text: 'buy milk' })`. Terminal logs `+ addTodo: "buy milk" (id=t1)` (the list starts empty, so the first id is `t1`).
- *"Mark the todo you just added as done."* — `node_todo__toggleTodo({ id: 't1' })`. Logs `~ toggleTodo t1: done=true`.
- *"Clear completed todos."* — `node_todo__clearCompleted`. Annotated `destructive + requiresConfirmation`.
- *"Read tesseron://node_todo/todoStats."* — resource read of the aggregate counts.

## Tools and resources exposed

| Tool name | Annotations | What it does |
|---|---|---|
| `node_todo__addTodo` | — | Append a todo. |
| `node_todo__toggleTodo` | — | Flip `done`. |
| `node_todo__deleteTodo` | destructive | Remove a todo. |
| `node_todo__clearCompleted` | destructive, requiresConfirmation | Remove all done; gates on `ctx.confirm`. |
| `node_todo__renameTodo` | — | Rename a todo via `ctx.elicit` with a schema. |
| `node_todo__importTodos` | — | Bulk-import; streams `ctx.progress` per item. |
| `node_todo__suggestTodos` | — | Ask the agent LLM via `ctx.sample` for a themed list. |
| `node_todo__listTodos` | readOnly | Snapshot, optionally filtered. |
| `node_todo__setFilter` | — | Change the active filter. |

| Resource URI (subscribable) | What it returns |
|---|---|
| `tesseron://node_todo/currentFilter` | `'all' \| 'active' \| 'completed'` |
| `tesseron://node_todo/todoStats` | `{ total, completed, pending }` |

## How it works

[`src/index.ts`](./src/index.ts) is ~120 lines — actions and resources plus some terminal logging. The integration is three moves:

```ts
import { tesseron } from '@tesseron/server';
import { z } from 'zod';

tesseron.app({ id: 'node_todo', name: 'Node Todo Service' });

tesseron
  .action('addTodo')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    // plain JS — mutate whatever you like
  });

const welcome = await tesseron.connect();
console.log(`claim code: ${welcome.claimCode}`);
```

Because this is a plain Node script, you can drop this same pattern into **any** Node entrypoint: a CLI built with commander, a BullMQ worker, a systemd-managed daemon, a Lambda handler that keeps a long-lived WS, whatever. The SDK just needs to call `tesseron.connect()` once the process is alive.

## Troubleshooting

- **`failed to connect to gateway`:** the MCP gateway isn't running. Check your MCP client config (it should spawn it), or run `pnpm --filter @tesseron/mcp start` standalone.
- **Port 7475 already in use:** another example is already holding a connection. That's fine — the gateway multiplexes sessions; you'll just get a different claim code. If you want to isolate this example, set `TESSERON_PORT=7476` on both the gateway and this process.

## Adapt it

- Swap the in-memory `Map` for a real database, Redis, SQLite — handlers are plain async functions.
- `importTodos` already shows `ctx.progress({ message, percent })` streaming per-item updates; adapt the loop for any long-running action.
- `suggestTodos` already shows `ctx.sample({ prompt, schema })` — use it to have the agent LLM reason over data held on your side.
- Layer this on top of an existing CLI: your `commander`/`yargs` subcommands run as usual; the MCP side runs concurrently on the same process.
