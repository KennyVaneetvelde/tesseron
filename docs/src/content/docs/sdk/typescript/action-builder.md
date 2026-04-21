---
title: Action builder
description: Every step of the fluent builder, what it does, and when to use it.
---

The action builder is the fluent API on `tesseron.action(name)`. It chains until `.handler(fn)` terminates it with a `RegisteredAction<I, O>`.

## Signature

```ts
interface ActionBuilder<I = unknown, O = unknown> {
  describe(description: string): ActionBuilder<I, O>;
  input<NewI>(schema: StandardSchemaV1<NewI>, jsonSchema?: unknown): ActionBuilder<NewI, O>;
  output<NewO>(schema: StandardSchemaV1<NewO>, jsonSchema?: unknown): ActionBuilder<I, NewO>;
  annotate(annotations: ActionAnnotations): ActionBuilder<I, O>;
  timeout(ms: number): ActionBuilder<I, O>;
  strictOutput(): ActionBuilder<I, O>;
  handler(fn: (input: I, ctx: ActionContext) => O | Promise<O>): RegisteredAction<I, O>;
}
```

## `.describe(string)`

Human-readable description. Shown to the agent's LLM verbatim as the MCP tool description. This is the single biggest lever for getting the agent to call your action correctly; write it as you would write a function docstring for a teammate.

```ts
tesseron.action('searchProducts')
  .describe(
    'Search the product catalog. Returns up to `limit` products ordered by ' +
    'relevance. Use when the user is trying to find items to buy.'
  );
```

## `.input(schema)` and `.input(schema, jsonSchema)`

Bind a Standard Schema validator for input. The schema is used for:

1. **Runtime validation** - invalid input fails with code `-32004` before the handler runs.
2. **Type inference** - `I` in `handler: (input: I, ctx) => …`.
3. **JSON Schema export** - for the MCP tool's `inputSchema`.

Most Standard Schema libraries expose JSON-Schema conversion utilities; the SDK uses whatever your validator provides. If the conversion is missing or inadequate, pass a hand-written JSON Schema as the second argument:

```ts
.input(
  z.object({ sku: z.string(), qty: z.number().int().positive() }),
  { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } }, required: ['sku', 'qty'] },
)
```

## `.output(schema)` / `.output(schema, jsonSchema)`

Bind a Standard Schema for the return value. By default **this is informational** - the value is passed through unchanged. Call `.strictOutput()` to enforce.

```ts
.output(z.object({ id: z.string(), itemId: z.string() }))
```

## `.annotate({…})`

Advisory metadata surfaced to the agent.

```ts
interface ActionAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
  requiresConfirmation?: boolean;
}
```

| Field | Use for |
|---|---|
| `readOnly: true` | Pure reads. Agent may parallelise. |
| `destructive: true` | Mutates persistent state. Agent SHOULD warn the user. |
| `requiresConfirmation: true` | Agent MUST NOT call without explicit user confirmation. Often paired with `ctx.confirm` inside the handler as a second gate. |

## `.timeout(ms)`

Per-invocation timeout. Default 60 000 ms. When exceeded, the handler's `ctx.signal` aborts and the invocation returns error `-32002 Timeout`.

```ts
.timeout(5 * 60 * 1000)   // big report, 5 minutes
```

## `.strictOutput()`

Turns `.output(schema)` from documentation into enforcement. Validation failure becomes `-32005 HandlerError` with `issues` in `error.data`.

```ts
.output(z.object({ id: z.string() }))
.strictOutput()
```

## `.handler(fn)`

The actual function. Terminates the builder. Returns a `RegisteredAction<I, O>` that you normally discard - the SDK keeps a reference internally.

```ts
.handler(async ({ sku, qty }, ctx) => {
  ctx.progress({ message: 'adding', percent: 50 });
  const item = await cart.add(sku, qty);
  return { id: cart.id, itemId: item.id };
});
```

The handler receives `(input: I, ctx: ActionContext)`. See [context API](/sdk/typescript/context/) for what's on `ctx`.

## Full example

```ts
tesseron
  .action('importCsv')
  .describe('Import products from a remote CSV. Emits progress updates while running.')
  .input(z.object({ url: z.string().url() }))
  .output(z.object({ imported: z.number().int().nonnegative() }))
  .annotate({ destructive: true, requiresConfirmation: true })
  .timeout(5 * 60 * 1000)
  .strictOutput()
  .handler(async ({ url }, ctx) => {
    ctx.progress({ message: 'downloading', percent: 5 });
    const rows = await fetchCsv(url, { signal: ctx.signal });
    for (let i = 0; i < rows.length; i += 100) {
      if (ctx.signal.aborted) throw new Error('cancelled');
      ctx.progress({ message: `${i}/${rows.length}`, percent: 5 + Math.floor(i / rows.length * 90) });
      await importBatch(rows.slice(i, i + 100));
    }
    return { imported: rows.length };
  });
```
