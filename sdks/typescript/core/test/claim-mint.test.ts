/**
 * Coverage for the CSPRNG mint helpers in `@tesseron/core/node`, shared by
 * `@tesseron/server`, `@tesseron/vite`, and `@tesseron/mcp` (which re-exports
 * them under its historical `generate*` names). Asserts wire format, the
 * confusable-character exclusion on claim codes, and basic uniqueness.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  mintClaimCode,
  mintInvocationId,
  mintResumeToken,
  mintSessionId,
} from '../src/node/claim-mint.js';

describe('CSPRNG-only invariant', () => {
  it('the mint source uses no Math.random (only crypto.getRandomValues)', () => {
    // These values gate the claim flow and seed resume tokens; a regression to
    // Math.random would make them predictable. This guard lives with the code
    // (it moved here from @tesseron/mcp's session-tokens test when the mint
    // helpers were consolidated into @tesseron/core/node).
    const src = readFileSync(
      fileURLToPath(new URL('../src/node/claim-mint.ts', import.meta.url)),
      'utf8',
    );
    // Strip comments first — the prose explains *why* Math.random is avoided,
    // so the guard must look at code only.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Math\.random/);
    expect(code).toMatch(/crypto\.getRandomValues/);
  });
});

describe('mintClaimCode', () => {
  it('produces the XXXX-XX format', () => {
    expect(mintClaimCode()).toMatch(
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{2}$/,
    );
  });

  it('excludes visually-confusable characters (0/1/I/L/O)', () => {
    for (let i = 0; i < 200; i++) {
      for (const ch of mintClaimCode().replace('-', '')) {
        expect('01ILO').not.toContain(ch);
      }
    }
  });

  it('is overwhelmingly unique across many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mintClaimCode());
    // A handful of collisions across 1000 draws of a ~10^9 space is essentially
    // impossible; require near-perfect uniqueness without demanding exactness.
    expect(seen.size).toBeGreaterThan(995);
  });
});

describe('mintSessionId / mintInvocationId', () => {
  it('use the s_ / inv_ prefixes with a base36 body', () => {
    expect(mintSessionId()).toMatch(/^s_[0-9a-z]{8}[0-9a-z]+$/);
    expect(mintInvocationId()).toMatch(/^inv_[0-9a-z]{8}[0-9a-z]+$/);
  });
});

describe('mintResumeToken', () => {
  it('is a 32-char url-safe base64 string (24 bytes)', () => {
    expect(mintResumeToken()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('does not repeat across consecutive draws', () => {
    expect(mintResumeToken()).not.toBe(mintResumeToken());
  });
});
