---
title: vue-todo
description: Vue 3 composition API driven by `@tesseron/vue` and bridged by `@tesseron/vite`.
related:
  - sdk/typescript/vue
  - sdk/typescript/vite
---

**What it teaches:** integrating Tesseron with Vue 3's reactivity via `@tesseron/vue`. Handlers mutate `todos.value` and the `@tesseron/vite` plugin bridges the browser WebSocket to the gateway.

**Source:** [`examples/vue-todo`](https://github.com/BrainBlend-AI/tesseron/tree/main/examples/vue-todo)

## Run it

```bash
pnpm --filter vue-todo dev
# http://localhost:5176
```

## What's inside

```ts title="vite.config.ts"
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [vue(), tesseron({ appName: 'vue-todo' })],
  server: { port: 5176 },
});
```

```vue title="src/app.vue (excerpt)"
<script setup lang="ts">
import { ref, computed } from 'vue';
import { tesseron, tesseronAction, tesseronResource, tesseronConnection } from '@tesseron/vue';
import { z } from 'zod';

const todos = ref<Todo[]>([]);
const filter = ref<'all' | 'active' | 'done'>('all');
const visibleTodos = computed(() =>
  filter.value === 'all'
    ? todos.value
    : todos.value.filter((t) => (filter.value === 'done' ? t.done : !t.done))
);

tesseron.app({ id: 'vue_todo', name: 'Vue Todo' });

tesseronAction('addTodo', {
  description: 'Add a new todo item. Returns the created todo.',
  input: z.object({ text: z.string().min(1) }),
  handler: ({ text }) => {
    const todo = { id: newId(), text, done: false };
    todos.value = [...todos.value, todo];
    return todo;
  },
});

tesseronResource('todoStats', () => ({
  total: todos.value.length,
  completed: todos.value.filter((t) => t.done).length,
}));

const connection = tesseronConnection();
</script>

<template>
  <p v-if="connection.status === 'open'">Claim code: {{ connection.claimCode }}</p>
</template>
```

Features exercised: **`ref` + `computed`, component-scoped actions, annotations, subscribable resources, `ctx.confirm` (`clearCompleted`), `ctx.elicit` with schema (`renameTodo`), `ctx.progress` (`importTodos`), `ctx.sample` (`suggestTodos`)**.

The Vite plugin serves `/@tesseron/ws` on the same port as the dev server; the adapter package handles lifecycle scoping. If you prefer the raw API, you can use `@tesseron/web` directly inside `onMounted` - the adapter is a convenience.
