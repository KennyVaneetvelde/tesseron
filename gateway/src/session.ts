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
   * Unix-millis timestamp of when the session was created (i.e. when the
   * gateway processed `tesseron/hello`). Lets {@link TesseronGateway.getPendingClaims}
   * report a stable mintedAt to the agent without re-reading the on-disk
   * claim breadcrumb.
   */
  mintedAt: number;
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

// Claim-code / session-id / invocation-id / resume-token minting lives once in
// `@tesseron/core/node` (shared with @tesseron/server and @tesseron/vite). The
// gateway keeps its historical `generate*` names as thin re-export aliases so
// call sites and the session-tokens test suite are unchanged.
export {
  mintClaimCode as generateClaimCode,
  mintInvocationId as generateInvocationId,
  mintResumeToken as generateResumeToken,
  mintSessionId as generateSessionId,
} from '@tesseron/core/node';

export { validateAppId } from '@tesseron/core/internal';
