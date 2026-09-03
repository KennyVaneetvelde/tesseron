/**
 * Shared host-side bind helpers for the claim-mediated (tesseron#60) flow.
 *
 * Used by the `@tesseron/server` WS + UDS host transports and the
 * `@tesseron/vite` dev-server bridge — all of which gate gateway bind upgrades
 * with the same rolling-window rate limit, answer the SDK's `tesseron/hello`
 * with the same synthesized pre-claim welcome, and detect hello frames the same
 * way. Previously each carried its own copy (server's two transports were
 * byte-identical; vite re-implemented the same rolling window on its Session
 * objects; the lockout constants were tripled).
 *
 * Node-only — {@link BindRateLimiter} logs via `process.stderr`. Lives behind
 * the `@tesseron/core/node` subpath; never imported by the browser-safe main
 * entry.
 */

import { type JsonRpcId, PROTOCOL_VERSION, type WelcomeResult } from '../protocol.js';
import type { HostMintedClaim } from '../transport-spec.js';

/**
 * Mismatched bind upgrades allowed in {@link BIND_FAILURE_WINDOW_MS} before a
 * lockout. High enough to tolerate a flapping legitimate retry loop while
 * shutting down a sustained brute-force cleanly.
 */
export const BIND_FAILURE_THRESHOLD = 5;
/** Rolling window for {@link BIND_FAILURE_THRESHOLD} (ms). */
export const BIND_FAILURE_WINDOW_MS = 60_000;
/** Lock-out duration once the threshold is crossed (ms). */
export const BIND_FAILURE_LOCKOUT_MS = 60_000;

/**
 * Rolling-window rate limiter for bind-code mismatches. Once more than
 * {@link BIND_FAILURE_THRESHOLD} mismatches land within
 * {@link BIND_FAILURE_WINDOW_MS}, the limiter locks out for
 * {@link BIND_FAILURE_LOCKOUT_MS}; callers should reject further upgrades
 * (HTTP 429 / `Unauthorized`) until {@link isLockedOut} clears.
 *
 * State is per-instance (server transports) or per-session (the vite bridge);
 * each owner holds its own limiter so the window/lockout are scoped correctly.
 */
export class BindRateLimiter {
  private readonly failureTimes: number[] = [];
  private lockoutUntil = 0;

  /** True while the lockout from a tripped threshold is still in effect. */
  isLockedOut(now: number): boolean {
    return now < this.lockoutUntil;
  }

  /**
   * Record a bind-code mismatch at `now`. `label` (typically the instance id)
   * is interpolated into the lockout log line. Returns `true` iff this failure
   * crossed the threshold and started a lockout, so callers can distinguish the
   * lockout transition from an ordinary mismatch in their own logging.
   */
  recordFailure(now: number, label: string): boolean {
    const cutoff = now - BIND_FAILURE_WINDOW_MS;
    while (this.failureTimes.length > 0 && this.failureTimes[0]! < cutoff) {
      this.failureTimes.shift();
    }
    this.failureTimes.push(now);
    if (this.failureTimes.length >= BIND_FAILURE_THRESHOLD) {
      this.lockoutUntil = now + BIND_FAILURE_LOCKOUT_MS;
      this.failureTimes.length = 0;
      process.stderr.write(
        `[tesseron] bind rate-limit triggered for instance ${label}; locked out for ${BIND_FAILURE_LOCKOUT_MS}ms\n`,
      );
      return true;
    }
    return false;
  }

  /** Clear the failure window after a successful bind. */
  reset(): void {
    this.failureTimes.length = 0;
  }
}

/** True if `raw` is a JSON-RPC frame whose method is `tesseron/hello`. */
export function isHelloFrame(raw: string): boolean {
  try {
    const parsed = JSON.parse(raw) as { method?: unknown };
    return parsed.method === 'tesseron/hello';
  } catch {
    return false;
  }
}

/**
 * Build the JSON-RPC response that answers the SDK's `tesseron/hello` with a
 * host-synthesized welcome, before any gateway has dialed.
 *
 * Conservative pre-claim capability defaults: the host has no visibility into
 * the gateway's MCP-client capabilities at this point. The gateway's real
 * values arrive via `tesseron/claimed.agentCapabilities` and the SDK overwrites
 * these defaults in its claimed handler.
 */
export function buildSynthesizedWelcomeResponse(
  claim: HostMintedClaim,
  sdkHelloId: unknown,
): { jsonrpc: '2.0'; id: JsonRpcId; result: WelcomeResult } {
  const result: WelcomeResult = {
    sessionId: claim.sessionId,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {
      streaming: true,
      subscriptions: true,
      sampling: false,
      elicitation: false,
    },
    agent: { id: 'pending', name: 'Awaiting agent' },
    claimCode: claim.code,
    resumeToken: claim.resumeToken,
  };
  return { jsonrpc: '2.0', id: sdkHelloId as JsonRpcId, result };
}
