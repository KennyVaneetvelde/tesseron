/**
 * WebSocket subprotocol-based bind transport for the host-minted claim flow.
 *
 * **Why a subprotocol, not a query string.** The first draft of tesseron#60
 * carried the claim code in `?claim=CODE` on the gateway's WS upgrade.
 * Reviewers flagged this as a leak: query strings appear in reverse-proxy
 * logs, browser history, crash dumps, command captures. The HTTP
 * `Sec-WebSocket-Protocol` header is just a header, never carried in the
 * URL, and is the standard place to negotiate WebSocket sub-features per
 * RFC 6455. This module is the single source of truth for the wire format;
 * the Vite plugin and `@tesseron/server` validate inbound headers via
 * {@link parseBindSubprotocol}, the `@tesseron/mcp` gateway emits them via
 * {@link formatBindSubprotocol} on its outbound dial.
 *
 * **Element shape.** The bind subprotocol element is the literal string
 * `tesseron-bind.<code>` where `<code>` is the host-minted claim code in
 * the existing `XXXX-XX` format. The full subprotocol header sent by a
 * v1.2 gateway is `tesseron-gateway, tesseron-bind.AB3X-7K` —
 * `tesseron-gateway` keeps v1.1 hosts' upgrade-acceptance logic working;
 * the second element is what carries the bind authorisation. v1.2 hosts
 * that don't see the second element fall back to the legacy
 * gateway-mints-the-code path so the old-gateway / new-host migration
 * matrix cell ships zero regression.
 */

const PREFIX = 'tesseron-bind.';

/**
 * Format the bind subprotocol element a v1.2 gateway sends as the second
 * value of `Sec-WebSocket-Protocol` on the outbound dial.
 *
 * @throws RangeError if `code` is empty or contains characters outside the
 * RFC 6455 token grammar — accidental whitespace, commas, or angle
 * brackets in the code would corrupt the on-wire header.
 */
export function formatBindSubprotocol(code: string): string {
  if (!isWellFormedBindCode(code)) {
    throw new RangeError(
      `bind code ${JSON.stringify(code)} contains characters disallowed in WebSocket subprotocol tokens`,
    );
  }
  return `${PREFIX}${code}`;
}

/**
 * Extract the bind code from a `Sec-WebSocket-Protocol` header value sent
 * on an inbound WS upgrade. Returns `{ code: null }` if no element matches
 * `tesseron-bind.<code>` — the caller should treat that as "legacy gateway
 * dial; proceed with the old gateway-mints path."
 *
 * **Multiple bind elements are an error.** Two distinct codes in the same
 * header is the kind of thing a header-injecting middlebox does. Returns
 * `{ code: null, reason }`; the caller MUST reject the upgrade.
 */
export function parseBindSubprotocol(
  headerValue: string | undefined,
): { code: string } | { code: null; reason?: string } {
  if (!headerValue) return { code: null };
  const elements = headerValue
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const candidates = elements.filter((e) => e.startsWith(PREFIX));
  if (candidates.length === 0) return { code: null };
  if (candidates.length > 1) {
    return {
      code: null,
      reason: `multiple ${PREFIX}* elements in header; refusing ambiguous bind`,
    };
  }
  const raw = candidates[0]!.slice(PREFIX.length);
  if (!isWellFormedBindCode(raw)) {
    return {
      code: null,
      reason: 'bind code does not match the host-minted claim grammar',
    };
  }
  // Canonicalize to upper-case. Host mints are always upper-case
  // (see `mintClaimCode` — alphabet is `ABCDEFGHJKMNPQRSTUVWXYZ23456789`),
  // and the host's bind validation is a constant-time byte compare. Without
  // this canonicalization, a relaxed grammar that accepts both cases would
  // never actually let a lower-case bind succeed — it would just look
  // like a malformed-mismatch failure to the operator.
  return { code: raw.toUpperCase() };
}

function isWellFormedBindCode(code: string): boolean {
  if (code.length === 0 || code.length > 64) return false;
  for (let i = 0; i < code.length; i++) {
    const ch = code.charCodeAt(i);
    const isUpper = ch >= 0x41 && ch <= 0x5a;
    const isLower = ch >= 0x61 && ch <= 0x7a;
    const isDigit = ch >= 0x30 && ch <= 0x39;
    const isDash = ch === 0x2d;
    const isUnderscore = ch === 0x5f;
    if (!(isUpper || isLower || isDigit || isDash || isUnderscore)) return false;
  }
  return true;
}

/** Subprotocol element prefix. Exposed for tests and for callers that */
/* assemble multi-element headers manually. */
export const BIND_SUBPROTOCOL_PREFIX = PREFIX;
