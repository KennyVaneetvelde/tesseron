<div align="center">
  <a href="https://github.com/BrainBlend-AI/tesseron">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://github.com/BrainBlend-AI/tesseron/raw/main/assets/logo/tesseron-smallcaps-dark.png">
      <img src="https://github.com/BrainBlend-AI/tesseron/raw/main/assets/logo/tesseron-smallcaps-light.png" alt="Tesseron" width="380">
    </picture>
  </a>
</div>

# @tesseron/svelte

Svelte adapter for [Tesseron](https://github.com/BrainBlend-AI/tesseron). Register actions, expose resources, and observe connection state from inside your components — no manual lifecycle wiring. Wraps [`@tesseron/web`](https://www.npmjs.com/package/@tesseron/web).

Compatible with Svelte 4 and Svelte 5.

## Install

```bash
npm install @tesseron/svelte
```

You also need the [`@tesseron/mcp`](https://www.npmjs.com/package/@tesseron/mcp) gateway running locally — bundled inside the [Claude Code plugin](https://github.com/BrainBlend-AI/tesseron/tree/main/plugin).

## Quick start

```svelte
<script lang="ts">
  import { tesseron, tesseronAction, tesseronResource, tesseronConnection } from '@tesseron/svelte';
  import { z } from 'zod';

  let todos = $state<{ id: string; text: string; done: boolean }[]>([]);

  // 1. Identify your app
  tesseron.app({ id: 'todo_app', name: 'Todo' });

  // 2. Register actions — removed automatically on component destroy
  tesseronAction('addTodo', {
    input: z.object({ text: z.string().min(1) }),
    handler: ({ text }) => {
      todos = [...todos, { id: crypto.randomUUID(), text, done: false }];
    },
  });

  // 3. Expose readable state as a resource
  tesseronResource('todoStats', {
    read: () => ({ total: todos.length, done: todos.filter((t) => t.done).length }),
  });

  // 4. Connect — returns a Svelte Readable store
  const connection = tesseronConnection();
</script>

{#if $connection.status === 'open'}
  <p>Claim code: <code>{$connection.claimCode}</code></p>
{/if}

<ul>
  {#each todos as todo (todo.id)}
    <li>{todo.text}</li>
  {/each}
</ul>
```

Every function registers with the active Tesseron client and cleans up on component destroy.

## Functions

| Function | Purpose |
|---|---|
| `tesseronAction(name, options)` | Registers an action for the component's lifetime. `options` mirrors the fluent builder (`input`, `output`, `annotations`, `timeoutMs`, `strictOutput`, `handler`). |
| `tesseronResource(name, options)` | Registers a readable and/or subscribable resource. Pass `read`, `subscribe`, or both. Shorthand: pass a reader function directly. |
| `tesseronConnection(options?)` | Connects the shared client on mount. Returns a `Readable<TesseronConnectionState>` store (`status`, `claimCode`, `welcome`, `error`). |

## Subscribable resources

To push state to the agent on every change, wire a subscriber using `$effect`:

```svelte
<script lang="ts">
  import { tesseronResource } from '@tesseron/svelte';

  let count = $state(0);
  const subs = new Set<(n: number) => void>();

  $effect(() => {
    const current = count; // reactive dep
    subs.forEach((fn) => fn(current));
  });

  tesseronResource('count', {
    read: () => count,
    subscribe: (emit) => { subs.add(emit); return () => subs.delete(emit); },
  });
</script>
```

## Pair with `@tesseron/web`

`@tesseron/svelte` re-exports the public surface of `@tesseron/web`, so you can mix raw calls with the helper functions. See [`examples/svelte-todo`](https://github.com/BrainBlend-AI/tesseron/tree/main/examples/svelte-todo) for a full app.

## Docs

| | |
|---|---|
| Main repo | <https://github.com/BrainBlend-AI/tesseron> |
| Protocol spec | <https://brainblend-ai.github.io/tesseron/protocol/> |
| Example app | <https://github.com/BrainBlend-AI/tesseron/tree/main/examples/svelte-todo> |

## License

Reference implementation — [Business Source License 1.1](https://github.com/BrainBlend-AI/tesseron/blob/main/LICENSE) (source-available). Each release auto-converts to Apache-2.0 four years after publication.

<p align="center">
  <a href="https://brainblendai.com/">
    <img src="https://github.com/BrainBlend-AI/tesseron/raw/main/assets/brainblend-ai/logo.png" width="32" alt="BrainBlend AI">
  </a>
</p>
<p align="center">Built and maintained by <a href="https://brainblendai.com/"><b>BrainBlend AI</b></a>.</p>
