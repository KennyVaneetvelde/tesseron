import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentIdentity,
  type ElicitationRequestParams,
  type ElicitationResult,
  type HelloParams,
  type InstanceManifest,
  PROTOCOL_VERSION,
  type ProgressUpdate,
  type ResourceReadResult,
  type ResumeParams,
  type SamplingRequestParams,
  type SamplingResult,
  TesseronError,
  TesseronErrorCode,
  type Transport,
  TransportClosedError,
  type TransportSpec,
  type WelcomeResult,
} from '@tesseron/core';
import { JsonRpcDispatcher, constantTimeEqual } from '@tesseron/core/internal';
import { type DialedTransport, type GatewayDialer, UdsDialer, WsDialer } from './dialer.js';
import { writePrivateFile } from './fs-hygiene.js';
import {
  type Session,
  generateClaimCode,
  generateInvocationId,
  generateResumeToken,
  generateSessionId,
  validateAppId,
} from './session.js';

/** Constructor options for {@link TesseronGateway}. */
export interface GatewayOptions {
  /**
   * Milliseconds to retain a closed session as a "zombie" so a reconnecting SDK
   * can rejoin via `tesseron/resume`. Default {@link DEFAULT_RESUME_TTL_MS}.
   * Set to `0` to disable session resume entirely — closed sessions drop
   * immediately and any reconnect must start fresh with `tesseron/hello`.
   */
  resumeTtlMs?: number;
  /**
   * Maximum number of zombie sessions retained simultaneously. When adding a
   * new zombie would exceed this cap, the oldest (longest-retained) zombie is
   * evicted. Defaults to {@link DEFAULT_MAX_ZOMBIES}. Exists so a peer that
   * rapidly connects and disconnects can't accumulate unbounded memory.
   */
  maxZombies?: number;
  /**
   * Override the set of dialers the gateway uses. Defaults to the built-in
   * `WsDialer` + `UdsDialer`. Tests pass a single in-memory dialer; downstream
   * embedders can register additional bindings.
   */
  dialers?: GatewayDialer[];
}

/** Options for {@link TesseronGateway.invokeAction}. */
export interface InvokeActionOptions {
  /** Forwarded to the SDK handler as `ctx.signal`; aborting sends `actions/cancel`. */
  signal?: AbortSignal;
  /** Called for each `actions/progress` notification emitted by the handler. */
  onProgress?: (update: ProgressUpdate) => void;
  /** Called for each `log` notification emitted by the handler. */
  onLog?: (entry: { level: string; message: string; meta?: Record<string, unknown> }) => void;
}

/** Handle returned by {@link TesseronGateway.subscribeResource}. */
export interface ResourceSubscription {
  /** Fully qualified `tesseron://<app_id>/<resource>` URI. */
  uri: string;
  /** Tears down the subscription on both ends. Safe to call even after the session closed. */
  unsubscribe: () => Promise<void>;
}

/** Options for {@link TesseronGateway.subscribeResource}. */
export interface ResourceSubscribeOptions {
  /** Fired for every value the SDK emits on this subscription. */
  onUpdate: (value: unknown) => void;
}

/**
 * Handler the bridge registers via {@link TesseronGateway.setSamplingHandler}.
 * Receives the SDK's `sampling/request` and must produce a completion from the
 * connected MCP client.
 */
export type SamplingHandler = (
  req: SamplingRequestParams,
  context: { session: Session },
) => Promise<SamplingResult>;

/**
 * Handler the bridge registers via {@link TesseronGateway.setElicitationHandler}.
 * Receives the SDK's `elicitation/request` and must prompt the user through
 * the connected MCP client.
 */
export type ElicitationHandler = (
  req: ElicitationRequestParams,
  context: { session: Session },
) => Promise<ElicitationResult>;

/**
 * Default zombie-session retention window (90 s). Long enough to cover a
 * manual tab refresh, a routine HMR cycle, or a brief network blip; short
 * enough that abandoned sessions don't accumulate.
 */
export const DEFAULT_RESUME_TTL_MS = 90_000;
/**
 * Default cap on {@link TesseronGateway.zombieSessions}. A peer that repeatedly
 * connects and disconnects could otherwise pile up zombies until their TTLs
 * elapse; when the cap is reached the oldest (longest-retained) zombie is
 * evicted to make room.
 */
export const DEFAULT_MAX_ZOMBIES = 100;

/** Capabilities the connected MCP client advertised to the bridge. */
export interface AgentCapabilityInfo {
  sampling: boolean;
  elicitation: boolean;
  /** Name of the connected MCP client (e.g. `claude-ai`) if already known. */
  clientName?: string;
}

/**
 * Operational event the gateway emits as `'gateway-log'` so an MCP bridge can
 * forward it to the connected agent via `notifications/message` (MCP
 * `sendLoggingMessage`). Solves the "user has to grep ~/.claude/" problem
 * called out as concern (4) in tesseron#53 — without this, dial successes /
 * failures / tombstone outcomes are stderr-only, invisible to the developer
 * unless they hunt down the gateway's log stream by hand.
 *
 * Currently only the discovery / dial path emits these; other categories may
 * be added later (the `category` discriminator exists so consumers can filter).
 */
export interface GatewayLogEvent {
  level: 'debug' | 'info' | 'warning' | 'error';
  /** Coarse-grained category; today only `'discovery'` is emitted. */
  category: 'discovery';
  /** Human-readable message; the same string written to stderr. */
  message: string;
  /** Instance the event is about, when the call site has one. */
  instanceId?: string;
  /** Structured payload merged into the MCP logging notification's `data`. */
  meta?: Record<string, unknown>;
}

// Defaults used before a bridge has announced its client's real capabilities. Optimistic so
// standalone gateways (no bridge yet) still advertise streaming/subscriptions which they own
// directly; sampling/elicitation default to false and are flipped true only when a bridge
// confirms the connected MCP client advertised the corresponding capability.
const DEFAULT_AGENT_CAPABILITIES: AgentCapabilityInfo = {
  sampling: false,
  elicitation: false,
};

interface ActiveInvocation {
  sessionId: string;
  options: InvokeActionOptions;
  onSignalAbort?: () => void;
}

/**
 * A recently-closed session retained in memory so a reconnecting SDK can
 * rejoin it via `tesseron/resume`. Carries only the metadata the resume
 * handler needs — the dead transport and its dispatcher are deliberately
 * dropped so we never try to write to them.
 */
interface ZombieSession {
  id: string;
  app: Session['app'];
  actions: Session['actions'];
  resources: Session['resources'];
  capabilities: Session['capabilities'];
  resumeToken: string;
  claimCode: string;
  claimed: boolean;
  claimedAt?: number;
  /** Timer that removes this zombie from {@link TesseronGateway.zombieSessions} once the TTL elapses. */
  evictTimer: ReturnType<typeof setTimeout>;
}

/**
 * Bridge between claimed Tesseron sessions and the MCP server exposed to the agent.
 * The gateway is a transport *client*: it discovers running apps by watching
 * `~/.tesseron/instances/` (and `~/.tesseron/tabs/` for v1 compat) and dials each
 * one's advertised binding (WS, UDS, …) via a registered {@link GatewayDialer}.
 * Emits `sessions-changed` whenever a session is claimed or its owning channel closes.
 */
export class TesseronGateway extends EventEmitter {
  private readonly sessions = new Map<string, Session>();
  private readonly pendingClaims = new Map<string, string>();
  private readonly activeInvocations = new Map<string, ActiveInvocation>();
  /**
   * Recently-closed sessions kept around for a TTL window so the SDK can
   * rejoin them with `tesseron/resume`. See {@link GatewayOptions.resumeTtlMs}.
   */
  private readonly zombieSessions = new Map<string, ZombieSession>();
  /**
   * Flipped true by {@link stop} so in-flight transport-close events queued by
   * shutdown skip re-inserting zombies into the map we just cleared.
   */
  private stopped = false;
  private samplingHandler?: SamplingHandler;
  private elicitationHandler?: ElicitationHandler;
  private agentCapabilities: AgentCapabilityInfo = { ...DEFAULT_AGENT_CAPABILITIES };
  /** Instance IDs already connected via {@link watchInstances} so we don't double-connect. */
  private readonly connected = new Map<string, DialedTransport>();
  private readonly dialers: Map<TransportSpec['kind'], GatewayDialer>;
  private discoveryWatchers: Array<ReturnType<typeof watch>> = [];
  private discoveryInterval?: ReturnType<typeof setInterval>;
  /**
   * Manifest paths already attempted to tombstone (via `unlink`). Keeps the
   * 2 s discovery poll from re-logging "tombstoning stale instance manifest"
   * for a file the OS won't let us delete (EACCES, EBUSY on Windows). Still
   * re-tries the unlink on every tick — the file might genuinely become
   * deletable later — but suppresses the repeated stderr line.
   */
  private readonly tombstonedManifests = new Set<string>();
  /**
   * Manifests with `helloHandledByHost: true` discovered via `watchInstances`
   * but NOT auto-dialed. The gateway dials these only on
   * `tesseron__claim_session` when a code matches an entry's
   * `hostMintedClaim.code`. See tesseron#60.
   */
  private readonly hostMintedInstances = new Map<string, InstanceManifest>();
  /**
   * In-flight `claimSession` deferreds keyed by instanceId, populated before
   * the gateway dials a host-minted instance and resolved by the hello
   * handler when the v3 mode session is registered. Lets `claimSession`
   * await the round-trip from "dialed" to "session marked claimed" and
   * return the resulting `Session` synchronously to its caller.
   */
  private readonly hostMintedClaimResolvers = new Map<
    string,
    { resolve: (s: Session) => void; reject: (err: Error) => void }
  >();

  constructor(private readonly options: GatewayOptions = {}) {
    super();
    this.dialers = new Map();
    const builtIns = options.dialers ?? [new WsDialer(), new UdsDialer()];
    for (const dialer of builtIns) {
      this.dialers.set(dialer.kind, dialer);
    }
  }

  /**
   * Write a discovery / dial-outcome event to stderr (kept for grep-ability)
   * and emit it as `'gateway-log'` so any attached MCP bridge can forward it
   * to the connected agent via `notifications/message`. Used by the discovery
   * loop and the dial paths so a developer sees connect successes, failures,
   * and stale-manifest tombstones inline in their MCP client. See
   * tesseron#53 concern (4).
   */
  private emitDiscoveryLog(event: Omit<GatewayLogEvent, 'category'>): void {
    logToStderr(`[tesseron] ${event.message}`);
    this.emit('gateway-log', { ...event, category: 'discovery' } satisfies GatewayLogEvent);
  }

  /** Closes all sessions, outbound connections, and discovery watchers. */
  async stop(): Promise<void> {
    this.stopped = true;
    // Capture in-flight breadcrumb writes for unclaimed sessions before we
    // clear the maps. A sibling gateway that boots after this one shouldn't
    // keep seeing our codes listed as "live" once we're gone, so sweep
    // their breadcrumbs explicitly. Awaiting the writes first guarantees a
    // fast-stop after a fresh hello doesn't unlink-before-write and orphan
    // the late file. The transport.onClose path on each closed session
    // would also call removeClaimRecord; the awaitThen helper makes the
    // double-call idempotent.
    const pendingClaimRemovals: Array<Promise<void>> = [];
    for (const session of this.sessions.values()) {
      if (!session.claimed) {
        pendingClaimRemovals.push(
          awaitThenRemoveClaimRecord(session.claimRecordWritten, session.claimCode),
        );
      }
      session.transport.close('Gateway shutting down');
    }
    this.sessions.clear();
    this.pendingClaims.clear();
    this.activeInvocations.clear();
    for (const zombie of this.zombieSessions.values()) {
      clearTimeout(zombie.evictTimer);
    }
    this.zombieSessions.clear();
    for (const w of this.discoveryWatchers) {
      w.close();
    }
    this.discoveryWatchers = [];
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = undefined;
    }
    for (const dialed of this.connected.values()) {
      dialed.close('Gateway shutting down');
    }
    this.connected.clear();
    // Wait for the breadcrumb unlinks to land before resolving stop() —
    // tests and embedders that delete the home dir straight after stop()
    // would otherwise race the file system.
    await Promise.allSettled(pendingClaimRemovals);
  }

  /** Installs the handler invoked for `sampling/request`. Pass `undefined` to clear. */
  setSamplingHandler(handler: SamplingHandler | undefined): void {
    this.samplingHandler = handler;
  }

  /** Installs the handler invoked for `elicitation/request`. Pass `undefined` to clear. */
  setElicitationHandler(handler: ElicitationHandler | undefined): void {
    this.elicitationHandler = handler;
  }

  /**
   * Register the capabilities the connected agent client advertised. The MCP bridge calls this
   * once the upstream client completes its `initialize` handshake, so subsequent `tesseron/hello`
   * responses accurately reflect what the client supports. Without this, the gateway falls back
   * to the cached defaults (sampling/elicitation off) which keeps SDK-side `ctx.sample` calls
   * from ever reaching a client that can't handle them.
   */
  setAgentCapabilities(capabilities: Partial<AgentCapabilityInfo>): void {
    this.agentCapabilities = {
      ...this.agentCapabilities,
      ...capabilities,
    };
  }

  /** Returns a snapshot of the capabilities the attached bridge last reported. */
  getAgentCapabilities(): AgentCapabilityInfo {
    return { ...this.agentCapabilities };
  }

  /**
   * Connects outbound to a Tesseron app instance using the binding described
   * by `spec`. The gateway becomes the transport client; the app accepts the
   * single inbound connection. The session lifecycle (tesseron/hello, resume,
   * zombie TTL) is identical regardless of which binding ships the bytes.
   *
   * @param instanceId - Unique ID assigned by the SDK side; used to deduplicate.
   * @param spec - {@link TransportSpec} discriminating which dialer to use.
   */
  async connectToApp(
    instanceId: string,
    spec: TransportSpec,
    options: {
      bindCode?: string;
      /**
       * Host-minted session id from the manifest's `hostMintedClaim`. When
       * present, the v3 hello handler uses it as the session's identity
       * instead of generating a fresh one. The SDK has already stored this
       * value (it came back in the host's synthesized welcome), so reusing
       * it here is what makes `tesseron/resume` line up between SDK and
       * gateway after a transport drop.
       */
      hostMintedSessionId?: string;
      /** Host-minted resume token, paired with `hostMintedSessionId`. */
      hostMintedResumeToken?: string;
    } = {},
  ): Promise<void> {
    if (this.connected.has(instanceId)) return;
    const dialer = this.dialers.get(spec.kind);
    if (!dialer) {
      throw new Error(`No dialer registered for transport kind "${spec.kind}".`);
    }
    // Synchronously dial and register handlers BEFORE awaiting opened, so an
    // in-process peer that fires `tesseron/hello` synchronously inside its
    // own upgrade handler isn't dropped on the floor (see WsDialer comment).
    const dialed = dialer.dial(spec as never, { bindCode: options.bindCode });
    this.connected.set(instanceId, dialed);
    const bindContext =
      options.bindCode !== undefined
        ? {
            instanceId,
            code: options.bindCode,
            hostMintedSessionId: options.hostMintedSessionId,
            hostMintedResumeToken: options.hostMintedResumeToken,
          }
        : undefined;
    this.handleConnection(dialed.transport, undefined, bindContext);
    dialed.onClose(() => {
      this.connected.delete(instanceId);
    });

    try {
      await dialed.opened;
    } catch (err) {
      this.connected.delete(instanceId);
      throw err;
    }
    this.emitDiscoveryLog({
      level: 'info',
      message: `connected to app instance ${instanceId} (${describeSpec(spec)})`,
      instanceId,
      meta: { transport: spec.kind },
    });
  }

  /**
   * Watches `~/.tesseron/instances/` for v2 manifests written by SDK-side
   * transports. For each new manifest, calls {@link connectToApp} with the
   * advertised {@link TransportSpec}. Also reads `~/.tesseron/tabs/` for v1
   * (pre-instances) manifests during the compat window — those get coerced to
   * `{ kind: 'ws', url: <wsUrl> }`. Returns a cleanup function that cancels
   * watchers and the polling interval.
   */
  watchInstances(): () => void {
    const tesseronDir = join(homedir(), '.tesseron');
    const instancesDir = join(tesseronDir, 'instances');
    const legacyTabsDir = join(tesseronDir, 'tabs');

    const checkDir = async (): Promise<void> => {
      // v2 manifests: ~/.tesseron/instances/<instanceId>.json
      if (existsSync(instancesDir)) {
        let files: string[] = [];
        try {
          files = await readdir(instancesDir);
        } catch {
          // ignore
        }
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const instanceId = file.slice(0, -5);
          if (this.connected.has(instanceId)) continue;
          try {
            const content = await readFile(join(instancesDir, file), 'utf-8');
            const data = JSON.parse(content) as Partial<InstanceManifest>;
            if (data.version !== 2 || !data.transport) continue;
            // Skip manifests whose owning process is gone — every gateway
            // would otherwise keep retrying a dead WS / UDS endpoint forever.
            // Tombstone the file so subsequent ticks don't re-evaluate it
            // and so future polls aren't paced by a growing queue of corpses.
            // pid is optional (older SDKs / v1 manifests) — absent ⇒ trust.
            // See tesseron#53.
            if (data.pid !== undefined && !isPidAlive(data.pid)) {
              const path = join(instancesDir, file);
              const alreadyLogged = this.tombstonedManifests.has(path);
              try {
                await unlink(path);
                if (!alreadyLogged) {
                  this.emitDiscoveryLog({
                    level: 'info',
                    message: `tombstoned stale instance manifest ${instanceId} (pid ${data.pid} no longer running)`,
                    instanceId,
                    meta: { pid: data.pid, path },
                  });
                }
                this.tombstonedManifests.delete(path);
              } catch (unlinkErr) {
                // Log the failure once per file so a stuck file (EACCES,
                // EBUSY from antivirus on Windows) is visible but doesn't
                // spam stderr every 2 s. Subsequent ticks still retry the
                // unlink in case the lock clears.
                if (!alreadyLogged) {
                  const reason = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
                  this.emitDiscoveryLog({
                    level: 'warning',
                    message: `could not tombstone stale manifest ${path} (pid ${data.pid} dead): ${reason} — remove the file manually if it persists`,
                    instanceId,
                    meta: { pid: data.pid, path, reason },
                  });
                  this.tombstonedManifests.add(path);
                }
              }
              continue;
            }
            const id = data.instanceId ?? instanceId;
            // Host-mint flow (tesseron#60): the SDK side owns the claim
            // code and asks us NOT to auto-dial. We remember the manifest
            // here so `claimSession` can scan it on the user-typed code,
            // but don't pipe bytes until that scan matches. The host's
            // welcome already showed the user-pasteable code; auto-dialing
            // here would race that and either confuse the SDK with two
            // codes (legacy gateway-mints) or burn a bind without the
            // user ever asking for one.
            if (data.helloHandledByHost === true) {
              this.hostMintedInstances.set(id, data as InstanceManifest);
              continue;
            }
            // Drop a stale entry if a manifest flips from host-mint back to
            // legacy (in practice never happens, but the in-memory map is
            // a soft cache; a missing flag should let auto-dial proceed).
            this.hostMintedInstances.delete(id);
            this.connectToApp(id, data.transport).catch((err: Error) => {
              this.emitDiscoveryLog({
                level: 'warning',
                message: `could not connect to instance ${id}: ${err.message}`,
                instanceId: id,
                meta: { reason: err.message },
              });
            });
          } catch {
            // malformed file or race with deletion — skip
          }
        }
      }

      // v1 compat: ~/.tesseron/tabs/<tabId>.json — coerce to ws spec.
      // SDKs at v1.0 wrote these; v1.1+ writes only `instances/`. Drop in v2.0.
      if (existsSync(legacyTabsDir)) {
        let files: string[] = [];
        try {
          files = await readdir(legacyTabsDir);
        } catch {
          // ignore
        }
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const tabId = file.slice(0, -5);
          if (this.connected.has(tabId)) continue;
          try {
            const content = await readFile(join(legacyTabsDir, file), 'utf-8');
            const data = JSON.parse(content) as { tabId?: string; wsUrl?: string };
            if (typeof data.wsUrl !== 'string') continue;
            const id = data.tabId ?? tabId;
            this.connectToApp(id, { kind: 'ws', url: data.wsUrl }).catch((err: Error) => {
              this.emitDiscoveryLog({
                level: 'warning',
                message: `could not connect to legacy tab ${id}: ${err.message}`,
                instanceId: id,
                meta: { reason: err.message, legacy: true },
              });
            });
          } catch {
            // malformed file or race with deletion — skip
          }
        }
      }
    };

    checkDir().catch(() => {});

    const watchDir = (dir: string): void => {
      if (!existsSync(dir)) return;
      try {
        this.discoveryWatchers.push(
          watch(dir, () => {
            checkDir().catch(() => {});
          }),
        );
      } catch {
        // fs.watch unavailable on this dir; rely on polling fallback
      }
    };
    watchDir(instancesDir);
    watchDir(legacyTabsDir);

    // If neither directory exists yet, watch the parent for either subdir to appear.
    if (!existsSync(instancesDir) && !existsSync(legacyTabsDir)) {
      try {
        this.discoveryWatchers.push(
          watch(tesseronDir, { recursive: false }, (_event, filename) => {
            if (filename === 'instances' || filename === 'tabs' || !filename) {
              checkDir().catch(() => {});
              watchDir(instancesDir);
              watchDir(legacyTabsDir);
            }
          }),
        );
      } catch {
        // ignore — polling fallback covers this
      }
    }

    // Polling fallback for platform quirks (Windows occasionally misses fs.watch events).
    this.discoveryInterval = setInterval(() => {
      checkDir().catch(() => {});
    }, 2_000);
    this.discoveryInterval.unref?.();

    return () => {
      for (const w of this.discoveryWatchers) {
        w.close();
      }
      this.discoveryWatchers = [];
      if (this.discoveryInterval) {
        clearInterval(this.discoveryInterval);
        this.discoveryInterval = undefined;
      }
    };
  }

  /**
   * @deprecated Use {@link watchInstances}. Kept as an alias for one minor
   * version (1.1.x) so embedders that called the old name keep working.
   * Removed in 2.0.
   */
  watchAppsJson(): () => void {
    return this.watchInstances();
  }

  /** Sessions that have completed the claim flow and are exposed to the MCP client. */
  getClaimedSessions(): Session[] {
    return Array.from(this.sessions.values()).filter((s) => s.claimed);
  }

  /** Sessions that have completed `tesseron/hello` but are waiting for a claim code. */
  getPendingSessions(): Session[] {
    return Array.from(this.sessions.values()).filter((s) => !s.claimed);
  }

  /**
   * Look up the cross-gateway breadcrumb for `code` in `~/.tesseron/claims/`.
   * Used by the MCP `tesseron__claim_session` handler when its own
   * `claimSession` returns null: instead of the previous flat "no pending
   * session" error, the tool can report "this code was minted by gateway pid
   * N at HH:MM:SS — switch to that Claude session and try again". On the
   * `stale` outcome only — never on `foreign` or `unknown` — the breadcrumb
   * file is unlinked as a side-effect so future probes don't keep reporting
   * the same dead pid. See tesseron#53.
   */
  async describeForeignClaim(code: string): Promise<ForeignClaim> {
    const record = await readClaimRecord(code);
    if (!record) return { kind: 'unknown' };
    if (!isPidAlive(record.gatewayPid)) {
      // Owning gateway is gone — clean up the breadcrumb so the next probe
      // doesn't keep reporting the same dead pid. Best-effort.
      void removeClaimRecord(code);
      return {
        kind: 'stale',
        gatewayPid: record.gatewayPid,
        mintedAt: record.mintedAt,
        appId: record.appId,
        appName: record.appName,
      };
    }
    return {
      kind: 'foreign',
      gatewayPid: record.gatewayPid,
      mintedAt: record.mintedAt,
      appId: record.appId,
      appName: record.appName,
    };
  }

  /**
   * Attempts to claim a pending session by its claim code. Returns the claimed
   * session, or `null` if the code is unknown or already consumed. Emits
   * `sessions-changed` on success and a `tesseron/claimed` notification to the
   * SDK so consumers can clear the now-spent `claimCode` from their UI.
   */
  async claimSession(claimCode: string): Promise<Session | null> {
    const upper = claimCode.toUpperCase();
    // Legacy v1.1 path: the gateway itself minted this code, the session is
    // already alive in `sessions` waiting for a claim. Common path on
    // existing deployments and the only path until tesseron#60 lands hosts
    // that mint locally.
    const sessionId = this.pendingClaims.get(upper);
    if (sessionId !== undefined) {
      const session = this.sessions.get(sessionId);
      if (!session || session.claimed) return null;
      session.claimed = true;
      session.claimedAt = Date.now();
      this.pendingClaims.delete(upper);
      void awaitThenRemoveClaimRecord(session.claimRecordWritten, claimCode);
      const clientName = this.agentCapabilities.clientName;
      session.dispatcher.notify('tesseron/claimed', {
        agent: {
          id: clientName ?? 'pending',
          name: clientName ?? 'Awaiting agent',
        },
        claimedAt: session.claimedAt,
        // Send authoritative gateway capabilities on the legacy path
        // too, so a v1.2 SDK paired with this gateway always sees the
        // updated values regardless of which mint flow ran. v1.1 SDKs
        // ignore the unknown field.
        agentCapabilities: {
          streaming: true,
          subscriptions: true,
          sampling: this.agentCapabilities.sampling,
          elicitation: this.agentCapabilities.elicitation,
        },
      });
      this.emit('sessions-changed');
      return session;
    }

    // Host-mint path (tesseron#60): scan every host-minted manifest the
    // discovery loop has remembered for one whose `hostMintedClaim.code`
    // matches. If found, dial that instance with the bind subprotocol
    // carrying the code; the host validates the bind and the gateway's
    // hello handler (in v3 mode, gated on `bindContext`) registers a
    // pre-claimed session and resolves the deferred set up here.
    for (const [instanceId, manifest] of this.hostMintedInstances) {
      const minted = manifest.hostMintedClaim;
      if (!minted || minted.code.toUpperCase() !== upper) continue;

      // Concurrency guard: a `tesseron__claim_session` retry while the
      // first call is still in flight would clobber the deferred and
      // leave the first promise hanging forever. Refuse the retry
      // explicitly. The bridge will produce a "no pending session"
      // message; the operator can re-paste once the first attempt
      // resolves.
      if (this.hostMintedClaimResolvers.has(instanceId)) {
        this.emitDiscoveryLog({
          level: 'warning',
          message: `host-mint claim already in flight for instance ${instanceId}; refusing concurrent retry`,
          instanceId,
          meta: { code: upper },
        });
        return null;
      }

      // Set up the deferred BEFORE dialing so the in-process synchronous
      // hello handler can resolve it without a tick race.
      const claimed = new Promise<Session>((resolve, reject) => {
        this.hostMintedClaimResolvers.set(instanceId, { resolve, reject });
      });
      try {
        await this.connectToApp(instanceId, manifest.transport, {
          bindCode: minted.code,
          hostMintedSessionId: minted.sessionId,
          hostMintedResumeToken: minted.resumeToken,
        });
      } catch (err) {
        this.hostMintedClaimResolvers.delete(instanceId);
        // Ensure a partially-failed dial doesn't strand `connected` with
        // a half-open entry — the next claim attempt would otherwise
        // short-circuit at `connectToApp`'s `if (this.connected.has)`
        // and never re-register the bind context, leaving the new
        // deferred to time out at 5 s.
        this.connected.delete(instanceId);
        this.emitDiscoveryLog({
          level: 'warning',
          message: `host-mint dial for instance ${instanceId} failed: ${err instanceof Error ? err.message : String(err)}`,
          instanceId,
          meta: { code: upper },
        });
        return null;
      }
      // Wait for the v3 hello handler to fire and create the session. A
      // 5 s ceiling guards against a host that never sends hello after the
      // bind upgrade — without it `claimSession` would hang forever and the
      // MCP tool call along with it.
      const timer = setTimeout(() => {
        const pending = this.hostMintedClaimResolvers.get(instanceId);
        if (pending) {
          this.hostMintedClaimResolvers.delete(instanceId);
          pending.reject(new Error('host-mint bind succeeded but hello never arrived'));
        }
      }, 5000);
      try {
        const session = await claimed;
        clearTimeout(timer);
        // Once the session is registered, the entry can leave the
        // discovery cache — the file may still exist but it's been
        // consumed. A future poll won't re-add because `connected` now
        // covers the instance.
        this.hostMintedInstances.delete(instanceId);
        return session;
      } catch (err) {
        clearTimeout(timer);
        // Same connected-state cleanup as the dial-failure path:
        // without it, a timed-out claim leaves an orphan in `connected`
        // that blocks every retry from re-entering the bind flow.
        this.connected.delete(instanceId);
        this.emitDiscoveryLog({
          level: 'warning',
          message: `host-mint claim for instance ${instanceId} failed: ${err instanceof Error ? err.message : String(err)}`,
          instanceId,
          meta: { code: upper },
        });
        return null;
      }
    }
    return null;
  }

  /**
   * Invokes an action on a claimed session. Progress and log notifications are
   * forwarded through `options`. If `options.signal` aborts, the SDK receives
   * an `actions/cancel` notification.
   * @throws {TesseronError} with `ActionNotFound` if no session exists, `Unauthorized` if unclaimed, or any error the SDK handler raises.
   */
  async invokeAction(
    sessionId: string,
    localActionName: string,
    args: unknown,
    options: InvokeActionOptions = {},
  ): Promise<unknown> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new TesseronError(TesseronErrorCode.ActionNotFound, `Session ${sessionId} not found.`);
    }
    if (!session.claimed) {
      throw new TesseronError(
        TesseronErrorCode.Unauthorized,
        `Session ${sessionId} has not been claimed.`,
      );
    }
    const invocationId = generateInvocationId();
    const invocation: ActiveInvocation = { sessionId, options };
    this.activeInvocations.set(invocationId, invocation);

    if (options.signal) {
      const abortListener = (): void => {
        try {
          session.dispatcher.notify('actions/cancel', { invocationId });
        } catch {
          // session may be gone
        }
      };
      if (options.signal.aborted) {
        abortListener();
      } else {
        options.signal.addEventListener('abort', abortListener, { once: true });
        invocation.onSignalAbort = () =>
          options.signal?.removeEventListener('abort', abortListener);
      }
    }

    try {
      const result = await session.dispatcher.request('actions/invoke', {
        name: localActionName,
        input: args,
        invocationId,
      });
      return result.output;
    } finally {
      invocation.onSignalAbort?.();
      this.activeInvocations.delete(invocationId);
    }
  }

  /**
   * Reads the current value of a resource exposed by a claimed session.
   * @throws {TesseronError} with `ActionNotFound` if no session exists or `Unauthorized` if unclaimed.
   */
  async readResource(sessionId: string, resourceName: string): Promise<ResourceReadResult> {
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new TesseronError(TesseronErrorCode.ActionNotFound, `Session ${sessionId} not found.`);
    if (!session.claimed) {
      throw new TesseronError(
        TesseronErrorCode.Unauthorized,
        `Session ${sessionId} has not been claimed.`,
      );
    }
    return session.dispatcher.request('resources/read', { name: resourceName });
  }

  /**
   * Subscribes to a subscribable resource. Returns a {@link ResourceSubscription}
   * whose `unsubscribe` must be called to release the server-side callback.
   * @throws {TesseronError} with `ActionNotFound` if no session exists or `Unauthorized` if unclaimed.
   */
  async subscribeResource(
    sessionId: string,
    resourceName: string,
    options: ResourceSubscribeOptions,
  ): Promise<ResourceSubscription> {
    const session = this.sessions.get(sessionId);
    if (!session)
      throw new TesseronError(TesseronErrorCode.ActionNotFound, `Session ${sessionId} not found.`);
    if (!session.claimed) {
      throw new TesseronError(
        TesseronErrorCode.Unauthorized,
        `Session ${sessionId} has not been claimed.`,
      );
    }
    const subscriptionId = generateInvocationId();
    const uri = `tesseron://${session.app.id}/${resourceName}`;
    session.subscriptionCallbacks ??= new Map();
    session.subscriptionCallbacks.set(subscriptionId, options.onUpdate);
    await session.dispatcher.request('resources/subscribe', {
      name: resourceName,
      subscriptionId,
    });
    return {
      uri,
      unsubscribe: async () => {
        session.subscriptionCallbacks?.delete(subscriptionId);
        try {
          await session.dispatcher.request('resources/unsubscribe', { subscriptionId });
        } catch {
          // session may be gone
        }
      },
    };
  }

  /**
   * Wires up a freshly-dialed (or freshly-accepted) {@link Transport} for a
   * single Tesseron session. Public so embedders that bypass the standard
   * dialers (e.g. an in-memory transport in tests) can attach a session
   * directly. `origin` is supplied by WS-binding code that knows the upgrade
   * request's `Origin` header; UDS and stdio bindings pass `undefined`.
   */
  handleConnection(
    transport: Transport,
    origin?: string,
    bindContext?: {
      instanceId: string;
      code: string;
      hostMintedSessionId?: string;
      hostMintedResumeToken?: string;
    },
  ): void {
    const dispatcher = new JsonRpcDispatcher((message) => {
      try {
        transport.send(message);
      } catch (err) {
        // The channel is in an unrecoverable state (closing socket, broken
        // pipe, JSON serialisation failure on a circular result, ...). If we
        // silently swallow we strand whichever pending request just lost its
        // response, and the bridge waits forever. Tear down the channel so
        // `transport.onClose` fires below, `rejectAllPending` rejects every
        // outstanding request with `TransportClosedError`, and the failure
        // surfaces to the bridge / MCP tool call instead of hanging.
        const reason = err instanceof Error ? err.message : String(err);
        logToStderr(`[tesseron] session transport send failed (${reason}); closing channel`);
        try {
          transport.close();
        } catch {
          // The transport is already in a bad state; nothing more to do.
        }
      }
    });

    let session: Session | undefined;

    transport.onMessage((parsed) => {
      dispatcher.receive(parsed);
    });

    transport.onClose(() => {
      // Mirrors the SDK-side rejectAllPending in TesseronClient: without it,
      // any gateway->SDK request in flight when the channel dies never settles,
      // and the MCP client's tool call hangs until its own timeout expires.
      dispatcher.rejectAllPending(new TransportClosedError('Session channel closed'));

      if (!session) return;

      // Zombify the session so a reconnecting SDK can rejoin via
      // `tesseron/resume` within the TTL. When the feature is disabled
      // (resumeTtlMs <= 0 or maxZombies <= 0) or the gateway is shutting
      // down, the session is dropped immediately.
      const resumeTtl = this.options.resumeTtlMs ?? DEFAULT_RESUME_TTL_MS;
      const maxZombies = this.options.maxZombies ?? DEFAULT_MAX_ZOMBIES;
      if (resumeTtl > 0 && maxZombies > 0 && !this.stopped) {
        // Cap the map to prevent a connect/disconnect flood from piling up
        // zombies until their TTLs elapse. Map iteration order is insertion
        // order, so the first key is the oldest entry.
        if (this.zombieSessions.size >= maxZombies) {
          const oldestId = this.zombieSessions.keys().next().value;
          if (oldestId !== undefined) {
            const oldest = this.zombieSessions.get(oldestId);
            if (oldest) clearTimeout(oldest.evictTimer);
            this.zombieSessions.delete(oldestId);
            logToStderr(
              `[tesseron] zombie cap (${maxZombies}) reached — evicted oldest zombie ${oldestId}`,
            );
          }
        }
        const closedSession = session;
        const evictTimer = setTimeout(() => {
          this.zombieSessions.delete(closedSession.id);
        }, resumeTtl);
        // Allow the process to exit even while the zombie waits out its TTL;
        // the gateway itself doesn't keep Node alive once the WS server stops.
        evictTimer.unref?.();
        this.zombieSessions.set(closedSession.id, {
          id: closedSession.id,
          app: closedSession.app,
          actions: closedSession.actions,
          resources: closedSession.resources,
          capabilities: closedSession.capabilities,
          resumeToken: closedSession.resumeToken,
          claimCode: closedSession.claimCode,
          claimed: closedSession.claimed,
          claimedAt: closedSession.claimedAt,
          evictTimer,
        });
      }

      // Drop the cross-gateway breadcrumb if this session never made it to
      // a successful claim — leaving the file behind would mislead a sibling
      // gateway into reporting "live elsewhere" for a code that's gone.
      // Sessions that DID get claimed already removed their record at claim
      // time; calling unlink twice is harmless. Await the hello-time write
      // promise first so a tiny disk write in flight doesn't outlive the
      // unlink (same race the claim-path guards against).
      if (!session.claimed) {
        void awaitThenRemoveClaimRecord(session.claimRecordWritten, session.claimCode);
      }
      this.sessions.delete(session.id);
      this.pendingClaims.delete(session.claimCode);
      // Cancel any active invocations for this session
      for (const [invocationId, inv] of this.activeInvocations.entries()) {
        if (inv.sessionId === session.id) {
          this.activeInvocations.delete(invocationId);
        }
      }
      if (session.claimed) this.emit('sessions-changed');
    });

    dispatcher.on('tesseron/hello', async (params): Promise<WelcomeResult> => {
      const helloParams = params as HelloParams;
      validateAppId(helloParams.app.id);

      // Protocol version handshake — hard-reject on major mismatch, warn
      // on minor so 1.0.x ↔ 1.1.x connections still work during the transition
      // while users rebuild their plugin bundle.
      const [theirMajor, theirMinor] = parseProtocolVersion(helloParams.protocolVersion);
      const [ourMajor, ourMinor] = parseProtocolVersion(PROTOCOL_VERSION);
      if (theirMajor !== ourMajor) {
        throw new TesseronError(
          TesseronErrorCode.ProtocolMismatch,
          `Gateway speaks protocol ${PROTOCOL_VERSION}; SDK sent ${helloParams.protocolVersion}. Major version mismatch — pin compatible package versions.`,
        );
      }
      if (theirMinor !== ourMinor) {
        logToStderr(
          `[tesseron] protocol minor version mismatch: gateway=${PROTOCOL_VERSION}, SDK=${helloParams.protocolVersion}. New fields (e.g. ElicitationResult.action) may be silently dropped. Rebuild plugin/server/index.cjs to sync.`,
        );
      }

      if (origin && helloParams.app.origin !== origin) {
        helloParams.app.origin = origin;
      }

      // Host-minted-claim path: the gateway dialed in response to a
      // `tesseron__claim_session` call that matched a manifest with
      // `helloHandledByHost: true`. The bind code already authenticated the
      // dial via the `tesseron-bind.<code>` subprotocol; the session is born
      // claimed and there's no pending-claims registration.
      //
      // **Identity comes from the host.** The SDK has already stored the
      // `sessionId` and `resumeToken` from the host's synthesized welcome.
      // If the gateway minted fresh values here they would diverge from
      // what the SDK has, and a later `tesseron/resume` (presented with
      // the SDK's values) would fail to find any zombie under the
      // gateway-minted id. We reuse the host-minted values so the
      // gateway's session ledger and the SDK's stored credentials line up.
      // See tesseron#60.
      if (bindContext) {
        const sessionId = bindContext.hostMintedSessionId ?? generateSessionId();
        const resumeToken = bindContext.hostMintedResumeToken ?? generateResumeToken();
        const claimedAt = Date.now();
        const clientName = this.agentCapabilities.clientName;
        const agent: AgentIdentity = {
          id: clientName ?? 'pending',
          name: clientName ?? 'Awaiting agent',
        };
        session = {
          id: sessionId,
          app: helloParams.app,
          transport,
          dispatcher,
          actions: helloParams.actions,
          resources: helloParams.resources,
          capabilities: helloParams.capabilities,
          claimCode: bindContext.code,
          claimed: true,
          claimedAt,
          resumeToken,
        };
        this.sessions.set(sessionId, session);
        logToStderr(
          `[tesseron] host-mint session "${helloParams.app.name}" (${sessionId}) — bound to claim code ${bindContext.code}`,
        );
        // Resolve the deferred set up by `claimSession` BEFORE dialing, so
        // the bridge can return success synchronously after the dial round-
        // trip completes.
        const pending = this.hostMintedClaimResolvers.get(bindContext.instanceId);
        if (pending) {
          this.hostMintedClaimResolvers.delete(bindContext.instanceId);
          pending.resolve(session);
        }
        // Send `tesseron/claimed` to the SDK side AFTER returning the
        // welcome — `setImmediate` puts the notification on a tick after
        // the dispatcher's response goes out, so the SDK sees welcome then
        // claimed in order. The bridge separately listens to
        // `sessions-changed` to refresh the MCP tool list.
        //
        // Carries the gateway's authoritative `agentCapabilities` so the
        // SDK can overwrite the conservative pre-claim defaults the host
        // synthesized. Without this, action handlers in v3 mode see
        // `ctx.agentCapabilities.sampling/elicitation` reflecting the
        // SDK's own capabilities rather than the agent's, and the
        // capability gates fail at runtime instead of at handler entry.
        const claimedSession = session;
        const claimedCapabilities = {
          streaming: true,
          subscriptions: true,
          sampling: this.agentCapabilities.sampling,
          elicitation: this.agentCapabilities.elicitation,
        };
        setImmediate(() => {
          try {
            claimedSession.dispatcher.notify('tesseron/claimed', {
              agent,
              claimedAt,
              agentCapabilities: claimedCapabilities,
            });
          } catch (err) {
            // Narrow the swallow: TransportClosedError is the expected
            // race between scheduling and now. Anything else points at
            // a real regression in the dispatcher and deserves a log
            // line so the operator isn't debugging a silently-stuck
            // claim-code-in-UI symptom hours later.
            if (!(err instanceof TransportClosedError)) {
              const reason = err instanceof Error ? err.message : String(err);
              logToStderr(`[tesseron] tesseron/claimed notify failed unexpectedly: ${reason}`);
            }
          }
          this.emit('sessions-changed');
        });
        return {
          sessionId,
          protocolVersion: PROTOCOL_VERSION,
          capabilities: claimedCapabilities,
          agent,
          // No claimCode in the response — the host's synthesized welcome
          // already showed it. Repeating here would race the SDK's UI.
          resumeToken,
        };
      }

      const sessionId = generateSessionId();
      const resumeToken = generateResumeToken();
      const claimCode = generateClaimCode();
      session = {
        id: sessionId,
        app: helloParams.app,
        transport,
        dispatcher,
        actions: helloParams.actions,
        resources: helloParams.resources,
        capabilities: helloParams.capabilities,
        claimCode,
        claimed: false,
        resumeToken,
      };
      this.sessions.set(sessionId, session);
      this.pendingClaims.set(claimCode, sessionId);
      // Drop a cross-gateway breadcrumb so a sibling gateway that receives
      // tesseron__claim_session with this code (rather than us) can tell the
      // user which Claude session minted it instead of failing flat. See
      // tesseron#53. Fire-and-forget against the welcome — the file is a UX
      // hint, never a correctness gate, so a write failure must not delay
      // the welcome. The returned promise is stashed on the session so the
      // claim/close paths can await it before unlinking, otherwise a
      // fast-claim could beat the disk write and orphan the late file.
      session.claimRecordWritten = writeClaimRecord({
        version: 1,
        code: claimCode,
        sessionId,
        appId: helloParams.app.id,
        appName: helloParams.app.name,
        gatewayPid: process.pid,
        mintedAt: Date.now(),
      });
      logToStderr(
        `[tesseron] new session "${helloParams.app.name}" (${sessionId}) — claim code: ${claimCode}`,
      );

      const welcome: WelcomeResult = {
        sessionId,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          streaming: true,
          subscriptions: true,
          sampling: this.agentCapabilities.sampling,
          elicitation: this.agentCapabilities.elicitation,
        },
        agent: {
          id: this.agentCapabilities.clientName ?? 'pending',
          name: this.agentCapabilities.clientName ?? 'Awaiting agent',
        },
        claimCode,
        resumeToken,
      };
      return welcome;
    });

    dispatcher.on('tesseron/resume', async (params): Promise<WelcomeResult> => {
      const resumeParams = params as ResumeParams;

      if (session) {
        // A well-behaved SDK never does this; it's a programming error, not a
        // recoverable resume failure. InvalidRequest (not ResumeFailed) so any
        // SDK fallback-on-ResumeFailed logic doesn't loop on a malformed call.
        throw new TesseronError(
          TesseronErrorCode.InvalidRequest,
          'This channel is already attached to a session. Send tesseron/resume on a fresh connection.',
        );
      }

      // Guard every field the handler dereferences below. Without this, a
      // malformed resume (missing `app`, non-string `resumeToken`, absent
      // `actions`) bails out as a raw TypeError — which the dispatcher
      // surfaces as a generic InternalError and the SDK's ResumeFailed
      // fallback path never sees. Validate once, up front, typed.
      if (
        typeof resumeParams.sessionId !== 'string' ||
        typeof resumeParams.resumeToken !== 'string' ||
        typeof resumeParams.protocolVersion !== 'string' ||
        !resumeParams.app ||
        typeof resumeParams.app.id !== 'string' ||
        !Array.isArray(resumeParams.actions) ||
        !Array.isArray(resumeParams.resources) ||
        !resumeParams.capabilities ||
        typeof resumeParams.capabilities !== 'object'
      ) {
        throw new TesseronError(
          TesseronErrorCode.ResumeFailed,
          'Invalid tesseron/resume request: expected { protocolVersion, sessionId, resumeToken, app, actions, resources, capabilities }.',
        );
      }

      // Same protocol-version policy as hello: hard-reject on major mismatch,
      // warn on minor. A resuming SDK that upgraded past a major bump must
      // fall back to a fresh tesseron/hello with its new manifest.
      const [theirMajor, theirMinor] = parseProtocolVersion(resumeParams.protocolVersion);
      const [ourMajor, ourMinor] = parseProtocolVersion(PROTOCOL_VERSION);
      if (theirMajor !== ourMajor) {
        throw new TesseronError(
          TesseronErrorCode.ProtocolMismatch,
          `Gateway speaks protocol ${PROTOCOL_VERSION}; SDK sent ${resumeParams.protocolVersion}. Major version mismatch on resume — pin compatible package versions or start a fresh session.`,
        );
      }
      if (theirMinor !== ourMinor) {
        logToStderr(
          `[tesseron] protocol minor version mismatch on resume: gateway=${PROTOCOL_VERSION}, SDK=${resumeParams.protocolVersion}.`,
        );
      }

      // Remap validateAppId's plain Error into the typed ResumeFailed the
      // ConnectOptions.resume contract promises, so SDK fallback logic that
      // branches on err.code === ResumeFailed catches malformed app ids too.
      try {
        validateAppId(resumeParams.app.id);
      } catch (err) {
        throw new TesseronError(
          TesseronErrorCode.ResumeFailed,
          err instanceof Error ? err.message : 'Invalid app id on resume.',
        );
      }

      const zombie = this.zombieSessions.get(resumeParams.sessionId);
      if (!zombie) {
        throw new TesseronError(
          TesseronErrorCode.ResumeFailed,
          `No resumable session "${resumeParams.sessionId}". The TTL may have elapsed, the gateway may have restarted, or the session never existed.`,
        );
      }

      if (zombie.app.id !== resumeParams.app.id) {
        throw new TesseronError(
          TesseronErrorCode.ResumeFailed,
          `Session "${resumeParams.sessionId}" is owned by app "${zombie.app.id}", not "${resumeParams.app.id}". Refusing cross-app resume.`,
        );
      }

      // Resume is only meaningful for sessions that were actually claimed; an
      // unclaimed zombie's original claim code is already gone from
      // pendingClaims and there's nothing user-visible to restore. Surface a
      // clean error so the SDK knows to fall back to a fresh tesseron/hello.
      if (!zombie.claimed) {
        throw new TesseronError(
          TesseronErrorCode.ResumeFailed,
          `Session "${resumeParams.sessionId}" was never claimed; open a fresh session with tesseron/hello instead.`,
        );
      }

      // Constant-time token compare via the shared helper. Plain `===` would
      // short-circuit on the first differing char and leak the matched-prefix
      // length to anyone measuring response latency — material against a
      // base64url 32-char bearer token. {@link constantTimeEqual} runs in
      // O(length) regardless of where the strings diverge.
      if (!constantTimeEqual(resumeParams.resumeToken, zombie.resumeToken)) {
        throw new TesseronError(
          TesseronErrorCode.ResumeFailed,
          `Invalid resumeToken for session "${resumeParams.sessionId}".`,
        );
      }

      // Token validated. Cancel eviction, remove zombie, promote to live
      // session with the fresh transport + dispatcher, and rotate the token.
      clearTimeout(zombie.evictTimer);
      this.zombieSessions.delete(zombie.id);

      if (origin && resumeParams.app.origin !== origin) {
        // The channel's Origin header is the authoritative value (it's what the
        // gateway already allowlisted during the WS upgrade). Log the mismatch
        // against the zombie's stored origin — a drift here can indicate a
        // misconfigured build (staging bundle dialing a prod gateway, or a
        // tenant swap) and otherwise leaves no forensic trail.
        logToStderr(
          `[tesseron] resume origin mismatch for session ${zombie.id}: stored=${zombie.app.origin} declared=${resumeParams.app.origin} channel=${origin} — rewriting to channel origin`,
        );
        resumeParams.app.origin = origin;
      }

      const rotatedResumeToken = generateResumeToken();
      session = {
        id: zombie.id,
        app: resumeParams.app,
        transport,
        dispatcher,
        actions: resumeParams.actions,
        resources: resumeParams.resources,
        capabilities: resumeParams.capabilities,
        claimCode: zombie.claimCode,
        claimed: zombie.claimed,
        claimedAt: zombie.claimedAt,
        resumeToken: rotatedResumeToken,
      };
      this.sessions.set(zombie.id, session);

      logToStderr(
        `[tesseron] resumed session "${resumeParams.app.name}" (${zombie.id}) — claim preserved`,
      );

      // The MCP bridge sees the reattached session via sessions-changed and
      // re-advertises its tools, so the agent gets them back in tools/list.
      this.emit('sessions-changed');

      const welcome: WelcomeResult = {
        sessionId: zombie.id,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          streaming: true,
          subscriptions: true,
          sampling: this.agentCapabilities.sampling,
          elicitation: this.agentCapabilities.elicitation,
        },
        agent: {
          id: this.agentCapabilities.clientName ?? 'pending',
          name: this.agentCapabilities.clientName ?? 'Awaiting agent',
        },
        // No claimCode on resume: the session is already claimed; re-issuing
        // a pairing code would only confuse the UI.
        resumeToken: rotatedResumeToken,
      };
      return welcome;
    });

    dispatcher.onNotification('actions/progress', (params) => {
      const p = params as {
        invocationId: string;
        message?: string;
        percent?: number;
        data?: unknown;
      };
      const invocation = this.activeInvocations.get(p.invocationId);
      invocation?.options.onProgress?.({
        message: p.message,
        percent: p.percent,
        data: p.data,
      });
    });

    dispatcher.onNotification('log', (params) => {
      const p = params as {
        invocationId?: string;
        level: string;
        message: string;
        meta?: Record<string, unknown>;
      };
      if (p.invocationId) {
        const invocation = this.activeInvocations.get(p.invocationId);
        invocation?.options.onLog?.({ level: p.level, message: p.message, meta: p.meta });
      }
    });

    dispatcher.onNotification('resources/updated', (params) => {
      if (!session) return;
      const p = params as { subscriptionId: string; value: unknown };
      const callback = session.subscriptionCallbacks?.get(p.subscriptionId);
      callback?.(p.value);
    });

    dispatcher.on('sampling/request', async (params) => {
      if (!this.samplingHandler || !this.agentCapabilities.sampling) {
        const who = this.agentCapabilities.clientName
          ? `"${this.agentCapabilities.clientName}"`
          : 'the connected MCP client';
        throw new TesseronError(
          TesseronErrorCode.SamplingNotAvailable,
          `${who} does not support sampling/createMessage. The handler should check ctx.agentCapabilities.sampling before calling ctx.sample, or catch SamplingNotAvailableError.`,
          this.agentCapabilities.clientName
            ? { clientName: this.agentCapabilities.clientName }
            : undefined,
        );
      }
      if (!session) {
        throw new TesseronError(TesseronErrorCode.Unauthorized, 'Hello not completed.');
      }
      return this.samplingHandler(params as SamplingRequestParams, { session });
    });

    dispatcher.on('elicitation/request', async (params) => {
      if (!this.elicitationHandler || !this.agentCapabilities.elicitation) {
        const who = this.agentCapabilities.clientName
          ? `"${this.agentCapabilities.clientName}"`
          : 'the connected MCP client';
        throw new TesseronError(
          TesseronErrorCode.ElicitationNotAvailable,
          `${who} does not support elicitation.`,
          this.agentCapabilities.clientName
            ? { clientName: this.agentCapabilities.clientName }
            : undefined,
        );
      }
      if (!session) {
        throw new TesseronError(TesseronErrorCode.Unauthorized, 'Hello not completed.');
      }
      return this.elicitationHandler(params as ElicitationRequestParams, { session });
    });
  }
}

function logToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function describeSpec(spec: TransportSpec): string {
  return spec.kind === 'ws' ? spec.url : spec.path;
}

function parseProtocolVersion(version: string): [number, number] {
  const parts = version.split('.');
  const major = Number.parseInt(parts[0] ?? '0', 10);
  const minor = Number.parseInt(parts[1] ?? '0', 10);
  return [Number.isFinite(major) ? major : 0, Number.isFinite(minor) ? minor : 0];
}

/**
 * True when the OS reports `pid` as a running process, false when it's
 * definitely gone (`ESRCH`). Any other error (`EPERM`: alive but owned by
 * another user; missing pid; non-numeric pid; platform quirks) is treated as
 * "live" — we'd rather waste a dial than tombstone a manifest that still has
 * a working owner. `process.kill(pid, 0)` is documented as cross-platform on
 * Windows + POSIX; signal 0 only probes existence.
 */
export function isPidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return true;
  }
}

/**
 * Persistent breadcrumb the gateway drops in `~/.tesseron/claims/<CODE>.json`
 * when it mints a claim code. Lets a sibling gateway (different Claude
 * session, parallel dev shell, …) that receives a `tesseron__claim_session`
 * call for a code it doesn't own surface a "this code belongs to gateway pid
 * N — switch to that session" hint instead of the previous flat "no pending
 * session". Removed atomically when the owning gateway claims the session,
 * the session closes unclaimed, or the gateway shuts down. See tesseron#53.
 */
interface ClaimRecord {
  version: 1;
  code: string;
  sessionId: string;
  appId: string;
  appName: string;
  /** Pid of the gateway process that minted this code. */
  gatewayPid: number;
  /** Unix-millis when the gateway sent the welcome carrying this code. */
  mintedAt: number;
}

// Resolved lazily so that tests which point HOME / USERPROFILE at a sandbox
// after this module has loaded still see the redirected directory.
function claimsDir(): string {
  return join(homedir(), '.tesseron', 'claims');
}

function claimFilePath(code: string): string {
  return join(claimsDir(), `${code.toUpperCase()}.json`);
}

async function writeClaimRecord(record: ClaimRecord): Promise<void> {
  const path = claimFilePath(record.code);
  try {
    // writePrivateFile creates `~/.tesseron/claims/` with mode 0o700 if
    // missing and atomically writes the breadcrumb at mode 0o600. The
    // breadcrumb carries no secrets today (the claim code is already on
    // the wire to the agent), but tightening the mode aligns with every
    // other file under `~/.tesseron/` and removes the world-readable
    // surface a sibling local process could enumerate.
    await writePrivateFile(path, JSON.stringify(record, null, 2));
  } catch (err) {
    // Surfacing the error in stderr is enough — a missing breadcrumb only
    // degrades the cross-gateway error message; it never blocks claiming a
    // code on the gateway that minted it. Include the resolved path so a
    // user hitting EACCES / ENOSPC / EROFS can act on the actual location
    // rather than guessing where breadcrumbs live.
    const reason = err instanceof Error ? err.message : String(err);
    logToStderr(`[tesseron] failed to write claim record at ${path}: ${reason}`);
  }
}

async function removeClaimRecord(code: string): Promise<void> {
  try {
    await unlink(claimFilePath(code));
  } catch (err) {
    // ENOENT is expected when the breadcrumb was never written (write race,
    // mkdir failed earlier) or already removed by the same code path on a
    // double-call. Anything else is worth telling the operator about — a
    // permission-denied unlink leaves a stale file behind that future
    // describeForeignClaim probes will keep matching, so the user has no
    // way to recover without manually `rm`ing the path. Include it.
    const errno = (err as NodeJS.ErrnoException).code;
    if (errno === 'ENOENT') return;
    const reason = err instanceof Error ? err.message : String(err);
    logToStderr(`[tesseron] failed to remove claim record at ${claimFilePath(code)}: ${reason}`);
  }
}

/**
 * Sequence the breadcrumb removal *after* the in-flight write completes, so a
 * fast-claim that runs before the hello-time write has landed on disk
 * doesn't unlink-before-write (the unlink would ENOENT, then the late write
 * would land and live forever — no later cleanup path covers a claimed
 * session's breadcrumb). Best-effort: if the write rejected, the file
 * isn't there and the unlink ENOENTs, which we silently swallow.
 */
async function awaitThenRemoveClaimRecord(
  writePromise: Promise<void> | undefined,
  code: string,
): Promise<void> {
  if (writePromise) {
    try {
      await writePromise;
    } catch {
      // write already failed; the file isn't there, nothing to remove.
    }
  }
  await removeClaimRecord(code);
}

async function readClaimRecord(code: string): Promise<ClaimRecord | null> {
  try {
    const raw = await readFile(claimFilePath(code), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<ClaimRecord>;
    if (
      parsed.version !== 1 ||
      typeof parsed.code !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.appId !== 'string' ||
      typeof parsed.appName !== 'string' ||
      typeof parsed.gatewayPid !== 'number' ||
      typeof parsed.mintedAt !== 'number'
    ) {
      return null;
    }
    return parsed as ClaimRecord;
  } catch {
    return null;
  }
}

/**
 * Outcome of probing `~/.tesseron/claims/<CODE>.json` from a gateway that
 * doesn't own the code locally. See {@link TesseronGateway.describeForeignClaim}.
 */
export type ForeignClaim =
  /** A live sibling gateway minted this code; tell the user which one to switch to. */
  | { kind: 'foreign'; gatewayPid: number; mintedAt: number; appId: string; appName: string }
  /** Record exists but the owning gateway is gone — likely a leftover from a crashed gateway. */
  | { kind: 'stale'; gatewayPid: number; mintedAt: number; appId: string; appName: string }
  /** No claim record for this code on disk at all. */
  | { kind: 'unknown' };
