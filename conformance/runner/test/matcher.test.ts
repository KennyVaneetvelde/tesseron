import { describe, expect, it } from 'vitest';
import { matchJson, resolveReferences } from '../src/matcher.js';

describe('matchJson', () => {
  it('matches every token and keeps object matching partial', () => {
    const captures = new Map<string, unknown>();
    const result = matchJson(
      {
        any: '~any',
        text: '~string',
        count: '~number',
        ready: '~boolean',
        record: '~object',
        list: '~array',
        pattern: '~regex:^claim-[0-9]+$',
        saved: '~capture:payload',
        missing: '~absent',
      },
      {
        any: null,
        text: 'hello',
        count: 4,
        ready: false,
        record: { ok: true },
        list: [1, 2],
        pattern: 'claim-42',
        saved: { nested: ['exact'] },
        extra: true,
      },
      captures,
    );

    expect(result).toEqual({ matched: true });
    expect(captures.get('payload')).toEqual({ nested: ['exact'] });
    expect(matchJson('~ref:payload', { nested: ['exact'] }, captures)).toEqual({ matched: true });
  });

  it('requires exact arrays, deep references, and absent object properties', () => {
    const captures = new Map<string, unknown>([['payload', { values: [1, 2] }]]);

    expect(matchJson(['~number'], [1, 2], captures).matched).toBe(false);
    expect(matchJson('~ref:payload', { values: [1, 3] }, captures).matched).toBe(false);
    expect(matchJson({ removed: '~absent' }, { removed: undefined }, captures).matched).toBe(false);
    expect(matchJson('~object', [], captures).matched).toBe(false);
  });

  it('commits captures only after the whole match succeeds', () => {
    const captures = new Map<string, unknown>();

    const result = matchJson(
      { first: '~capture:first', second: 'expected' },
      { first: { value: 1 }, second: 'different' },
      captures,
    );

    expect(result.matched).toBe(false);
    expect(captures.has('first')).toBe(false);
  });
});

describe('resolveReferences', () => {
  it('resolves nested references as independent JSON values', () => {
    const original = { nested: ['value'] };
    const captures = new Map<string, unknown>([['payload', original]]);
    const resolved = resolveReferences(
      { direct: '~ref:payload', nested: ['~ref:payload'] },
      captures,
    );

    expect(resolved).toEqual({ direct: original, nested: [original] });
    expect(resolved).not.toBe(original);
  });
});
