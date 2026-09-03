export type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface FixtureDocument {
  id: string;
  title: string;
  spec: string;
  requires: string[];
  fixture: { [key: string]: unknown };
  steps: FixtureStep[];
}

export interface ConnectInstruction {
  bindCode?: string;
  expect?: ConnectExpectation;
}

export type ConnectExpectation =
  | 'open'
  | { upgradeStatus: number }
  | { bindErrorCode: number; closes?: boolean };

export interface CloseExpectation {
  code?: number;
  reason?: string;
}

export interface FileModeExpectation {
  target: 'parent' | 'socket';
  mode: '0600' | '0700';
}

export interface FixtureStep {
  recv?: { [key: string]: unknown };
  send?: { [key: string]: unknown };
  connect?: ConnectInstruction;
  reconnect?: boolean | ConnectInstruction;
  dropTransport?: true;
  expectClosed?: true | CloseExpectation;
  expectSilence?: unknown;
  expectFileMode?: FileModeExpectation;
  label?: string;
  notBefore?: string;
  timeoutMs?: number;
  note?: string;
}

export interface IncomingFrame {
  value: unknown;
  arrivedAt: number;
}

export interface ConnectionClose {
  code?: number;
  reason?: string;
}

export interface ProtocolConnection {
  readonly kind: 'uds' | 'ws';
  readonly closed: boolean;
  send(frame: unknown): void;
  receive(timeoutMs: number): Promise<IncomingFrame>;
  expectNoMatch(
    expected: unknown,
    captures: ReadonlyMap<string, unknown>,
    timeoutMs: number,
  ): Promise<IncomingFrame | undefined>;
  waitForClose(timeoutMs: number): Promise<ConnectionClose>;
  drop(): Promise<void>;
  close(): Promise<void>;
}

export type ConnectOutcome =
  | { kind: 'open'; connection: ProtocolConnection }
  | { kind: 'upgrade-rejected'; status: number }
  | {
      kind: 'bind-rejected';
      code: number;
      closed: boolean;
      connection?: ProtocolConnection;
    }
  | { kind: 'error'; message: string };

export interface StepConnectionController {
  readonly endpointKind: 'uds' | 'ws';
  current(): ProtocolConnection | undefined;
  connect(instruction: ConnectInstruction, timeoutMs: number): Promise<ConnectOutcome>;
  drop(): Promise<void>;
  expectFileMode(expectation: FileModeExpectation): Promise<{ actualMode: string }>;
}

export interface FixtureFailure {
  id: string;
  stepIndex: number;
  expected: unknown;
  actual: unknown;
}

export interface SuiteReport {
  passed: string[];
  skipped: Array<{ id: string; missing: string[] }>;
  failed: FixtureFailure[];
  summary: {
    passed: number;
    skipped: number;
    failed: number;
  };
  exitCode: 0 | 1;
}

export type Endpoint = { kind: 'ws'; url: string } | { kind: 'uds'; path: string };
