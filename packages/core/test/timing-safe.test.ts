/**
 * Coverage for the constant-time string equality helper. This is small but
 * deserves explicit tests because the security guarantee (no early exit on
 * a prefix mismatch) is exactly the kind of property a future "performance"
 * refactor could quietly violate.
 *
 * The tests cover correctness across length / type / content edge cases and
 * a coarse statistical timing-equivalence check between same-prefix and
 * different-prefix mismatches. Real timing-side-channel testing would need
 * a microbenchmark harness; this test fails loudly if someone reintroduces
 * an early-return pattern that's orders of magnitude faster on prefix
 * mismatch, which is the regression we actually care about.
 */

import { describe, expect, it } from 'vitest';
import { constantTimeEqual } from '../src/timing-safe.js';

describe('constantTimeEqual', () => {
  it('returns true for identical strings', () => {
    expect(constantTimeEqual('', '')).toBe(true);
    expect(constantTimeEqual('a', 'a')).toBe(true);
    expect(constantTimeEqual('AB3X-7K', 'AB3X-7K')).toBe(true);
    expect(
      constantTimeEqual('gXyR8s9wQAt7zV3KqM5L1mN6pT2bU4dF', 'gXyR8s9wQAt7zV3KqM5L1mN6pT2bU4dF'),
    ).toBe(true);
  });

  it('returns false for different-length strings', () => {
    expect(constantTimeEqual('a', '')).toBe(false);
    expect(constantTimeEqual('', 'a')).toBe(false);
    expect(constantTimeEqual('AB3X-7K', 'AB3X-7K ')).toBe(false);
  });

  it('returns false for same-length but mismatched strings', () => {
    expect(constantTimeEqual('a', 'b')).toBe(false);
    expect(constantTimeEqual('AB3X-7K', 'AB3X-7L')).toBe(false); // last char
    expect(constantTimeEqual('AB3X-7K', 'CB3X-7K')).toBe(false); // first char
    expect(constantTimeEqual('AB3X-7K', 'AB3X-XK')).toBe(false); // middle char
  });

  it('throws TypeError when an argument is not a string', () => {
    // Calls intentionally pass non-string values to verify the runtime
    // guard. TypeScript would flag these in normal code; at runtime we
    // throw rather than silently returning false because a type-violating
    // call is a programmer bug whose symptoms (token mismatch errors)
    // would otherwise burn hours of debugging the wrong hypothesis.
    expect(() => constantTimeEqual('abc', 123 as unknown as string)).toThrow(TypeError);
    expect(() => constantTimeEqual(undefined as unknown as string, 'abc')).toThrow(TypeError);
    expect(() => constantTimeEqual(null as unknown as string, null as unknown as string)).toThrow(
      TypeError,
    );
    expect(() => constantTimeEqual('abc', { length: 3 } as unknown as string)).toThrow(TypeError);
  });

  it('handles non-ASCII characters via charCodeAt', () => {
    expect(constantTimeEqual('café', 'café')).toBe(true);
    expect(constantTimeEqual('café', 'cafe')).toBe(false);
    // Surrogate pairs: charCodeAt sees half-units, but the comparison is
    // still consistent — same string compares equal, different strings
    // compare unequal.
    expect(constantTimeEqual('🎉a', '🎉a')).toBe(true);
    expect(constantTimeEqual('🎉a', '🎉b')).toBe(false);
  });

  it('does not short-circuit on a prefix mismatch (coarse timing check)', () => {
    // Build two same-length strings: one differs at position 0, one differs
    // at the very end. A short-circuiting comparison would be ~Nx faster
    // for the prefix mismatch. We're not benchmarking precisely — we just
    // want both calls to complete without one being orders of magnitude
    // faster.
    const len = 1024;
    const a = 'a'.repeat(len);
    const earlyDiff = `b${'a'.repeat(len - 1)}`;
    const lateDiff = `${'a'.repeat(len - 1)}b`;

    const iters = 200;
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      constantTimeEqual(a, earlyDiff);
    }
    const earlyMs = Number(process.hrtime.bigint() - t0) / 1e6;

    const t1 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) {
      constantTimeEqual(a, lateDiff);
    }
    const lateMs = Number(process.hrtime.bigint() - t1) / 1e6;

    // Fail only if early-diff is implausibly faster than late-diff. A
    // generous 4x ceiling tolerates JIT warm-up and runtime jitter while
    // still catching a `for (..) if (!=) return false` regression.
    const ratio = lateMs === 0 ? Number.POSITIVE_INFINITY : earlyMs / lateMs;
    expect(ratio).toBeGreaterThan(0.25);
    expect(ratio).toBeLessThan(4);
  });
});
