import { useEffect, useRef, useState } from 'react';
import {
  useTesseronAction,
  useTesseronConnection,
  useTesseronResource,
} from '@tesseron/react';
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

export function App(): JSX.Element {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [input, setInput] = useState('');
  const [lastLog, setLastLog] = useState<string>('');

  // `resume: true` persists `{ sessionId, resumeToken }` in localStorage so a
  // page refresh / HMR reload reattaches to the same claimed session via
  // `tesseron/resume` instead of issuing a fresh claim code each time.
  const connection = useTesseronConnection({ resume: true });

  // Refs to read latest state from handlers that close over stale values.
  const todosRef = useRef(todos);
  todosRef.current = todos;
  const filterRef = useRef(filter);
  filterRef.current = filter;

  // Subscriber registries — pushed when state changes.
  const filterSubs = useRef(new Set<(v: Filter) => void>());
  const statsSubs = useRef(new Set<(v: Stats) => void>());

  const stats: Stats = {
    total: todos.length,
    completed: todos.filter((t) => t.done).length,
    pending: todos.filter((t) => !t.done).length,
  };

  // Push updates to subscribers whenever state changes.
  useEffect(() => {
    filterSubs.current.forEach((fn) => fn(filter));
  }, [filter]);
  useEffect(() => {
    statsSubs.current.forEach((fn) => fn(stats));
    // Stats is derived from todos; depending on `todos` is the correct trigger.
  }, [todos]); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Plain actions ------------------------------------------------

  useTesseronAction('addTodo', {
    description: 'Add a new todo item to the list. Returns the created todo.',
    input: z.object({ text: z.string().min(1), tag: z.string().optional() }),
    handler: ({ text, tag }) => {
      const todo: Todo = { id: newId(), text, done: false, tag };
      setTodos((current) => [...current, todo]);
      return todo;
    },
  });

  useTesseronAction('toggleTodo', {
    description: 'Toggle the done state of a todo by id.',
    input: z.object({ id: z.string() }),
    handler: ({ id }) => {
      let updated: Todo | undefined;
      setTodos((current) =>
        current.map((todo) => {
          if (todo.id === id) {
            updated = { ...todo, done: !todo.done };
            return updated;
          }
          return todo;
        }),
      );
      if (!updated) throw new Error(`No todo with id "${id}"`);
      return updated;
    },
  });

  useTesseronAction('deleteTodo', {
    description: 'Delete a todo by id. Destructive: removes the item permanently.',
    input: z.object({ id: z.string() }),
    annotations: { destructive: true },
    handler: ({ id }) => {
      let removed = false;
      setTodos((current) => {
        const before = current.length;
        const next = current.filter((t) => t.id !== id);
        removed = next.length < before;
        return next;
      });
      if (!removed) throw new Error(`No todo with id "${id}"`);
      return { id, removed: true };
    },
  });

  useTesseronAction('listTodos', {
    description: 'List todos, optionally filtered by state.',
    input: z.object({
      filter: z.enum(['all', 'active', 'completed']).optional(),
    }),
    annotations: { readOnly: true },
    handler: ({ filter: f }) => {
      const which = f ?? 'all';
      const current = todosRef.current;
      if (which === 'active') return current.filter((t) => !t.done);
      if (which === 'completed') return current.filter((t) => t.done);
      return current;
    },
  });

  useTesseronAction('setFilter', {
    description: 'Change the visible filter (all | active | completed).',
    input: z.object({ filter: z.enum(['all', 'active', 'completed']) }),
    handler: ({ filter: f }) => {
      setFilter(f);
      return { filter: f };
    },
  });

  // --- Elicitation -------------------------------------------------

  useTesseronAction('clearCompleted', {
    description:
      'Remove all todos marked as done. If the agent supports elicitation, the user is prompted to confirm first.',
    annotations: { destructive: true, requiresConfirmation: true },
    handler: async (_input, ctx) => {
      const removable = todosRef.current.filter((t) => t.done).length;
      if (removable === 0) return { removed: 0 };

      const ok = await ctx.confirm({
        question: `Remove ${removable} completed todo${removable === 1 ? '' : 's'}? This cannot be undone.`,
      });
      if (!ok) {
        setLastLog(`clearCompleted cancelled (${removable} would-have-been-removed)`);
        return { removed: 0, cancelled: true };
      }
      setTodos((current) => current.filter((t) => !t.done));
      setLastLog(`clearCompleted removed ${removable} todo${removable === 1 ? '' : 's'}`);
      return { removed: removable };
    },
  });

  // --- Structured elicitation --------------------------------------

  useTesseronAction('renameTodo', {
    description:
      'Rename a todo. Prompts the user via ctx.elicit for the new name — if the user declines or cancels, no change.',
    input: z.object({ id: z.string() }),
    handler: async ({ id }, ctx) => {
      const todo = todosRef.current.find((t) => t.id === id);
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
        setLastLog(`renameTodo ${id}: cancelled`);
        return { id, renamed: false, cancelled: true };
      }
      setTodos((current) =>
        current.map((t) => (t.id === id ? { ...t, text: answer.newName } : t)),
      );
      setLastLog(`renameTodo ${id}: "${todo.text}" → "${answer.newName}"`);
      return { id, renamed: true, newName: answer.newName };
    },
  });

  // --- Progress ----------------------------------------------------

  useTesseronAction('importTodos', {
    description:
      'Bulk-import a list of todos one by one. Emits progress notifications so the agent can surface a live status.',
    input: z.object({
      items: z.array(z.string().min(1)).min(1).max(50),
      tag: z.string().optional(),
    }),
    handler: async ({ items, tag }, ctx) => {
      const total = items.length;
      ctx.progress({ message: 'importing...', percent: 0 });
      const added: Todo[] = [];
      for (let i = 0; i < total; i += 1) {
        await new Promise((r) => setTimeout(r, 60));
        if (ctx.signal.aborted) throw new Error('Cancelled');
        const todo: Todo = { id: newId(), text: items[i]!, done: false, tag };
        setTodos((current) => [...current, todo]);
        added.push(todo);
        ctx.progress({
          message: `${i + 1}/${total} imported`,
          percent: Math.round(((i + 1) / total) * 100),
        });
      }
      return { added: added.length, ids: added.map((t) => t.id) };
    },
  });

  // --- Sampling ----------------------------------------------------

  useTesseronAction('suggestTodos', {
    description:
      'Ask the agent LLM to produce a themed list of todos, then add them. Uses ctx.sample — no API key needed on this side.',
    input: z.object({
      theme: z.string().min(1),
      count: z.number().int().min(1).max(10).optional(),
    }),
    handler: async ({ theme, count }, ctx) => {
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
      const added: Todo[] = result.items.map((text) => ({
        id: newId(),
        text,
        done: false,
        tag: theme,
      }));
      setTodos((current) => [...current, ...added]);
      return { theme, added: added.length, ids: added.map((t) => t.id) };
    },
  });

  // --- Subscribable resources -------------------------------------

  useTesseronResource<Filter>('currentFilter', {
    description: 'The filter currently active on the UI.',
    read: () => filterRef.current,
    subscribe: (emit) => {
      filterSubs.current.add(emit);
      return () => filterSubs.current.delete(emit);
    },
  });

  useTesseronResource<Stats>('todoStats', {
    description: 'Counts of total / completed / pending todos. Pushed on every change.',
    read: () => {
      const current = todosRef.current;
      return {
        total: current.length,
        completed: current.filter((t) => t.done).length,
        pending: current.filter((t) => !t.done).length,
      };
    },
    subscribe: (emit) => {
      statsSubs.current.add(emit);
      return () => statsSubs.current.delete(emit);
    },
  });

  const visibleTodos = todos.filter((t) => {
    if (filter === 'active') return !t.done;
    if (filter === 'completed') return t.done;
    return true;
  });

  function addInput(): void {
    const trimmed = input.trim();
    if (!trimmed) return;
    setTodos((current) => [...current, { id: newId(), text: trimmed, done: false }]);
    setInput('');
  }

  return (
    <main>
      <header>
        <h1>Todos × Claude</h1>
        <p>
          A real React app whose state is drivable by Claude through{' '}
          <code>@tesseron/react</code>. Every Tesseron capability is wired in:
          actions, <code>ctx.progress</code>, <code>ctx.elicit</code>,{' '}
          <code>ctx.sample</code>, and subscribable resources.
        </p>
      </header>

      <section className="connect-card" data-status={connection.status}>
        <div>
          <strong>Status:</strong> {connection.status}
          {connection.error && <span className="error"> — {connection.error.message}</span>}
        </div>
        {connection.claimCode && (
          <div>
            <strong>Claim code:</strong> <code className="claim-code">{connection.claimCode}</code>
            <p className="hint">Tell Claude: "claim session {connection.claimCode}"</p>
          </div>
        )}
      </section>

      <section className="add-row">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addInput();
          }}
          placeholder="What needs doing?"
          aria-label="New todo text"
        />
        <button type="button" onClick={addInput}>
          Add
        </button>
      </section>

      <nav className="filters">
        {(['all', 'active', 'completed'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={filter === f ? 'active' : ''}
            onClick={() => setFilter(f)}
          >
            {f}
          </button>
        ))}
      </nav>

      <ul className="todos">
        {visibleTodos.map((todo) => (
          <li key={todo.id} className={todo.done ? 'done' : ''}>
            <label>
              <input
                type="checkbox"
                checked={todo.done}
                onChange={() =>
                  setTodos((current) =>
                    current.map((t) => (t.id === todo.id ? { ...t, done: !t.done } : t)),
                  )
                }
              />
              <span>{todo.text}</span>
              {todo.tag && <em className="tag">#{todo.tag}</em>}
            </label>
            <button
              type="button"
              className="delete"
              onClick={() => setTodos((current) => current.filter((t) => t.id !== todo.id))}
              aria-label={`Delete ${todo.text}`}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <p className="stats">
        <strong>{stats.total}</strong> total ·{' '}
        <strong>{stats.pending}</strong> pending ·{' '}
        <strong>{stats.completed}</strong> done
      </p>

      {lastLog && <p className="log">last agent event: {lastLog}</p>}

      <footer>
        <p>
          Actions exposed to Claude:{' '}
          <code>todos__addTodo</code>, <code>todos__toggleTodo</code>,{' '}
          <code>todos__deleteTodo</code>,{' '}
          <code>todos__clearCompleted</code> (confirms),{' '}
          <code>todos__renameTodo</code> (elicits),{' '}
          <code>todos__importTodos</code> (progress),{' '}
          <code>todos__suggestTodos</code> (sampling),{' '}
          <code>todos__listTodos</code>, <code>todos__setFilter</code>.
        </p>
        <p>
          Resources (subscribable): <code>tesseron://todos/currentFilter</code>,{' '}
          <code>tesseron://todos/todoStats</code>.
        </p>
      </footer>
    </main>
  );
}
