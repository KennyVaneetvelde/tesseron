import express from 'express';
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

const HTTP_PORT = Number(process.env['PORT'] ?? 3001);

// --- Subscriber registries — HTTP mutations emit too --------------
const filterSubs = new Set<(v: Filter) => void>();
const statsSubs = new Set<(v: Stats) => void>();

function readStats(): Stats {
  const list = Array.from(todos.values());
  return {
    total: list.length,
    completed: list.filter((t) => t.done).length,
    pending: list.filter((t) => !t.done).length,
  };
}

function notifyFilter(): void {
  const v = filter;
  filterSubs.forEach((fn) => fn(v));
}
function notifyStats(): void {
  const v = readStats();
  statsSubs.forEach((fn) => fn(v));
}

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/todos', (req, res) => {
  const f = (req.query['filter'] as Filter | undefined) ?? filter;
  const list = Array.from(todos.values());
  if (f === 'active') {
    res.json(list.filter((t) => !t.done));
    return;
  }
  if (f === 'completed') {
    res.json(list.filter((t) => t.done));
    return;
  }
  res.json(list);
});

app.post('/todos', (req, res) => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const tag = typeof req.body?.tag === 'string' ? req.body.tag : undefined;
  const todo: Todo = { id: newId(), text, done: false, tag };
  todos.set(todo.id, todo);
  notifyStats();
  res.status(201).json(todo);
});

app.patch('/todos/:id', (req, res) => {
  const todo = todos.get(req.params.id);
  if (!todo) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  const next: Todo = { ...todo };
  if (typeof req.body?.text === 'string') next.text = req.body.text;
  if (typeof req.body?.done === 'boolean') next.done = req.body.done;
  if (typeof req.body?.tag === 'string') next.tag = req.body.tag;
  todos.set(next.id, next);
  notifyStats();
  res.json(next);
});

app.delete('/todos/:id', (req, res) => {
  const existed = todos.delete(req.params.id);
  if (!existed) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  notifyStats();
  res.status(204).end();
});

tesseron.app({
  id: 'express_todo',
  name: 'Express Todo Backend',
  description: 'Express backend exposing the same todo domain to Claude via MCP and to HTTP clients via REST.',
  origin: `http://localhost:${HTTP_PORT}`,
});

// --- Plain actions -------------------------------------------------

tesseron
  .action('addTodo')
  .describe('Add a new todo item to the list. Returns the created todo.')
  .input(z.object({ text: z.string().min(1), tag: z.string().optional() }))
  .handler(({ text, tag }) => {
    const todo: Todo = { id: newId(), text, done: false, tag };
    todos.set(todo.id, todo);
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
  .describe('Change the default filter used by GET /todos when no ?filter= is provided.')
  .input(z.object({ filter: z.enum(['all', 'active', 'completed']) }))
  .handler(({ filter: f }) => {
    filter = f;
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
    if (!ok) return { removed: 0, cancelled: true };

    let removed = 0;
    for (const [id, t] of todos) {
      if (t.done) {
        todos.delete(id);
        removed++;
      }
    }
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
    if (answer === null) return { id, renamed: false, cancelled: true };
    const updated: Todo = { ...todo, text: answer.newName };
    todos.set(id, updated);
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
    notifyStats();
    return { theme, added: added.length, ids: added.map((t) => t.id) };
  });

// --- Subscribable resources ---------------------------------------

tesseron
  .resource<Filter>('currentFilter')
  .describe('The filter currently set on the backend.')
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

const httpServer = app.listen(HTTP_PORT, async () => {
  process.stdout.write(`[todo] Express HTTP API on http://localhost:${HTTP_PORT}\n`);
  try {
    const welcome = await tesseron.connect();
    process.stdout.write(
      `[todo] connected to gateway. session=${welcome.sessionId} claim=${welcome.claimCode}\n`,
    );
    process.stdout.write(`[todo] tell Claude: "claim session ${welcome.claimCode}"\n`);
  } catch (error) {
    process.stderr.write(
      `[todo] failed to connect to gateway: ${(error as Error).message}\n`,
    );
    process.stderr.write(
      '[todo] is the gateway running? `pnpm --filter @tesseron/mcp start`\n',
    );
  }
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`[todo] ${signal} received, shutting down\n`);
  try {
    await tesseron.disconnect();
  } catch {
    // best effort: gateway may already be gone
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
