# Actions (`ActionBuilder` + `ActionDefinition`)

## Contents
- The builder chain
- Shape of an action definition
- Annotations
- Timeouts
- Strict output validation
- Sync vs async handlers
- Registering multiple actions
- Removing actions at runtime
- Common mistakes

## The builder chain

```ts
import { tesseron } from '@tesseron/web'; // or '@tesseron/server'
import { z } from 'zod';

tesseron
  .action('addTodo')
  .describe('Add a new todo item to the list. Returns the created todo.')
  .input(z.object({ text: z.string().min(1), tag: z.string().optional() }))
  .output(z.object({ id: z.string(), text: z.string(), done: z.boolean() }))
  .annotate({ destructive: false, readOnly: false })
  .timeout({ ms: 10_000 })
  .strictOutput()
  .handler(({ text, tag }) => {
    const todo = { id: crypto.randomUUID(), text, done: false, tag };
    todos.push(todo);
    return todo;
  });
```

Each method except `.handler(...)` returns the builder for chaining. `.handler(...)` is the **terminal call** — it commits the action and returns an `ActionDefinition`. Chaining anything after `.handler(...)` operates on the frozen definition, not the builder, and the chain call is silently dropped.

Call order does not matter between `.describe()`, `.input()`, `.output()`, `.annotate()`, `.timeout()`, and `.strictOutput()`. Only `.handler()` must be last.

## Shape of an action definition

```ts
interface ActionDefinition<I, O> {
  name: string;
  description: string;
  inputSchema?: StandardSchemaV1<I>;
  outputSchema?: StandardSchemaV1<O>;
  annotations: ActionAnnotations;
  timeoutMs: number;
  strictOutput: boolean;
  handler: ActionHandler<I, O>;
}

type ActionHandler<I, O> = (input: I, ctx: ActionContext) => Promise<O> | O;
```

Once registered, the action is announced in the `tesseron/hello` handshake and exposed to the agent as an MCP tool named `<app_id>__<action_name>` (see `gateway.md`).

## `.describe(...)`

The description is the primary hint the LLM uses to pick the tool. Write for the model.

```ts
// Good — explicit purpose, explicit return
.describe('Mark a todo as completed. Returns the updated todo.')

// Good — covers intent + key behavior
.describe('Search the user\'s todos by text. Returns matching items sorted by recency.')

// Bad — vague
.describe('Todo stuff')

// Bad — refers to implementation
.describe('Calls updateTodoInDB and then refreshes the view')
```

Field descriptions in the input schema matter just as much:

```ts
.input(z.object({
  text: z.string().min(1).describe('The text content of the todo item'),
  tag: z.string().optional().describe('Optional tag for categorization, e.g. "work" or "home"'),
}))
```

Zod's `.describe(...)` on individual fields flows through `z.toJSONSchema(...)` into the manifest the agent sees.

## Annotations

```ts
interface ActionAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  requiresConfirmation?: boolean;
}
```

- **`readOnly: true`** — Pure getters or queries that never mutate state. Helps the agent reason about side effects.
- **`destructive: true`** — Deletes, resets, outbound side effects the user cannot trivially undo.
- **`requiresConfirmation: true`** — The agent should surface a confirmation UI before invoking. Pair with `destructive` for deletes; use alone for anything the user should consciously authorize (sending email, posting publicly, charging a card).

```ts
.annotate({ destructive: true, requiresConfirmation: true })
```

Annotations are advisory — the gateway forwards them to the agent, but the agent is free to invoke regardless. Still set them accurately so the agent can present the right UX.

## Timeouts

Default is **60 seconds**. Override per-action:

```ts
.timeout({ ms: 5_000 })   // cut off at 5 seconds
.timeout({ ms: 120_000 }) // allow 2 minutes for a long operation
```

When the timeout fires, the handler is **not** automatically cancelled — the gateway sends an `actions/cancel` notification, which fires `ctx.signal`. Handlers must observe `ctx.signal` to actually abort the work; see `context.md`.

## Strict output validation

By default, output validation is **informational** — if the output fails the schema, a warning is logged but the value is still returned to the agent. Set `.strictOutput()` to make validation a hard gate:

```ts
.output(z.object({ id: z.string(), done: z.boolean() }))
.strictOutput()
.handler(() => ({ id: 'abc', done: 'yes' })) // throws HandlerError, agent sees failure
```

Use strict output when the agent's next step depends on the exact shape. Skip it when you want fault tolerance for shapes that may evolve.

## Sync vs async handlers

Handlers may be sync or async. Tesseron awaits the return value either way, so `return value` and `return Promise.resolve(value)` are equivalent.

```ts
// Sync — fine for in-memory mutations
.handler(({ id }) => todos.delete(id))

// Async — required for I/O
.handler(async ({ id }, ctx) => {
  const res = await fetch(`/api/todos/${id}`, { method: 'DELETE', signal: ctx.signal });
  if (!res.ok) throw new Error(`delete failed: ${res.status}`);
  return { id, deleted: true };
})
```

When the handler does any I/O that respects an `AbortSignal`, forward `ctx.signal`. Gateway cancellation propagates through the signal; handlers that ignore it keep running after cancellation.

## Registering multiple actions

Register all actions **before** calling `tesseron.connect(...)`. They're announced in the initial `tesseron/hello` welcome handshake.

```ts
tesseron.app({ id: 'todos', name: 'Todos' });

tesseron.action('addTodo').describe('...').input(...).handler(...);
tesseron.action('completeTodo').describe('...').input(...).handler(...);
tesseron.action('listTodos').describe('...').annotate({ readOnly: true }).handler(...);

await tesseron.connect();
```

Actions registered after `connect()` are valid but must be announced via `actions/list_changed` — the SDK does this automatically. Agents that honor `notifications/tools/list_changed` pick them up; agents that freeze their tool list at startup will not.

## Removing actions at runtime

```ts
tesseron.removeAction('addTodo');
```

Sends `actions/list_changed` to the gateway so the agent can refresh. Useful for feature flags, permission-scoped actions, or actions that depend on transient app state.

## Common mistakes

- **Chaining after `.handler(...)`.** `.handler(...)` is terminal; subsequent `.describe(...)` / `.annotate(...)` calls operate on the frozen `ActionDefinition` and do nothing useful. Put all chain calls before `.handler(...)`.
- **Skipping `.describe(...)`.** The LLM picks tools by description; an undescribed action is effectively invisible.
- **Plain TypeScript types passed to `.input(...)`.** `interface User { ... }` is a compile-time type, not a runtime validator. Wrap in Zod / Valibot / Typebox.
- **Not forwarding `ctx.signal` to `fetch` / child processes.** Cancellation from the gateway cannot propagate; timeouts fire but the work keeps running.
- **Forgetting `.annotate({ destructive: true })` on deletes.** The agent loses the signal to surface confirmation UX.
- **Setting a huge `.timeout({ ms: ... })` as a substitute for progress reporting.** Long operations should `ctx.progress(...)` periodically, not hide behind a 10-minute timeout.
- **Relying on output validation without `.strictOutput()`.** Default is informational; handler-returned garbage still reaches the agent. Add `.strictOutput()` when correctness matters.
- **Registering actions inside handlers, loops, or conditionals.** Register at module load (for the singleton) or on component mount (for React hooks), not inside request-handling code.
