<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { tesseron, tesseronConnection } from '@tesseron/vue';
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

const todos = ref<Todo[]>([]);
const filter = ref<Filter>('all');
const input = ref('');
const lastLog = ref('');

const FILTERS: readonly Filter[] = ['all', 'active', 'completed'];

const visibleTodos = computed(() =>
  todos.value.filter((t) => {
    if (filter.value === 'active') return !t.done;
    if (filter.value === 'completed') return t.done;
    return true;
  }),
);

const stats = computed(() => ({
  total: todos.value.length,
  completed: todos.value.filter((t) => t.done).length,
  pending: todos.value.filter((t) => !t.done).length,
}));

// --- Pub/sub for subscribable resources ---------------------------
const filterSubs = new Set<(v: Filter) => void>();
const statsSubs = new Set<(v: typeof stats.value) => void>();
watch(filter, (v) => filterSubs.forEach((fn) => fn(v)));
watch(stats, (v) => statsSubs.forEach((fn) => fn(v)), { deep: true });

tesseron.app({
  id: 'vue_todo',
  name: 'Vue Todo',
  description: 'A Vue 3 todo app driven live by Claude through Tesseron.',
});

// --- Plain actions ------------------------------------------------

tesseron
  .action('addTodo')
  .describe('Add a new todo item to the list. Returns the created todo.')
  .input(z.object({ text: z.string().min(1), tag: z.string().optional() }))
  .handler(({ text, tag }) => {
    const todo: Todo = { id: newId(), text, done: false, tag };
    todos.value = [...todos.value, todo];
    return todo;
  });

tesseron
  .action('toggleTodo')
  .describe('Toggle the done state of a todo by id.')
  .input(z.object({ id: z.string() }))
  .handler(({ id }) => {
    let updated: Todo | undefined;
    todos.value = todos.value.map((todo) => {
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
    const before = todos.value.length;
    todos.value = todos.value.filter((t) => t.id !== id);
    if (todos.value.length === before) throw new Error(`No todo with id "${id}"`);
    return { id, removed: true };
  });

tesseron
  .action('listTodos')
  .describe('List todos, optionally filtered by state.')
  .input(z.object({ filter: z.enum(['all', 'active', 'completed']).optional() }))
  .annotate({ readOnly: true })
  .handler(({ filter: f }) => {
    const which = f ?? 'all';
    if (which === 'active') return todos.value.filter((t) => !t.done);
    if (which === 'completed') return todos.value.filter((t) => t.done);
    return todos.value;
  });

tesseron
  .action('setFilter')
  .describe('Change the visible filter (all | active | completed).')
  .input(z.object({ filter: z.enum(['all', 'active', 'completed']) }))
  .handler(({ filter: f }) => {
    filter.value = f;
    return { filter: f };
  });

// --- Elicitation -------------------------------------------------

tesseron
  .action('clearCompleted')
  .describe(
    'Remove all todos marked as done. If the agent supports elicitation, the user is prompted to confirm first.',
  )
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async (_input, ctx) => {
    const removable = todos.value.filter((t) => t.done).length;
    if (removable === 0) return { removed: 0 };

    const ok = await ctx.confirm({
      question: `Remove ${removable} completed todo${removable === 1 ? '' : 's'}? This cannot be undone.`,
    });
    if (!ok) {
      lastLog.value = `clearCompleted cancelled (${removable} would-have-been-removed)`;
      return { removed: 0, cancelled: true };
    }
    todos.value = todos.value.filter((t) => !t.done);
    lastLog.value = `clearCompleted removed ${removable} todo${removable === 1 ? '' : 's'}`;
    return { removed: removable };
  });

// --- Structured elicitation --------------------------------------

tesseron
  .action('renameTodo')
  .describe(
    'Rename a todo. Prompts the user via ctx.elicit for the new name — if the user declines or cancels, no change.',
  )
  .input(z.object({ id: z.string() }))
  .handler(async ({ id }, ctx) => {
    const todo = todos.value.find((t) => t.id === id);
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
      lastLog.value = `renameTodo ${id}: cancelled`;
      return { id, renamed: false, cancelled: true };
    }
    todos.value = todos.value.map((t) => (t.id === id ? { ...t, text: answer.newName } : t));
    lastLog.value = `renameTodo ${id}: "${todo.text}" → "${answer.newName}"`;
    return { id, renamed: true, newName: answer.newName };
  });

// --- Progress ----------------------------------------------------

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
      await new Promise((r) => setTimeout(r, 60));
      if (ctx.signal.aborted) throw new Error('Cancelled');
      const todo: Todo = { id: newId(), text: items[i]!, done: false, tag };
      todos.value = [...todos.value, todo];
      added.push(todo);
      ctx.progress({
        message: `${i + 1}/${total} imported`,
        percent: Math.round(((i + 1) / total) * 100),
      });
    }
    return { added: added.length, ids: added.map((t) => t.id) };
  });

// --- Sampling ----------------------------------------------------

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
    if (!ctx.agentCapabilities.sampling) {
      throw new Error(
        'Agent does not support sampling. Use `importTodos` with an explicit list instead.',
      );
    }
    const howMany = count ?? 5;
    ctx.progress({ message: 'asking LLM...', percent: 25 });
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
    todos.value = [...todos.value, ...added];
    return { theme, added: added.length, ids: added.map((t) => t.id) };
  });

// --- Subscribable resources -------------------------------------

tesseron
  .resource<Filter>('currentFilter')
  .describe('The filter currently active on the UI.')
  .read(() => filter.value)
  .subscribe((emit) => {
    filterSubs.add(emit);
    return () => filterSubs.delete(emit);
  });

tesseron
  .resource<{ total: number; completed: number; pending: number }>('todoStats')
  .describe('Counts of total / completed / pending todos. Pushed on every change.')
  .read(() => stats.value)
  .subscribe((emit) => {
    statsSubs.add(emit);
    return () => statsSubs.delete(emit);
  });

function addInput(): void {
  const trimmed = input.value.trim();
  if (!trimmed) return;
  todos.value = [...todos.value, { id: newId(), text: trimmed, done: false }];
  input.value = '';
}

function toggle(id: string): void {
  todos.value = todos.value.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
}

function remove(id: string): void {
  todos.value = todos.value.filter((t) => t.id !== id);
}

const connection = tesseronConnection();
</script>

<template>
  <main>
    <header>
      <h1>Vue Todos <span class="badge">live</span></h1>
      <p>
        A real Vue 3 app whose state is drivable by Claude through
        <code>@tesseron/vue</code>. Every Tesseron capability is wired in:
        actions, <code>ctx.progress</code>, <code>ctx.elicit</code>,
        <code>ctx.sample</code>, and subscribable resources.
      </p>
    </header>

    <section class="connect-card" :data-status="connection.status">
      <div>
        <strong>Status:</strong>
        {{ connection.status }}
        <span v-if="connection.error" class="error"> — {{ connection.error.message }}</span>
      </div>
      <template v-if="connection.claimCode">
        <div>
          <strong>Claim code:</strong>
          <code class="claim-code">{{ connection.claimCode }}</code>
        </div>
        <p class="hint">Tell Claude: "claim session {{ connection.claimCode }}"</p>
      </template>
    </section>

    <section class="add-row">
      <input
        v-model="input"
        @keydown.enter="addInput"
        placeholder="What needs doing?"
        aria-label="New todo text"
      />
      <button type="button" @click="addInput">Add</button>
    </section>

    <nav class="filters">
      <button
        v-for="f in FILTERS"
        :key="f"
        type="button"
        :class="filter === f ? 'active' : ''"
        @click="filter = f"
      >
        {{ f }}
      </button>
    </nav>

    <ul class="todos">
      <li v-for="todo in visibleTodos" :key="todo.id" :class="todo.done ? 'done' : ''">
        <label>
          <input type="checkbox" :checked="todo.done" @change="toggle(todo.id)" />
          <span>{{ todo.text }}</span>
          <em v-if="todo.tag" class="tag">#{{ todo.tag }}</em>
        </label>
        <button
          type="button"
          class="delete"
          :aria-label="`Delete ${todo.text}`"
          @click="remove(todo.id)"
        >
          ×
        </button>
      </li>
    </ul>

    <p class="stats">
      <strong>{{ stats.total }}</strong> total ·
      <strong>{{ stats.pending }}</strong> pending ·
      <strong>{{ stats.completed }}</strong> done
    </p>

    <p v-if="lastLog" class="log">last agent event: {{ lastLog }}</p>

    <footer>
      <p>
        Actions exposed to Claude:
        <code>vue_todo__addTodo</code>, <code>vue_todo__toggleTodo</code>,
        <code>vue_todo__deleteTodo</code>,
        <code>vue_todo__clearCompleted</code> (confirms),
        <code>vue_todo__renameTodo</code> (elicits),
        <code>vue_todo__importTodos</code> (progress),
        <code>vue_todo__suggestTodos</code> (sampling),
        <code>vue_todo__listTodos</code>, <code>vue_todo__setFilter</code>.
      </p>
      <p>
        Resources (subscribable):
        <code>tesseron://vue_todo/currentFilter</code>,
        <code>tesseron://vue_todo/todoStats</code>.
      </p>
    </footer>
  </main>
</template>
