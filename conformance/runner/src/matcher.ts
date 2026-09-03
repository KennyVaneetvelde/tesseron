import { isDeepStrictEqual } from 'node:util';

export interface MatchResult {
  matched: boolean;
  reason?: string;
}

export function matchJson(
  expected: unknown,
  actual: unknown,
  captures: Map<string, unknown>,
  allowCapture = true,
): MatchResult {
  const pendingCaptures = new Map(captures);
  const result = matchValue(expected, actual, pendingCaptures, allowCapture, '$');
  if (result.matched) {
    for (const [name, value] of pendingCaptures) captures.set(name, value);
  }
  return result;
}

function matchValue(
  expected: unknown,
  actual: unknown,
  captures: Map<string, unknown>,
  allowCapture: boolean,
  path: string,
): MatchResult {
  if (typeof expected === 'string' && expected.startsWith('~')) {
    return matchToken(expected, actual, captures, allowCapture, path);
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return mismatch(path, 'expected an array');
    if (expected.length !== actual.length) {
      return mismatch(path, `expected ${expected.length} array items, received ${actual.length}`);
    }
    for (let index = 0; index < expected.length; index += 1) {
      const result = matchValue(
        expected[index],
        actual[index],
        captures,
        allowCapture,
        `${path}[${index}]`,
      );
      if (!result.matched) return result;
    }
    return { matched: true };
  }

  if (isRecord(expected)) {
    if (!isRecord(actual)) return mismatch(path, 'expected an object');
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (expectedValue === '~absent') {
        if (Object.hasOwn(actual, key))
          return mismatch(`${path}.${key}`, 'expected key to be absent');
        continue;
      }
      if (!Object.hasOwn(actual, key))
        return mismatch(`${path}.${key}`, 'expected key to be present');
      const result = matchValue(
        expectedValue,
        actual[key],
        captures,
        allowCapture,
        `${path}.${key}`,
      );
      if (!result.matched) return result;
    }
    return { matched: true };
  }

  return isDeepStrictEqual(expected, actual)
    ? { matched: true }
    : mismatch(path, 'literal values differ');
}

function matchToken(
  token: string,
  actual: unknown,
  captures: Map<string, unknown>,
  allowCapture: boolean,
  path: string,
): MatchResult {
  if (token === '~any') {
    return actual === undefined
      ? mismatch(path, '~any does not match an absent value')
      : { matched: true };
  }
  if (token === '~string') {
    return typeof actual === 'string' ? { matched: true } : mismatch(path, 'expected a string');
  }
  if (token === '~number') {
    return typeof actual === 'number' ? { matched: true } : mismatch(path, 'expected a number');
  }
  if (token === '~boolean') {
    return typeof actual === 'boolean' ? { matched: true } : mismatch(path, 'expected a boolean');
  }
  if (token === '~object') {
    return isRecord(actual) ? { matched: true } : mismatch(path, 'expected an object');
  }
  if (token === '~array') {
    return Array.isArray(actual) ? { matched: true } : mismatch(path, 'expected an array');
  }
  if (token.startsWith('~regex:')) {
    if (typeof actual !== 'string') return mismatch(path, 'regex matcher requires a string');
    const pattern = token.slice('~regex:'.length);
    return new RegExp(pattern).test(actual)
      ? { matched: true }
      : mismatch(path, `string did not match /${pattern}/`);
  }
  if (token.startsWith('~capture:')) {
    if (!allowCapture) return mismatch(path, 'captures are not allowed in this matcher');
    if (actual === undefined) return mismatch(path, 'capture does not match an absent value');
    const name = token.slice('~capture:'.length);
    if (captures.has(name)) return mismatch(path, `capture ${name} is already bound`);
    captures.set(name, structuredClone(actual));
    return { matched: true };
  }
  if (token.startsWith('~ref:')) {
    const name = token.slice('~ref:'.length);
    if (!captures.has(name)) return mismatch(path, `capture ${name} is not bound`);
    return isDeepStrictEqual(captures.get(name), actual)
      ? { matched: true }
      : mismatch(path, `value differs from capture ${name}`);
  }
  if (token === '~absent') return mismatch(path, '~absent is valid only as an object property');
  return mismatch(path, `unknown matcher ${token}`);
}

export function resolveReferences(value: unknown, captures: ReadonlyMap<string, unknown>): unknown {
  if (typeof value === 'string' && value.startsWith('~ref:')) {
    const name = value.slice('~ref:'.length);
    if (!captures.has(name)) throw new Error(`Capture ${name} is not bound`);
    return structuredClone(captures.get(name));
  }
  if (Array.isArray(value)) return value.map((item) => resolveReferences(item, captures));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveReferences(entry, captures)]),
    );
  }
  return value;
}

function mismatch(path: string, reason: string): MatchResult {
  return { matched: false, reason: `${path}: ${reason}` };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
