import type { StandardSchemaV1 } from '@standard-schema/spec';
import { describe, expect, it } from 'vitest';
import { TesseronError } from '../src/errors.js';
import { TesseronErrorCode } from '../src/protocol.js';
import {
  CONFIRM_REQUESTED_SCHEMA,
  PERMISSIVE_ELICIT_SCHEMA,
  assertValidElicitSchema,
  deriveJsonSchema,
} from '../src/schema-helpers.js';

describe('assertValidElicitSchema', () => {
  it('accepts a flat object with primitive leaves', () => {
    expect(() =>
      assertValidElicitSchema({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
          active: { type: 'boolean' },
          weight: { type: 'number' },
        },
        required: ['name'],
      }),
    ).not.toThrow();
  });

  it('accepts the empty-properties CONFIRM_REQUESTED_SCHEMA', () => {
    expect(() => assertValidElicitSchema(CONFIRM_REQUESTED_SCHEMA)).not.toThrow();
  });

  it('accepts the fallback PERMISSIVE_ELICIT_SCHEMA', () => {
    expect(() => assertValidElicitSchema(PERMISSIVE_ELICIT_SCHEMA)).not.toThrow();
  });

  it('rejects non-object values', () => {
    for (const v of [null, undefined, 42, 'string', true, []]) {
      expect(() => assertValidElicitSchema(v)).toThrow(TesseronError);
    }
  });

  it('rejects a non-object top-level type', () => {
    expect(() => assertValidElicitSchema({ type: 'array' })).toThrow(/top level/);
    expect(() => assertValidElicitSchema({ type: 'string' })).toThrow(/top level/);
  });

  it('rejects top-level oneOf / anyOf / allOf / not', () => {
    expect(() =>
      assertValidElicitSchema({
        type: 'object',
        properties: {},
        oneOf: [{ type: 'object' }, { type: 'object' }],
      }),
    ).toThrow(/oneOf/);
    expect(() =>
      assertValidElicitSchema({
        type: 'object',
        properties: {},
        anyOf: [{ type: 'object' }],
      }),
    ).toThrow(/anyOf/);
  });

  it('rejects nested objects as properties (MCP elicit requires primitive leaves)', () => {
    expect(() =>
      assertValidElicitSchema({
        type: 'object',
        properties: {
          nested: { type: 'object', properties: {} },
        },
      }),
    ).toThrow(/primitive-typed leaves/);
  });

  it('rejects array properties', () => {
    expect(() =>
      assertValidElicitSchema({
        type: 'object',
        properties: { tags: { type: 'array' } },
      }),
    ).toThrow(/primitive-typed leaves/);
  });

  it('surfaces errors as InvalidParams', () => {
    try {
      assertValidElicitSchema({ type: 'array' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(TesseronError);
      expect((e as TesseronError).code).toBe(TesseronErrorCode.InvalidParams);
    }
  });
});

/**
 * Mock-driven tests for the validator-agnostic JSON Schema derivation. We
 * don't pull in real Zod / TypeBox / ArkType here — the contract is duck-
 * typed, so a mock that exposes the right method or `~standard.vendor` is
 * a faithful substitute.
 */
describe('deriveJsonSchema', () => {
  function withZodLike(): StandardSchemaV1<unknown> {
    return {
      '~standard': {
        version: 1,
        vendor: 'zod',
        validate: () => ({ value: undefined }),
      },
      toJSONSchema: () => ({
        type: 'object',
        properties: {
          name: { type: 'string' },
          age: { type: 'integer' },
        },
        required: ['name'],
      }),
    } as never;
  }

  function withArkTypeLike(): StandardSchemaV1<unknown> {
    return {
      '~standard': {
        version: 1,
        vendor: 'arktype',
        validate: () => ({ value: undefined }),
      },
      toJsonSchema: () => ({
        type: 'object',
        properties: { count: { type: 'integer' } },
      }),
    } as never;
  }

  function withTypeBoxLike(): StandardSchemaV1<unknown> {
    return {
      '~standard': {
        version: 1,
        vendor: 'typebox',
        validate: () => ({ value: undefined }),
      },
      type: 'object',
      properties: { value: { type: 'number' } },
      required: ['value'],
    } as never;
  }

  it('extracts JSON Schema from Zod-4-style instance method', () => {
    const result = deriveJsonSchema(withZodLike()) as Record<string, unknown>;
    expect(result?.['type']).toBe('object');
    expect((result?.['properties'] as Record<string, unknown>)?.['age']).toEqual({
      type: 'integer',
    });
  });

  it('extracts JSON Schema from ArkType-style toJsonSchema', () => {
    const result = deriveJsonSchema(withArkTypeLike()) as Record<string, unknown>;
    expect((result?.['properties'] as Record<string, unknown>)?.['count']).toEqual({
      type: 'integer',
    });
  });

  it('returns the TypeBox schema as-is, with `~standard` stripped', () => {
    const result = deriveJsonSchema(withTypeBoxLike()) as Record<string, unknown>;
    expect(result).toBeTruthy();
    expect(result['type']).toBe('object');
    expect(result['~standard']).toBeUndefined();
    expect(result['properties']).toEqual({ value: { type: 'number' } });
  });

  it('returns undefined for a validator with no exporter', () => {
    const valibotLike: StandardSchemaV1<unknown> = {
      '~standard': {
        version: 1,
        vendor: 'valibot',
        validate: () => ({ value: undefined }),
      },
    };
    expect(deriveJsonSchema(valibotLike)).toBeUndefined();
  });

  it('falls back to undefined when the exporter throws', () => {
    const broken = {
      '~standard': { version: 1, vendor: 'zod', validate: () => ({ value: undefined }) },
      toJSONSchema: () => {
        throw new Error('unsupported feature');
      },
    } as unknown as StandardSchemaV1<unknown>;
    expect(deriveJsonSchema(broken)).toBeUndefined();
  });

  it('returns undefined for non-objects', () => {
    expect(deriveJsonSchema(undefined)).toBeUndefined();
    expect(deriveJsonSchema(null)).toBeUndefined();
    expect(deriveJsonSchema('schema')).toBeUndefined();
    expect(deriveJsonSchema(42)).toBeUndefined();
  });
});
