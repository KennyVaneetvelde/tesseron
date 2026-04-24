import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ElicitationRequestParams,
  type ElicitationResult,
  type HelloParams,
  PROTOCOL_VERSION,
  type ProgressUpdate,
  type ResourceReadResult,
  type ResumeParams,
  type SamplingRequestParams,
  type SamplingResult,
  TesseronError,
  TesseronErrorCode,
  TransportClosedError,
  type WelcomeResult,
} from '@tesseron/core';
import { JsonRpcDispatcher } from '@tesseron/core/internal';
import { type RawData, WebSocket } from 'ws';
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

// Defaults used before a bridge has announced its client's real capabilities. Optimistic so
// standalone gateways (no bridge yet) still advertise streaming/subscriptions which they own
// directly; sampling/elicitation default to false and are flipped true only when a bridge
// confirms the connected MCP client advertised the corresponding capability.
const DEFAULT_AGENT_CAPABILITIES: AgentCapabilityInfo = {
  sampling: false,
  elicitation: false,
};

/** WebSocket subprotocol the gateway uses when connecting outbound to a Vite plugin tab. */
const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';

interface ActiveInvocation {
  sessionId: string;
  options: InvokeActionOptions;
  onSignalAbort?: () => void;
}

/**
 * A recently-closed session retained in memory so a reconnecting SDK can
 * rejoin it via `tesseron/resume`. Carries only the metadata the resume
 * handler needs — the dead WebSocket and its dispatcher are deliberately
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
 * The gateway is a WebSocket *client*: it discovers running apps by watching
 * {@link watchAppsJson} (`~/.tesseron/tabs/`) and dials each one's WebSocket
 * endpoint with the `tesseron-gateway` subprotocol. Emits `sessions-changed`
 * whenever a session is claimed or its owning socket closes.
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
   * Flipped true by {@link stop} so in-flight `ws.on('close')` events queued by
   * shutdown skip re-inserting zombies into the map we just cleared.
   */
  private stopped = false;
  private samplingHandler?: SamplingHandler;
  private elicitationHandler?: ElicitationHandler;
  private agentCapabilities: AgentCapabilityInfo = { ...DEFAULT_AGENT_CAPABILITIES };
  /** Tab IDs already connected via {@link watchAppsJson} so we don't double-connect. */
  private readonly connectedTabs = new Map<string, WebSocket>();
  private appsWatcher?: ReturnType<typeof watch>;
  private appsWatchInterval?: ReturnType<typeof setInterval>;

  constructor(private readonly options: GatewayOptions = {}) {
    super();
  }

  /** Closes all sessions, outbound connections, and the tabs-dir watcher. */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const session of this.sessions.values()) {
      session.ws.close(1001, 'Gateway shutting down');
    }
    this.sessions.clear();
    this.pendingClaims.clear();
    this.activeInvocations.clear();
    for (const zombie of this.zombieSessions.values()) {
      clearTimeout(zombie.evictTimer);
    }
    this.zombieSessions.clear();
    this.appsWatcher?.close();
    this.appsWatcher = undefined;
    if (this.appsWatchInterval) {
      clearInterval(this.appsWatchInterval);
      this.appsWatchInterval = undefined;
    }
    for (const ws of this.connectedTabs.values()) {
      ws.close(1001, 'Gateway shutting down');
    }
    this.connectedTabs.clear();
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
   * Connects outbound to a Tesseron Vite plugin tab endpoint. The gateway becomes the
   * WebSocket client; the Vite plugin bridges it to the browser tab. The session
   * lifecycle (tesseron/hello, resume, zombie TTL) is identical to inbound connections.
   *
   * @param tabId - Unique ID assigned by the Vite plugin, used to deduplicate.
   * @param wsUrl - Full WebSocket URL to connect to, e.g. `ws://127.0.0.1:5173/@tesseron/ws/tab-abc`.
   */
  async connectToApp(tabId: string, wsUrl: string): Promise<void> {
    if (this.connectedTabs.has(tabId)) return;
    const ws = new WebSocket(wsUrl, [GATEWAY_SUBPROTOCOL]);
    // Reserve the slot immediately so concurrent watchAppsJson ticks don't double-connect.
    this.connectedTabs.set(tabId, ws);

    // Register the dispatcher and message handlers BEFORE awaiting 'open'.
    // When gateway and SDK share a process, the SDK's attachGateway() runs
    // synchronously inside handleUpgrade and sends `tesseron/hello` before the
    // client-side 'open' event fires. If we waited for 'open' before wiring
    // ws.on('message'), that frame would be emitted with no listener and
    // silently dropped — the SDK's connect() then hangs waiting for a welcome
    // that never comes. Subprocess dialling has enough cross-process latency
    // to hide the race, which is why it only surfaced under in-process use.
    this.handleConnection(ws, undefined);
    ws.once('close', () => {
      this.connectedTabs.delete(tabId);
    });

    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', (err: Error) =>
          reject(new Error(`Failed to connect to ${wsUrl}: ${err.message}`)),
        );
      });
    } catch (err) {
      this.connectedTabs.delete(tabId);
      throw err;
    }
    logToStderr(`[tesseron] connected to app tab ${tabId} (${wsUrl})`);
  }

  /**
   * Watches `~/.tesseron/tabs/` for per-tab JSON files written by `@tesseron/vite`.
   * For each new tab file, calls {@link connectToApp}. Returns a cleanup function
   * that cancels the watcher and polling interval.
   */
  watchAppsJson(): () => void {
    const tabsDir = join(homedir(), '.tesseron', 'tabs');

    const checkDir = async (): Promise<void> => {
      if (!existsSync(tabsDir)) return;
      let files: string[];
      try {
        files = await readdir(tabsDir);
      } catch {
        return;
      }
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const tabId = file.slice(0, -5);
        if (this.connectedTabs.has(tabId)) continue;
        try {
          const content = await readFile(join(tabsDir, file), 'utf-8');
          const data = JSON.parse(content) as { version: number; tabId: string; wsUrl: string };
          if (typeof data.wsUrl !== 'string') continue;
          this.connectToApp(data.tabId ?? tabId, data.wsUrl).catch((err: Error) => {
            logToStderr(`[tesseron] could not connect to tab ${tabId}: ${err.message}`);
          });
        } catch {
          // Malformed file or race with deletion — skip
        }
      }
    };

    checkDir().catch(() => {});

    // Watch the tabs directory for new files (event-driven, fast)
    if (existsSync(tabsDir)) {
      try {
        this.appsWatcher = watch(tabsDir, () => {
          checkDir().catch(() => {});
        });
      } catch {
        // fs.watch unavailable; fall through to polling only
      }
    } else {
      // Directory doesn't exist yet; watch parent and re-try when it's created
      const parent = join(homedir(), '.tesseron');
      try {
        this.appsWatcher = watch(parent, { recursive: false }, (_event, filename) => {
          if (filename === 'tabs' || !filename) {
            checkDir().catch(() => {});
          }
        });
      } catch {
        // ignore
      }
    }

    // Polling fallback for platform quirks (Windows occasionally misses fs.watch events)
    this.appsWatchInterval = setInterval(() => {
      checkDir().catch(() => {});
    }, 2_000);
    this.appsWatchInterval.unref?.();

    return () => {
      this.appsWatcher?.close();
      this.appsWatcher = undefined;
      if (this.appsWatchInterval) {
        clearInterval(this.appsWatchInterval);
        this.appsWatchInterval = undefined;
      }
    };
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
   * Attempts to claim a pending session by its claim code. Returns the claimed
   * session, or `null` if the code is unknown or already consumed. Emits
   * `sessions-changed` on success.
   */
  claimSession(claimCode: string): Session | null {
    const sessionId = this.pendingClaims.get(claimCode.toUpperCase());
    if (!sessionId) return null;
    const session = this.sessions.get(sessionId);
    if (!session || session.claimed) return null;
    session.claimed = true;
    session.claimedAt = Date.now();
    this.pendingClaims.delete(claimCode.toUpperCase());
    this.emit('sessions-changed');
    return session;
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

  private handleConnection(ws: WebSocket, origin?: string): void {
    const dispatcher = new JsonRpcDispatcher((message) => {
      try {
        ws.send(JSON.stringify(message));
      } catch {
        // socket likely closed; ignore
      }
    });

    let session: Session | undefined;

    ws.on('message', (data: RawData) => {
      const text = rawDataToString(data);
      if (!text) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      dispatcher.receive(parsed);
    });

    ws.on('close', () => {
      // Mirrors the SDK-side rejectAllPending in TesseronClient: without it,
      // any gateway->SDK request in flight when the socket dies never settles,
      // and the MCP client's tool call hangs until its own timeout expires.
      dispatcher.rejectAllPending(new TransportClosedError('Session socket closed'));

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
      // on minor so 0.1.x ↔ 0.2.x connections still work during the transition
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

      const sessionId = generateSessionId();
      const claimCode = generateClaimCode();
      const resumeToken = generateResumeToken();
      session = {
        id: sessionId,
        app: helloParams.app,
        ws,
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
          'This socket is already attached to a session. Send tesseron/resume on a fresh connection.',
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

      // Constant-time token compare. timingSafeEqual throws on mismatched-
      // length buffers, so gate it behind an explicit length check first to
      // return a clean ResumeFailed instead of a raw TypeError. Both tokens
      // are 32-char base64url in the happy path.
      const presented = Buffer.from(resumeParams.resumeToken);
      const stored = Buffer.from(zombie.resumeToken);
      if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
        throw new TesseronError(
          TesseronErrorCode.ResumeFailed,
          `Invalid resumeToken for session "${resumeParams.sessionId}".`,
        );
      }

      // Token validated. Cancel eviction, remove zombie, promote to live
      // session with the fresh socket + dispatcher, and rotate the token.
      clearTimeout(zombie.evictTimer);
      this.zombieSessions.delete(zombie.id);

      if (origin && resumeParams.app.origin !== origin) {
        // The socket's Origin header is the authoritative value (it's what the
        // gateway already allowlisted during the WS upgrade). Log the mismatch
        // against the zombie's stored origin — a drift here can indicate a
        // misconfigured build (staging bundle dialing a prod gateway, or a
        // tenant swap) and otherwise leaves no forensic trail.
        logToStderr(
          `[tesseron] resume origin mismatch for session ${zombie.id}: stored=${zombie.app.origin} declared=${resumeParams.app.origin} socket=${origin} — rewriting to socket origin`,
        );
        resumeParams.app.origin = origin;
      }

      const rotatedResumeToken = generateResumeToken();
      session = {
        id: zombie.id,
        app: resumeParams.app,
        ws,
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

function rawDataToString(data: RawData): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  return null;
}

function logToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function parseProtocolVersion(version: string): [number, number] {
  const parts = version.split('.');
  const major = Number.parseInt(parts[0] ?? '0', 10);
  const minor = Number.parseInt(parts[1] ?? '0', 10);
  return [Number.isFinite(major) ? major : 0, Number.isFinite(minor) ? minor : 0];
}
