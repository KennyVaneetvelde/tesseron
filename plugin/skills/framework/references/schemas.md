# Schemas (Standard Schema + Zod / Valibot / Typebox)

## Contents
- Standard Schema spec
- Zod (most common)
- Valibot
- Typebox
- The optional `jsonSchema` argument
- What the agent actually sees
- Output schemas and `.strictOutput()`
- Common mistakes

## Standard Schema spec

Tesseron does not ship its own validator. `.input(...)` and `.output(...)` accept any object implementing the [Standard Schema v1 spec](https://standardschema.dev):

```ts
type StandardSchemaV1<T> = {
  '~standard': {
    version: 1;
    vendor: string;
    validate: (value: unknown) =>
      | { value: T }
      | { issues: StandardSchemaV1.Issue[] };
  };
};
```

Zod, Valibot, and Typebox all implement this spec out of the box. So do many other validators — if your favorite does, it works.

## Zod

Most Tesseron code in the wild uses Zod. It's the most ergonomic option and `z.toJSONSchema(...)` produces high-quality JSON Schema for the manifest.

```ts
import { z } from 'zod';

const TodoInput = z.object({
  text: z.string().min(1).describe('The text content of the todo'),
  tag: z.enum(['work', 'personal', 'urgent']).optional().describe('Optional tag'),
  priority: z.number().int().min(1).max(5).default(3).describe('1 = low, 5 = high'),
});

tesseron
  .action('addTodo')
  .describe('Add a new todo item.')
  .input(TodoInput, z.toJSONSchema(TodoInput))
  .handler(({ text, tag, priority }) => { /* ... */ });
```

Use `.describe(...)` on individual fields — Zod flows those into the generated JSON Schema and Instructor-style validators surface them to the agent as argument hints.

**Zod version.** `z.toJSONSchema(...)` lives on Zod 4+. On Zod 3 you can use the community `zod-to-json-schema` package or skip the second argument entirely (see below).

## Valibot

```ts
import { object, string, minLength, pipe, enum as v_enum, optional } from 'valibot';

const TodoInput = object({
  text: pipe(string(), minLength(1)),
  tag: optional(v_enum({ Work: 'work', Personal: 'personal', Urgent: 'urgent' })),
});

tesseron
  .action('addTodo')
  .describe('Add a todo.')
  .input(TodoInput)
  .handler(({ text, tag }) => { /* ... */ });
```

Valibot is smaller than Zod at the cost of a sparser DX for deriving JSON Schema. Pass the second `jsonSchema` argument manually if your agent needs rich argument hints.

## Typebox

```ts
import { Type } from '@sinclair/typebox';

const TodoInput = Type.Object({
  text: Type.String({ minLength: 1, description: 'The text content' }),
  tag: Type.Optional(Type.Union([
    Type.Literal('work'),
    Type.Literal('personal'),
    Type.Literal('urgent'),
  ])),
});

tesseron
  .action('addTodo')
  .describe('Add a todo.')
  .input(TodoInput, TodoInput) // Typebox schemas ARE JSON Schema
  .handler(({ text, tag }) => { /* ... */ });
```

Typebox is unique in that its runtime schema objects *are* valid JSON Schema — you can pass the same object as both the validator and the `jsonSchema` argument.

## The optional `jsonSchema` argument

`.input(schema, jsonSchema?)` and `.output(schema, jsonSchema?)` both accept a second argument: a plain JSON Schema object that is sent to the agent in the manifest.

```ts
// With explicit JSON Schema — recommended
.input(TodoInput, z.toJSONSchema(TodoInput))

// Without — the gateway falls back to a permissive schema
.input(TodoInput)
```

**What the agent sees when you pass a JSON Schema:** a typed, constrained hint — field names, types, enums, min/max — that lets the agent generate the right call.

**What the agent sees when you omit it:** a permissive fallback (`{ type: 'object', additionalProperties: true }`). Invocations still validate at runtime against your validator, but the agent has less information to work with, so it may produce inputs that validate poorly.

**Rule of thumb:** always pass `jsonSchema` when you can derive it cheaply (Zod 4's `z.toJSONSchema`, Typebox's own schema, a generator library). Skip it only when deriving is painful and the action is simple enough that the description + `.describe()` per-field already makes the shape obvious.

## What the agent actually sees

The manifest entry for an action reaching the agent looks roughly like:

```jsonc
{
  "name": "todos__addTodo",              // <app_id>__<action_name>
  "description": "Add a new todo item.", // from .describe(...)
  "inputSchema": {                        // from jsonSchema OR the fallback
    "type": "object",
    "properties": {
      "text": { "type": "string", "minLength": 1, "description": "The text content of the todo" },
      "tag":  { "type": "string", "enum": ["work", "personal", "urgent"] }
    },
    "required": ["text"]
  },
  "annotations": { "destructive": false, "readOnly": false }
}
```

The agent builds a tool call using this schema; the SDK validates it against your validator when `actions/invoke` arrives; invalid input is rejected with `InputValidation` (`-32004`) before your handler runs.

## Output schemas and `.strictOutput()`

`.output(schema)` serves two purposes:

1. It's published in the manifest so the agent can reason about what it will receive.
2. It's validated at runtime (*informational* by default; *enforced* with `.strictOutput()`).

```ts
// Default — validation is advisory; output is returned to the agent even if invalid
.output(z.object({ id: z.string() }))

// Strict — validation failure throws HandlerError and the agent sees an error
.output(z.object({ id: z.string() }))
.strictOutput()
```

Use `.strictOutput()` when the agent's next step depends on the exact shape. Skip it when you want graceful degradation — the agent is often smart enough to handle slightly different output shapes.

## Common mistakes

- **Passing a plain TypeScript `interface` or `type` to `.input(...)`.** TypeScript types erase at runtime. They cannot validate anything. Use a real validator.
- **Omitting the `jsonSchema` argument when you could derive it for free.** The permissive fallback works but gives the agent less help; an imperfect JSON Schema is better than none.
- **Forgetting `.describe(...)` on Zod fields.** Field descriptions flow into the JSON Schema as `description` and into the agent's tool signature. The agent leans on them when picking arguments.
- **Writing JSON Schema by hand for a Zod object.** `z.toJSONSchema(schema)` produces what you'd write anyway; hand-written versions drift. If Zod 4 is not yet in the project, use `zod-to-json-schema`.
- **Validating output "strictly" everywhere by default.** Strict output is a hard gate — if your handler occasionally returns an extra field, the agent sees an error. Reserve `.strictOutput()` for shapes the agent must rely on.
- **Mixing validator libraries for one action.** Stick to one library per codebase unless you have a strong reason; interop between Zod + Valibot + Typebox works but increases cognitive load.
- **Treating schema errors as generic `Error`.** Input validation failures produce `TesseronError` with `code: -32004` (`InputValidation`) and a `data` field containing the issue path. Branch on that, not message text.
