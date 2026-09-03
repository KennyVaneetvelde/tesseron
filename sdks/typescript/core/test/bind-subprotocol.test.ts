import { describe, expect, it } from 'vitest';
import {
  BIND_SUBPROTOCOL_PREFIX,
  formatBindSubprotocol,
  parseBindSubprotocol,
} from '../src/bind-subprotocol.js';

describe('formatBindSubprotocol', () => {
  it('produces the documented `tesseron-bind.<code>` shape', () => {
    expect(formatBindSubprotocol('AB3X-7K')).toBe('tesseron-bind.AB3X-7K');
  });

  it('rejects codes with characters outside the bind grammar', () => {
    expect(() => formatBindSubprotocol('')).toThrow(RangeError);
    expect(() => formatBindSubprotocol('AB3X 7K')).toThrow(RangeError);
    expect(() => formatBindSubprotocol('AB3X,7K')).toThrow(RangeError);
    expect(() => formatBindSubprotocol('AB3X;7K')).toThrow(RangeError);
    expect(() => formatBindSubprotocol('AB3X<7K')).toThrow(RangeError);
    expect(() => formatBindSubprotocol('AB3X@7K')).toThrow(RangeError);
    expect(() => formatBindSubprotocol('"AB3X-7K"')).toThrow(RangeError);
  });

  it('exposes the prefix for callers that assemble headers manually', () => {
    expect(BIND_SUBPROTOCOL_PREFIX).toBe('tesseron-bind.');
  });
});

describe('parseBindSubprotocol', () => {
  it('returns null for empty / undefined header (legacy dial path)', () => {
    expect(parseBindSubprotocol(undefined)).toEqual({ code: null });
    expect(parseBindSubprotocol('')).toEqual({ code: null });
    expect(parseBindSubprotocol('   ')).toEqual({ code: null });
  });

  it('returns null when only the legacy gateway subprotocol is present', () => {
    // Old gateway dialing a new host: caller treats this as
    // "legacy path; gateway will mint the claim itself."
    expect(parseBindSubprotocol('tesseron-gateway')).toEqual({ code: null });
  });

  it('extracts the code from a header with both elements', () => {
    expect(parseBindSubprotocol('tesseron-gateway, tesseron-bind.AB3X-7K')).toEqual({
      code: 'AB3X-7K',
    });
    expect(parseBindSubprotocol('tesseron-bind.AB3X-7K, tesseron-gateway')).toEqual({
      code: 'AB3X-7K',
    });
  });

  it('tolerates extra subprotocol elements without confusion', () => {
    expect(
      parseBindSubprotocol('tesseron-gateway, tesseron-bind.AB3X-7K, permessage-deflate'),
    ).toEqual({ code: 'AB3X-7K' });
  });

  it('refuses ambiguous duplicate bind elements', () => {
    const result = parseBindSubprotocol('tesseron-bind.AB3X-7K, tesseron-bind.CD9Y-2M');
    expect(result.code).toBeNull();
    expect((result as { reason?: string }).reason).toContain('multiple');
  });

  it('rejects bind codes that violate the grammar', () => {
    expect(parseBindSubprotocol('tesseron-bind.AB 3X-7K').code).toBeNull();
    expect(parseBindSubprotocol('tesseron-bind.AB3X<7K').code).toBeNull();
    expect(parseBindSubprotocol(`tesseron-bind.${'X'.repeat(100)}`).code).toBeNull();
    expect(parseBindSubprotocol('tesseron-bind.').code).toBeNull();
  });

  it('handles whitespace variants around the comma separator', () => {
    expect(parseBindSubprotocol('tesseron-gateway,tesseron-bind.AB3X-7K')).toEqual({
      code: 'AB3X-7K',
    });
    expect(parseBindSubprotocol('tesseron-gateway,  tesseron-bind.AB3X-7K')).toEqual({
      code: 'AB3X-7K',
    });
    expect(parseBindSubprotocol('tesseron-gateway,\ttesseron-bind.AB3X-7K')).toEqual({
      code: 'AB3X-7K',
    });
  });

  it('does not match a prefix that happens to start the same way', () => {
    expect(parseBindSubprotocol('tesseron-bindings.foo').code).toBeNull();
    expect(parseBindSubprotocol('not-tesseron-bind.foo').code).toBeNull();
  });

  it('parser inverts the formatter for upper-case codes (host mints upper-case)', () => {
    const codes = ['AB3X-7K', 'CD9Y-2M', 'XXXX-YY', '0123-45'];
    for (const code of codes) {
      const header = `tesseron-gateway, ${formatBindSubprotocol(code)}`;
      expect(parseBindSubprotocol(header)).toEqual({ code });
    }
  });

  it('canonicalizes mixed-case codes to upper-case to match host-mint format', () => {
    // Host mints from `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (upper-case
    // only) and validates with constant-time bytewise compare. If a
    // user pastes their code lower-case, the gateway forwards
    // lower-case, and the parser must canonicalize so the compare
    // succeeds.
    expect(parseBindSubprotocol('tesseron-gateway, tesseron-bind.a1b2-c3')).toEqual({
      code: 'A1B2-C3',
    });
    expect(parseBindSubprotocol('tesseron-gateway, tesseron-bind.aB3x-7K')).toEqual({
      code: 'AB3X-7K',
    });
  });
});
