import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentIdentity, HelloParams, Transport } from '@tesseron/core';
import { constantTimeEqual, parseBindSubprotocol, validateAppId } from '@tesseron/core/internal';
import {
  BindRateLimiter,
  buildSynthesizedWelcomeResponse,
  isHelloFrame,
  mintClaimCode,
  mintResumeToken,
  mintSessionId,
  writePrivateFile,
} from '@tesseron/core/node';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';
/**
 * Default sliding TTL on a host-minted claim — 10 minutes from `mintedAt`,
 * refreshed each time the heartbeat runs (see {@link HEARTBEAT_INTERVAL_MS}).
 * The Node app simply being alive keeps the code redeemable; an app left
 * running overnight refreshes its mint while a crashed-and-stranded
 * manifest expires before someone else can paste the code.
 */
const HOST_MINT_TTL_MS = 10 * 60 * 1000;
/**
 * How often the host rewrites the manifest with a fresh `mintedAt` /
 * `expiresAt`. Half the TTL so a single missed heartbeat never expires a
 * live session.
 */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Resolves the instance-discovery directory on every call rather than at
 * module load. Tests (and long-lived processes that change `$HOME` at runtime)
 * need this — capturing at load time meant a sandbox set via
 * `process.env.HOME` before `beforeAll` was ignored.
 */
function getInstancesDir(): string {
  return join(homedir(), '.tesseron', 'instances');
}

function generateInstanceId(): string {
  // CSPRNG-sourced like the rest of `~/.tesseron/*` writes. Instance IDs
  // aren't bearer tokens (the gateway still requires the standard
  // handshake), but a predictable id is a side channel — a sibling
  // process that observes one id can narrow the manifest namespace
  // for the next, and the consistency with claim/session/resume token
  // generation matters for review.
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  const rand = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `inst-${Date.now().toString(36)}-${rand}`;
}

interface HostMintedClaim {
  code: string;
  sessionId: string;
  resumeToken: string;
  mintedAt: number;
  expiresAt: number;
  boundAgent: AgentIdentity | null;
}

export interface NodeWebSocketServerTransportOptions {
  /** App name written to the tab discovery file. Defaults to `'node'`. */
  appName?: string;
  /** Host/interface to bind. Defaults to `'127.0.0.1'` (loopback-only). */
  host?: string;
  /** Port to bind. Defaults to `0` (OS picks a free port). */
  port?: number;
}

/**
 * Transport that hosts a one-shot WebSocket server on loopback and announces
 * itself to the Tesseron gateway by writing `~/.tesseron/instances/<instanceId>.json`
 * with a `{ kind: 'ws', url }` spec. The gateway watches that directory, dials
 * the advertised URL (using the `tesseron-gateway` WS subprotocol), and the
 * two ends then exchange the standard Tesseron JSON-RPC traffic.
 *
 * Implements the host-mint claim flow (tesseron#60): mints `claimCode`,
 * `sessionId`, and `resumeToken` at construction; writes them into the
 * manifest's `hostMintedClaim`; intercepts the SDK's `tesseron/hello` and
 * synthesizes a welcome locally; on a v1.2 gateway dial validates the
 * `tesseron-bind.<code>` subprotocol element constant-time and replays
 * the cached hello to the gateway with an internal id, discarding the
 * gateway's reply by id. v1.1 gateway dials (no bind subprotocol) take
 * the legacy queue-drain path, with the gateway minting its own claim
 * code — zero regression for old-gateway / new-host pairings.
 */
export class NodeWebSocketServerTransport implements Transport {
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private readonly opened: Promise<void>;
  private readonly instanceId: string;
  private readonly options: NodeWebSocketServerTransportOptions;
  private readonly hostMintedClaim: HostMintedClaim;
  private server?: Server;
  private wss?: WebSocketServer;
  private ws?: WebSocket;
  private manifestFile?: string;
  /** Messages queued before the gateway dials in. Drained on connection. */
  private readonly sendQueue: string[] = [];
  /** True after the gateway dialed with a valid bind subprotocol element. */
  private boundViaSubprotocol = false;
  /**
   * The SDK's cached `tesseron/hello` request, captured the first time
   * `send` sees one. Replayed to the gateway with {@link helloReplayId}
   * after a successful bind.
   */
  private cachedHello?: { id: unknown; method: 'tesseron/hello'; params: HelloParams };
  /** Marks `send`'s hello-interception as done so a duplicate hello (theoretical) doesn't re-trigger. */
  private helloAnswered = false;
  /** Internal id used when replaying hello to the gateway; the gateway's response carrying this id is discarded. */
  private helloReplayId?: string;
  /** Heartbeat timer rewriting the manifest every {@link HEARTBEAT_INTERVAL_MS}. Cleared on `close`. */
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  /** Rolling-window rate limiter for bind-code mismatches. */
  private readonly bindLimiter = new BindRateLimiter();

  constructor(options: NodeWebSocketServerTransportOptions = {}) {
    this.options = options;
    this.instanceId = generateInstanceId();
    const now = Date.now();
    this.hostMintedClaim = {
      code: mintClaimCode(),
      sessionId: mintSessionId(),
      resumeToken: mintResumeToken(),
      mintedAt: now,
      expiresAt: now + HOST_MINT_TTL_MS,
      boundAgent: null,
    };
    this.opened = this.listen();
  }

  private async listen(): Promise<void> {
    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? 0;
    const server = createServer();
    this.server = server;

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (req, socket, head) => {
      const protoHeader = req.headers['sec-websocket-protocol'];
      const protoStr = Array.isArray(protoHeader) ? protoHeader.join(', ') : (protoHeader ?? '');
      const protocols = protoStr.split(',').map((s) => s.trim());
      if (!protocols.includes(GATEWAY_SUBPROTOCOL)) {
        socket.destroy();
        return;
      }
      // Rate-limit lock-out: refuse bind upgrades during the cool-down
      // window after a sustained mismatch burst. 429 makes the failure
      // distinguishable from a code-mismatch 403.
      const now = Date.now();
      if (this.bindLimiter.isLockedOut(now)) {
        const body =
          'Too many bind failures; this host is locked out. Mint a fresh session by reloading.';
        socket.end(
          `HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
        return;
      }

      // Parse bind subprotocol: a v1.2 gateway sends
      // `tesseron-bind.<code>` alongside `tesseron-gateway` when dialing
      // in response to `tesseron__claim_session`.
      const bind = parseBindSubprotocol(protoStr);
      if (bind.code !== null) {
        if (!constantTimeEqual(bind.code, this.hostMintedClaim.code)) {
          this.bindLimiter.recordFailure(now, this.instanceId);
          const body = 'Bind code does not match the host-minted claim.';
          socket.end(
            `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
          return;
        }
        if (this.hostMintedClaim.boundAgent !== null) {
          const body = 'Claim has already been bound; mint a fresh session.';
          socket.end(
            `HTTP/1.1 409 Conflict\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
          return;
        }
        // Concurrent-bind race: between this check passing and
        // `wss.handleUpgrade` actually attaching the gateway WebSocket
        // (and {@link attachGateway} setting `this.ws`), a second
        // concurrent valid bind upgrade could otherwise pass the same
        // gates and call `handleUpgrade` again. The `if (this.ws)`
        // check below sees `undefined` until handleUpgrade fires its
        // callback. Setting `boundViaSubprotocol` is the early
        // marker the second concurrent attempt sees.
        if (this.boundViaSubprotocol) {
          const body = 'Bind already in progress; mint a fresh session.';
          socket.end(
            `HTTP/1.1 409 Conflict\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
          );
          return;
        }
        // Reset the failure window on a successful bind so a slow brute-
        // force can't accumulate a lock-out across an eventual hit.
        this.bindLimiter.reset();
        this.boundViaSubprotocol = true;
      } else if (bind.reason !== undefined) {
        const body = `Malformed bind subprotocol: ${bind.reason}`;
        socket.end(
          `HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
        return;
      }

      if (!this.boundViaSubprotocol) {
        // Legacy v1.1 gateway dial. The host has minted its own claim
        // code and synthesized a welcome to the SDK on hello arrival;
        // letting a legacy gateway through would result in a second,
        // conflicting welcome and confuse the SDK's already-resolved
        // hello promise. Users running an old gateway against a new
        // host need to upgrade @tesseron/mcp to >= 2.4.0.
        process.stderr.write(
          `[tesseron] rejecting legacy auto-dial for instance ${this.instanceId}: gateway must speak v1.2 (use the tesseron-bind.<code> subprotocol). Upgrade @tesseron/mcp to >= 2.4.0.\n`,
        );
        const body =
          'This Tesseron host requires a v1.2-compatible gateway (tesseron-bind subprotocol). Upgrade @tesseron/mcp to >= 2.4.0.';
        socket.end(
          `HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
        );
        return;
      }
      if (this.ws) {
        // Already bound to a gateway; reject duplicates.
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.attachGateway(ws));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to obtain listening address');
    }
    // Bracket IPv6 hosts so the URL parses cleanly. `ws://::1:54213/` is
    // ambiguous — the parser can't tell which `:` separates host from
    // port. RFC 3986 §3.2.2 requires brackets around literal IPv6.
    const hostPart = host.includes(':') ? `[${host}]` : host;
    const wsUrl = `ws://${hostPart}:${addr.port}/`;
    await this.writeManifest(wsUrl);
    this.startHeartbeat(wsUrl);
  }

  private attachGateway(ws: WebSocket): void {
    this.ws = ws;

    // V3 path only — legacy dials are now rejected at the upgrade
    // handler, so reaching this point means a valid bind subprotocol
    // was present. If the SDK already sent its hello (and the synthesized
    // welcome already went out via {@link send}), replay the cached
    // hello to the gateway with an internal id; the gateway's reply
    // is discarded by id below in the message handler. If the SDK
    // hasn't sent hello yet, {@link send} will fire the replay once it
    // does (it checks `boundViaSubprotocol` and the live socket state).
    if (this.cachedHello !== undefined) {
      this.replayHelloToGateway(this.cachedHello.params);
    }
    // Drain any non-hello queued frames to the gateway.
    for (const raw of this.sendQueue) {
      if (!isHelloFrame(raw)) ws.send(raw);
    }
    this.sendQueue.length = 0;

    ws.on('message', (data: RawData) => {
      let text: string;
      if (typeof data === 'string') {
        text = data;
      } else if (Buffer.isBuffer(data)) {
        text = data.toString('utf-8');
      } else if (Array.isArray(data)) {
        text = Buffer.concat(data).toString('utf-8');
      } else {
        text = Buffer.from(data).toString('utf-8');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      // V3: drop the gateway's reply to the replayed hello — the SDK
      // already received the synthesized welcome from this transport.
      if (
        this.boundViaSubprotocol &&
        this.helloReplayId !== undefined &&
        typeof parsed === 'object' &&
        parsed !== null &&
        (parsed as { id?: unknown }).id === this.helloReplayId
      ) {
        // Capture the gateway's bound agent for any future manifest
        // re-write (TTL refresh path uses the latest known boundAgent).
        const result = (parsed as { result?: { agent?: AgentIdentity } }).result;
        if (result?.agent !== undefined) {
          this.hostMintedClaim.boundAgent = result.agent;
        }
        this.helloReplayId = undefined;
        return;
      }
      for (const handler of this.messageHandlers) handler(parsed);
    });

    ws.on('close', (_code: number, reason: Buffer) => {
      // Release the slot so a future gateway re-dial can attempt.
      // Without this, the next upgrade hits `if (this.ws)` and is
      // rejected forever, leaving the host transport unable to
      // re-bind after a transient disconnect.
      if (this.ws === ws) {
        this.ws = undefined;
      }
      const text = reason.toString('utf-8');
      for (const handler of this.closeHandlers) handler(text);
    });
  }

  private deliverSynthesizedWelcome(sdkHelloId: unknown, helloParams: HelloParams): void {
    void helloParams; // silence unused; reserved for future capability negotiation
    const response = buildSynthesizedWelcomeResponse(this.hostMintedClaim, sdkHelloId);
    for (const handler of this.messageHandlers) handler(response);
    this.helloAnswered = true;
  }

  private replayHelloToGateway(helloParams: HelloParams): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.helloReplayId = `__tesseron-server-replay-${globalThis.crypto.randomUUID()}`;
    const replay = {
      jsonrpc: '2.0' as const,
      id: this.helloReplayId,
      method: 'tesseron/hello',
      params: helloParams,
    };
    this.ws.send(JSON.stringify(replay));
  }

  private startHeartbeat(wsUrl: string): void {
    this.heartbeatTimer = setInterval(() => {
      // Stop refreshing once the claim has been consumed — the gateway
      // already binds via subprotocol on the live channel; the manifest
      // is for discovery, and a bound instance has been discovered.
      if (this.hostMintedClaim.boundAgent !== null) {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        return;
      }
      const now = Date.now();
      this.hostMintedClaim.mintedAt = now;
      this.hostMintedClaim.expiresAt = now + HOST_MINT_TTL_MS;
      this.writeManifest(wsUrl).catch((err: Error) =>
        process.stderr.write(`[tesseron] heartbeat manifest write failed: ${err.message}\n`),
      );
    }, HEARTBEAT_INTERVAL_MS);
    // Don't keep the process alive purely for the heartbeat — it'd
    // prevent a clean exit when the app drops its other handles.
    this.heartbeatTimer.unref?.();
  }

  private async writeManifest(wsUrl: string): Promise<void> {
    this.manifestFile = join(getInstancesDir(), `${this.instanceId}.json`);
    await writePrivateFile(
      this.manifestFile,
      JSON.stringify(
        {
          version: 2,
          instanceId: this.instanceId,
          appName: this.options.appName ?? 'node',
          addedAt: Date.now(),
          // Stamp the Node app's pid so a gateway can probe liveness with
          // `process.kill(pid, 0)` and tombstone manifests whose owning
          // process died without unlinking (e.g. crashed, SIGKILLed). See
          // tesseron#53.
          pid: process.pid,
          transport: { kind: 'ws', url: wsUrl },
          helloHandledByHost: true,
          hostMintedClaim: { ...this.hostMintedClaim },
        },
        null,
        2,
      ),
    );
  }

  /** Resolves once the WS server is listening and the instance manifest has been written. */
  async ready(): Promise<void> {
    await this.opened;
  }

  send(message: unknown): void {
    // Intercept the SDK's `tesseron/hello` and synthesize a welcome
    // immediately so the SDK can show the host-minted claim code as
    // soon as it boots, without waiting for a gateway to dial. The
    // cached hello is replayed to the gateway after a v1.2 dial with
    // the bind subprotocol; the gateway's reply is discarded by id.
    // Legacy gateway dials (no bind subprotocol) are rejected by
    // {@link listen}'s upgrade handler, so the cached hello is never
    // forwarded as a stale frame.
    if (
      !this.helloAnswered &&
      typeof message === 'object' &&
      message !== null &&
      (message as { method?: unknown }).method === 'tesseron/hello'
    ) {
      const m = message as { id?: unknown; method: 'tesseron/hello'; params: HelloParams };
      // Validate the app.id BEFORE synthesizing — defends against the
      // SDK trying to claim a reserved id (e.g. 'tesseron') or a
      // malformed identifier. The legacy gateway-mints path got this
      // free from the gateway's hello handler; with the host
      // synthesizing locally we re-apply the same validation here so
      // the SDK's `connect()` promise rejects with a clear message
      // rather than appearing to succeed and breaking later.
      try {
        if (typeof m.params?.app?.id === 'string') {
          validateAppId(m.params.app.id);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const errorResponse = {
          jsonrpc: '2.0' as const,
          id: (m.id ?? null) as string | number | null,
          error: { code: -32600, message: reason },
        };
        for (const handler of this.messageHandlers) handler(errorResponse);
        this.helloAnswered = true;
        return;
      }
      this.cachedHello = { id: m.id, method: 'tesseron/hello', params: m.params };
      this.deliverSynthesizedWelcome(m.id, m.params);
      // If a v1.2 gateway has already bound (rare ordering — the SDK
      // tends to call connect() before any dial completes), replay the
      // hello straight away; otherwise wait for attachGateway.
      if (this.boundViaSubprotocol && this.ws && this.ws.readyState === 1) {
        this.replayHelloToGateway(m.params);
      }
      return;
    }
    const raw = JSON.stringify(message);
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(raw);
    } else {
      this.sendQueue.push(raw);
    }
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandlers.push(handler);
  }

  close(reason?: string): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.manifestFile && existsSync(this.manifestFile)) {
      unlink(this.manifestFile).catch(() => {});
    }
    this.ws?.close(1000, reason);
    this.wss?.close();
    this.server?.close();
  }
}
