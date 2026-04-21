# react-todo

A real React 18 todo app whose state is also drivable by Claude through the [`@tesseron/react`](../../packages/react) hooks. **Adding, toggling, deleting, and clearing todos all happen via React `useState` — and they all update the visible list in real time when Claude calls the corresponding action.**

## What you'll see live

- Open the page. The connect card surfaces the claim code automatically (no button click needed — `useTesseronConnection` handles the lifecycle).
- After you claim the session, ask Claude things like *"add a todo to buy milk"*.
- The todo appears in the list **the same instant** Claude responds. Same with `toggleTodo`, `deleteTodo`, `clearCompleted`.
- `setFilter` flips the visible filter chips — yet another live UI update from Claude.

## Quick start

> One-time MCP-client setup: [examples/README.md](../README.md#one-time-setup).

```bash
pnpm --filter react-todo dev
```

Open <http://localhost:5174>. The claim code appears in the **Status: open** card at the top of the page. In Claude:

```
claim session ABCD-XY
```

## Try these prompts

- *"What todos do I have?"* — `todos__listTodos()` returns the array.
- *"Add a todo: buy milk."* — `todos__addTodo({ text: 'buy milk' })`. Watch the list grow.
- *"What's the id of the first todo?"* (or just look at the page) — then *"toggle todo `t4`"* → checkbox flips.
- *"Delete the milk todo."* — destructive, the agent may confirm.
- *"Switch the filter to active."* — chips update on screen.
- *"Clear all completed todos."* — annotated `requiresConfirmation`, so good MCP clients will ask before executing.

## Tools and resources exposed

| Tool name | Annotations | What it does |
|---|---|---|
| `todos__addTodo` | — | Append a new todo |
| `todos__toggleTodo` | — | Flip done/undone |
| `todos__deleteTodo` | destructive | Remove by id |
| `todos__clearCompleted` | destructive, requiresConfirmation | Remove all done items; gates on `ctx.confirm` |
| `todos__renameTodo` | — | Rename a todo via `ctx.elicit` with a schema |
| `todos__importTodos` | — | Bulk-import; streams `ctx.progress` per item |
| `todos__suggestTodos` | — | Ask the agent LLM via `ctx.sample` for a themed list |
| `todos__listTodos` | readOnly | Read the list, optionally filtered |
| `todos__setFilter` | — | Change visible filter |

| Resource URI (subscribable) | What it returns |
|---|---|
| `tesseron://todos/currentFilter` | `'all' \| 'active' \| 'completed'` |
| `tesseron://todos/todoStats` | `{ total, completed, pending }` |

## How the live updates work

[`src/app.tsx`](./src/app.tsx) wires every action to React state via the hooks adapter:

```tsx
import { useTesseronAction } from '@tesseron/react';

useTesseronAction('addTodo', {
  description: 'Add a new todo item.',
  input: z.object({ text: z.string().min(1) }),
  handler: ({ text }) => {
    const todo = { id: newId(), text, done: false };
    setTodos((current) => [...current, todo]);  // <- React re-renders
    return todo;
  },
});
```

When Claude calls `todos__addTodo`:

1. The MCP gateway receives the call and routes it to this session.
2. The web SDK invokes the registered handler in your browser tab.
3. The handler calls `setTodos`, which is a normal React state update.
4. React re-renders the `<ul className="todos">` and the new item appears.
5. The handler's return value goes back to Claude as the tool result.

The whole round trip is sub-100ms locally.

The hooks register on mount and **deregister on unmount** (the gateway emits `notifications/tools/list_changed` so the agent's tool list stays in sync), which is what makes this safe to use in dynamic component trees.

## Troubleshooting

- **Status stuck at `connecting`:** MCP gateway isn't reachable. See the [shared troubleshooting table](../README.md#troubleshooting).
- **Tools don't appear in Claude after claim:** check the agent's MCP server panel for an active connection to `tesseron`; reconnect if needed.
- **Strict Mode double-effect in dev:** React 18 StrictMode runs effects twice in dev. The hook's cleanup (`removeAction`) handles this fine.

## Adapt it

- Wrap real state (a Zustand store, a React Query cache, a context) instead of `useState` — pass the mutator into the handler the same way.
- Add more destructive actions that gate on `ctx.confirm()` — `clearCompleted` is the baseline. For structured prompts, use `ctx.elicit()` with a schema (see the [Phase 3 elicitation tests](../../packages/mcp/test/phase3.test.ts)).
- Surface live data via `useTesseronResource` so Claude can read app state on demand without a tool call.
