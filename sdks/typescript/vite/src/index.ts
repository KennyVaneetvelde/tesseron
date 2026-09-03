import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentIdentity, WelcomeResult } from '@tesseron/core';
import { PROTOCOL_VERSION, TesseronErrorCode } from '@tesseron/core';
import { constantTimeEqual, parseBindSubprotocol, validateAppId } from '@tesseron/core/internal';
import {
  BindRateLimiter,
  mintClaimCode,
  mintResumeToken,
  mintSessionId,
  writePrivateFile,
} from '@tesseron/core/node';
import type { Plugin, ViteDevServer } from 'vite';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

export interface TesseronViteOptions {
  /** Human-readable app name written to the instance manifest. Defaults to the Vite project directory name. */
  appName?: string;
  /**
   * Milliseconds a {@link Session} is kept alive after its browser WebSocket
   * detaches (refresh, tab close, network blip). A new browser WS that arrives
   * within this window with a matching `tesseron/resume` payload re-attaches
   * to the existing Session — the gateway-side bridge never sees a
   * disconnect. Default: 4 hours (matches `@tesseron/mcp`'s `resumeTtlMs`).
   * Set to `0` to tear down sessions immediately on browser close (disables
   * cross-refresh resume; every reload becomes a fresh `tesseron/hello`).
   */
  sessionIdleTtlMs?: number;
}

/** A frame buffered or forwarded across the bridge. Text frames are kept as
 * `string` so that re-`send()` produces a text frame; binary frames stay as
 * the original `RawData` (Buffer/ArrayBuffer/Buffer[]) and re-`send()` produces
 * a binary frame. */
type BridgePayload = string | RawData;

/** Mirrors `HostMintedClaim` from `@tesseron/core/transport-spec`. The local */
/* alias keeps the Vite plugin from depending on the core type's import */
/* surface for what's a single-property descriptor used here. */
interface HostMintedClaim {
  code: string;
  sessionId: string;
  resumeToken: string;
  mintedAt: number;
  /** Sliding TTL deadline; gateway skips manifests past this time. */
  expiresAt: number;
  boundAgent: AgentIdentity | null;
}

/** Default sliding TTL on a host-minted claim — 10 minutes from `mintedAt`. */
const HOST_MINT_TTL_MS = 10 * 60 * 1000;
/** How often the plugin rewrites the manifest with a fresh `mintedAt` / `expiresAt`. */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Default idle TTL: how long a Session is held without a browser WS attached
 * before the plugin tears it down. Matches `@tesseron/mcp`'s `resumeTtlMs`
 * default (4 hours) so the cross-refresh resume window is consistent on both
 * sides of the bridge. Configurable via {@link TesseronViteOptions.sessionIdleTtlMs}.
 */
const DEFAULT_SESSION_IDLE_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * A Tesseron host session — the unit of identity the host owns across the
 * lifecycle of one logical browser pairing. The {@link sessionId} is stable
 * across browser-WS detach/reattach (page refresh, HMR, brief network drop);
 * the {@link gatewayWs} bridge stays open across those reattachments so the
 * MCP gateway never sees a disconnect.
 *
 * Invariants:
 * - At any moment, a Session has 0 or 1 attached browser WebSockets
 *   ({@link browserWs}). A second `tesseron/resume` arriving while another
 *   browser is still attached kicks the older one (see {@link attachBrowserResume}).
 * - {@link gatewayWs} is set exactly once per Session — after a successful
 *   bind via the `tesseron-bind.<code>` subprotocol. Its closure destroys
 *   the Session because we have no way to re-establish a bind without a
 *   user-typed claim code, and the SDK on the browser side would receive no
 *   replies.
 * - The {@link idleTimer} runs only when {@link browserWs} is unset. Its fire
 *   destroys the Session.
 */
interface Session {
  /** Manifest filename and gateway-dial URL path component. Stable for the
   *  lifetime of the Session. */
  instanceId: string;
  /** Host-minted session identifier echoed in the welcome's `sessionId`. The
   *  browser persists this and uses it as the resume key on subsequent
   *  connects. Stable for the Session's lifetime. */
  sessionId: string;
  /** Current resume token. Rotated on every successful `tesseron/resume`. The
   *  most recently issued token is the only one that validates the next
   *  resume — single-shot per the protocol spec. */
  resumeToken: string;
  /** User-facing 6-character claim code minted at Session creation. Persists
   *  for the Session's lifetime even after binding (it's used by the bind
   *  subprotocol's constant-time compare on every gateway dial). */
  claimCode: string;
  /** Human-readable app name; surfaced in `tesseron__list_pending_claims`. */
  appName?: string;
  /** Manifest-side descriptor that's written to `~/.tesseron/instances/`. The
   *  `resumeToken` field here mirrors {@link Session.resumeToken} so the
   *  gateway sees the freshest value on dial. */
  hostMintedClaim: HostMintedClaim;
  /** SDK's `tesseron/hello` request frame, cached so the host can replay it
   *  to the gateway once a v1.2 bind dial completes. */
  cachedHello?: { id: unknown; params: unknown };
  /** True once the host has answered the SDK's hello with a synthesized
   *  welcome. After this, browser-side frames flow to the gateway. */
  helloAnswered: boolean;
  /** Sentinel id used on the hello frame replayed to the gateway. The reply
   *  carrying this id is dropped (the SDK already saw the synthesized
   *  welcome). */
  helloReplayId?: string;
  /** Rolling-window rate limiter for bind-code mismatches. Reset on a
   *  successful bind to avoid coupling a one-time misconfiguration to
   *  legitimate retries; locks out (HTTP 429) once the threshold is crossed. */
  bindLimiter: BindRateLimiter;
  /** True once a `tesseron-bind.<code>` upgrade has been accepted. Required
   *  before the host accepts a non-bind dial (legacy v1.1 dials are rejected
   *  with HTTP 426). */
  boundViaSubprotocol: boolean;
  /** Currently attached browser WebSocket, if any. Nullable across the
   *  detach/reattach window managed by {@link idleTimer}. */
  browserWs?: WebSocket;
  /** The gateway-side WebSocket of the bridge. Lifetime spans potentially
   *  many browser-WS lifetimes; only the gateway closing (or the Session
   *  being destroyed by idle timeout) tears it down. */
  gatewayWs?: WebSocket;
  /** Browser-side frames buffered while the gateway dial hasn't completed
   *  AND/OR while no browser is attached. Drained when both ends are open. */
  queue: BridgePayload[];
  /** Refreshes the manifest mid-flight while the Session is unbound. Cleared
   *  on bind (gateway sees `boundAgent !== null` and stops dialing). */
  heartbeatTimer?: ReturnType<typeof setInterval>;
  /** Started on browser detach; cancelled on browser reattach via resume.
   *  Fires {@link Session.destroy} on expiry. */
  idleTimer?: ReturnType<typeof setTimeout>;
}

const WS_PATH_PREFIX = '/@tesseron/ws';
const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';

/**
 * Resolve the instance-discovery directory at call time rather than module
 * load. Tests (and long-lived processes that change `$HOME` at runtime) need
 * this — capturing at load meant a sandbox set via `process.env.HOME` after
 * the plugin was imported wrote to the host's real `~/.tesseron/instances/`.
 * Mirrors the lazy pattern in `@tesseron/server`.
 */
function getInstancesDir(): string {
  return join(homedir(), '.tesseron', 'instances');
}

function generateInstanceId(): string {
  // CSPRNG-sourced like the rest of `~/.tesseron/*` writes. Instance IDs
  // aren't bearer tokens (the gateway still requires the standard
  // handshake), but the consistency with claim/session/resume token
  // generation matters for security review.
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  const rand = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `inst-${Date.now().toString(36)}-${rand}`;
}

/** Decode a `ws` text-frame payload back to a string. `ws` always emits a
 * Buffer (or Buffer fragments) for text frames; we just need UTF-8 it. */
function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

/**
 * Parse a queued bridge payload back to JSON, or null if it isn't a JSON
 * text frame. Used by the v3 path to identify the SDK's hello request and
 * the gateway's reply to the replayed hello.
 */
function parseJsonFrame(payload: BridgePayload | string): unknown {
  let text: string;
  if (typeof payload === 'string') {
    text = payload;
  } else if (Buffer.isBuffer(payload)) {
    text = payload.toString('utf8');
  } else if (Array.isArray(payload)) {
    text = Buffer.concat(payload).toString('utf8');
  } else {
    text = Buffer.from(payload as ArrayBuffer).toString('utf8');
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `true` iff the payload is a JSON-RPC request whose `method` is
 * `tesseron/hello`. Used to find the SDK's hello frame in the queue at
 * v3-bind time so the plugin can synthesize a welcome and replay the
 * frame to the gateway.
 */
function isHelloRequest(payload: BridgePayload | string): boolean {
  const parsed = parseJsonFrame(payload);
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { method?: unknown }).method === 'tesseron/hello'
  );
}

/** Minimal subset of {@link Session} the manifest writer needs.
 *  Exported alongside {@link writeInstanceManifest} so a test can call the
 *  helper directly without standing up a real WebSocket. */
export interface InstanceManifestInput {
  instanceId: string;
  appName?: string;
  wsUrl: string;
  /**
   * When set, the manifest advertises `helloHandledByHost: true` and a
   * matching `hostMintedClaim`. Omitted callers (e.g. legacy tests) get the
   * pre-tesseron#60 manifest shape exactly.
   */
  hostMintedClaim?: HostMintedClaim;
}

/**
 * Exported so the manifest contract can be unit-tested without booting a Vite
 * dev server. `process.pid` and `Date.now()` still come from the runtime, so
 * a test asserts on the pid stamp by inspecting the produced file.
 *
 * Uses {@link writePrivateFile} so the manifest lands with mode 0o600 inside
 * a 0o700 parent dir — a sibling local process under the same user can no
 * longer enumerate/read instance manifests just by walking `~/.tesseron/`.
 */
export async function writeInstanceManifest(inst: InstanceManifestInput): Promise<void> {
  const file = join(getInstancesDir(), `${inst.instanceId}.json`);
  // The manifest schema doesn't bump major when host-mint fields land —
  // released v1.1 gateways do a strict `data.version !== 2` check, so a
  // bumped tag would silently skip every v3 file. New fields are optional;
  // old gateways read the manifest as their existing v2 shape. See
  // `@tesseron/core/transport-spec.ts` for the authoritative contract.
  const payload: Record<string, unknown> = {
    version: 2,
    instanceId: inst.instanceId,
    appName: inst.appName,
    addedAt: Date.now(),
    // Stamp the Vite dev-server pid so a gateway that boots later can
    // probe `process.kill(pid, 0)` and skip manifests whose owning process
    // is already dead (e.g. a Vite session killed without a clean
    // `httpServer.close`, leaving an orphan `<id>.json`). See tesseron#53.
    pid: process.pid,
    transport: { kind: 'ws', url: inst.wsUrl },
  };
  if (inst.hostMintedClaim !== undefined) {
    payload['helloHandledByHost'] = true;
    payload['hostMintedClaim'] = inst.hostMintedClaim;
  }
  await writePrivateFile(file, JSON.stringify(payload, null, 2));
}

async function deleteManifest(instanceId: string): Promise<void> {
  const file = join(getInstancesDir(), `${instanceId}.json`);
  if (existsSync(file)) {
    await unlink(file).catch(() => {});
  }
}

/**
 * Owns the lifetime of host-minted {@link Session}s. Two indices because two
 * dial paths exist: the gateway dials by `instanceId` (URL path component),
 * the browser-side resume looks up by `sessionId` (carried in the resume
 * request). Both refer to the same Session object.
 */
class SessionManager {
  private readonly byInstanceId = new Map<string, Session>();
  private readonly bySessionId = new Map<string, Session>();
  private readonly idleTtlMs: number;

  constructor(opts: { idleTtlMs: number }) {
    this.idleTtlMs = opts.idleTtlMs;
  }

  /** Look up by instanceId (gateway dial path). */
  getByInstance(instanceId: string): Session | undefined {
    return this.byInstanceId.get(instanceId);
  }

  /** Look up by sessionId (resume path). */
  getBySession(sessionId: string): Session | undefined {
    return this.bySessionId.get(sessionId);
  }

  /** Build a fresh Session for a `tesseron/hello`. Caller owns wiring up
   *  WebSocket handlers; this just allocates the state and records the
   *  Session in both maps. */
  createForHello(opts: { browserWs: WebSocket; appName?: string }): Session {
    const instanceId = generateInstanceId();
    const mintedAt = Date.now();
    const hostMintedClaim: HostMintedClaim = {
      code: mintClaimCode(),
      sessionId: mintSessionId(),
      resumeToken: mintResumeToken(),
      mintedAt,
      expiresAt: mintedAt + HOST_MINT_TTL_MS,
      boundAgent: null,
    };
    const session: Session = {
      instanceId,
      sessionId: hostMintedClaim.sessionId,
      claimCode: hostMintedClaim.code,
      resumeToken: hostMintedClaim.resumeToken,
      appName: opts.appName,
      hostMintedClaim,
      helloAnswered: false,
      bindLimiter: new BindRateLimiter(),
      boundViaSubprotocol: false,
      browserWs: opts.browserWs,
      queue: [],
    };
    this.byInstanceId.set(instanceId, session);
    this.bySessionId.set(session.sessionId, session);
    return session;
  }

  /**
   * Attach a browser WS to an existing Session via `tesseron/resume`.
   *
   * Returns the Session on success (token valid, Session still alive).
   * Returns `null` when the resume must be rejected (unknown sessionId or
   * token mismatch) — caller is responsible for sending `ResumeFailed` and
   * closing the WS so the SDK can fall back to a fresh hello on a new socket.
   *
   * On success: rotates the Session's `resumeToken` (one-shot per spec) and
   * cancels any idle timer; if a previous browser is still attached, it's
   * kicked out (close code 1000, reason "Replaced by resume"). The Session's
   * `gatewayWs` is untouched — the bridge stays open across the attachment
   * swap, which is the whole point of this flow.
   */
  attachBrowserResume(opts: {
    browserWs: WebSocket;
    sessionId: string;
    resumeToken: string;
  }): Session | null {
    const session = this.bySessionId.get(opts.sessionId);
    if (!session) return null;
    // Constant-time compare to deny a timing oracle on the token. Pre-check
    // lengths (constantTimeEqual asserts equal length).
    if (
      opts.resumeToken.length !== session.resumeToken.length ||
      !constantTimeEqual(opts.resumeToken, session.resumeToken)
    ) {
      return null;
    }
    // Cancel idle timer — a fresh browser is attaching.
    if (session.idleTimer !== undefined) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    // Kick the prior browser if one is still attached. This shouldn't
    // happen in practice (the browser-side WS owner sent the resume from a
    // freshly-opened socket), but if it does we keep the invariant of "one
    // browser per Session" cleanly.
    if (session.browserWs !== undefined && session.browserWs.readyState === 1 /* OPEN */) {
      try {
        session.browserWs.close(1000, 'Replaced by resume');
      } catch {
        // Already closing; nothing to do.
      }
    }
    session.browserWs = opts.browserWs;
    // Rotate the resume token. The freshest token is the only one that
    // validates the next resume, matching the gateway's contract on the
    // non-host-minted path.
    const rotated = mintResumeToken();
    session.resumeToken = rotated;
    session.hostMintedClaim.resumeToken = rotated;
    return session;
  }

  /**
   * Browser WS has closed. Detach it, but keep the Session alive for the
   * idle-TTL window so a refresh-driven reconnect with the saved resume
   * token can re-attach. If the TTL is `0`, destroy immediately.
   *
   * Idempotent — calling on an already-detached Session is a no-op.
   */
  onBrowserClose(session: Session, reason: 'close' | 'error'): void {
    if (session.browserWs === undefined) return;
    session.browserWs = undefined;
    if (this.idleTtlMs <= 0) {
      this.destroy(session);
      return;
    }
    // Schedule destruction; cancellable by a successful resume.
    const timer = setTimeout(() => {
      session.idleTimer = undefined;
      this.destroy(session);
    }, this.idleTtlMs);
    timer.unref?.();
    session.idleTimer = timer;
    process.stderr.write(
      `[tesseron] session ${session.instanceId} browser detached (${reason}); idle TTL ${this.idleTtlMs}ms\n`,
    );
  }

  /**
   * Gateway WS has closed. After bind there's no way to re-bridge without
   * the user re-typing the claim code, so destroy the Session — a stranded
   * Session would let resume requests succeed but their messages would have
   * nowhere to flow.
   */
  onGatewayClose(session: Session): void {
    if (session.gatewayWs === undefined) return;
    session.gatewayWs = undefined;
    this.destroy(session);
  }

  /** Tear down a Session unconditionally: close timers, gateway socket,
   *  manifest, and the maps. Safe to call on an already-destroyed Session. */
  destroy(session: Session): void {
    if (!this.bySessionId.has(session.sessionId)) return; // already destroyed
    this.bySessionId.delete(session.sessionId);
    this.byInstanceId.delete(session.instanceId);
    if (session.heartbeatTimer) {
      clearInterval(session.heartbeatTimer);
      session.heartbeatTimer = undefined;
    }
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
      session.idleTimer = undefined;
    }
    if (session.gatewayWs !== undefined) {
      try {
        session.gatewayWs.close(1000, 'Session destroyed');
      } catch {
        // already closing/closed
      }
      session.gatewayWs = undefined;
    }
    if (session.browserWs !== undefined) {
      try {
        session.browserWs.close(1000, 'Session destroyed');
      } catch {
        // already closing/closed
      }
      session.browserWs = undefined;
    }
    deleteManifest(session.instanceId).catch(() => {});
  }

  destroyAll(): void {
    for (const session of [...this.bySessionId.values()]) {
      this.destroy(session);
    }
  }
}

/**
 * Tesseron Vite plugin. Exposes `/@tesseron/ws` on the Vite dev server so
 * browser apps can connect without a separate gateway port. Writes per-tab
 * instance manifests to `~/.tesseron/instances/` so the gateway can find and
 * connect to each open tab.
 *
 * **Session model.** A Session is the unit of identity, not the browser
 * WebSocket. A page refresh (or HMR remount, or short network blip) detaches
 * the browser WS and starts an idle timer; a new browser WS arriving within
 * the idle TTL with a matching `tesseron/resume` payload re-attaches to the
 * same Session. The gateway-side bridge never sees a disconnect — the agent
 * keeps the same `sessionId` and stays paired without the user retyping the
 * claim code. The idle TTL defaults to 4 hours (configurable via
 * {@link TesseronViteOptions.sessionIdleTtlMs}); after it elapses the
 * Session is destroyed and a future browser connect goes through a fresh
 * `tesseron/hello`. See [protocol/resume](https://tesseron.dev/protocol/resume/).
 */
export function tesseron(options: TesseronViteOptions = {}): Plugin {
  const idleTtlMs = options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
  const manager = new SessionManager({ idleTtlMs });
  let serverUrl = '';

  return {
    name: 'tesseron',

    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        if (addr && typeof addr !== 'string') {
          // Use 'localhost' rather than the raw bind address so the URL works on
          // both IPv4 (127.0.0.1) and IPv6 (::1) systems — Vite on Windows
          // commonly binds to ::1, which is not reachable via 127.0.0.1.
          serverUrl = `http://localhost:${addr.port}`;
        }
      });

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const url = req.url ?? '';

        // Browser tab connecting to /@tesseron/ws
        if (url === WS_PATH_PREFIX || url === `${WS_PATH_PREFIX}/`) {
          const protocols =
            req.headers['sec-websocket-protocol']?.split(',').map((s: string) => s.trim()) ?? [];
          // Reject if somehow the gateway is trying the plain path
          if (protocols.includes(GATEWAY_SUBPROTOCOL)) return;

          wss.handleUpgrade(req, socket, head, (ws) => {
            attachBrowserWebSocket(ws, manager, server, options, () => serverUrl);
          });
          return;
        }

        // Gateway connecting to /@tesseron/ws/:instanceId
        if (url.startsWith(`${WS_PATH_PREFIX}/`)) {
          const instanceId = url.slice(WS_PATH_PREFIX.length + 1).split('?')[0]!;
          const session = manager.getByInstance(instanceId);
          if (!session) {
            socket.destroy();
            return;
          }
          handleGatewayUpgrade(req, socket, head, session, wss, manager);
          return;
        }
      });

      server.httpServer?.on('close', () => {
        manager.destroyAll();
      });
    },
  };
}

/**
 * Wires browser-side WS handlers. The browser is in one of three states at
 * any given moment:
 *
 * 1. **Pre-hello** — the plugin hasn't seen the first frame yet. The first
 *    frame must be `tesseron/hello` (create a new Session) or
 *    `tesseron/resume` (attach to an existing Session). Anything else gets
 *    queued and routed once a Session is established.
 * 2. **Attached, hello-answered** — the SDK has its welcome (or resume
 *    response), the Session exists, frames flow to the gateway WS (or queue
 *    until it dials).
 * 3. **Detached** — browser WS is closed; Session lives on for the idle TTL
 *    so the next browser WS can resume it.
 *
 * The detach/reattach mechanics live in {@link SessionManager}. This function
 * just wires handlers and routes the first frame.
 */
function attachBrowserWebSocket(
  ws: WebSocket,
  manager: SessionManager,
  server: ViteDevServer,
  options: TesseronViteOptions,
  getServerUrl: () => string,
): void {
  // Session is bound on the first valid frame. Tracked locally so the close
  // handler can find it without a global lookup.
  let session: Session | undefined;

  ws.on('message', (data: RawData, isBinary: boolean) => {
    // `ws` hands us a Buffer for both text and binary frames. Calling
    // send(Buffer) without options forwards as a binary frame, which the
    // browser receives as a Blob and the @tesseron/web transport drops (it
    // only handles string frames). Decode text frames back to a string so
    // the frame type round-trips correctly.
    const payload: RawData | string = isBinary ? data : rawDataToString(data);

    // Pre-hello: route the first frame.
    if (session === undefined) {
      if (isBinary) {
        // Binary frame before any handshake — protocol violation. Drop.
        return;
      }
      const parsed = parseJsonFrame(payload);
      const method =
        parsed !== null && typeof parsed === 'object'
          ? (parsed as { method?: unknown }).method
          : undefined;

      if (method === 'tesseron/resume') {
        const m = parsed as {
          id?: unknown;
          params?: { sessionId?: unknown; resumeToken?: unknown };
        };
        const sidParam = m.params?.sessionId;
        const tokParam = m.params?.resumeToken;
        if (typeof sidParam !== 'string' || typeof tokParam !== 'string') {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: m.id ?? null,
              error: {
                code: TesseronErrorCode.ResumeFailed,
                message: 'Resume params malformed: sessionId and resumeToken are required strings.',
              },
            }),
          );
          // Don't close — the SDK is allowed to follow up with a hello on
          // the same socket (matches the pre-refactor fallback contract).
          return;
        }
        const attached = manager.attachBrowserResume({
          browserWs: ws,
          sessionId: sidParam,
          resumeToken: tokParam,
        });
        if (attached === null) {
          ws.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: m.id ?? null,
              error: {
                code: TesseronErrorCode.ResumeFailed,
                message:
                  'No resumable Tesseron session matching the supplied sessionId/resumeToken. The SDK will fall back to a fresh tesseron/hello.',
              },
            }),
          );
          // Same as the malformed branch: leave the socket open so a
          // follow-up hello on the same socket still works. The SDK
          // typically opens a fresh socket for fallback anyway.
          return;
        }
        session = attached;
        // Re-attach handlers: ws is bound to this session for its lifetime.
        // Synthesize the resume response — no claimCode (already claimed),
        // populated agent (from the prior bind, if any), rotated token.
        const resumeResult: WelcomeResult = {
          sessionId: session.sessionId,
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            streaming: true,
            subscriptions: true,
            sampling: false,
            elicitation: false,
          },
          agent: session.hostMintedClaim.boundAgent ?? { id: 'pending', name: 'Awaiting agent' },
          resumeToken: session.resumeToken,
        };
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id ?? null,
            result: resumeResult,
          }),
        );
        return;
      }

      if (method === 'tesseron/hello') {
        const m = parsed as { id?: unknown; params?: { app?: { id?: unknown } } };
        // Validate the app.id before synthesizing — defends against the SDK
        // trying to claim a reserved id (e.g. 'tesseron') or a malformed
        // identifier. The legacy path got this for free from the gateway's
        // hello handler; with the host synthesizing locally we re-apply the
        // same validation here so the SDK's connect() promise rejects with
        // a clear message rather than appearing to succeed and breaking
        // later.
        const appId = m.params?.app?.id;
        if (typeof appId === 'string') {
          try {
            validateAppId(appId);
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: m.id ?? null,
                error: { code: -32600, message: reason },
              }),
            );
            return;
          }
        }
        // Mint the Session and write the manifest. The Session is now the
        // authoritative owner of the bridge identity.
        const appName =
          options.appName ??
          (server.config.root ? server.config.root.split('/').pop() : undefined) ??
          'unknown';
        session = manager.createForHello({ browserWs: ws, appName });
        session.cachedHello = { id: m.id, params: m.params };
        session.helloAnswered = true;

        const wsUrl = `${getServerUrl().replace(/^http/, 'ws')}${WS_PATH_PREFIX}/${session.instanceId}`;
        writeInstanceManifest({
          instanceId: session.instanceId,
          appName: session.appName,
          wsUrl,
          hostMintedClaim: session.hostMintedClaim,
        }).catch((err: Error) =>
          process.stderr.write(`[tesseron] failed to write instance manifest: ${err.message}\n`),
        );

        startHeartbeat(session, wsUrl);

        const synthesized: WelcomeResult = {
          sessionId: session.sessionId,
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {
            streaming: true,
            subscriptions: true,
            sampling: false,
            elicitation: false,
          },
          agent: { id: 'pending', name: 'Awaiting agent' },
          claimCode: session.claimCode,
          resumeToken: session.resumeToken,
        };
        ws.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id ?? null,
            result: synthesized,
          }),
        );
        return;
      }

      // First frame was neither hello nor resume — this is a protocol
      // violation by the SDK. Drop the frame; the SDK should retry with a
      // proper handshake on a fresh socket.
      return;
    }

    // Session is bound. Forward to gateway, or queue.
    if (session.gatewayWs?.readyState === 1 /* OPEN */) {
      session.gatewayWs.send(payload);
    } else {
      session.queue.push(payload);
    }
  });

  ws.on('close', () => {
    if (session === undefined) return; // never reached hello/resume
    manager.onBrowserClose(session, 'close');
  });

  ws.on('error', () => {
    if (session === undefined) return;
    manager.onBrowserClose(session, 'error');
  });
}

/**
 * Heartbeat that refreshes the manifest's sliding TTL while the Session is
 * unbound. Stops once `boundAgent !== null` (the bind has consumed the
 * claim code) or the Session has been destroyed.
 */
function startHeartbeat(session: Session, wsUrl: string): void {
  const heartbeat = setInterval(() => {
    if (session.hostMintedClaim.boundAgent !== null) {
      clearInterval(heartbeat);
      session.heartbeatTimer = undefined;
      return;
    }
    const now = Date.now();
    session.hostMintedClaim.mintedAt = now;
    session.hostMintedClaim.expiresAt = now + HOST_MINT_TTL_MS;
    writeInstanceManifest({
      instanceId: session.instanceId,
      appName: session.appName,
      wsUrl,
      hostMintedClaim: session.hostMintedClaim,
    }).catch((err: Error) =>
      process.stderr.write(`[tesseron] heartbeat manifest write failed: ${err.message}\n`),
    );
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  session.heartbeatTimer = heartbeat;
}

/**
 * Handles the gateway-side `wss.handleUpgrade`. Validates the
 * `tesseron-bind.<code>` subprotocol against the Session's host-minted
 * claim, accepts/rejects accordingly, and wires the bridge once accepted.
 */
function handleGatewayUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  session: Session,
  wss: WebSocketServer,
  manager: SessionManager,
): void {
  // Single-owner binding. The first gateway to upgrade owns the Session;
  // later upgrades on the same instanceId would overwrite `session.gatewayWs`
  // and silently split the bridge — the welcome+claim code already left
  // through the first gateway, so the user-visible code can no longer be
  // claimed via the second one. Reject with HTTP 409 and let the race-loser
  // back off via the gateway's poll loop instead of fighting.
  //
  // Only reject when the existing slot is CONNECTING (0) or OPEN (1).
  // CLOSING (2) or CLOSED (3) means the previous owner is on its way out;
  // the close handler will null `gatewayWs` once the event fires, but the
  // new dial may have arrived first. Treating those as free avoids a stuck
  // slot if the close event is dropped (rare with abrupt RST).
  if (
    session.gatewayWs &&
    (session.gatewayWs.readyState === 0 || session.gatewayWs.readyState === 1)
  ) {
    process.stderr.write(
      `[tesseron] rejecting second gateway upgrade for instance ${session.instanceId} (already bound; first-gateway-wins). See tesseron#53.\n`,
    );
    const body = 'Another Tesseron gateway is already bound to this instance. See tesseron#53.';
    socket.end(
      `HTTP/1.1 409 Conflict\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(
        body,
      )}\r\nConnection: close\r\n\r\n${body}`,
    );
    return;
  }

  // Parse the `Sec-WebSocket-Protocol` header for a bind element. A v1.2
  // gateway sends `tesseron-gateway, tesseron-bind.<code>` when it dials in
  // response to `tesseron__claim_session`. The host validates the bind code
  // against its in-memory mint before accepting the upgrade — a mismatch
  // produces a 403, a missing bind element (legacy v1.1 dial) takes the
  // legacy path. See `@tesseron/core/bind-subprotocol`.
  const protoHeader = req.headers['sec-websocket-protocol'];
  const bind = parseBindSubprotocol(
    Array.isArray(protoHeader) ? protoHeader.join(', ') : protoHeader,
  );
  if (bind.code !== null) {
    const now = Date.now();
    if (session.bindLimiter.isLockedOut(now)) {
      const body =
        'Too many bind failures; this instance is locked out. Reload the tab to mint a fresh session.';
      socket.end(
        `HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      return;
    }
    if (!constantTimeEqual(bind.code, session.hostMintedClaim.code)) {
      const lockedOut = session.bindLimiter.recordFailure(now, session.instanceId);
      if (!lockedOut) {
        process.stderr.write(
          `[tesseron] rejecting bind subprotocol upgrade for instance ${session.instanceId} (code mismatch)\n`,
        );
      }
      const body = 'Bind code does not match the host-minted claim.';
      socket.end(
        `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      return;
    }
    if (session.hostMintedClaim.boundAgent !== null) {
      const body = 'Claim has already been bound; mint a fresh session.';
      socket.end(
        `HTTP/1.1 409 Conflict\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
      return;
    }
    session.bindLimiter.reset();
    session.boundViaSubprotocol = true;
  } else if (bind.reason !== undefined) {
    process.stderr.write(`[tesseron] rejecting bind upgrade: ${bind.reason}\n`);
    const body = `Malformed bind subprotocol: ${bind.reason}`;
    socket.end(
      `HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    return;
  }

  // Legacy v1.1 gateway dials (no bind subprotocol) are now rejected. The
  // plugin has already minted a host-side claim code and synthesized a
  // welcome to the SDK; allowing a legacy auto-dial through would produce a
  // second, conflicting welcome from the gateway and confuse the SDK's
  // already-resolved hello promise. Users running an old gateway against a
  // new plugin need to upgrade the gateway alongside.
  //
  // The 426 Upgrade Required response signals "the protocol you dialed with
  // is incompatible; switch to a newer one" — the closest HTTP status to
  // "v1.2 required."
  if (!session.boundViaSubprotocol) {
    process.stderr.write(
      `[tesseron] rejecting legacy auto-dial for instance ${session.instanceId}: gateway must speak v1.2 (use the tesseron-bind.<code> subprotocol). Upgrade @tesseron/mcp to >= 2.4.0.\n`,
    );
    const body =
      'This Tesseron host requires a v1.2-compatible gateway (tesseron-bind subprotocol). Upgrade @tesseron/mcp to >= 2.4.0.';
    socket.end(
      `HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    );
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    session.gatewayWs = ws;

    // V3 path: the gateway has authenticated via the bind subprotocol.
    // Replay the SDK's cached hello to the gateway with a unique internal
    // id, and discard the gateway's welcome reply by id (the SDK already
    // received the synthesized welcome on its hello). Subsequent traffic
    // flows in both directions normally.
    if (session.cachedHello !== undefined) {
      session.helloReplayId = `__tesseron-host-replay-${globalThis.crypto.randomUUID()}`;
      const replayFrame = JSON.stringify({
        jsonrpc: '2.0',
        id: session.helloReplayId,
        method: 'tesseron/hello',
        params: session.cachedHello.params,
      });
      ws.send(replayFrame);
    }
    for (const msg of session.queue) {
      if (!isHelloRequest(msg)) ws.send(msg);
    }
    session.queue = [];

    ws.on('message', (data: RawData, isBinary: boolean) => {
      const payload: RawData | string = isBinary ? data : rawDataToString(data);
      // V3 mode: drop the gateway's reply to the replayed hello — the SDK
      // already received the synthesized welcome from the plugin. Inspect
      // by JSON-RPC id; everything else forwards as in the legacy path.
      if (session.boundViaSubprotocol && session.helloReplayId !== undefined) {
        const text = typeof payload === 'string' ? payload : rawDataToString(payload);
        const msg = parseJsonFrame(text);
        if (
          msg !== null &&
          typeof msg === 'object' &&
          'id' in msg &&
          (msg as { id?: unknown }).id === session.helloReplayId
        ) {
          // Capture agent identity if the response carries it, for later
          // bridging on a host-mint resume (the synthesized resume
          // response uses `boundAgent` to populate `agent`).
          const result = (msg as { result?: { agent?: AgentIdentity } }).result;
          if (result?.agent !== undefined) {
            session.hostMintedClaim.boundAgent = result.agent;
          }
          session.helloReplayId = undefined;
          return;
        }
      }
      // Forward to the currently-attached browser, if any. When the
      // browser has detached for refresh, queue the frame so the
      // reattaching browser gets it. Without queuing, in-flight progress /
      // sampling responses from the agent could drop on the floor across
      // a refresh.
      if (session.browserWs !== undefined && session.browserWs.readyState === 1 /* OPEN */) {
        session.browserWs.send(payload);
        return;
      }
      session.queue.push(payload);
    });

    ws.on('close', () => {
      manager.onGatewayClose(session);
    });

    ws.on('error', () => {
      manager.onGatewayClose(session);
    });
  });
}
