import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { chmod, mkdtemp, rm, unlink } from 'node:fs/promises';
import { type Server as HttpServer, createServer as createHttpServer } from 'node:http';
import { type Server as NetServer, type Socket, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import type { HelloParams, Transport } from '@tesseron/server';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { HostFixture, HostMintedClaimFixture } from './fixture.js';

const GATEWAY_PROTOCOL = 'tesseron-gateway';
const BIND_PROTOCOL_PREFIX = 'tesseron-bind.';

export class ConformanceHostEndpoint {
  private httpServer?: HttpServer;
  private webSocketServer?: WebSocketServer;
  private netServer?: NetServer;
  private socketPath?: string;
  private socketDirectory?: string;
  private connectionHandler?: (transport: Transport) => void;
  private readonly channels = new Set<WireChannel>();
  private readonly sockets = new Set<Socket>();
  private claimReserved = false;
  private claimSpent = false;

  private constructor(private readonly fixture: HostFixture) {}

  static async listen(fixture: HostFixture): Promise<ConformanceHostEndpoint> {
    const endpoint = new ConformanceHostEndpoint(fixture);
    if (fixture.requires.includes('uds')) await endpoint.listenUds();
    else await endpoint.listenWebSocket();
    return endpoint;
  }

  onConnection(handler: (transport: Transport) => void): void {
    this.connectionHandler = handler;
  }

  readinessLine(): string {
    if (this.socketPath) return `tesseron-conformance-uds=${this.socketPath}`;
    const address = this.httpServer?.address();
    if (!address || typeof address === 'string')
      throw new Error('WebSocket endpoint is not listening');
    return `tesseron-conformance-url=ws://127.0.0.1:${address.port}/`;
  }

  async close(): Promise<void> {
    for (const channel of this.channels) channel.close('conformance host shutdown');
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([
      closeServer(this.webSocketServer),
      closeServer(this.httpServer),
      closeServer(this.netServer),
    ]);
    if (this.socketPath) await unlink(this.socketPath).catch(() => {});
    if (this.socketDirectory) {
      await rm(this.socketDirectory, { recursive: true, force: true }).catch(() => {});
    }
  }

  private async listenWebSocket(): Promise<void> {
    const httpServer = createHttpServer();
    const webSocketServer = new WebSocketServer({ noServer: true });
    this.httpServer = httpServer;
    this.webSocketServer = webSocketServer;
    httpServer.on('upgrade', (request, socket, head) => {
      const protocols = parseProtocols(request.headers['sec-websocket-protocol']);
      if (!protocols.includes(GATEWAY_PROTOCOL)) {
        socket.destroy();
        return;
      }
      const claim = this.fixture.hostMintedClaim;
      if (claim) {
        const bindCodes = protocols
          .filter((protocol) => protocol.startsWith(BIND_PROTOCOL_PREFIX))
          .map((protocol) => protocol.slice(BIND_PROTOCOL_PREFIX.length));
        if (bindCodes.length === 0) {
          rejectUpgrade(socket, 426, 'Upgrade Required');
          return;
        }
        if (bindCodes.length !== 1 || !constantTimeCodeEqual(bindCodes[0]!, claim.code)) {
          rejectUpgrade(socket, 403, 'Forbidden');
          return;
        }
        if (this.claimReserved || this.claimSpent) {
          rejectUpgrade(socket, 409, 'Conflict');
          return;
        }
        this.claimReserved = true;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        this.attachChannel(new WebSocketWireChannel(webSocket));
      });
    });
    await listenHttp(httpServer);
  }

  private async listenUds(): Promise<void> {
    if (process.platform === 'win32') {
      throw new Error('UDS fixtures require TESSERON_CONFORMANCE_UNSUPPORTED=uds on Windows');
    }
    const socketDirectory = await mkdtemp(join(tmpdir(), 'tesseron-conformance-host-'));
    await chmod(socketDirectory, 0o700);
    const socketPath = join(socketDirectory, 'socket');
    this.socketDirectory = socketDirectory;
    this.socketPath = socketPath;
    const server = createNetServer((socket) => this.acceptUdsSocket(socket));
    this.netServer = server;
    await listenNet(server, socketPath);
    await chmod(socketPath, 0o600);
  }

  private acceptUdsSocket(socket: Socket): void {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    const claim = this.fixture.hostMintedClaim;
    if (!claim) {
      this.attachChannel(new NetWireChannel(socket));
      return;
    }

    socket.setEncoding('utf8');
    let buffer = '';
    const receiveBind = (chunk: string): void => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.off('data', receiveBind);
      const line = buffer.slice(0, newline);
      const remainder = buffer.slice(newline + 1);
      this.handleUdsBind(socket, line, remainder, claim);
    };
    socket.on('data', receiveBind);
  }

  private handleUdsBind(
    socket: Socket,
    line: string,
    remainder: string,
    claim: HostMintedClaimFixture,
  ): void {
    const request = parseBindRequest(line);
    if (!request || !constantTimeCodeEqual(request.code, claim.code)) {
      writeBindError(socket, request?.id ?? null, true);
      return;
    }
    if (this.claimReserved || this.claimSpent) {
      writeBindError(socket, request.id, false);
      return;
    }
    this.claimReserved = true;
    socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } })}\n`,
      () => {
        const channel = new NetWireChannel(socket);
        this.attachChannel(channel);
        if (remainder.length > 0) channel.acceptChunk(remainder);
      },
    );
  }

  private attachChannel(channel: WireChannel): void {
    this.channels.add(channel);
    channel.onClose(() => this.channels.delete(channel));
    const transport = new FixtureSocketTransport(channel, this.fixture.hostMintedClaim, () => {
      this.claimSpent = true;
    });
    const handler = this.connectionHandler;
    if (!handler) {
      channel.close('host not ready');
      return;
    }
    handler(transport);
  }
}

class FixtureSocketTransport implements Transport {
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private replayId?: string;
  private helloAnswered = false;

  constructor(
    private readonly channel: WireChannel,
    private readonly claim: HostMintedClaimFixture | undefined,
    private readonly markClaimSpent: () => void,
  ) {
    channel.onFrame((frame) => this.receive(frame));
    channel.onClose((reason) => {
      for (const handler of this.closeHandlers) handler(reason);
    });
  }

  send(message: unknown): void {
    if (this.claim && !this.helloAnswered && isHello(message)) {
      this.helloAnswered = true;
      const welcome = {
        jsonrpc: '2.0' as const,
        id: message.id,
        result: {
          sessionId: this.claim.sessionId,
          protocolVersion: '1.2.0',
          capabilities: {
            streaming: true,
            subscriptions: true,
            sampling: true,
            elicitation: true,
          },
          agent: { id: 'pending', name: 'Pending claim' },
          claimCode: this.claim.code,
          resumeToken: this.claim.resumeToken,
        },
      };
      for (const handler of this.messageHandlers) handler(welcome);
      this.replayId = `__tesseron_conformance_replay_${globalThis.crypto.randomUUID()}`;
      this.channel.send({ ...message, id: this.replayId });
      return;
    }
    this.channel.send(message);
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandlers.push(handler);
  }

  close(reason?: string): void {
    this.channel.close(reason);
  }

  isClosed(): boolean {
    return this.channel.closed;
  }

  private receive(frame: unknown): void {
    if (this.replayId !== undefined && isResponseWithId(frame, this.replayId)) {
      this.replayId = undefined;
      this.markClaimSpent();
      return;
    }
    for (const handler of this.messageHandlers) handler(frame);
  }
}

interface WireChannel {
  readonly closed: boolean;
  send(frame: unknown): void;
  onFrame(handler: (frame: unknown) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(reason?: string): void;
}

class WebSocketWireChannel implements WireChannel {
  private readonly frameHandlers: Array<(frame: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private hasClosed = false;

  constructor(private readonly webSocket: WebSocket) {
    webSocket.on('message', (data) => this.parse(rawDataToText(data)));
    webSocket.on('close', (_code, reason) => {
      this.hasClosed = true;
      for (const handler of this.closeHandlers) handler(reason.toString('utf8'));
    });
    webSocket.on('error', () => {});
  }

  get closed(): boolean {
    return this.hasClosed;
  }

  send(frame: unknown): void {
    this.webSocket.send(JSON.stringify(frame));
  }

  onFrame(handler: (frame: unknown) => void): void {
    this.frameHandlers.push(handler);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandlers.push(handler);
  }

  close(reason?: string): void {
    if (this.hasClosed) return;
    this.webSocket.close(1000, reason);
  }

  private parse(text: string): void {
    try {
      const frame: unknown = JSON.parse(text);
      for (const handler of this.frameHandlers) handler(frame);
    } catch {
      this.close('invalid JSON');
    }
  }
}

class NetWireChannel implements WireChannel {
  private readonly frameHandlers: Array<(frame: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private buffer = '';
  private hasClosed = false;

  constructor(private readonly socket: Socket) {
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.acceptChunk(chunk));
    socket.on('close', () => {
      this.hasClosed = true;
      for (const handler of this.closeHandlers) handler();
    });
    socket.on('error', () => {});
  }

  get closed(): boolean {
    return this.hasClosed;
  }

  acceptChunk(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.parse(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  send(frame: unknown): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  onFrame(handler: (frame: unknown) => void): void {
    this.frameHandlers.push(handler);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandlers.push(handler);
  }

  close(): void {
    if (this.hasClosed) return;
    this.socket.end();
    setTimeout(() => {
      if (!this.hasClosed) this.socket.destroy();
    }, 100).unref?.();
  }

  private parse(line: string): void {
    try {
      const frame: unknown = JSON.parse(line);
      for (const handler of this.frameHandlers) handler(frame);
    } catch {
      this.close();
    }
  }
}

function listenHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function listenNet(server: NetServer, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(
  server: { close(callback?: (error?: Error) => void): unknown } | undefined,
): Promise<void> {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function parseProtocols(value: string | string[] | undefined): string[] {
  const combined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return combined
    .split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean);
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  const body = reason;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
  );
}

function constantTimeCodeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  const width = Math.max(leftBytes.length, rightBytes.length, 1);
  const paddedLeft = Buffer.alloc(width);
  const paddedRight = Buffer.alloc(width);
  leftBytes.copy(paddedLeft);
  rightBytes.copy(paddedRight);
  return timingSafeEqual(paddedLeft, paddedRight) && leftBytes.length === rightBytes.length;
}

function parseBindRequest(line: string): { id: unknown; code: string } | undefined {
  try {
    const value: unknown = JSON.parse(line);
    if (
      typeof value !== 'object' ||
      value === null ||
      !('method' in value) ||
      value.method !== 'tesseron/bind' ||
      !('params' in value) ||
      typeof value.params !== 'object' ||
      value.params === null ||
      !('code' in value.params) ||
      typeof value.params.code !== 'string'
    ) {
      return undefined;
    }
    return { id: 'id' in value ? value.id : null, code: value.params.code };
  } catch {
    return undefined;
  }
}

function writeBindError(socket: Socket, id: unknown, closes: boolean): void {
  const frame = `${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32009, message: closes ? 'bind code mismatch' : 'claim already spent' },
  })}\n`;
  if (closes) socket.end(frame);
  else socket.write(frame);
}

function isHello(
  value: unknown,
): value is { id: unknown; method: 'tesseron/hello'; params: HelloParams } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'method' in value &&
    value.method === 'tesseron/hello' &&
    'id' in value &&
    'params' in value
  );
}

function isResponseWithId(value: unknown, id: string): boolean {
  return typeof value === 'object' && value !== null && 'id' in value && value.id === id;
}

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
