# vue-todo

A real Vue 3 (composition API) todo app whose state is also drivable by Claude through [`@tesseron/web`](../../packages/web). Same scenario as [`svelte-todo`](../svelte-todo), in Vue's reactivity model — `ref()` instead of runes. **Adding, toggling, deleting, filtering, and clearing todos all update the visible list the instant Claude calls an action.**

## What you'll see live

- Open the page. The connect card surfaces the claim code — `tesseron.connect()` runs in `onMounted`.
- After you claim the session, ask Claude *"add a todo to buy milk"*.
- The todo appears in the list **the same instant** Claude responds.
- The filter chips flip to whatever Claude picks — pure Vue reactivity driven from the chat.

## Quick start

> One-time MCP-client setup: [examples/README.md](../README.md#one-time-setup).

```bash
pnpm --filter vue-todo dev
```

Open <http://localhost:5176>. The claim code appears in the **Status: open** card at the top of the page. In Claude:

```
claim session ABCD-XY
```

## Try these prompts

- *"What todos do I have?"* — `vue_todo__listTodos()` returns the array.
- *"Add a todo: buy milk."* — `vue_todo__addTodo({ text: 'buy milk' })`. Watch the list grow.
- *"Toggle todo `t4`."* — checkbox flips.
- *"Delete the milk todo."* — destructive, the agent may confirm.
- *"Switch the filter to active."* — chips update on screen.
- *"Clear all completed todos."* — annotated `requiresConfirmation`.
- *"Read the tesseron stats resource."* — Claude calls `resources/read` on `tesseron://vue_todo/todoStats`.

## Tools and resources exposed

| Tool name | Annotations | What it does |
|---|---|---|
| `vue_todo__addTodo` | — | Append a new todo |
| `vue_todo__toggleTodo` | — | Flip done/undone |
| `vue_todo__deleteTodo` | destructive | Remove by id |
| `vue_todo__clearCompleted` | destructive, requiresConfirmation | Remove all done items; gates on `ctx.confirm` |
| `vue_todo__renameTodo` | — | Rename a todo via `ctx.elicit` with a schema |
| `vue_todo__importTodos` | — | Bulk-import; streams `ctx.progress` per item |
| `vue_todo__suggestTodos` | — | Ask the agent LLM via `ctx.sample` for a themed list |
| `vue_todo__listTodos` | readOnly | Read the list, optionally filtered |
| `vue_todo__setFilter` | — | Change visible filter |

| Resource URI (subscribable) | What it returns |
|---|---|
| `tesseron://vue_todo/currentFilter` | `'all' \| 'active' \| 'completed'` |
| `tesseron://vue_todo/todoStats` | `{ total, completed, pending }` |

## How the live updates work

[`src/app.vue`](./src/app.vue) wires every action to a `ref`:

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

const todos = ref<Todo[]>([]);

tesseron
  .action('addTodo')
  .describe('Add a new todo item.')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    const todo = { id: newId(), text, done: false };
    todos.value = [...todos.value, todo];   // <- Vue tracks the ref write
    return todo;
  });
</script>
```

When Claude calls `vue_todo__addTodo`:

1. MCP gateway routes to this session.
2. SDK invokes the handler in your browser tab.
3. Handler writes to `todos.value`. Vue's reactivity system schedules an update.
4. The component re-renders; the `<ul class="todos">` reflects the new item.
5. Handler returns; Claude gets the tool result.

Array writes use `todos.value = [...todos.value, todo]` (full reassignment) for clarity; `todos.value.push(...)` would also work since Vue wraps refs of arrays in a Proxy, but full reassignment reads identically to the Svelte and React versions.

## Troubleshooting

- **Status stuck at `connecting`:** MCP gateway isn't reachable. See the [shared troubleshooting table](../README.md#troubleshooting).
- **Tools don't appear in Claude after claim:** the gateway emits `notifications/tools/list_changed`; Claude Code picks this up automatically.
- **`vue-tsc` complains about `.vue` imports:** the included `tsconfig.json` already includes `src/**/*.vue` in the input set. If you scaffold a new file, restart the dev server.
- **Static analysis tools (Biome, ESLint) don't understand `<template>`:** that's normal — Vue SFCs need their own tooling. The repo's Biome config ignores `examples/`.

## Adapt it

- Add a `computed()` for a "pending count" and expose it via `tesseron.resource()`.
- Lift state into a Pinia store and have handlers call store actions — Claude becomes another driver of the same store.
- Use `ctx.confirm()` inside a destructive handler to gate on user approval — `clearCompleted` already shows the pattern. For structured prompts (e.g. "rename this to?") reach for `ctx.elicit()` with a schema.
