/**
 * Discriminated description of how a Tesseron app binding can be reached. Used
 * by the gateway to pick a dialer and by the SDK transports to advertise
 * themselves in the instance manifest. The set is intentionally closed; a new
 * binding requires a new tag and a new gateway dialer.
 *
 * The `Transport` interface in `./transport.ts` is the runtime contract the
 * binding must implement. `TransportSpec` is the *address* — it tells the
 * gateway how to dial in, not how to talk once connected.
 */
export type TransportSpec =
  | {
      kind: 'ws';
      /** Full WebSocket URL (`ws://host:port/path`) the gateway dials with the `tesseron-gateway` subprotocol. */
      url: string;
    }
  | {
      kind: 'uds';
      /** Filesystem path of the Unix domain socket the gateway connects to. NDJSON framing. */
      path: string;
    };

import type { AgentIdentity } from './protocol.js';

/**
 * On-disk descriptor each running app writes to `~/.tesseron/instances/<id>.json`
 * so the gateway can discover and dial it. Replaces the v1 `tabs/` files; the
 * gateway reads both formats during the compat window. SDKs only ever write v2.
 *
 * `instanceId` and `appName` are the same fields the v1 manifest carried under
 * `tabId` / `appName`. `transport` is the {@link TransportSpec} discriminant
 * that lets new bindings (UDS, future stdio, etc.) ship without changing the
 * file shape.
 *
 * The `version: 2` tag is intentionally *not* bumped when new optional fields
 * land. Released gateways do a strict `data.version !== 2` check, so a fresh
 * major would be silently skipped — exactly the regression the migration
 * exists to avoid. New fields stay optional and old gateways read this as
 * their existing v2 shape, ignoring extras. The authoritative contract is
 * this type definition, not the integer in the file.
 */
export interface InstanceManifest {
  version: 2;
  instanceId: string;
  appName: string;
  /** Unix-millis timestamp of when the manifest was written. */
  addedAt: number;
  /**
   * Process id of the SDK side that owns this instance (i.e. the Vite dev
   * server, Node app, etc.). Optional for backward compatibility — older
   * SDKs omit it; gateways treat absence as "trust" so upgrading the
   * gateway before the SDK doesn't tombstone working manifests. When
   * present, gateways probe `process.kill(pid, 0)` and skip / tombstone
   * manifests whose owning process is gone. See tesseron#53.
   */
  pid?: number;
  transport: TransportSpec;
  /**
   * `true` when the SDK host (Vite plugin, `@tesseron/server`) has minted the
   * claim code itself and can answer `tesseron/hello` locally. A v1.2 gateway
   * that reads this MUST NOT auto-dial the manifest; instead it waits for
   * `tesseron__claim_session(code)`, scans every manifest for one whose
   * `hostMintedClaim.code === code`, then dials the matching one with the
   * `tesseron-bind.<code>` WebSocket subprotocol.
   *
   * A v1.1 gateway ignores this field and falls back to legacy auto-dial.
   * The host detects the legacy dial (no `tesseron-bind` subprotocol on the
   * upgrade) and serves the legacy gateway-mints-the-code path. Old-gateway
   * / new-host migration ships zero regression. See tesseron#60.
   */
  helloHandledByHost?: boolean;
  /**
   * Claim metadata minted by the SDK host when `helloHandledByHost` is `true`.
   * The `code` is the user-pasteable string; the gateway scans for it on
   * `tesseron__claim_session` and dials the corresponding instance with the
   * matching bind subprotocol element.
   */
  hostMintedClaim?: HostMintedClaim;
}

/**
 * Host-minted claim metadata published in {@link InstanceManifest.hostMintedClaim}.
 *
 * **The `code` is on disk in plaintext.** That's the same threat surface as
 * the legacy `~/.tesseron/claims/<CODE>.json` breadcrumb #58 introduced — a
 * sibling local process could read the file and try to claim. PR #62 closed
 * the cross-user variant by tightening file mode to 0o600. The same-user
 * variant is the OS's job, not Tesseron's; the user-typed gesture into the
 * MCP agent is the real authentication. Future hardening (TTL refreshed on
 * heartbeat, rate-limited bind failures) moves this from a strong gate to
 * a strong-and-time-bounded one but stays out of scope for the first
 * tesseron#60 cut.
 */
export interface HostMintedClaim {
  /** 6-character pairing code in the existing `XXXX-XX` format. */
  code: string;
  /** Opaque session id minted by the host; mirrors `WelcomeResult.sessionId`. */
  sessionId: string;
  /**
   * Resume token paired with `sessionId`. Bearer credential the SDK
   * presents on `tesseron/resume` after a transport drop. The gateway
   * reads this on dial so its session ledger uses the same value the
   * SDK already stored from the host's synthesized welcome — without
   * the shared value, resume always fails in v3 mode (the gateway
   * would generate its own and the SDK's stored token wouldn't match
   * any zombie). Same on-disk threat model as `code`: file mode 0o600
   * gates cross-user reads (PR #62), same-user enumeration is the OS's
   * responsibility, and the user-typed claim into the MCP agent is the
   * real authentication.
   */
  resumeToken: string;
  /** Unix-millis timestamp when the host minted the code. */
  mintedAt: number;
  /**
   * Unix-millis sliding TTL deadline. The host rewrites the manifest
   * every half-TTL with a refreshed `mintedAt` and `expiresAt` while
   * the SDK is alive; once consumed (`boundAgent !== null`) the
   * heartbeat stops. A gateway scanning for a code match skips entries
   * whose `expiresAt < Date.now()`. Optional for the very first hosts
   * shipping the field; absent ⇒ "no TTL, code lives until manifest
   * unlink." Default TTL is 10 minutes.
   */
  expiresAt?: number;
  /**
   * `null` until the claim is consumed; set to the bound agent's identity
   * after `tesseron__claim_session` succeeds. A non-null value means the
   * code has been spent and is no longer claimable.
   */
  boundAgent: AgentIdentity | null;
}
