---
'@tesseron/core': patch
'@tesseron/mcp': patch
'@tesseron/server': patch
'@tesseron/web': patch
'@tesseron/react': patch
'@tesseron/svelte': patch
'@tesseron/vue': patch
---

Auto-derive JSON Schema from Standard Schema validators that ship a converter.

The documented `.input(z.object({...}))` idiom previously shipped every action
with a permissive `{type: 'object', additionalProperties: true}` because no
auto-derivation existed in `@tesseron/core` — only the explicit-second-arg
path was wired up. Agents got no field-type signal, which meant Claude
sometimes JSON-encoded numeric arguments as strings; Zod's runtime then
correctly rejected the call with `-32004 InputValidation`.

`ActionBuilder.input` / `.output` and `ResourceBuilder.output` now look for a
JSON Schema exporter on the validator and use it when the caller didn't pass
one explicitly. Detection is duck-typed and never throws — failures fall
through to the existing permissive default:

- **Zod 4+** — `schema.toJSONSchema()` instance method.
- **TypeBox** — schema object IS the JSON Schema; `~standard` is stripped.
- **ArkType** — `schema.toJsonSchema()` instance method.
- **Valibot / Effect Schema / Zod 3** — no native instance exporter; pass
  JSON Schema as the second argument (use `@valibot/to-json-schema`,
  `@effect/schema/JSONSchema`, or `zod-to-json-schema` respectively).

Closes #43.
