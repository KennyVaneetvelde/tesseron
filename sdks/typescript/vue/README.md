<div align="center">
  <a href="https://github.com/eigenwise/tesseron">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-dark.png">
      <img src="https://github.com/eigenwise/tesseron/raw/main/assets/logo/tesseron-smallcaps-light.png" alt="Tesseron" width="380">
    </picture>
  </a>
</div>

# @tesseron/vue

Vue 3 adapter for [Tesseron](https://github.com/eigenwise/tesseron). Register actions, expose resources, and observe connection state from inside your components — no manual lifecycle wiring. Wraps [`@tesseron/web`](https://www.npmjs.com/package/@tesseron/web).

## Install

```bash
npm install @tesseron/vue
```

Requires Vue ≥ 3. You also need the [`@tesseron/mcp`](https://www.npmjs.com/package/@tesseron/mcp) gateway running locally — bundled inside the [Claude Code plugin](https://github.com/eigenwise/tesseron/tree/main/plugin).

## Quick start

```vue
<script setup lang="ts">
import { tesseron, tesseronAction, tesseronResource, tesseronConnection } from '@tesseron/vue';
import { ref } from 'vue';
import { z } from 'zod';

const todos = ref<{ id: string; text: string; done: boolean }[]>([]);

// 1. Identify your app
tesseron.app({ id: 'todo_app', name: 'Todo' });

// 2. Register actions — removed automatically on unmount
tesseronAction('addTodo', {
  input: z.object({ text: z.string().min(1) }),
  handler: ({ text }) => {
    todos.value = [...todos.value, { id: crypto.randomUUID(), text, done: false }];
  },
});

// 3. Expose readable state as a resource
tesseronResource('todoStats', {
  read: () => ({ total: todos.value.length, done: todos.value.filter((t) => t.done).length }),
});

// 4. Connect — returns a Ref with auto-unwrapping in templates
const connection = tesseronConnection();
</script>

<template>
  <p v-if="connection.status === 'open'">
    Claim code: <code>{{ connection.claimCode }}</code>
  </p>
  <ul>
    <li v-for="todo in todos" :key="todo.id">{{ todo.text }}</li>
  </ul>
</template>
```

Every function registers with the active Tesseron client and cleans up on component unmount.

## Functions

| Function | Purpose |
|---|---|
| `tesseronAction(name, options)` | Registers an action for the component's lifetime. `options` mirrors the fluent builder (`input`, `output`, `annotations`, `timeoutMs`, `strictOutput`, `handler`). |
| `tesseronResource(name, options)` | Registers a readable and/or subscribable resource. Pass `read`, `subscribe`, or both. Shorthand: pass a reader function directly. |
| `tesseronConnection(options?)` | Connects the shared client on mount. Returns a `Ref<TesseronConnectionState>` (`status`, `claimCode`, `welcome`, `error`) — auto-unwrapped in templates. |

## Subscribable resources

To push state to the agent on every change, wire a watcher using Vue's `watch`:

```vue
<script setup lang="ts">
import { tesseronResource } from '@tesseron/vue';
import { ref, watch } from 'vue';

const count = ref(0);
const subs = new Set<(n: number) => void>();

watch(count, (n) => subs.forEach((fn) => fn(n)));

tesseronResource('count', {
  read: () => count.value,
  subscribe: (emit) => { subs.add(emit); return () => subs.delete(emit); },
});
</script>
```

## Pair with `@tesseron/web`

`@tesseron/vue` re-exports the public surface of `@tesseron/web`, so you can mix raw calls with the helper functions. See [`examples/vue-todo`](https://github.com/eigenwise/tesseron/tree/main/examples/vue-todo) for a full app.

## Docs

| | |
|---|---|
| Main repo | <https://github.com/eigenwise/tesseron> |
| Protocol spec | <https://eigenwise.github.io/tesseron/protocol/> |
| Example app | <https://github.com/eigenwise/tesseron/tree/main/examples/vue-todo> |

## License

Reference implementation — [Business Source License 1.1](https://github.com/eigenwise/tesseron/blob/main/LICENSE) (source-available). Each release auto-converts to Apache-2.0 four years after publication.

<p align="center">Built and maintained by <a href="https://eigenwise.io/"><b>Eigenwise</b></a>.</p>
