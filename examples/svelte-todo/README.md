# svelte-todo

A real Svelte 5 (runes) todo app whose state is also drivable by Claude through [`@tesseron/web`](../../packages/web). **Adding, toggling, deleting, filtering, and clearing todos all happen via `$state` reactivity — and they all update the visible list in real time when Claude calls the corresponding action.**

## What you'll see live

- Open the page. The connect card surfaces the claim code automatically — `tesseron.connect()` runs in `onMount` and resolves to the welcome.
- After you claim the session, ask Claude things like *"add a todo to buy milk"*.
- The todo appears in the list **the same instant** Claude responds. Same with `toggleTodo`, `deleteTodo`, `clearCompleted`, `setFilter`.
- The filter chips flip to whatever Claude picks — another live UI update from the chat.

## Quick start

> One-time MCP-client setup: [examples/README.md](../README.md#one-time-setup).

```bash
pnpm --filter svelte-todo dev
```

Open <http://localhost:5175>. The claim code appears in the **Status: open** card at the top of the page. In Claude:

```
claim session ABCD-XY
```

## Try these prompts

- *"What todos do I have?"* — `svelte_todo__listTodos()` returns the array.
- *"Add a todo: buy milk."* — `svelte_todo__addTodo({ text: 'buy milk' })`. Watch the list grow.
- *"Toggle todo `t4`."* — checkbox flips.
- *"Delete the milk todo."* — destructive, the agent may confirm.
- *"Switch the filter to active."* — chips update on screen.
- *"Clear all completed todos."* — annotated `requiresConfirmation`, so good MCP clients will ask before executing.
- *"Read the tesseron stats resource."* — Claude calls `resources/read` on `tesseron://svelte_todo/todoStats`.

## Tools and resources exposed

| Tool name | Annotations | What it does |
|---|---|---|
| `svelte_todo__addTodo` | — | Append a new todo |
| `svelte_todo__toggleTodo` | — | Flip done/undone |
| `svelte_todo__deleteTodo` | destructive | Remove by id |
| `svelte_todo__clearCompleted` | destructive, requiresConfirmation | Remove all done items; gates on `ctx.confirm` |
| `svelte_todo__renameTodo` | — | Rename a todo via `ctx.elicit` with a schema |
| `svelte_todo__importTodos` | — | Bulk-import; streams `ctx.progress` per item |
| `svelte_todo__suggestTodos` | — | Ask the agent LLM via `ctx.sample` for a themed list (returns a friendly fallback if the client doesn't advertise sampling) |
| `svelte_todo__listTodos` | readOnly | Read the list, optionally filtered |
| `svelte_todo__setFilter` | — | Change visible filter |

| Resource URI (subscribable) | What it returns |
|---|---|
| `tesseron://svelte_todo/currentFilter` | `'all' \| 'active' \| 'completed'` |
| `tesseron://svelte_todo/todoStats` | `{ total, completed, pending }` |

## How the live updates work

[`src/app.svelte`](./src/app.svelte) wires every action to a `$state` rune:

```svelte
<script lang="ts">
  import { tesseron } from '@tesseron/web';
  import { z } from 'zod';

  let todos = $state<Todo[]>([]);

  tesseron
    .action('addTodo')
    .describe('Add a new todo item.')
    .input(z.object({ text: z.string().min(1) }))
    .handler(({ text }) => {
      const todo = { id: newId(), text, done: false };
      todos = [...todos, todo];     // <- $state assignment → Svelte re-renders
      return todo;
    });
</script>
```

When Claude calls `svelte_todo__addTodo`:

1. The MCP gateway receives the call and routes it to this session.
2. The web SDK invokes the registered handler in your browser tab.
3. The handler assigns a new array to the `$state` variable.
4. Svelte's reactivity system re-renders the `<ul class="todos">` and the new item appears.
5. The handler's return value goes back to Claude as the tool result.

The whole round trip is sub-100ms locally. Assignment (not mutation!) is what triggers Svelte 5 reactivity for arrays — `todos.push()` alone would NOT re-render. Every handler here re-assigns.

## Troubleshooting

- **Status stuck at `connecting`:** MCP gateway isn't reachable. See the [shared troubleshooting table](../README.md#troubleshooting).
- **Tools don't appear in Claude after claim:** the gateway emits `notifications/tools/list_changed`; Claude Code picks this up automatically. If your client caches tools, reconnect the MCP server in its UI.
- **`importTodos` shows only the final result, no `0/5 → 5/5` progress:** this is an MCP client-compatibility limitation, not a Tesseron bug. The handler emits `ctx.progress`; the gateway forwards it as MCP `notifications/progress` whenever the client supplies `_meta.progressToken` on the `tools/call` request (see [`packages/mcp/test/phase3.test.ts`](../../packages/mcp/test/phase3.test.ts) for the verified path). As of April 2026, Claude Code does not attach a `progressToken` to tool calls nor render in-flight progress notifications inline, so streaming updates are silently discarded client-side — you'll still see the terminal result. Clients like `@modelcontextprotocol/sdk` with an explicit `onprogress` handler receive them correctly. Tracked upstream in [tesseron#2](https://github.com/KennyVaneetvelde/tesseron/issues/2).
- **HMR resets the todo list to the initial three:** expected — Vite's hot reload re-mounts the component, which re-runs `$state` initializers. Production builds don't have this.
- **`vite-plugin-svelte` warns about preprocess:** the included `svelte.config.js` enables `vitePreprocess()` for `<script lang="ts">` support — leave it in.

## Adapt it

- Add a `$derived` rune for a "pending count" and expose it via `tesseron.resource()`.
- Replace the in-component `$state` with a Svelte store (`writable`) so handlers drive a store shared across components.
- Use `ctx.confirm()` inside a destructive handler to gate on user approval — `clearCompleted` already shows the pattern. For structured prompts, use `ctx.elicit()` with a schema (see the [Phase 3 elicitation tests](../../packages/mcp/test/phase3.test.ts)).
