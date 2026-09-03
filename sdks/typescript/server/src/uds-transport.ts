import { existsSync } from 'node:fs';
import { chmod, mkdtemp, rm, unlink } from 'node:fs/promises';
import { type Server, type Socket, createServer } from 'node:net';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentIdentity, HelloParams, Transport } from '@tesseron/core';
import { TesseronErrorCode } from '@tesseron/core';
import { constantTimeEqual } from '@tesseron/core/internal';
import {
  BindRateLimiter,
  buildSynthesizedWelcomeResponse,
  isHelloFrame,
  mintClaimCode,
  mintResumeToken,
  mintSessionId,
  writePrivateFile,
} from '@tesseron/core/node';

const isWindows = platform() === 'win32';
const HOST_MINT_TTL_MS = 10 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;

function getInstancesDir(): string {
  return join(homedir(), '.tesseron', 'instances');
}

function generateInstanceId(): string {
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

export interface UnixSocketServerTransportOptions {
  /** App name written to the instance manifest. Defaults to `'node'`. */
  appName?: string;
  /**
   * Override the socket path. If omitted, the transport creates a 0700 dir
   * under `os.tmpdir()` and binds `<dir>/sock` inside it — the dir mode is the
   * access control (kernel rejects `connect()` from any UID other than the
   * owner on Linux/macOS).
   */
  path?: string;
}

/**
 * Host-side UDS transport with the v3 host-mint claim flow (tesseron#60).
 *
 * Mints `claimCode` / `sessionId` / `resumeToken` at construction; writes
 * them into the manifest's `hostMintedClaim`; intercepts the SDK's
 * `tesseron/hello` and synthesizes a welcome locally. When the gateway
 * dials and sends `tesseron/bind { code }` as the first NDJSON frame,
 * this transport validates against its in-memory mint constant-time and
 * either accepts (proceeding with the v3 hello-replay) or rejects with
 * an `Unauthorized` error and closes. v1.1 gateways that don't send a
 * bind frame take the legacy queue-drain path; the gateway mints its
 * own claim code in that path.
 *
 * **Access control.** The kernel's same-UID enforcement on the socket
 * inode (mode 0600 in a 0700 directory) is the first gate; the bind
 * handshake is the second. Same two-gate model as the WS path.
 */
export class UnixSocketServerTransport implements Transport {
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private readonly opened: Promise<void>;
  private readonly instanceId: string;
  private readonly options: UnixSocketServerTransportOptions;
  private readonly hostMintedClaim: HostMintedClaim;
  private server?: Server;
  private socket?: Socket;
  private socketPath?: string;
  private tempDir?: string;
  private manifestFile?: string;
  private readonly sendQueue: string[] = [];
  private buffer = '';
  private boundViaHandshake = false;
  private cachedHello?: { id: unknown; params: HelloParams };
  private helloAnswered = false;
  private helloReplayId?: string;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private readonly bindLimiter = new BindRateLimiter();

  constructor(options: UnixSocketServerTransportOptions = {}) {
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
    const socketPath = await this.resolveSocketPath();
    this.socketPath = socketPath;

    const server = createServer((socket) => this.attachGateway(socket));
    this.server = server;

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });

    if (!isWindows) {
      try {
        await chmod(socketPath, 0o600);
      } catch {
        // best effort — tempdir mode 0700 is the primary access gate
      }
    }

    await this.writeManifest(socketPath);
    this.startHeartbeat(socketPath);
  }

  private async resolveSocketPath(): Promise<string> {
    if (this.options.path) {
      if (existsSync(this.options.path)) {
        try {
          await unlink(this.options.path);
        } catch {
          // bind will fail noisily if this was important
        }
      }
      return this.options.path;
    }
    const dir = await mkdtemp(join(tmpdir(), 'tesseron-'));
    this.tempDir = dir;
    if (!isWindows) {
      try {
        await chmod(dir, 0o700);
      } catch {
        // tmpdir is rare to fail chmod; if it does we still bind below
      }
    }
    return join(dir, 'sock');
  }

  private attachGateway(socket: Socket): void {
    if (this.socket) {
      socket.end();
      socket.destroy();
      return;
    }
    this.socket = socket;
    socket.setEncoding('utf-8');

    socket.on('data', (chunk: string) => this.onData(chunk));
    socket.on('close', () => {
      // Pre-bind close (bind mismatch, rate-limit lockout, legacy
      // auto-dial reject) → release the slot so a fresh gateway dial
      // can attempt without permanently disabling the host transport.
      // The SDK's close handlers only fire for a *bound* channel
      // dropping — a failed bind attempt is ephemeral and not a
      // transport-level close from the SDK's perspective.
      const wasOurSocket = this.socket === socket;
      const wasBound = this.boundViaHandshake;
      if (wasOurSocket && !wasBound) {
        this.socket = undefined;
        this.buffer = '';
        return;
      }
      if (wasOurSocket) {
        this.socket = undefined;
      }
      for (const handler of this.closeHandlers) handler();
    });
    socket.on('error', () => {
      // 'close' fires after 'error'; let onClose drive teardown
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf('\n');
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          idx = this.buffer.indexOf('\n');
          continue;
        }
        this.routeFrame(parsed);
      }
      idx = this.buffer.indexOf('\n');
    }
  }

  /**
   * Route an inbound frame from the gateway. The first frame may be a
   * `tesseron/bind` request — this transport handles it specially:
   * validates the code constant-time, responds, sets the bound flag,
   * and (on success) synthesizes a welcome to the SDK + replays the
   * cached hello to the gateway.
   *
   * Drops the gateway's reply to the replayed hello (id-matched) so the
   * SDK doesn't see a second welcome. All other frames forward to the
   * registered messageHandlers.
   */
  private routeFrame(parsed: unknown): void {
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { method?: unknown }).method === 'tesseron/bind'
    ) {
      this.handleBindRequest(
        parsed as { id: string | number | null; method: string; params: { code: string } },
      );
      return;
    }
    if (
      this.boundViaHandshake &&
      this.helloReplayId !== undefined &&
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as { id?: unknown }).id === this.helloReplayId
    ) {
      const result = (parsed as { result?: { agent?: AgentIdentity } }).result;
      if (result?.agent !== undefined) {
        this.hostMintedClaim.boundAgent = result.agent;
      }
      this.helloReplayId = undefined;
      return;
    }
    if (!this.boundViaHandshake) {
      // Symmetric to the WS server transport's HTTP 426 rejection of
      // legacy auto-dials: a v1.1 gateway that connected to this UDS
      // and skipped `tesseron/bind` is incompatible. Without this
      // rejection the channel would silently consume the SDK's
      // post-welcome traffic without ever bridging to the gateway,
      // and the dial would hang. Surface a clear error and close.
      process.stderr.write(
        `[tesseron] rejecting legacy UDS auto-dial for instance ${this.instanceId}: gateway must speak v1.2 (send tesseron/bind as the first frame). Upgrade @tesseron/mcp to >= 2.4.0.\n`,
      );
      const reqId =
        typeof parsed === 'object' && parsed !== null && 'id' in parsed
          ? (((parsed as { id?: unknown }).id as string | number | null) ?? null)
          : null;
      this.respondBindError(
        reqId,
        TesseronErrorCode.InvalidRequest,
        'requires v1.2 gateway (tesseron/bind first)',
      );
      this.socket?.end();
      this.socket?.destroy();
      return;
    }
    for (const handler of this.messageHandlers) handler(parsed);
  }

  private handleBindRequest(req: {
    id: string | number | null;
    method: string;
    params: { code: string };
  }): void {
    const now = Date.now();
    if (this.bindLimiter.isLockedOut(now)) {
      this.respondBindError(req.id, TesseronErrorCode.Unauthorized, 'rate-limit lockout');
      this.socket?.end();
      this.socket?.destroy();
      return;
    }
    if (this.boundViaHandshake) {
      this.respondBindError(req.id, TesseronErrorCode.Unauthorized, 'already bound');
      return;
    }
    if (this.hostMintedClaim.boundAgent !== null) {
      this.respondBindError(req.id, TesseronErrorCode.Unauthorized, 'claim already spent');
      return;
    }
    if (typeof req.params?.code !== 'string') {
      this.respondBindError(
        req.id,
        TesseronErrorCode.InvalidParams,
        'bind requires `code` string param',
      );
      return;
    }
    if (!constantTimeEqual(req.params.code.toUpperCase(), this.hostMintedClaim.code)) {
      this.bindLimiter.recordFailure(now, this.instanceId);
      this.respondBindError(req.id, TesseronErrorCode.Unauthorized, 'bind code mismatch');
      this.socket?.end();
      this.socket?.destroy();
      return;
    }
    this.bindLimiter.reset();
    this.boundViaHandshake = true;
    // Respond first so the gateway's dial promise resolves before any
    // hello-replay traffic.
    const ok = `${JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: { ok: true },
    })}\n`;
    try {
      this.socket?.write(ok);
    } catch (err) {
      process.stderr.write(
        `[tesseron] UDS bind ack write failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      return;
    }
    // SDK hello already received a synthesized welcome via send();
    // replay just the hello to the gateway here. If the SDK hasn't
    // sent hello yet, send() will fire the replay when it does.
    if (this.cachedHello !== undefined) {
      this.replayHelloToGateway(this.cachedHello.params);
    }
    // Drain any non-hello queued frames to the gateway (post-bind).
    for (const raw of this.sendQueue) {
      if (!isHelloFrame(raw)) {
        try {
          this.socket?.write(`${raw}\n`);
        } catch {
          // best-effort drain
        }
      }
    }
    this.sendQueue.length = 0;
  }

  private respondBindError(id: string | number | null, code: number, message: string): void {
    const frame = `${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    })}\n`;
    try {
      this.socket?.write(frame);
    } catch {
      // socket already in trouble; close handler will clean up
    }
  }

  private deliverSynthesizedWelcome(sdkHelloId: unknown, helloParams: HelloParams): void {
    void helloParams; // silence unused; reserved for future capability negotiation
    const response = buildSynthesizedWelcomeResponse(this.hostMintedClaim, sdkHelloId);
    for (const handler of this.messageHandlers) handler(response);
    this.helloAnswered = true;
  }

  private replayHelloToGateway(helloParams: HelloParams): void {
    if (!this.socket || this.socket.destroyed) return;
    this.helloReplayId = `__tesseron-uds-replay-${globalThis.crypto.randomUUID()}`;
    const replay = `${JSON.stringify({
      jsonrpc: '2.0' as const,
      id: this.helloReplayId,
      method: 'tesseron/hello',
      params: helloParams,
    })}\n`;
    this.socket.write(replay);
  }

  private startHeartbeat(socketPath: string): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.hostMintedClaim.boundAgent !== null) {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
        return;
      }
      const now = Date.now();
      this.hostMintedClaim.mintedAt = now;
      this.hostMintedClaim.expiresAt = now + HOST_MINT_TTL_MS;
      this.writeManifest(socketPath).catch((err: Error) =>
        process.stderr.write(`[tesseron] UDS heartbeat manifest write failed: ${err.message}\n`),
      );
    }, HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
  }

  private async writeManifest(socketPath: string): Promise<void> {
    this.manifestFile = join(getInstancesDir(), `${this.instanceId}.json`);
    await writePrivateFile(
      this.manifestFile,
      JSON.stringify(
        {
          version: 2,
          instanceId: this.instanceId,
          appName: this.options.appName ?? 'node',
          addedAt: Date.now(),
          pid: process.pid,
          transport: { kind: 'uds', path: socketPath },
          helloHandledByHost: true,
          hostMintedClaim: { ...this.hostMintedClaim },
        },
        null,
        2,
      ),
    );
  }

  async ready(): Promise<void> {
    await this.opened;
  }

  send(message: unknown): void {
    // Synthesize the welcome immediately on SDK hello so the SDK can
    // surface the host-minted claim code without waiting for a gateway.
    // If a gateway has already completed the bind handshake, replay
    // the hello straight away; otherwise the bind handler does the
    // replay when it succeeds.
    if (
      !this.helloAnswered &&
      typeof message === 'object' &&
      message !== null &&
      (message as { method?: unknown }).method === 'tesseron/hello'
    ) {
      const m = message as { id?: unknown; method: 'tesseron/hello'; params: HelloParams };
      this.cachedHello = { id: m.id, params: m.params };
      this.deliverSynthesizedWelcome(m.id, m.params);
      if (this.boundViaHandshake && this.socket && !this.socket.destroyed) {
        this.replayHelloToGateway(m.params);
      }
      return;
    }
    const raw = JSON.stringify(message);
    if (this.socket && !this.socket.destroyed) {
      this.socket.write(`${raw}\n`);
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

  close(_reason?: string): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.manifestFile && existsSync(this.manifestFile)) {
      unlink(this.manifestFile).catch(() => {});
    }
    this.socket?.end();
    this.socket?.destroy();
    this.server?.close();
    if (this.socketPath && existsSync(this.socketPath)) {
      unlink(this.socketPath).catch(() => {});
    }
    if (this.tempDir) {
      rm(this.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
