import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import {
  type ElicitationRequestParams,
  type ElicitationResult,
  type HelloParams,
  PROTOCOL_VERSION,
  type ProgressUpdate,
  type ResourceReadResult,
  type SamplingRequestParams,
  type SamplingResult,
  TesseronError,
  TesseronErrorCode,
  TransportClosedError,
  type WelcomeResult,
} from '@tesseron/core';
import { JsonRpcDispatcher } from '@tesseron/core/internal';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import {
  type Session,
  generateClaimCode,
  generateInvocationId,
  generateSessionId,
  validateAppId,
} from './session.js';

/** Constructor options for {@link TesseronGateway}. */
export interface GatewayOptions {
  /** Port to bind. Defaults to {@link DEFAULT_GATEWAY_PORT}. */
  port?: number;
  /** Host/interface to bind. Defaults to {@link DEFAULT_GATEWAY_HOST} (loopback only). */
  host?: string;
  /** Extra origins accepted in addition to localhost/127.0.0.1. Anything else is rejected with 403. */
  originAllowlist?: string[];
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

/** Default gateway port (`7475`) — also the port SDK clients dial by default. */
export const DEFAULT_GATEWAY_PORT = 7475;
/** Default gateway bind host; loopback-only to prevent accidental LAN exposure. */
export const DEFAULT_GATEWAY_HOST = '127.0.0.1';

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

interface ActiveInvocation {
  sessionId: string;
  options: InvokeActionOptions;
  onSignalAbort?: () => void;
}

/**
 * Local WebSocket server that hosts Tesseron sessions. SDK clients connect
 * and send `tesseron/hello`; an {@link McpAgentBridge} consumes the gateway on
 * the MCP-server side to expose claimed sessions as tools and resources. Emits
 * `sessions-changed` whenever a session is claimed or its owning socket closes.
 */
export class TesseronGateway extends EventEmitter {
  private wss?: WebSocketServer;
  private readonly sessions = new Map<string, Session>();
  private readonly pendingClaims = new Map<string, string>();
  private readonly activeInvocations = new Map<string, ActiveInvocation>();
  private samplingHandler?: SamplingHandler;
  private elicitationHandler?: ElicitationHandler;
  private agentCapabilities: AgentCapabilityInfo = { ...DEFAULT_AGENT_CAPABILITIES };

  constructor(private readonly options: GatewayOptions = {}) {
    super();
  }

  /** Binds the WebSocket server. Resolves when `listening` fires; rejects on bind error. */
  async start(): Promise<void> {
    const port = this.options.port ?? DEFAULT_GATEWAY_PORT;
    const host = this.options.host ?? DEFAULT_GATEWAY_HOST;
    const allowlist = new Set(this.options.originAllowlist ?? []);

    return new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({
        port,
        host,
        verifyClient: (info, cb) => {
          const origin = info.origin ?? '';
          if (
            !origin ||
            origin.startsWith('http://localhost') ||
            origin.startsWith('http://127.0.0.1')
          ) {
            cb(true);
            return;
          }
          if (allowlist.has(origin)) {
            cb(true);
            return;
          }
          cb(false, 403, `Origin "${origin}" not allowed`);
        },
      });
      wss.once('listening', () => resolve());
      wss.once('error', (err) => reject(err));
      wss.on('connection', (ws, req) => this.handleConnection(ws, req.headers.origin));
      this.wss = wss;
    });
  }

  /** Closes all sessions and shuts down the WebSocket server. */
  async stop(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.ws.close(1001, 'Gateway shutting down');
    }
    this.sessions.clear();
    this.pendingClaims.clear();
    this.activeInvocations.clear();
    if (!this.wss) return;
    return new Promise<void>((resolve, reject) => {
      this.wss?.close((err) => (err ? reject(err) : resolve()));
    });
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
