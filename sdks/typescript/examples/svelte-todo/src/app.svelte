<script lang="ts">
  import { tesseron, tesseronConnection } from '@tesseron/svelte';
  import { z } from 'zod';

  interface Todo {
    id: string;
    text: string;
    done: boolean;
    tag?: string;
  }
  type Filter = 'all' | 'active' | 'completed';

  let nextId = 1;
  const newId = (): string => `t${nextId++}`;

  let todos = $state<Todo[]>([]);
  let filter = $state<Filter>('all');
  let input = $state('');
  const FILTERS: readonly Filter[] = ['all', 'active', 'completed'];
  let lastLog = $state<string>('');

  const visibleTodos = $derived(
    todos.filter((t) => {
      if (filter === 'active') return !t.done;
      if (filter === 'completed') return t.done;
      return true;
    }),
  );

  const stats = $derived({
    total: todos.length,
    completed: todos.filter((t) => t.done).length,
    pending: todos.filter((t) => !t.done).length,
  });

  // --- Subscriber registries: agents get pushed updates when state changes.
  const filterSubs = new Set<(v: Filter) => void>();
  const statsSubs = new Set<(v: typeof stats) => void>();
  $effect(() => {
    const current = filter;
    filterSubs.forEach((fn) => fn(current));
  });
  $effect(() => {
    const snapshot = stats;
    statsSubs.forEach((fn) => fn(snapshot));
  });

  tesseron.app({
    id: 'svelte_todo',
    name: 'Svelte Todo',
    description: 'A Svelte 5 todo app driven live by Claude through Tesseron.',
  });

  // --- Plain actions --------------------------------------------------

  tesseron
    .action('addTodo')
    .describe('Add a new todo item to the list. Returns the created todo.')
    .input(z.object({ text: z.string().min(1), tag: z.string().optional() }))
    .handler(({ text, tag }) => {
      const todo: Todo = { id: newId(), text, done: false, tag };
      todos = [...todos, todo];
      return todo;
    });

  tesseron
    .action('toggleTodo')
    .describe('Toggle the done state of a todo by id.')
    .input(z.object({ id: z.string() }))
    .handler(({ id }) => {
      let updated: Todo | undefined;
      todos = todos.map((todo) => {
        if (todo.id === id) {
          updated = { ...todo, done: !todo.done };
          return updated;
        }
        return todo;
      });
      if (!updated) throw new Error(`No todo with id "${id}"`);
      return updated;
    });

  tesseron
    .action('deleteTodo')
    .describe('Delete a todo by id. Destructive: removes the item permanently.')
    .input(z.object({ id: z.string() }))
    .annotate({ destructive: true })
    .handler(({ id }) => {
      const before = todos.length;
      todos = todos.filter((t) => t.id !== id);
      if (todos.length === before) throw new Error(`No todo with id "${id}"`);
      return { id, removed: true };
    });

  tesseron
    .action('listTodos')
    .describe('List todos, optionally filtered by state.')
    .input(z.object({ filter: z.enum(['all', 'active', 'completed']).optional() }))
    .annotate({ readOnly: true })
    .handler(({ filter: f }) => {
      const which = f ?? 'all';
      if (which === 'active') return todos.filter((t) => !t.done);
      if (which === 'completed') return todos.filter((t) => t.done);
      return todos;
    });

  tesseron
    .action('setFilter')
    .describe('Change the visible filter (all | active | completed).')
    .input(z.object({ filter: z.enum(['all', 'active', 'completed']) }))
    .handler(({ filter: f }) => {
      filter = f;
      return { filter: f };
    });

  // --- Elicitation: confirm before destructive mass-delete -----------

  tesseron
    .action('clearCompleted')
    .describe(
      'Remove all todos marked as done. If the agent supports elicitation, the user is prompted to confirm first.',
    )
    .annotate({ destructive: true, requiresConfirmation: true })
    .handler(async (_input, ctx) => {
      const removable = todos.filter((t) => t.done).length;
      if (removable === 0) return { removed: 0 };

      const ok = await ctx.confirm({
        question: `Remove ${removable} completed todo${removable === 1 ? '' : 's'}? This cannot be undone.`,
      });
      if (!ok) {
        lastLog = `clearCompleted cancelled by user (${removable} would-have-been-removed)`;
        return { removed: 0, cancelled: true };
      }
      todos = todos.filter((t) => !t.done);
      lastLog = `clearCompleted removed ${removable} todo${removable === 1 ? '' : 's'}`;
      return { removed: removable };
    });

  // --- Structured elicitation ------------------------------------------

  tesseron
    .action('renameTodo')
    .describe(
      'Rename a todo. Prompts the user via ctx.elicit for the new name — if the user declines or cancels, no change.',
    )
    .input(z.object({ id: z.string() }))
    .handler(async ({ id }, ctx) => {
      const todo = todos.find((t) => t.id === id);
      if (!todo) throw new Error(`No todo with id "${id}"`);
      const answer = await ctx.elicit({
        question: `Rename "${todo.text}" to?`,
        schema: z.object({ newName: z.string().min(1) }),
        jsonSchema: {
          type: 'object',
          properties: { newName: { type: 'string', description: 'New name for the todo' } },
          required: ['newName'],
        },
      });
      if (answer === null) {
        lastLog = `renameTodo ${id}: cancelled`;
        return { id, renamed: false, cancelled: true };
      }
      todos = todos.map((t) => (t.id === id ? { ...t, text: answer.newName } : t));
      lastLog = `renameTodo ${id}: "${todo.text}" → "${answer.newName}"`;
      return { id, renamed: true, newName: answer.newName };
    });

  // --- Progress: streaming updates while a long-ish batch runs --------

  tesseron
    .action('importTodos')
    .describe(
      'Bulk-import a list of todos one by one. Emits progress notifications so the agent can surface a live status.',
    )
    .input(
      z.object({
        items: z.array(z.string().min(1)).min(1).max(50),
        tag: z.string().optional(),
      }),
    )
    .handler(async ({ items, tag }, ctx) => {
      const total = items.length;
      ctx.progress({ message: 'importing...', percent: 0 });
      const added: Todo[] = [];
      for (let i = 0; i < total; i += 1) {
        // Tiny delay so progress is visibly streamed, not batched.
        await new Promise((r) => setTimeout(r, 60));
        if (ctx.signal.aborted) throw new Error('Cancelled');
        const todo: Todo = { id: newId(), text: items[i]!, done: false, tag };
        todos = [...todos, todo];
        added.push(todo);
        ctx.progress({
          message: `${i + 1}/${total} imported`,
          percent: Math.round(((i + 1) / total) * 100),
        });
      }
      return { added: added.length, ids: added.map((t) => t.id) };
    });

  // --- Sampling: ask the agent's LLM for structured data --------------

  tesseron
    .action('suggestTodos')
    .describe(
      'Ask the agent LLM to produce a themed list of todos, then add them. Uses ctx.sample — no API key needed on this side.',
    )
    .input(
      z.object({
        theme: z.string().min(1),
        count: z.number().int().min(1).max(10).optional(),
      }),
    )
    .handler(async ({ theme, count }, ctx) => {
      // Capability-gated: if the MCP client didn't advertise sampling during its
      // `initialize` handshake (Claude Code, as of this writing), Tesseron's gateway surfaces
      // that truthfully on `ctx.agentCapabilities.sampling`. Return a structured, friendly
      // result instead of bubbling up as a raw tool-call failure. See github issue #1.
      if (!ctx.agentCapabilities.sampling) {
        return {
          theme,
          added: 0,
          reason:
            "Your MCP client doesn't support sampling; no suggestions generated. Use `importTodos` with an explicit list instead.",
        };
      }
      const howMany = count ?? 5;
      ctx.progress({ message: 'asking LLM...', percent: 25 });
      try {
        const result = await ctx.sample({
          prompt:
            `Produce exactly ${howMany} concrete todo items for the theme "${theme}". ` +
            `Return JSON matching the schema: { items: string[] }. ` +
            `Items should be short, imperative, and user-friendly. No numbering.`,
          schema: z.object({ items: z.array(z.string().min(1)).length(howMany) }),
          maxTokens: 400,
        });
        ctx.progress({ message: 'adding to list...', percent: 80 });
        const added: Todo[] = result.items.map((text) => {
          const todo: Todo = { id: newId(), text, done: false, tag: theme };
          return todo;
        });
        todos = [...todos, ...added];
        return { theme, added: added.length, ids: added.map((t) => t.id) };
      } catch (error) {
        // Belt-and-braces: even if the capability gate said "yes" but the client still rejects
        // the sampling/createMessage round-trip (e.g. partial implementation), degrade
        // gracefully rather than showing a raw `-32601 Method not found`.
        const name =
          error && typeof error === 'object' && 'name' in error
            ? (error as { name?: string }).name
            : undefined;
        if (name === 'SamplingNotAvailableError') {
          return {
            theme,
            added: 0,
            reason:
              "Your MCP client doesn't support sampling; no suggestions generated. Use `importTodos` with an explicit list instead.",
          };
        }
        throw error;
      }
    });

  // --- Resources: readable AND subscribable ---------------------------

  tesseron
    .resource<Filter>('currentFilter')
    .describe('The filter currently active on the UI.')
    .read(() => filter)
    .subscribe((emit) => {
      filterSubs.add(emit);
      return () => filterSubs.delete(emit);
    });

  tesseron
    .resource<{ total: number; completed: number; pending: number }>('todoStats')
    .describe('Counts of total / completed / pending todos. Pushed on every change.')
    .read(() => stats)
    .subscribe((emit) => {
      statsSubs.add(emit);
      return () => statsSubs.delete(emit);
    });

  function addInput(): void {
    const trimmed = input.trim();
    if (!trimmed) return;
    todos = [...todos, { id: newId(), text: trimmed, done: false }];
    input = '';
  }

  function toggle(id: string): void {
    todos = todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
  }

  function remove(id: string): void {
    todos = todos.filter((t) => t.id !== id);
  }

  const connection = tesseronConnection();
</script>

<main>
  <header>
    <h1>Svelte Todos <span class="badge">live</span></h1>
    <p>
      A real Svelte 5 app whose state is drivable by Claude through
      <code>@tesseron/svelte</code>. Every Tesseron capability is wired in: actions,
      <code>ctx.progress</code>, <code>ctx.elicit</code>, <code>ctx.sample</code>,
      and subscribable resources.
    </p>
  </header>

  <section class="connect-card" data-status={$connection.status}>
    <div>
      <strong>Status:</strong>
      {$connection.status}
      {#if $connection.error}<span class="error"> — {$connection.error.message}</span>{/if}
    </div>
    {#if $connection.claimCode}
      <div>
        <strong>Claim code:</strong>
        <code class="claim-code">{$connection.claimCode}</code>
      </div>
      <p class="hint">Tell Claude: "claim session {$connection.claimCode}"</p>
    {/if}
  </section>

  <section class="add-row">
    <input
      bind:value={input}
      onkeydown={(e) => {
        if (e.key === 'Enter') addInput();
      }}
      placeholder="What needs doing?"
      aria-label="New todo text"
    />
    <button type="button" onclick={addInput}>Add</button>
  </section>

  <nav class="filters">
    {#each FILTERS as f (f)}
      <button
        type="button"
        class={filter === f ? 'active' : ''}
        onclick={() => (filter = f)}
      >
        {f}
      </button>
    {/each}
  </nav>

  <ul class="todos">
    {#each visibleTodos as todo (todo.id)}
      <li class={todo.done ? 'done' : ''}>
        <label>
          <input
            type="checkbox"
            checked={todo.done}
            onchange={() => toggle(todo.id)}
          />
          <span>{todo.text}</span>
          {#if todo.tag}<em class="tag">#{todo.tag}</em>{/if}
        </label>
        <button
          type="button"
          class="delete"
          onclick={() => remove(todo.id)}
          aria-label={`Delete ${todo.text}`}
        >
          ×
        </button>
      </li>
    {/each}
  </ul>

  <p class="stats">
    <strong>{stats.total}</strong> total ·
    <strong>{stats.pending}</strong> pending ·
    <strong>{stats.completed}</strong> done
  </p>

  {#if lastLog}
    <p class="log">last agent event: {lastLog}</p>
  {/if}

  <footer>
    <p>
      Actions exposed to Claude:
      <code>svelte_todo__addTodo</code>, <code>svelte_todo__toggleTodo</code>,
      <code>svelte_todo__deleteTodo</code>, <code>svelte_todo__clearCompleted</code>
      (confirms), <code>svelte_todo__renameTodo</code> (elicits),
      <code>svelte_todo__importTodos</code> (progress),
      <code>svelte_todo__suggestTodos</code> (sampling),
      <code>svelte_todo__listTodos</code>, <code>svelte_todo__setFilter</code>.
    </p>
    <p>
      Resources (subscribable):
      <code>tesseron://svelte_todo/currentFilter</code>,
      <code>tesseron://svelte_todo/todoStats</code>.
    </p>
  </footer>
</main>
