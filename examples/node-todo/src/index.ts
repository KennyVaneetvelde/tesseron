import { tesseron } from '@tesseron/server';
import { z } from 'zod';

interface Todo {
  id: string;
  text: string;
  done: boolean;
  tag?: string;
}
type Filter = 'all' | 'active' | 'completed';
type Stats = { total: number; completed: number; pending: number };

let nextId = 1;
const newId = (): string => `t${nextId++}`;

const todos = new Map<string, Todo>();

let filter: Filter = 'all';

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

function readStats(): Stats {
  const list = Array.from(todos.values());
  return {
    total: list.length,
    completed: list.filter((t) => t.done).length,
    pending: list.filter((t) => !t.done).length,
  };
}

function snapshot(): void {
  const s = readStats();
  log(`state: ${s.total} todos (${s.completed} done, ${s.pending} pending), filter=${filter}`);
}

// --- Subscriber registries -----------------------------------------
const filterSubs = new Set<(v: Filter) => void>();
const statsSubs = new Set<(v: Stats) => void>();
function notifyFilter(): void {
  const v = filter;
  filterSubs.forEach((fn) => fn(v));
}
function notifyStats(): void {
  const v = readStats();
  statsSubs.forEach((fn) => fn(v));
}

tesseron.app({
  id: 'node_todo',
  name: 'Node Todo Service',
  description: 'A headless Node todo service exposed to Claude via Tesseron. No HTTP, no browser.',
});

// --- Plain actions -------------------------------------------------

tesseron
  .action('addTodo')
  .describe('Add a new todo item to the list. Returns the created todo.')
  .input(z.object({ text: z.string().min(1), tag: z.string().optional() }))
  .handler(({ text, tag }) => {
    const todo: Todo = { id: newId(), text, done: false, tag };
    todos.set(todo.id, todo);
    log(`+ addTodo: "${text}"${tag ? ` #${tag}` : ''} (id=${todo.id})`);
    notifyStats();
    return todo;
  });

tesseron
  .action('toggleTodo')
  .describe('Toggle the done state of a todo by id.')
  .input(z.object({ id: z.string() }))
  .handler(({ id }) => {
    const todo = todos.get(id);
    if (!todo) throw new Error(`No todo with id "${id}"`);
    const updated: Todo = { ...todo, done: !todo.done };
    todos.set(id, updated);
    log(`~ toggleTodo ${id}: done=${updated.done}`);
    notifyStats();
    return updated;
  });

tesseron
  .action('deleteTodo')
  .describe('Delete a todo by id. Destructive: removes the item permanently.')
  .input(z.object({ id: z.string() }))
  .annotate({ destructive: true })
  .handler(({ id }) => {
    const existed = todos.delete(id);
    if (!existed) throw new Error(`No todo with id "${id}"`);
    log(`- deleteTodo ${id}`);
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
    const list = Array.from(todos.values());
    if (which === 'active') return list.filter((t) => !t.done);
    if (which === 'completed') return list.filter((t) => t.done);
    return list;
  });

tesseron
  .action('setFilter')
  .describe('Change the active filter (all | active | completed). Purely a piece of server state.')
  .input(z.object({ filter: z.enum(['all', 'active', 'completed']) }))
  .handler(({ filter: f }) => {
    filter = f;
    log(`= setFilter ${f}`);
    notifyFilter();
    return { filter: f };
  });

// --- Elicitation ---------------------------------------------------

tesseron
  .action('clearCompleted')
  .describe(
    'Remove all todos marked as done. If the agent supports elicitation, the user is prompted to confirm first.',
  )
  .annotate({ destructive: true, requiresConfirmation: true })
  .handler(async (_input, ctx) => {
    const removable = Array.from(todos.values()).filter((t) => t.done).length;
    if (removable === 0) return { removed: 0 };

    const ok = await ctx.confirm({
      question: `Remove ${removable} completed todo${removable === 1 ? '' : 's'}? This cannot be undone.`,
    });
    if (!ok) {
      log(`- clearCompleted cancelled by user (${removable} would-have-been-removed)`);
      return { removed: 0, cancelled: true };
    }

    let removed = 0;
    for (const [id, t] of todos) {
      if (t.done) {
        todos.delete(id);
        removed++;
      }
    }
    log(`- clearCompleted: removed ${removed}`);
    notifyStats();
    return { removed };
  });

// --- Structured elicitation ----------------------------------------

tesseron
  .action('renameTodo')
  .describe(
    'Rename a todo. Prompts the user via ctx.elicit for the new name — if the user declines or cancels, no change.',
  )
  .input(z.object({ id: z.string() }))
  .handler(async ({ id }, ctx) => {
    const todo = todos.get(id);
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
      log(`~ renameTodo ${id}: cancelled`);
      return { id, renamed: false, cancelled: true };
    }
    const updated: Todo = { ...todo, text: answer.newName };
    todos.set(id, updated);
    log(`~ renameTodo ${id}: "${todo.text}" → "${answer.newName}"`);
    notifyStats();
    return { id, renamed: true, newName: answer.newName };
  });

// --- Progress ------------------------------------------------------

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
    log(`+ importTodos: starting (${total} items${tag ? `, tag=${tag}` : ''})`);
    const added: Todo[] = [];
    for (let i = 0; i < total; i += 1) {
      await new Promise((r) => setTimeout(r, 60));
      if (ctx.signal.aborted) throw new Error('Cancelled');
      const todo: Todo = { id: newId(), text: items[i]!, done: false, tag };
      todos.set(todo.id, todo);
      added.push(todo);
      ctx.progress({
        message: `${i + 1}/${total} imported`,
        percent: Math.round(((i + 1) / total) * 100),
      });
    }
    log(`+ importTodos: added ${added.length}`);
    notifyStats();
    return { added: added.length, ids: added.map((t) => t.id) };
  });

// --- Sampling ------------------------------------------------------

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
    log(`? suggestTodos: theme="${theme}", count=${howMany}`);
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
      todos.set(todo.id, todo);
      return todo;
    });
    log(`+ suggestTodos: added ${added.length}`);
    notifyStats();
    return { theme, added: added.length, ids: added.map((t) => t.id) };
  });

// --- Subscribable resources ---------------------------------------

tesseron
  .resource<Filter>('currentFilter')
  .describe('The filter currently set on the service.')
  .read(() => filter)
  .subscribe((emit) => {
    filterSubs.add(emit);
    return () => filterSubs.delete(emit);
  });

tesseron
  .resource<Stats>('todoStats')
  .describe('Counts of total / completed / pending todos. Pushed on every change.')
  .read(() => readStats())
  .subscribe((emit) => {
    statsSubs.add(emit);
    return () => statsSubs.delete(emit);
  });

async function main(): Promise<void> {
  log('node-todo starting up');
  snapshot();
  try {
    const welcome = await tesseron.connect();
    log(`connected to gateway. session=${welcome.sessionId}`);
    log(`claim code: ${welcome.claimCode}`);
    log(`tell Claude: "claim session ${welcome.claimCode}"`);
    log('watching for actions. Ctrl-C to exit.');
  } catch (error) {
    process.stderr.write(
      `[node-todo] failed to connect to gateway: ${(error as Error).message}\n`,
    );
    process.stderr.write(
      '[node-todo] is the gateway running? `pnpm --filter @tesseron/mcp start`\n',
    );
    process.exit(1);
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down`);
  try {
    await tesseron.disconnect();
  } catch {
    // best effort
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  process.stderr.write(`[node-todo] fatal: ${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});
