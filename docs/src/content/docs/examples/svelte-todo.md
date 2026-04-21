---
title: svelte-todo
description: Svelte 5 runes (`$state`, `$derived`). Mutation via direct reassignment.
---

**What it teaches:** integrating Tesseron with Svelte 5's rune-based reactivity. Handlers reassign `let todos = $state(...)` and Svelte re-renders.

**Source:** [`examples/svelte-todo`](https://github.com/KennyVaneetvelde/tesseron/tree/main/examples/svelte-todo)

## Run it

```bash
pnpm --filter svelte-todo dev
# http://localhost:5173
```

## What's inside

```svelte title="src/app.svelte (excerpt)"
<script lang="ts">
  import { tesseron } from '@tesseron/web';
  import { z } from 'zod';
  import { onMount } from 'svelte';

  let todos = $state<Todo[]>([]);
  let filter = $state<'all' | 'active' | 'done'>('all');
  const visibleTodos = $derived(
    filter === 'all' ? todos : todos.filter((t) => (filter === 'done' ? t.done : !t.done))
  );

  tesseron.app({ id: 'svelte_todo', name: 'Svelte Todo' });

  tesseron.action('addTodo')
    .describe('Add a new todo item. Returns the created todo.')
    .input(z.object({ text: z.string().min(1) }))
    .handler(({ text }) => {
      const todo = { id: newId(), text, done: false };
      todos = [...todos, todo];       // reassign - Svelte observes $state
      return todo;
    });

  tesseron.resource('todoStats')
    .read(() => ({ total: todos.length, completed: todos.filter((t) => t.done).length }));

  onMount(async () => {
    const welcome = await tesseron.connect();
    console.log('claim code:', welcome.claimCode);
  });
</script>
```

Features exercised: **`$state` / `$derived` runes, actions, annotations, subscribable resources, `ctx.confirm` (`clearCompleted`), `ctx.elicit` with schema (`renameTodo`), `ctx.progress` (`importTodos`), `ctx.sample` (`suggestTodos`, with a graceful fallback when the client doesn't advertise sampling), connection inside `onMount`**.

There isn't a Svelte-specific package - `@tesseron/web` composes cleanly with runes. If you'd like a `useTesseron*` rune-style API, it's a small wrapper to build - open an issue if you'd use it.
