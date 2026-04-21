---
title: Standard Schema (Zod, Valibot, …)
description: Any Standard Schema v1 validator works. What that means, which libraries are supported, and how to handle JSON Schema export.
---

Tesseron's action builder accepts any validator that implements [Standard Schema v1](https://standardschema.dev). That's a small contract that most modern TypeScript validation libraries already expose:

```ts
interface StandardSchemaV1<T> {
  readonly '~standard': {
    version: 1;
    vendor: string;
    validate(value: unknown): { value: T } | { issues: Issue[] } | Promise<…>;
  };
}
```

Because the contract is minimal, the SDK doesn't care which library you use. Pick whichever is already in your project - or whichever feels best for writing schemas for agents.

## Supported libraries

All of these implement Standard Schema v1 and work with Tesseron:

| Library | Notes |
|---|---|
| [Zod](https://zod.dev) | De-facto default. The smoothest DX, broadest ecosystem, native `toJSONSchema`. |
| [Valibot](https://valibot.dev) | Tree-shakable, smaller bundle, functional style. |
| [ArkType](https://arktype.io) | TypeScript-first; schemas read like runtime type expressions. |
| [Effect Schema](https://effect.website) | Part of the Effect ecosystem; best if you already use Effect. |
| [TypeBox](https://github.com/sinclairzx81/typebox) | JSON-Schema-first; schemas *are* JSON Schema. |

If your library isn't on the list, check its docs for "Standard Schema" - most have it or are adding it.

## Input validation

Whichever library you use, the behaviour is the same:

```ts
.input(validator)
```

- Before the handler runs, the SDK calls `validator['~standard'].validate(input)`.
- On `{ issues }` → the invocation fails with `-32004 InputValidation`; `issues` ride in `error.data`.
- On `{ value }` → the parsed `value` is passed to your handler, typed as `I`.

## Output validation

Default (informational):

```ts
.output(validator)
```

The SDK does not validate - it uses the schema for JSON Schema export and nothing else.

Strict:

```ts
.output(validator).strictOutput()
```

The SDK validates the handler's return value the same way it validates input. Failures raise `-32005 HandlerError`.

## JSON Schema export

The wire protocol transports each action's input and output as JSON Schema (for the MCP tool descriptor). There are two paths:

### 1. Your validator provides it

Modern Zod, TypeBox, and Effect Schema can produce JSON Schema natively. The SDK picks it up automatically. No extra work.

### 2. Pass it manually

Some validators don't emit JSON Schema, or the export isn't great for a given shape. Pass the JSON Schema as the second argument:

```ts
.input(
  myValidator,
  {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer', default: 10 } },
    required: ['query'],
  },
)
```

### 3. Fallback

If neither path produces a schema, the SDK sends `{ type: 'object', additionalProperties: true }` - permissive, unhelpful to the agent, but the call still works.

## Zod idioms that help the agent

- Use `.describe()` on fields. The text shows up in the generated JSON Schema as `description`, which the agent reads when deciding what to pass.
- Prefer `z.enum(['a', 'b'])` over `z.string()` when there's a finite set - gives the agent the choices up front.
- Provide defaults for optional-looking fields: `z.number().int().default(10)`.
- Avoid deeply nested structures. Flatten where possible.

```ts
.input(z.object({
  query: z.string().describe('Full-text search query; empty string matches all.'),
  limit: z.number().int().min(1).max(100).default(20).describe('Max results to return.'),
  sort: z.enum(['relevance', 'date', 'price']).default('relevance'),
}))
```

## Mixing validators

You can use different validators across actions in the same app. Use Zod for one, Valibot for another - the SDK doesn't care. Consistency inside a project is mostly a tooling preference, not a correctness requirement.
