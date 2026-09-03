import { Buffer } from 'node:buffer';
import { stat } from 'node:fs/promises';
import { type Socket, createConnection } from 'node:net';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import WebSocket, { type RawData } from 'ws';
import { matchJson } from './matcher.js';
import type {
  ConnectInstruction,
  ConnectOutcome,
  ConnectionClose,
  Endpoint,
  FileModeExpectation,
  IncomingFrame,
  ProtocolConnection,
  StepConnectionController,
} from './types.js';

export class WaitTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WaitTimeoutError';
  }
}

abstract class BufferedProtocolConnection implements ProtocolConnection {
  abstract readonly kind: 'uds' | 'ws';
  private readonly frames: IncomingFrame[] = [];
  private readonly receiveWaiters: Array<{
    resolve: (frame: IncomingFrame) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private readonly frameObservers = new Set<(frame: IncomingFrame) => void>();
  private readonly closeWaiters: Array<{
    resolve: (close: ConnectionClose) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closeDetails?: ConnectionClose;

  get closed(): boolean {
    return this.closeDetails !== undefined;
  }

  abstract send(frame: unknown): void;
  abstract drop(): Promise<void>;
  abstract close(): Promise<void>;

  receive(timeoutMs: number): Promise<IncomingFrame> {
    const buffered = this.frames.shift();
    if (buffered) return Promise.resolve(buffered);
    if (this.closeDetails)
      return Promise.reject(new Error('Connection closed before a frame arrived'));

    return new Promise<IncomingFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.receiveWaiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.receiveWaiters.splice(waiterIndex, 1);
        reject(new WaitTimeoutError(`No frame arrived within ${timeoutMs} ms`));
      }, timeoutMs);
      this.receiveWaiters.push({ resolve, reject, timer });
    });
  }

  async expectNoMatch(
    expected: unknown,
    captures: ReadonlyMap<string, unknown>,
    timeoutMs: number,
  ): Promise<IncomingFrame | undefined> {
    const alreadyBuffered = this.frames.find(
      (frame) => matchJson(expected, frame.value, new Map(captures), false).matched,
    );
    if (alreadyBuffered) return alreadyBuffered;

    return new Promise<IncomingFrame | undefined>((resolve) => {
      const finish = (frame: IncomingFrame | undefined): void => {
        clearTimeout(timer);
        this.frameObservers.delete(observer);
        resolve(frame);
      };
      const observer = (frame: IncomingFrame): void => {
        if (matchJson(expected, frame.value, new Map(captures), false).matched) finish(frame);
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      this.frameObservers.add(observer);
    });
  }

  waitForClose(timeoutMs: number): Promise<ConnectionClose> {
    if (this.closeDetails) return Promise.resolve(this.closeDetails);
    return new Promise<ConnectionClose>((resolve, reject) => {
      const timer = setTimeout(() => {
        const waiterIndex = this.closeWaiters.findIndex((waiter) => waiter.timer === timer);
        if (waiterIndex >= 0) this.closeWaiters.splice(waiterIndex, 1);
        reject(new WaitTimeoutError(`Connection did not close within ${timeoutMs} ms`));
      }, timeoutMs);
      this.closeWaiters.push({
        resolve: (details) => {
          clearTimeout(timer);
          resolve(details);
        },
        timer,
      });
    });
  }

  protected pushFrame(value: unknown): void {
    const frame = { value, arrivedAt: performance.now() };
    const waiter = this.receiveWaiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.resolve(frame);
    } else {
      this.frames.push(frame);
    }
    for (const observer of this.frameObservers) observer(frame);
  }

  protected markClosed(details: ConnectionClose): void {
    if (this.closeDetails) return;
    this.closeDetails = details;
    for (const waiter of this.receiveWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Connection closed before a frame arrived'));
    }
    for (const waiter of this.closeWaiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.resolve(details);
    }
  }

  protected parseFrame(text: string): void {
    try {
      const parsed: unknown = JSON.parse(text);
      this.pushFrame(parsed);
    } catch (error) {
      this.pushFrame({ invalidJson: text, error: errorMessage(error) });
    }
  }
}

class WebSocketProtocolConnection extends BufferedProtocolConnection {
  readonly kind = 'ws' as const;

  constructor(private readonly socket: WebSocket) {
    super();
    socket.on('message', (data) => this.parseFrame(rawDataToText(data)));
    socket.on('close', (code, reason) =>
      this.markClosed({ code, reason: reason.toString('utf8') }),
    );
    socket.on('error', () => {});
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  async drop(): Promise<void> {
    if (this.closed) return;
    this.socket.close(1001, 'conformance drop');
    try {
      await this.waitForClose(2_000);
    } catch {
      this.socket.terminate();
      await this.waitForClose(500).catch(() => {});
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.socket.close(1000, 'conformance complete');
    try {
      await this.waitForClose(500);
    } catch {
      this.socket.terminate();
      await this.waitForClose(500).catch(() => {});
    }
  }
}

class UdsProtocolConnection extends BufferedProtocolConnection {
  readonly kind = 'uds' as const;
  private buffer = '';

  constructor(private readonly socket: Socket) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.readChunk(chunk));
    socket.on('close', () => this.markClosed({}));
    socket.on('error', () => {});
  }

  send(frame: unknown): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
  }

  async drop(): Promise<void> {
    if (this.closed) return;
    this.socket.destroy();
    await this.waitForClose(500).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.socket.end();
    const closed = this.waitForClose(500);
    setTimeout(() => {
      if (!this.closed) this.socket.destroy();
    }, 100).unref?.();
    await closed.catch(() => {});
  }

  private readChunk(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.parseFrame(line);
      newline = this.buffer.indexOf('\n');
    }
  }
}

export class EndpointConnectionController implements StepConnectionController {
  private activeConnection?: ProtocolConnection;
  private readonly cleanupConnections = new Set<ProtocolConnection>();
  private previousBindCode?: string;

  constructor(private readonly endpoint: Endpoint) {}

  get endpointKind(): 'uds' | 'ws' {
    return this.endpoint.kind;
  }

  current(): ProtocolConnection | undefined {
    return this.activeConnection;
  }

  async connect(instruction: ConnectInstruction, timeoutMs: number): Promise<ConnectOutcome> {
    if (this.activeConnection && !this.activeConnection.closed) {
      return { kind: 'error', message: 'A connection is already open' };
    }
    this.activeConnection = undefined;
    const bindCode = instruction.bindCode ?? this.previousBindCode;
    if (bindCode !== undefined) this.previousBindCode = bindCode;
    const effectiveInstruction =
      bindCode === undefined ? instruction : { ...instruction, bindCode };
    const outcome =
      this.endpoint.kind === 'ws'
        ? await dialWebSocket(this.endpoint.url, effectiveInstruction, timeoutMs)
        : await dialUds(this.endpoint.path, effectiveInstruction, timeoutMs);
    if (outcome.kind === 'open') {
      this.activeConnection = outcome.connection;
      this.cleanupConnections.add(outcome.connection);
    } else if (outcome.kind === 'bind-rejected' && outcome.connection) {
      this.cleanupConnections.add(outcome.connection);
    }
    return outcome;
  }

  async drop(): Promise<void> {
    const connection = this.activeConnection;
    if (!connection) throw new Error('No open connection to drop');
    await connection.drop();
    this.activeConnection = undefined;
  }

  async expectFileMode(expectation: FileModeExpectation): Promise<{ actualMode: string }> {
    if (this.endpoint.kind !== 'uds') throw new Error('File mode checks require a UDS endpoint');
    const target =
      expectation.target === 'socket' ? this.endpoint.path : dirname(this.endpoint.path);
    const file = await stat(target);
    return { actualMode: (file.mode & 0o777).toString(8).padStart(4, '0') };
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.cleanupConnections].map((connection) => connection.close()));
    this.activeConnection = undefined;
    this.cleanupConnections.clear();
  }
}

async function dialWebSocket(
  url: string,
  instruction: ConnectInstruction,
  timeoutMs: number,
): Promise<ConnectOutcome> {
  const protocols = ['tesseron-gateway'];
  if (instruction.bindCode) protocols.push(`tesseron-bind.${instruction.bindCode}`);

  return new Promise<ConnectOutcome>((resolve) => {
    const socket = new WebSocket(url, protocols, { handshakeTimeout: timeoutMs });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.terminate();
      resolve({ kind: 'error', message: `WebSocket did not open within ${timeoutMs} ms` });
    }, timeoutMs);
    const finish = (outcome: ConnectOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off('open', opened);
      socket.off('unexpected-response', rejected);
      socket.off('error', failed);
      resolve(outcome);
    };
    const opened = (): void =>
      finish({ kind: 'open', connection: new WebSocketProtocolConnection(socket) });
    const rejected = (
      _request: import('node:http').ClientRequest,
      response: import('node:http').IncomingMessage,
    ): void => {
      const status = response.statusCode ?? 0;
      response.resume();
      finish({ kind: 'upgrade-rejected', status });
    };
    const failed = (error: Error): void => finish({ kind: 'error', message: error.message });
    socket.once('open', opened);
    socket.once('unexpected-response', rejected);
    socket.once('error', failed);
  });
}

async function dialUds(
  path: string,
  instruction: ConnectInstruction,
  timeoutMs: number,
): Promise<ConnectOutcome> {
  const socket = createConnection(path);
  const opened = await waitForSocketOpen(socket, timeoutMs);
  if (!opened.ok) return { kind: 'error', message: opened.message };
  const connection = new UdsProtocolConnection(socket);
  if (!instruction.bindCode) return { kind: 'open', connection };

  connection.send({
    jsonrpc: '2.0',
    id: '__tesseron_conformance_bind__',
    method: 'tesseron/bind',
    params: { code: instruction.bindCode },
  });
  let response: IncomingFrame;
  try {
    response = await connection.receive(timeoutMs);
  } catch (error) {
    await connection.close();
    return { kind: 'error', message: errorMessage(error) };
  }
  const result = response.value;
  if (isSuccessfulBind(result)) return { kind: 'open', connection };
  const errorCode = bindErrorCode(result);
  if (errorCode === undefined) {
    await connection.close();
    return { kind: 'error', message: `Unexpected UDS bind response: ${JSON.stringify(result)}` };
  }

  const shouldClose =
    typeof instruction.expect === 'object' && 'bindErrorCode' in instruction.expect
      ? (instruction.expect.closes ?? false)
      : false;
  let closed = connection.closed;
  if (shouldClose && !closed) {
    try {
      await connection.waitForClose(Math.min(timeoutMs, 500));
      closed = true;
    } catch {
      closed = false;
    }
  } else if (!shouldClose && !closed) {
    try {
      await connection.waitForClose(100);
      closed = true;
    } catch {
      closed = false;
    }
  }
  return { kind: 'bind-rejected', code: errorCode, closed, connection };
}

function waitForSocketOpen(
  socket: Socket,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      resolve({ ok: false, message: `UDS did not open within ${timeoutMs} ms` });
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', connected);
      socket.off('error', failed);
    };
    const connected = (): void => {
      cleanup();
      resolve({ ok: true });
    };
    const failed = (error: Error): void => {
      cleanup();
      resolve({ ok: false, message: error.message });
    };
    socket.once('connect', connected);
    socket.once('error', failed);
  });
}

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function isSuccessfulBind(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'result' in value &&
    typeof value.result === 'object' &&
    value.result !== null &&
    'ok' in value.result &&
    value.result.ok === true
  );
}

function bindErrorCode(value: unknown): number | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('error' in value) ||
    typeof value.error !== 'object' ||
    value.error === null ||
    !('code' in value.error) ||
    typeof value.error.code !== 'number'
  ) {
    return undefined;
  }
  return value.error.code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
