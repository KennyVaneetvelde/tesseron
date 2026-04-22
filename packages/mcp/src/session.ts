import { randomBytes } from 'node:crypto';
import type {
  ActionManifestEntry,
  AppMetadata,
  ResourceManifestEntry,
  TesseronCapabilities,
} from '@tesseron/core';
import type { JsonRpcDispatcher } from '@tesseron/core/internal';
import type { WebSocket } from 'ws';

export interface Session {
  id: string;
  app: AppMetadata;
  ws: WebSocket;
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
}

const CLAIM_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateClaimCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CLAIM_CHARS[Math.floor(Math.random() * CLAIM_CHARS.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function generateSessionId(): string {
  return `s_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

export function generateInvocationId(): string {
  return `inv_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Cryptographically random session-resume token. 24 bytes (~192 bits) encoded
 * as URL-safe base64 → 32 characters, enough entropy that guessing attacks are
 * infeasible within the zombie TTL even under aggressive concurrency.
 */
export function generateResumeToken(): string {
  return randomBytes(24).toString('base64url');
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
