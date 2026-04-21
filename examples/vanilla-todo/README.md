# vanilla-todo

The same todo app as [`react-todo`](../react-todo), [`svelte-todo`](../svelte-todo), and [`vue-todo`](../vue-todo) — but with **zero framework**. Vite + vanilla TypeScript, hand-rolled DOM rendering, one file.

This is the example to read first — it shows the SDK as directly as possible.

## What you'll see live

- The page loads and auto-connects to the MCP gateway. A 6-character claim code appears.
- After you claim the session in Claude and ask it to add/toggle/delete todos, **the DOM updates immediately** — the same reactive-state-from-Claude pattern you get with React/Svelte/Vue, but powered by a plain `render()` function.
- Resources (`currentFilter`, `todoStats`) give Claude read-only views of UI state.

## Quick start

> One-time MCP-client setup is documented [here](../README.md#one-time-setup). The block below assumes you've already wired the MCP gateway into Claude Code or Claude Desktop.

```bash
# from the repo root
pnpm --filter vanilla-todo dev
```

Open <http://localhost:5173>.

1. Copy the claim code (e.g. `WXYZ-12`) shown on the page.
2. In Claude, type: `claim session WXYZ-12`.
3. Try the prompts below. Watch the page update.

## Try these prompts

- *"List the current todos."* — calls `vanilla_todo__listTodos`.
- *"Add a todo for buying milk."* — calls `vanilla_todo__addTodo({ text: 'buy milk' })`.
- *"Mark the milk todo done."* — Claude will first `listTodos`, then `toggleTodo({ id })`.
- *"Delete all completed todos."* — calls `vanilla_todo__clearCompleted` (annotated destructive + requiresConfirmation).
- *"Show only active todos."* — calls `vanilla_todo__setFilter({ filter: 'active' })`. The filter bar updates live.

## Tools exposed

| Tool name | Input | What it does |
|---|---|---|
| `vanilla_todo__addTodo` | `{ text: string, tag?: string }` | Appends a new todo. |
| `vanilla_todo__toggleTodo` | `{ id: string }` | Flips `done`. |
| `vanilla_todo__deleteTodo` | `{ id: string }` | Removes a todo. Destructive. |
| `vanilla_todo__clearCompleted` | — | Removes all completed. Destructive + requires confirmation; uses `ctx.confirm`. |
| `vanilla_todo__renameTodo` | `{ id: string }` | Renames a todo via `ctx.elicit` (schema-validated follow-up). |
| `vanilla_todo__importTodos` | `{ items: string[], tag?: string }` | Bulk-import; streams `ctx.progress` updates. |
| `vanilla_todo__suggestTodos` | `{ theme: string, count?: number }` | Asks the agent LLM via `ctx.sample` for a themed list, then adds them. |
| `vanilla_todo__listTodos` | `{ filter?: 'all'\|'active'\|'completed' }` | Read-only snapshot. |
| `vanilla_todo__setFilter` | `{ filter: 'all'\|'active'\|'completed' }` | Changes the visible filter. |

Subscribable resources: `tesseron://vanilla_todo/currentFilter`, `tesseron://vanilla_todo/todoStats`.

## How it works

Look at [`src/main.ts`](./src/main.ts). The integration is ~30 lines of SDK calls plus the `render()` function. Core pattern:

```ts
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

tesseron.app({ id: 'vanilla_todo', name: 'Vanilla Todo' });

tesseron
  .action('addTodo')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    state.todos.push({ id: newId(), text, done: false });
    render();
    return { ok: true };
  });

await tesseron.connect(); // auto-connects on load
```

The handler mutates the same `state` object that your DOM-rendering code reads. When Claude invokes the tool, your handler runs, mutates state, and the next `render()` shows the change.

## Troubleshooting

- **`Connect Claude` says "error":** the MCP gateway isn't reachable on `ws://localhost:7475`. Confirm the gateway is running (your MCP client should have spawned it; check its server status, or run `pnpm --filter @tesseron/mcp start` standalone in another terminal).
- **Claude can't see `vanilla_todo__*` tools:** make sure you claimed the session with the exact 6-character code from the page. Each browser refresh issues a new claim code. If the tools still don't appear, your MCP client may be caching its tool list ([Claude Code #50515](https://github.com/anthropics/claude-code/issues/50515)) — use the meta dispatcher as a fallback: `tesseron__list_actions()` then `tesseron__invoke_action({app_id: 'vanilla_todo', action: 'addTodo', args: {text: 'hello'}})`. See the [troubleshooting table](../README.md#troubleshooting).

## Adapt it

- Add an action: copy any of the `tesseron.action(...)` blocks, change the name, write your handler.
- Talk to your real app: replace the body of a handler with your existing logic — append to a list, mutate state, call your store. The browser SDK doesn't care what runs inside the handler.
- Move to a framework: see [`react-todo`](../react-todo), [`svelte-todo`](../svelte-todo), or [`vue-todo`](../vue-todo) for hooks/runes/refs flavors of the exact same app.
