---
title: vue-todo
description: Vue 3 composition API with `ref()` and `computed()`.
---

**What it teaches:** integrating Tesseron with Vue 3's reactivity. Handlers mutate `todos.value` and `computed()` recomputes downstream derived state.

**Source:** [`examples/vue-todo`](https://github.com/KennyVaneetvelde/tesseron/tree/main/examples/vue-todo)

## Run it

```bash
pnpm --filter vue-todo dev
# http://localhost:5173
```

## What's inside

```vue title="src/app.vue (excerpt)"
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

const todos = ref<Todo[]>([]);
const filter = ref<'all' | 'active' | 'done'>('all');
const visibleTodos = computed(() =>
  filter.value === 'all'
    ? todos.value
    : todos.value.filter((t) => (filter.value === 'done' ? t.done : !t.done))
);

tesseron.app({ id: 'vue_todo', name: 'Vue Todo' });

tesseron.action('addTodo')
  .describe('Add a new todo item. Returns the created todo.')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    const todo = { id: newId(), text, done: false };
    todos.value = [...todos.value, todo];   // .value mutation triggers reactivity
    return todo;
  });

tesseron.resource('todoStats')
  .read(() => ({ total: todos.value.length, completed: todos.value.filter((t) => t.done).length }));

onMounted(async () => {
  const welcome = await tesseron.connect();
  console.log('claim code:', welcome.claimCode);
});
</script>
```

Features exercised: **`ref` + `computed`, actions, annotations, subscribable resources, `ctx.confirm` (`clearCompleted`), `ctx.elicit` with schema (`renameTodo`), `ctx.progress` (`importTodos`), `ctx.sample` (`suggestTodos`), connection inside `onMounted`**.

Like Svelte, Vue doesn't need a dedicated adapter package - `@tesseron/web` composes with the composition API directly.
