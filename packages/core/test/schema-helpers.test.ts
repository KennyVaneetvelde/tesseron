import { describe, expect, it } from 'vitest';
import {
  CONFIRM_REQUESTED_SCHEMA,
  PERMISSIVE_ELICIT_SCHEMA,
  assertValidElicitSchema,
} from '../src/schema-helpers.js';
import { TesseronError } from '../src/errors.js';
import { TesseronErrorCode } from '../src/protocol.js';

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
