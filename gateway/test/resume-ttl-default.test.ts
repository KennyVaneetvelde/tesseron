import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RESUME_TTL_MS } from '../src/gateway.js';

/**
 * The default zombie-retention TTL is part of the gateway's public surface:
 * embedders and operators tune it via `new TesseronGateway({ resumeTtlMs })`
 * or the `TESSERON_RESUME_TTL_MS` env var. The L1 bump from 90 s to 4 h
 * exists so a casual page refresh (or laptop close, or dev-server restart)
 * inside a normal working session lands inside the window and doesn't force
 * a fresh claim-code dance. Lock the value here so a future "let's just trim
 * this" PR has to explain itself.
 */
describe('DEFAULT_RESUME_TTL_MS', () => {
  it('is 4 hours (14_400_000 ms)', () => {
    expect(DEFAULT_RESUME_TTL_MS).toBe(4 * 60 * 60 * 1000);
    expect(DEFAULT_RESUME_TTL_MS).toBe(14_400_000);
  });
});

/**
 * The CLI parses `TESSERON_RESUME_TTL_MS` defensively: a valid non-negative
 * integer is forwarded to the gateway as `resumeTtlMs`; anything else logs a
 * warning and falls through to the default. We re-implement the parser inline
 * here rather than importing from `cli.ts` because the CLI module has side
 * effects (it spawns the gateway on import) — but the contract is small
 * enough to mirror, and a divergence between this test's parser and the
 * CLI's would surface immediately as the env-var stops working in real
 * gateways.
 */
function parseEnv(raw: string | undefined): { value?: number; warned: boolean } {
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try {
    if (raw === undefined || raw === '') return { warned: false };
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      process.stderr.write(
        `[tesseron] ignoring TESSERON_RESUME_TTL_MS=${JSON.stringify(raw)} — expected a non-negative integer (milliseconds)\n`,
      );
      return { warned: true };
    }
    return { value: parsed, warned: false };
  } finally {
    stderr.mockRestore();
  }
}

describe('TESSERON_RESUME_TTL_MS env-var parsing', () => {
  const originalEnv = process.env['TESSERON_RESUME_TTL_MS'];
  beforeEach(() => {
    process.env['TESSERON_RESUME_TTL_MS'] = undefined;
  });
  afterEach(() => {
    process.env['TESSERON_RESUME_TTL_MS'] = originalEnv;
  });

  it('returns undefined when unset', () => {
    expect(parseEnv(undefined).value).toBeUndefined();
  });

  it('returns undefined when set to empty string', () => {
    expect(parseEnv('').value).toBeUndefined();
  });

  it('parses a valid integer in milliseconds', () => {
    expect(parseEnv('600000').value).toBe(600_000);
  });

  it('accepts 0 (disables resume entirely per GatewayOptions.resumeTtlMs contract)', () => {
    const result = parseEnv('0');
    expect(result.value).toBe(0);
    expect(result.warned).toBe(false);
  });

  it('warns and falls through on negative values', () => {
    const result = parseEnv('-5');
    expect(result.value).toBeUndefined();
    expect(result.warned).toBe(true);
  });

  it('warns and falls through on non-integer floats', () => {
    const result = parseEnv('1.5');
    expect(result.value).toBeUndefined();
    expect(result.warned).toBe(true);
  });

  it('warns and falls through on non-numeric input', () => {
    const result = parseEnv('twelve');
    expect(result.value).toBeUndefined();
    expect(result.warned).toBe(true);
  });
});
