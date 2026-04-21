import type { WebSocket } from 'ws';
import type {
  ActionManifestEntry,
  AppMetadata,
  TesseronCapabilities,
  JsonRpcDispatcher,
  ResourceManifestEntry,
} from '@tesseron/core';

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
