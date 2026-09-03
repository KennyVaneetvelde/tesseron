import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { RawData, WebSocket } from 'ws';
import { WebSocketServer } from 'ws';
import { EndpointConnectionController } from '../src/connection.js';
import { type HostIssue, StepFailure, runFixtureSteps } from '../src/engine.js';
import type {
  ConnectInstruction,
  ConnectOutcome,
  ConnectionClose,
  FileModeExpectation,
  FixtureDocument,
  IncomingFrame,
  ProtocolConnection,
  StepConnectionController,
} from '../src/types.js';

const noHostIssue = new Promise<HostIssue>(() => {});

describe('runFixtureSteps', () => {
  it('drives connect, capture, send, ordering, silence, drop, reconnect, and close', async () => {
    const host = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((resolve, reject) => {
      host.once('listening', resolve);
      host.once('error', reject);
    });
    const address = host.address();
    if (!address || typeof address === 'string') throw new Error('Fake host did not bind TCP');

    const received: unknown[] = [];
    let connectionNumber = 0;
    host.on('connection', (socket) => {
      connectionNumber += 1;
      serveConnection(socket, connectionNumber, received);
    });

    const controller = new EndpointConnectionController({
      kind: 'ws',
      url: `ws://127.0.0.1:${address.port}/`,
    });
    const fixture: FixtureDocument = {
      id: 'test/full-engine',
      title: 'Full engine flow',
      spec: '/test/',
      requires: [],
      fixture: {},
      steps: [
        { connect: { expect: 'open' } },
        {
          recv: {
            id: '~capture:firstHelloId',
            method: 'tesseron/hello',
            params: {
              capabilities: {
                streaming: true,
                subscriptions: true,
                sampling: true,
                elicitation: true,
              },
            },
          },
        },
        {
          send: { jsonrpc: '2.0', id: '~ref:firstHelloId', result: { ok: true } },
          label: 'welcomed',
        },
        { recv: { method: 'host/ready' }, notBefore: 'welcomed' },
        { expectSilence: { method: 'host/forbidden' }, timeoutMs: 20 },
        { dropTransport: true },
        { reconnect: true },
        { recv: { id: '~capture:secondHelloId', method: 'tesseron/hello' } },
        { send: { jsonrpc: '2.0', id: '~ref:secondHelloId', result: { ok: true } } },
        { expectClosed: { code: 1000, reason: 'fake host complete' } },
      ],
    };

    try {
      await runFixtureSteps(fixture, controller, new Set(), noHostIssue);
      expect(connectionNumber).toBe(2);
      expect(received).toEqual([
        { jsonrpc: '2.0', id: 'hello-1', result: { ok: true } },
        { jsonrpc: '2.0', id: 'hello-2', result: { ok: true } },
      ]);
    } finally {
      await controller.closeAll();
      for (const socket of host.clients) socket.terminate();
      await closeHost(host);
    }
  });

  it('checks bind rejection and UDS mode outcomes', async () => {
    const controller = new ResultController(
      { kind: 'bind-rejected', code: -32009, closed: false },
      '0600',
    );
    const fixture: FixtureDocument = {
      id: 'test/result-steps',
      title: 'Result-only steps',
      spec: '/test/',
      requires: ['uds'],
      fixture: {},
      steps: [
        { connect: { bindCode: 'AB3X-7K', expect: { bindErrorCode: -32009, closes: false } } },
        { expectFileMode: { target: 'socket', mode: '0600' } },
      ],
    };

    await expect(
      runFixtureSteps(fixture, controller, new Set(), noHostIssue),
    ).resolves.toBeUndefined();
    expect(controller.modeTargets).toEqual(['socket']);
  });

  it('attributes a host crash to the active step', async () => {
    const connection = new PendingConnection();
    const controller = new ResultController({ kind: 'open', connection }, '0600', connection);
    let reportIssue: (issue: HostIssue) => void = () => {};
    const hostIssue = new Promise<HostIssue>((resolve) => {
      reportIssue = resolve;
    });
    const fixture: FixtureDocument = {
      id: 'test/host-crash',
      title: 'Host crash',
      spec: '/test/',
      requires: [],
      fixture: {},
      steps: [{ connect: { expect: 'open' } }, { recv: { method: 'never-arrives' } }],
    };

    const running = runFixtureSteps(fixture, controller, new Set(), hostIssue);
    await Promise.resolve();
    reportIssue({ expected: { host: 'running' }, actual: { exitCode: 9 } });

    await expect(running).rejects.toMatchObject({
      name: StepFailure.name,
      stepIndex: 1,
      expected: { host: 'running' },
      actual: { exitCode: 9 },
    });
  });
});

function serveConnection(socket: WebSocket, connectionNumber: number, received: unknown[]): void {
  setTimeout(() => {
    socket.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: `hello-${connectionNumber}`,
        method: 'tesseron/hello',
        params: {
          capabilities: {
            streaming: true,
            subscriptions: true,
            sampling: true,
            elicitation: true,
          },
        },
      }),
    );
  }, 0);
  socket.on('message', (data) => {
    const message: unknown = JSON.parse(rawDataToText(data));
    received.push(message);
    if (connectionNumber === 1) {
      setTimeout(() => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'host/ready' })), 0);
    } else {
      socket.close(1000, 'fake host complete');
    }
  });
}

class ResultController implements StepConnectionController {
  readonly endpointKind = 'uds' as const;
  readonly modeTargets: Array<FileModeExpectation['target']> = [];

  constructor(
    private readonly outcome: ConnectOutcome,
    private readonly mode: '0600' | '0700',
    private readonly connection?: ProtocolConnection,
  ) {}

  current(): ProtocolConnection | undefined {
    return this.connection;
  }

  connect(_instruction: ConnectInstruction, _timeoutMs: number): Promise<ConnectOutcome> {
    return Promise.resolve(this.outcome);
  }

  drop(): Promise<void> {
    return Promise.resolve();
  }

  expectFileMode(expectation: FileModeExpectation): Promise<{ actualMode: string }> {
    this.modeTargets.push(expectation.target);
    return Promise.resolve({ actualMode: this.mode });
  }
}

class PendingConnection implements ProtocolConnection {
  readonly kind = 'ws' as const;
  readonly closed = false;

  send(_frame: unknown): void {}

  receive(_timeoutMs: number): Promise<IncomingFrame> {
    return new Promise(() => {});
  }

  expectNoMatch(
    _expected: unknown,
    _captures: ReadonlyMap<string, unknown>,
    _timeoutMs: number,
  ): Promise<IncomingFrame | undefined> {
    return new Promise(() => {});
  }

  waitForClose(_timeoutMs: number): Promise<ConnectionClose> {
    return new Promise(() => {});
  }

  drop(): Promise<void> {
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function closeHost(host: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    host.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function rawDataToText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}
