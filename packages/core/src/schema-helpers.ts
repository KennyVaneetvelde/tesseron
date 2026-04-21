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
