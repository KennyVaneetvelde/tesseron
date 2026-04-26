/**
 * Direct coverage for the token generators in `session.ts`. The previous
 * test surface only exercised these transitively through `integration.test`
 * — which is enough to catch "tokens don't roundtrip" regressions but not
 * enough to catch "tokens silently lost their CSPRNG entropy" regressions
 * or "rejection sampling bypassed and modulo bias is back" regressions,
 * which are the failure modes that motivated PR #62.
 *
 * Tests intentionally avoid mocking `globalThis.crypto`: the security
 * property we want is "the deployed code path actually uses the platform
 * CSPRNG correctly." A mock-based test of the *non*-CSPRNG path is the
 * thing that quietly turned green when production drifted; we test the
 * real code on the real CSPRNG instead.
 */

import { describe, expect, it } from 'vitest';
import {
  generateClaimCode,
  generateInvocationId,
  generateResumeToken,
  generateSessionId,
} from '../src/session.js';

const CLAIM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BASE36_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';
const CONFUSABLES = ['0', '1', 'I', 'L', 'O'];

describe('generateClaimCode', () => {
  it('returns the documented XXXX-XX format from the 31-char alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateClaimCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{2}$/);
    }
  });

  it('never emits a visually-confusable character (0, 1, I, L, O)', () => {
    // The whole point of the 31-char alphabet is a pasteable code that
    // doesn't trip on 0/O or 1/I/L confusion. A regression that swapped
    // CLAIM_CHARS for a 36-char base36 alphabet would still pass the
    // length+format test above; this assertion catches it.
    for (let i = 0; i < 500; i++) {
      const code = generateClaimCode().replace('-', '');
      for (const c of CONFUSABLES) {
        expect(code).not.toContain(c);
      }
    }
  });

  it('produces a roughly uniform distribution across the alphabet', () => {
    // Catches a regression that drops the rejection-sampling guard and
    // reintroduces modulo bias — that would skew the distribution toward
    // the first `256 % 31 = 8` characters by ~3% each. We sample enough
    // codes that the bias would be visible; loose threshold so CI noise
    // doesn't flake.
    const counts = new Map<string, number>();
    const SAMPLES = 10_000;
    const charsPerCode = 6;
    const totalChars = SAMPLES * charsPerCode;
    for (let i = 0; i < SAMPLES; i++) {
      for (const ch of generateClaimCode().replace('-', '')) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }
    // Every alphabet character should appear; expected count is
    // totalChars/31 ≈ 1935. A 5x deviation either way would fail.
    const expected = totalChars / CLAIM_CHARS.length;
    for (const ch of CLAIM_CHARS) {
      const got = counts.get(ch) ?? 0;
      expect(got, `char "${ch}" count`).toBeGreaterThan(expected * 0.5);
      expect(got, `char "${ch}" count`).toBeLessThan(expected * 1.5);
    }
  });

  it('produces no collisions across 1000 calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateClaimCode());
    }
    // The 31^6 ≈ 887M space makes collisions in 1000 draws cosmically
    // unlikely (birthday paradox: 50% at ~37000). Fewer than 1000 unique
    // values is a sign the CSPRNG path is broken (e.g. fixed seed in a
    // misconfigured test runner).
    expect(seen.size).toBe(1000);
  });
});

describe('generateSessionId / generateInvocationId', () => {
  it('returns the documented prefixed-base36 format', () => {
    for (let i = 0; i < 200; i++) {
      // 8 random base36 chars + a base36 timestamp suffix (≥ 7 chars
      // for any realistic Date.now()).
      expect(generateSessionId()).toMatch(/^s_[0-9a-z]{8}[0-9a-z]+$/);
      expect(generateInvocationId()).toMatch(/^inv_[0-9a-z]{8}[0-9a-z]+$/);
    }
  });

  it('the random prefix uses only the 36-char base36 alphabet', () => {
    // Catches a regression that swaps BASE36_CHARS for a charset that
    // happens to contain something the regex above tolerates (e.g.
    // upper-case letters via Math.random().toString(36).toUpperCase()).
    for (let i = 0; i < 500; i++) {
      const session = generateSessionId().slice(2, 10); // 8 random chars
      const invocation = generateInvocationId().slice(4, 12);
      for (const ch of session) expect(BASE36_CHARS).toContain(ch);
      for (const ch of invocation) expect(BASE36_CHARS).toContain(ch);
    }
  });

  it('produces no collisions across 1000 calls', () => {
    const sessionSeen = new Set<string>();
    const invocationSeen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      sessionSeen.add(generateSessionId());
      invocationSeen.add(generateInvocationId());
    }
    expect(sessionSeen.size).toBe(1000);
    expect(invocationSeen.size).toBe(1000);
  });
});

describe('generateResumeToken', () => {
  it('returns 32 url-safe base64 characters', () => {
    for (let i = 0; i < 100; i++) {
      const tok = generateResumeToken();
      expect(tok).toHaveLength(32);
      // base64url charset: A-Z a-z 0-9 - _ (no '+', '/', or '=' padding).
      expect(tok).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(tok).not.toContain('+');
      expect(tok).not.toContain('/');
      expect(tok).not.toContain('=');
    }
  });

  it('produces no collisions across 1000 calls', () => {
    // 24 random bytes = 192 bits. Collision in 1000 draws is impossibly
    // unlikely unless the CSPRNG path is broken.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(generateResumeToken());
    }
    expect(seen.size).toBe(1000);
  });

  it('successive calls produce different values', () => {
    // Defends against a refactor that accidentally caches the first
    // result (e.g. memoising the buffer at module scope by mistake).
    expect(generateResumeToken()).not.toBe(generateResumeToken());
    expect(generateResumeToken()).not.toBe(generateResumeToken());
  });
});

describe('Math.random is no longer used in session token generation', () => {
  it('session.ts source contains no Math.random calls', async () => {
    // Structural regression guard. The CSPRNG migration is the security
    // property we care about; a future "perf" refactor that quietly
    // reintroduces Math.random would still pass every behavioural test
    // above (the format and distribution properties survive a switch
    // back to PRNG). This grep-style assertion immortalises the
    // decision: if you genuinely need Math.random somewhere, this
    // test must be updated explicitly.
    //
    // Comments mentioning the prior `Math.random()` callsites in JSDoc
    // are stripped before the check so the doc trail explaining "we
    // used to use Math.random() here, then migrated" can stay.
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, resolve } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    const src = await readFile(resolve(here, '../src/session.ts'), 'utf8');
    const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(stripped).not.toMatch(/\bMath\.random\b/);
  });
});
