/**
 * Host-side mint helpers for claim codes, session IDs, invocation IDs, and
 * resume tokens (the tesseron#60 claim-mediated flow).
 *
 * Single source of truth shared by `@tesseron/server`, `@tesseron/vite`, and
 * `@tesseron/mcp` via the `@tesseron/core/node` subpath. (These primitives
 * previously lived as a duplicated `claim-mint.ts` in server/vite plus an
 * inline copy in `@tesseron/mcp`'s `session.ts`; mcp re-exports these under its
 * historical `generate*` names.)
 *
 * Node-only — imports `node:buffer`. Never import from the browser-safe main
 * `@tesseron/core` entry; this lives behind the explicit `/node` subpath.
 */

import { Buffer } from 'node:buffer';

const CLAIM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BASE36_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Draw `len` characters uniformly from `alphabet` using the platform CSPRNG
 * (`crypto.getRandomValues`) with rejection sampling. Bytes that fall in the
 * modulo-bias spillover region are discarded so the resulting distribution is
 * exactly uniform across the alphabet — for the 31-char claim alphabet the
 * rejection rate is ~3% and for the 36-char base36 alphabet it's ~1.5%.
 *
 * Cheap to call: re-fills the byte buffer in a tight loop and emits as many
 * characters as the over-read produces before redrawing.
 */
function randomFromAlphabet(alphabet: string, len: number): string {
  const aLen = alphabet.length;
  if (aLen === 0 || aLen > 256) {
    throw new RangeError('alphabet length must be 1..256');
  }
  const maxAcceptable = Math.floor(256 / aLen) * aLen;
  let out = '';
  while (out.length < len) {
    const buf = new Uint8Array((len - out.length) * 2 + 4);
    globalThis.crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= maxAcceptable) continue;
      out += alphabet.charAt(b % aLen);
      if (out.length === len) break;
    }
  }
  return out;
}

/**
 * Random claim code in the format `XXXX-XX`. 31-char alphabet of upper-case
 * letters + digits with visually-confusable characters (`0`, `1`, `I`, `L`,
 * `O`) excluded.
 *
 * Drawn from the platform CSPRNG (`crypto.getRandomValues`) rather than
 * `Math.random()`. The claim code is the user-typed gate between an unclaimed
 * session and the MCP agent: a malicious local process can call
 * `tesseron__claim_session` repeatedly with guessed codes, and against a
 * predictable PRNG the ~1.5-billion-combination space is no defence at all.
 * CSPRNG output is the bare minimum for this gate to mean anything.
 */
export function mintClaimCode(): string {
  const code = randomFromAlphabet(CLAIM_CHARS, 6);
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Opaque session ID. 8 random base36 chars + a base36 timestamp suffix for log
 * legibility ("which session did *that* one come from?"). Random prefix is
 * CSPRNG-sourced so a session ID can't be guessed from another one observed in
 * logs — session IDs are surfaced in `tesseron/welcome` and predictable values
 * would let a sibling process narrow the search space for a future
 * `tesseron/resume` token brute-force if the token ever leaked.
 */
export function mintSessionId(): string {
  return `s_${randomFromAlphabet(BASE36_CHARS, 8)}${Date.now().toString(36)}`;
}

/** Opaque invocation ID, `inv_`-prefixed. Same construction as {@link mintSessionId}. */
export function mintInvocationId(): string {
  return `inv_${randomFromAlphabet(BASE36_CHARS, 8)}${Date.now().toString(36)}`;
}

/**
 * Cryptographically random session-resume token. 24 bytes (~192 bits) encoded
 * as URL-safe base64 → 32 characters, enough entropy that guessing attacks are
 * infeasible within the zombie TTL even under aggressive concurrency.
 */
export function mintResumeToken(): string {
  const buf = new Uint8Array(24);
  globalThis.crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64url');
}
