import { tesseron } from '@tesseron/web';
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

const state = {
  todos: [] as Todo[],
  filter: 'all' as Filter,
  input: '',
  lastLog: '' as string,
  connection: { status: 'idle' as string, claimCode: undefined as string | undefined, error: undefined as string | undefined },
};

const FILTERS: readonly Filter[] = ['all', 'active', 'completed'];

// --- Pub/sub for subscribable resources ---------------------------------
const filterSubs = new Set<(v: Filter) => void>();
const statsSubs = new Set<(v: ReturnType<typeof readStats>) => void>();

function readStats(): { total: number; completed: number; pending: number } {
  return {
    total: state.todos.length,
    completed: state.todos.filter((t) => t.done).length,
    pending: state.todos.filter((t) => !t.done).length,
  };
}

function notifyFilter(): void {
  const v = state.filter;
  filterSubs.forEach((fn) => fn(v));
}
function notifyStats(): void {
  const v = readStats();
  statsSubs.forEach((fn) => fn(v));
}

tesseron.app({
  id: 'vanilla_todo',
  name: 'Vanilla Todo',
  description: 'A plain TypeScript todo app driven live by Claude through Tesseron.',
});

// --- Plain actions ------------------------------------------------------

tesseron
  .action('addTodo')
  .describe('Add a new todo item to the list. Returns the created todo.')
  .input(z.object({ text: z.string().min(1), tag: z.string().optional() }))
  .handler(({ text, tag }) => {
    const todo: Todo = { id: newId(), text, done: false, tag };
    state.todos = [...state.todos, todo];
    render();
    notifyStats();
    return todo;
  });

tesseron
  .action('toggleTodo')
  .describe('Toggle the done state of a todo by id.')
  .input(z.object({ id: z.string() }))
  .handler(({ id }) => {
    let updated: Todo | undefined;
    state.todos = state.todos.map((todo) => {
      if (todo.id === id) {
        updated = { ...todo, done: !todo.done };
        return updated;
      }
      return todo;
    });
    if (!updated) throw new Error(`No todo with id "${id}"`);
    render();
    notifyStats();
    return updated;
  });

tesseron
  .action('deleteTodo')
  .describe('Delete a todo by id. Destructive: removes the item permanently.')
  .input(z.object({ id: z.string() }))
  .annotate({ destructive: true })
  .handler(({ id }) => {
    const before = state.todos.length;
    state.todos = state.todos.filter((t) => t.id !== id);
    if (state.todos.length === before) throw new Error(`No todo with id "${id}"`);
    render();
    notifyStats();
    return { id, removed: true };
  });

tesseron
  .action('listTodos')
  .describe('List todos, optionally filtered by state.')
  .input(z.object({ filter: z.enum(['all', 'active', 'completed']).optional() }))
  .annotate({ readOnly: true })
  .handler(({ filter: f }) => {
    const which = f ?? 'all';
    if (which === 'active') return state.todos.filter((t) => !t.done);
    if (which === 'completed') return state.todos.filter((t) => t.done);
    return state.todos;
  });

tesseron
  .action('setFilter')
  .describe('Change the visible filter (all | active | completed).')
  .input(z.object({ filter: z.enum(['all', 'active', 'completed']) }))
  .handler(({ filter: f }) => {
    state.filter = f;
    render();
    notifyFilter();
    return { filter: f };
  });

// --- Elicitation --------------------------------------------------------

tesseron
  .action('clearCompleted')
  .describe(
    'Remove all todos marked as done. If the agent supports elicitation, the user is prompted to confirm first.',
  )
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async (_input, ctx) => {
    const removable = state.todos.filter((t) => t.done).length;
    if (removable === 0) return { removed: 0 };

    const ok = await ctx.confirm({
      question: `Remove ${removable} completed todo${removable === 1 ? '' : 's'}? This cannot be undone.`,
    });
    if (!ok) {
      state.lastLog = `clearCompleted cancelled (${removable} would-have-been-removed)`;
      render();
      return { removed: 0, cancelled: true };
    }
    state.todos = state.todos.filter((t) => !t.done);
    state.lastLog = `clearCompleted removed ${removable} todo${removable === 1 ? '' : 's'}`;
    render();
    notifyStats();
    return { removed: removable };
  });

// --- Structured elicitation ---------------------------------------------

tesseron
  .action('renameTodo')
  .describe(
    'Rename a todo. Prompts the user via ctx.elicit for the new name — if the user declines or cancels, no change.',
  )
  .input(z.object({ id: z.string() }))
  .handler(async ({ id }, ctx) => {
    const todo = state.todos.find((t) => t.id === id);
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
      state.lastLog = `renameTodo ${id}: cancelled`;
      render();
      return { id, renamed: false, cancelled: true };
    }
    state.todos = state.todos.map((t) => (t.id === id ? { ...t, text: answer.newName } : t));
    state.lastLog = `renameTodo ${id}: "${todo.text}" → "${answer.newName}"`;
    render();
    notifyStats();
    return { id, renamed: true, newName: answer.newName };
  });

// --- Progress -----------------------------------------------------------

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
      state.todos = [...state.todos, todo];
      added.push(todo);
      ctx.progress({
        message: `${i + 1}/${total} imported`,
        percent: Math.round(((i + 1) / total) * 100),
      });
      render();
      notifyStats();
    }
    return { added: added.length, ids: added.map((t) => t.id) };
  });

// --- Sampling -----------------------------------------------------------

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
      state.todos = [...state.todos, todo];
      return todo;
    });
    render();
    notifyStats();
    return { theme, added: added.length, ids: added.map((t) => t.id) };
  });

// --- Subscribable resources --------------------------------------------

tesseron
  .resource<Filter>('currentFilter')
  .describe('The filter currently active on the UI.')
  .read(() => state.filter)
  .subscribe((emit) => {
    filterSubs.add(emit);
    return () => filterSubs.delete(emit);
  });

tesseron
  .resource<{ total: number; completed: number; pending: number }>('todoStats')
  .describe('Counts of total / completed / pending todos. Pushed on every change.')
  .read(() => readStats())
  .subscribe((emit) => {
    statsSubs.add(emit);
    return () => statsSubs.delete(emit);
  });

const root = document.getElementById('root');
if (!root) throw new Error('No #root element');

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function visibleTodos(): Todo[] {
  return state.todos.filter((t) => {
    if (state.filter === 'active') return !t.done;
    if (state.filter === 'completed') return t.done;
    return true;
  });
}

function render(): void {
  const c = state.connection;
  const s = readStats();
  root!.innerHTML = `
    <main>
      <header>
        <h1>Vanilla Todos <span class="badge">live</span></h1>
        <p>
          A plain TypeScript app whose state is drivable by Claude through
          <code>@tesseron/web</code>. Every Tesseron capability is wired in:
          actions, <code>ctx.progress</code>, <code>ctx.elicit</code>,
          <code>ctx.sample</code>, and subscribable resources.
        </p>
      </header>

      <section class="connect-card" data-status="${c.status}">
        <div>
          <strong>Status:</strong> ${c.status}
          ${c.error ? `<span class="error"> — ${escape(c.error)}</span>` : ''}
        </div>
        ${c.claimCode ? `
          <div>
            <strong>Claim code:</strong>
            <code class="claim-code">${escape(c.claimCode)}</code>
          </div>
          <p class="hint">Tell Claude: "claim session ${escape(c.claimCode)}"</p>
        ` : ''}
      </section>

      <section class="add-row">
        <input id="input" value="${escape(state.input)}" placeholder="What needs doing?" aria-label="New todo text" />
        <button type="button" id="add">Add</button>
      </section>

      <nav class="filters">
        ${FILTERS.map((f) => `
          <button type="button" data-filter="${f}" class="${state.filter === f ? 'active' : ''}">${f}</button>
        `).join('')}
      </nav>

      <ul class="todos">
        ${visibleTodos().map((todo) => `
          <li class="${todo.done ? 'done' : ''}">
            <label>
              <input type="checkbox" data-toggle="${todo.id}" ${todo.done ? 'checked' : ''} />
              <span>${escape(todo.text)}</span>
              ${todo.tag ? `<em class="tag">#${escape(todo.tag)}</em>` : ''}
            </label>
            <button type="button" class="delete" data-delete="${todo.id}" aria-label="Delete ${escape(todo.text)}">×</button>
          </li>
        `).join('')}
      </ul>

      <p class="stats">
        <strong>${s.total}</strong> total ·
        <strong>${s.pending}</strong> pending ·
        <strong>${s.completed}</strong> done
      </p>

      ${state.lastLog ? `<p class="log">last agent event: ${escape(state.lastLog)}</p>` : ''}

      <footer>
        <p>
          Actions exposed to Claude:
          <code>vanilla_todo__addTodo</code>, <code>vanilla_todo__toggleTodo</code>,
          <code>vanilla_todo__deleteTodo</code>,
          <code>vanilla_todo__clearCompleted</code> (confirms),
          <code>vanilla_todo__renameTodo</code> (elicits),
          <code>vanilla_todo__importTodos</code> (progress),
          <code>vanilla_todo__suggestTodos</code> (sampling),
          <code>vanilla_todo__listTodos</code>, <code>vanilla_todo__setFilter</code>.
        </p>
        <p>
          Resources (subscribable):
          <code>tesseron://vanilla_todo/currentFilter</code>,
          <code>tesseron://vanilla_todo/todoStats</code>.
        </p>
      </footer>
    </main>
  `;

  const inputEl = root!.querySelector<HTMLInputElement>('#input');
  if (inputEl) {
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
    inputEl.addEventListener('input', (e) => {
      state.input = (e.target as HTMLInputElement).value;
    });
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') addFromInput();
    });
  }

  root!.querySelector('#add')?.addEventListener('click', addFromInput);

  root!.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.filter = btn.dataset['filter'] as Filter;
      render();
      notifyFilter();
    });
  });

  root!.querySelectorAll<HTMLInputElement>('[data-toggle]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const id = cb.dataset['toggle']!;
      state.todos = state.todos.map((t) => (t.id === id ? { ...t, done: !t.done } : t));
      render();
      notifyStats();
    });
  });

  root!.querySelectorAll<HTMLButtonElement>('[data-delete]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset['delete']!;
      state.todos = state.todos.filter((t) => t.id !== id);
      render();
      notifyStats();
    });
  });
}

function addFromInput(): void {
  const trimmed = state.input.trim();
  if (!trimmed) return;
  state.todos = [...state.todos, { id: newId(), text: trimmed, done: false }];
  state.input = '';
  render();
  notifyStats();
}

render();

state.connection = { status: 'connecting', claimCode: undefined, error: undefined };
render();
try {
  const welcome = await tesseron.connect();
  state.connection = { status: 'open', claimCode: welcome.claimCode, error: undefined };
} catch (e) {
  state.connection = { status: 'error', claimCode: undefined, error: (e as Error).message };
}
render();
