import type { StandardSchemaV1 } from '@standard-schema/spec';
import { TesseronError } from './errors.js';
import { TesseronErrorCode } from './protocol.js';

export interface ValidationSuccess<T> {
  ok: true;
  value: T;
}

export interface ValidationFailure {
  ok: false;
  issues: ReadonlyArray<StandardSchemaV1.Issue>;
}

export type ValidationOutcome<T> = ValidationSuccess<T> | ValidationFailure;

export async function standardValidate<T>(
  schema: StandardSchemaV1<T>,
  value: unknown,
): Promise<ValidationOutcome<T>> {
  const result = await schema['~standard'].validate(value);
  if ('issues' in result && result.issues) {
    return { ok: false, issues: result.issues };
  }
  return { ok: true, value: (result as { value: T }).value };
}

const PERMISSIVE_OBJECT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
} as const;

export function permissiveJsonSchema(): unknown {
  return { ...PERMISSIVE_OBJECT_SCHEMA };
}

/**
 * Try to extract a JSON Schema from a Standard Schema validator without
 * dragging the validator package in as a dependency. Auto-derivation is the
 * documented happy path — the agent sees real property types instead of the
 * `{type: 'object', additionalProperties: true}` fallback, which makes Claude
 * dramatically more likely to JSON-encode field values correctly.
 *
 * Detection is duck-typed and conservative — we never throw, and any failure
 * (vendor we can't introspect, a validator that throws inside its converter)
 * silently returns `undefined` so the caller falls back to the permissive
 * default. Callers that want a guaranteed schema should pass one explicitly
 * as the second argument to `.input()` / `.output()`.
 *
 * Supported today:
 *   - **Zod 4+**         – `schema.toJSONSchema()` (instance method).
 *   - **ArkType**        – `schema.toJsonSchema()` (instance method, lowerCamelCase).
 *   - **TypeBox**        – the schema object IS a JSON Schema; we strip the
 *                          Standard Schema metadata field and return the rest.
 *
 * Not auto-derived (caller must pass JSON Schema explicitly):
 *   - **Zod ≤ 3**        – no native export; pair `.input(schema, zodToJsonSchema(schema))`.
 *   - **Valibot**        – needs `@valibot/to-json-schema` separately.
 *   - **Effect Schema**  – needs `JSONSchema.make` from `@effect/schema` separately.
 */
export function deriveJsonSchema(schema: unknown): unknown | undefined {
  if (!schema || typeof schema !== 'object') return undefined;
  const s = schema as Record<string, unknown>;

  // Zod 4 (and any other validator that ships an instance-method exporter
  // following Zod's casing): `schema.toJSONSchema()`.
  const toJSONSchema = s['toJSONSchema'];
  if (typeof toJSONSchema === 'function') {
    try {
      const result = (toJSONSchema as () => unknown).call(schema);
      if (result && typeof result === 'object') return result;
    } catch {
      // fall through to other strategies
    }
  }

  // ArkType: lowerCamelCase variant.
  const toJsonSchema = s['toJsonSchema'];
  if (typeof toJsonSchema === 'function') {
    try {
      const result = (toJsonSchema as () => unknown).call(schema);
      if (result && typeof result === 'object') return result;
    } catch {
      // fall through
    }
  }

  // TypeBox: the schema object already conforms to JSON Schema; strip the
  // Standard Schema metadata key so we don't leak `~standard` (which carries
  // a `validate` function) into the wire manifest.
  const standard = s['~standard'] as { vendor?: unknown } | undefined;
  if (standard && standard.vendor === 'typebox' && typeof s['type'] === 'string') {
    const { '~standard': _ignored, ...rest } = s;
    return rest;
  }

  return undefined;
}

/**
 * Schema used by `ctx.confirm` — an object with zero properties, so MCP
 * clients render pure Accept/Decline without any input field. Verified
 * against the MCP SDK's `ElicitRequestFormParamsSchema` (ZodRecord with no
 * min-properties constraint) — empty `properties` parses cleanly. The SDK's
 * $strip pass would drop any `additionalProperties` key on the way out, so
 * we don't include it.
 */
export const CONFIRM_REQUESTED_SCHEMA = {
  type: 'object',
  properties: {},
  required: [],
} as const;

/**
 * Permissive fallback used when `ctx.elicit` is called without an explicit
 * `jsonSchema`. The MCP client renders a single text input. Callers should
 * provide a real jsonSchema for good UX — this is a last-resort default.
 */
export const PERMISSIVE_ELICIT_SCHEMA = {
  type: 'object',
  properties: {
    response: { type: 'string', description: 'Your response' },
  },
  required: ['response'],
} as const;

/**
 * Validate that a JSON Schema is usable as an MCP elicit `requestedSchema`:
 * object at the top, primitive-typed leaves, no `oneOf`/`anyOf`/`allOf`/`not`.
 * Called on the SDK send path (primary — best error location for the author)
 * and on the gateway's bridge receive path as defense in depth.
 */
export function assertValidElicitSchema(schema: unknown): object {
  if (!schema || typeof schema !== 'object') {
    throw new TesseronError(
      TesseronErrorCode.InvalidParams,
      'elicit jsonSchema must be a JSON Schema object.',
    );
  }
  const s = schema as Record<string, unknown>;
  if (s['type'] !== 'object') {
    throw new TesseronError(
      TesseronErrorCode.InvalidParams,
      `elicit jsonSchema must be { type: "object" } at the top level; got type="${String(
        s['type'],
      )}". Compose a flat object of primitives.`,
    );
  }
  if (s['oneOf'] || s['anyOf'] || s['allOf'] || s['not']) {
    throw new TesseronError(
      TesseronErrorCode.InvalidParams,
      'elicit jsonSchema must not use top-level oneOf/anyOf/allOf/not — MCP elicit clients require a single flat object shape.',
    );
  }
  const props = (s['properties'] ?? {}) as Record<string, unknown>;
  for (const [name, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== 'object') continue;
    const p = prop as Record<string, unknown>;
    const type = Array.isArray(p['type']) ? (p['type'] as unknown[])[0] : p['type'];
    if (!type) continue;
    const t = String(type);
    if (!['string', 'number', 'integer', 'boolean'].includes(t)) {
      throw new TesseronError(
        TesseronErrorCode.InvalidParams,
        `elicit jsonSchema property "${name}" has unsupported type "${t}". MCP elicitation requires primitive-typed leaves (string, number, integer, boolean).`,
      );
    }
  }
  return schema as object;
}
