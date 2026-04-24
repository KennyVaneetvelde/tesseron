---
title: svelte-todo
description: Svelte 5 runes driven by `@tesseron/svelte` and bridged by `@tesseron/vite`.
related:
  - sdk/typescript/svelte
  - sdk/typescript/vite
---

**What it teaches:** integrating Tesseron with Svelte 5's rune-based reactivity via `@tesseron/svelte`. Handlers reassign `$state` variables and Svelte re-renders; the `@tesseron/vite` plugin bridges the browser WebSocket to the gateway.

**Source:** [`examples/svelte-todo`](https://github.com/BrainBlend-AI/tesseron/tree/main/examples/svelte-todo)

## Run it

```bash
pnpm --filter svelte-todo dev
# http://localhost:5175
```

## What's inside

```ts title="vite.config.ts"
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [svelte(), tesseron({ appName: 'svelte-todo' })],
  server: { port: 5175 },
});
```

```svelte title="src/app.svelte (excerpt)"
<script lang="ts">
  import { tesseron, tesseronAction, tesseronResource, tesseronConnection } from '@tesseron/svelte';
  import { z } from 'zod';

  let todos = $state<Todo[]>([]);
  let filter = $state<'all' | 'active' | 'done'>('all');
  const visibleTodos = $derived(
    filter === 'all' ? todos : todos.filter((t) => (filter === 'done' ? t.done : !t.done))
  );

  tesseron.app({ id: 'svelte_todo', name: 'Svelte Todo' });

  tesseronAction('addTodo', {
    description: 'Add a new todo item. Returns the created todo.',
    input: z.object({ text: z.string().min(1) }),
    handler: ({ text }) => {
      const todo = { id: newId(), text, done: false };
      todos = [...todos, todo];
      return todo;
    },
  });

  tesseronResource('todoStats', () => ({
    total: todos.length,
    completed: todos.filter((t) => t.done).length,
  }));

  const connection = tesseronConnection();
</script>

{#if $connection.status === 'open'}
  <p>Claim code: {$connection.claimCode}</p>
{/if}
```

Features exercised: **`$state` / `$derived` runes, component-scoped actions, annotations, subscribable resources, `ctx.confirm` (`clearCompleted`), `ctx.elicit` with schema (`renameTodo`), `ctx.progress` (`importTodos`), `ctx.sample` (`suggestTodos`, with graceful fallback when sampling isn't advertised)**.

The Vite plugin serves `/@tesseron/ws` on the same port as the dev server; the adapter package handles lifecycle scoping. If you prefer the raw API, you can use `@tesseron/web` directly inside `onMount` - the adapter is a convenience.
