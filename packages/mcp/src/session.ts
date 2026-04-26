import { Buffer } from 'node:buffer';
import type {
  ActionManifestEntry,
  AppMetadata,
  ResourceManifestEntry,
  TesseronCapabilities,
  Transport,
} from '@tesseron/core';
import type { JsonRpcDispatcher } from '@tesseron/core/internal';

export interface Session {
  id: string;
  app: AppMetadata;
  /**
   * Binding-neutral channel to the SDK side. The gateway closes via this on
   * shutdown; outbound messages go through `dispatcher`. Was `ws: WebSocket`
   * in v1.0; renamed to drop the WS-only bias.
   */
  transport: Transport;
  dispatcher: JsonRpcDispatcher;
  actions: ActionManifestEntry[];
  resources: ResourceManifestEntry[];
  capabilities: TesseronCapabilities;
  claimCode: string;
  claimed: boolean;
  claimedAt?: number;
  /**
   * Opaque server-issued token returned in the session's {@link WelcomeResult}.
   * The SDK stashes this alongside {@link Session.id} to rejoin via
   * `tesseron/resume` after a transport drop. Rotated on every successful
   * resume (one-shot); the gateway replaces it with a fresh token before the
   * resume response goes back to the SDK.
   */
  resumeToken: string;
  subscriptionCallbacks?: Map<string, (value: unknown) => void>;
  /**
   * Resolves once the cross-gateway claim breadcrumb at
   * `~/.tesseron/claims/<CODE>.json` has finished writing. The hello handler
   * fires the write and stashes its promise here; the claim/close paths
   * await it before unlinking, so a fast-claim that beats the disk write
   * doesn't leak a stale breadcrumb past the session's life. See tesseron#53.
   */
  claimRecordWritten?: Promise<void>;
}

const CLAIM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const BASE36_CHARS = '0123456789abcdefghijklmnopqrstuvwxyz';

/**
 * Draw `len` characters uniformly from `alphabet` using the platform CSPRNG
 * (`crypto.getRandomValues`) with rejection sampling. Bytes that fall in the
 * modulo-bias spillover region are discarded so the resulting distribution
 * is exactly uniform across the alphabet — for the 31-char claim alphabet
 * the rejection rate is ~3% and for the 36-char base36 alphabet it's ~1.5%.
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
 * `Math.random()`. The claim code is the user-typed gate between an
 * unclaimed session and the MCP agent: a malicious local process can call
 * `tesseron__claim_session` repeatedly with guessed codes, and against a
 * predictable PRNG the ~1.5-billion-combination space is no defence at all.
 * CSPRNG output is the bare minimum for this gate to mean anything.
 */
export function generateClaimCode(): string {
  const code = randomFromAlphabet(CLAIM_CHARS, 6);
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * Opaque session ID. 8 random base36 chars + a base36 timestamp suffix for
 * log legibility ("which session did *that* one come from?"). Random prefix
 * is CSPRNG-sourced so a session ID can't be guessed from another one
 * observed in logs — session IDs are surfaced in `tesseron/welcome` and
 * predictable values would let a sibling process narrow the search space
 * for a future `tesseron/resume` token brute-force if the token ever leaked.
 */
export function generateSessionId(): string {
  return `s_${randomFromAlphabet(BASE36_CHARS, 8)}${Date.now().toString(36)}`;
}

export function generateInvocationId(): string {
  return `inv_${randomFromAlphabet(BASE36_CHARS, 8)}${Date.now().toString(36)}`;
}

/**
 * Cryptographically random session-resume token. 24 bytes (~192 bits) encoded
 * as URL-safe base64 → 32 characters, enough entropy that guessing attacks are
 * infeasible within the zombie TTL even under aggressive concurrency.
 */
export function generateResumeToken(): string {
  const buf = new Uint8Array(24);
  globalThis.crypto.getRandomValues(buf);
  return Buffer.from(buf).toString('base64url');
}

const RESERVED_APP_IDS = new Set(['tesseron', 'mcp', 'system']);
const APP_ID_RE = /^[a-z][a-z0-9_]*$/;

export function validateAppId(id: string): void {
  if (!APP_ID_RE.test(id)) {
    throw new Error(`Invalid app id "${id}". Must match /^[a-z][a-z0-9_]*$/.`);
  }
  if (RESERVED_APP_IDS.has(id)) {
    throw new Error(`App id "${id}" is reserved. Choose a different identifier.`);
  }
}
