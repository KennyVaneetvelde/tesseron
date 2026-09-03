/**
 * Node-only utilities shared across the host/server-side Tesseron packages
 * (`@tesseron/server`, `@tesseron/vite`, `@tesseron/mcp`): atomic owner-only
 * filesystem writes and CSPRNG mint helpers for claim codes / session IDs /
 * resume tokens.
 *
 * Exposed behind the explicit `@tesseron/core/node` subpath because it imports
 * `node:fs` / `node:buffer`. The main `@tesseron/core` entry stays
 * browser-safe and must never re-export from here.
 */

export {
  mintClaimCode,
  mintInvocationId,
  mintResumeToken,
  mintSessionId,
} from './node/claim-mint.js';
export { ensurePrivateDir, writePrivateFile } from './node/fs-hygiene.js';
export {
  BIND_FAILURE_LOCKOUT_MS,
  BIND_FAILURE_THRESHOLD,
  BIND_FAILURE_WINDOW_MS,
  BindRateLimiter,
  buildSynthesizedWelcomeResponse,
  isHelloFrame,
} from './node/host-bind.js';
