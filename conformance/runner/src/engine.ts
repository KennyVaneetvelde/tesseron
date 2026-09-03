import { performance } from 'node:perf_hooks';
import { isRecord, matchJson, resolveReferences } from './matcher.js';
import type {
  ConnectExpectation,
  ConnectInstruction,
  ConnectOutcome,
  FixtureDocument,
  FixtureStep,
  ProtocolConnection,
  StepConnectionController,
} from './types.js';

const DEFAULT_STEP_TIMEOUT_MS = 2_000;
const HELLO_CAPABILITIES = ['streaming', 'subscriptions', 'sampling', 'elicitation'] as const;

export interface HostIssue {
  expected: unknown;
  actual: unknown;
}

export class StepFailure extends Error {
  constructor(
    readonly stepIndex: number,
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    super(`Step ${stepIndex} failed`);
    this.name = 'StepFailure';
  }
}

export function needsImplicitConnection(steps: FixtureStep[]): boolean {
  for (const step of steps) {
    if (step.connect) return false;
    if (
      step.recv ||
      step.send ||
      step.reconnect ||
      step.dropTransport ||
      step.expectClosed ||
      step.expectSilence
    ) {
      return true;
    }
  }
  return false;
}

export async function openImplicitConnection(
  controller: StepConnectionController,
  issue: Promise<HostIssue>,
): Promise<void> {
  const instruction = { expect: 'open' } satisfies ConnectInstruction;
  const outcome = await raceWithHostIssue(
    controller.connect(instruction, DEFAULT_STEP_TIMEOUT_MS),
    issue,
    0,
  );
  assertConnectOutcome(0, instruction.expect, outcome);
}

export async function runFixtureSteps(
  fixture: FixtureDocument,
  controller: StepConnectionController,
  unsupported: ReadonlySet<string>,
  issue: Promise<HostIssue>,
): Promise<void> {
  const captures = new Map<string, unknown>();
  const completedLabels = new Map<string, number>();

  for (const [stepIndex, step] of fixture.steps.entries()) {
    try {
      await raceWithHostIssue(
        executeStep(stepIndex, step, controller, captures, completedLabels, unsupported),
        issue,
        stepIndex,
      );
      if (step.label) completedLabels.set(step.label, performance.now());
    } catch (error) {
      if (error instanceof StepFailure) throw error;
      throw new StepFailure(stepIndex, expectedForStep(step), { error: errorMessage(error) });
    }
  }
}

async function executeStep(
  stepIndex: number,
  step: FixtureStep,
  controller: StepConnectionController,
  captures: Map<string, unknown>,
  completedLabels: ReadonlyMap<string, number>,
  unsupported: ReadonlySet<string>,
): Promise<void> {
  if (step.recv) {
    const connection = requireConnection(stepIndex, step, controller);
    const incoming = await connection.receive(step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    const result = matchJson(step.recv, incoming.value, captures);
    if (!result.matched) {
      throw new StepFailure(stepIndex, step.recv, incoming.value);
    }
    if (step.notBefore) {
      const completedAt = completedLabels.get(step.notBefore);
      if (completedAt === undefined || incoming.arrivedAt <= completedAt) {
        throw new StepFailure(
          stepIndex,
          { ...step.recv, notBefore: step.notBefore },
          incoming.value,
        );
      }
    }
    assertCapabilityDeclaration(stepIndex, incoming.value, unsupported);
    return;
  }

  if (step.send) {
    const connection = requireConnection(stepIndex, step, controller);
    connection.send(resolveReferences(step.send, captures));
    return;
  }

  if (step.connect) {
    const outcome = await controller.connect(
      step.connect,
      step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    );
    assertConnectOutcome(stepIndex, step.connect.expect, outcome);
    return;
  }

  if (step.reconnect) {
    const instruction = step.reconnect === true ? { expect: 'open' as const } : step.reconnect;
    const outcome = await controller.connect(
      instruction,
      step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    );
    assertConnectOutcome(stepIndex, instruction.expect, outcome);
    return;
  }

  if (step.dropTransport) {
    await controller.drop();
    return;
  }

  if (step.expectClosed) {
    const connection = requireConnection(stepIndex, step, controller);
    const close = await connection.waitForClose(step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS);
    if (step.expectClosed !== true) {
      if (controller.endpointKind !== 'ws') {
        throw new StepFailure(stepIndex, step.expectClosed, {
          error: 'UDS closes have no code or reason',
        });
      }
      if (step.expectClosed.code !== undefined && close.code !== step.expectClosed.code) {
        throw new StepFailure(stepIndex, step.expectClosed, close);
      }
      if (step.expectClosed.reason !== undefined && close.reason !== step.expectClosed.reason) {
        throw new StepFailure(stepIndex, step.expectClosed, close);
      }
    }
    return;
  }

  if (step.expectSilence !== undefined) {
    const connection = requireConnection(stepIndex, step, controller);
    const matchingFrame = await connection.expectNoMatch(
      step.expectSilence,
      captures,
      step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
    );
    if (matchingFrame) {
      throw new StepFailure(stepIndex, { silence: step.expectSilence }, matchingFrame.value);
    }
    return;
  }

  if (step.expectFileMode) {
    const actual = await controller.expectFileMode(step.expectFileMode);
    if (actual.actualMode !== step.expectFileMode.mode) {
      throw new StepFailure(stepIndex, step.expectFileMode, actual);
    }
    return;
  }

  throw new StepFailure(stepIndex, expectedForStep(step), { error: 'Unknown step kind' });
}

function requireConnection(
  stepIndex: number,
  step: FixtureStep,
  controller: StepConnectionController,
): ProtocolConnection {
  const connection = controller.current();
  if (!connection) {
    throw new StepFailure(stepIndex, expectedForStep(step), { error: 'No open connection' });
  }
  return connection;
}

function assertConnectOutcome(
  stepIndex: number,
  expectation: ConnectExpectation | undefined,
  outcome: ConnectOutcome,
): void {
  const expected = expectation ?? 'open';
  if (expected === 'open') {
    if (outcome.kind !== 'open') throw new StepFailure(stepIndex, expected, outcome);
    return;
  }
  if ('upgradeStatus' in expected) {
    if (outcome.kind !== 'upgrade-rejected' || outcome.status !== expected.upgradeStatus) {
      throw new StepFailure(stepIndex, expected, outcome);
    }
    return;
  }
  const closes = expected.closes ?? false;
  if (
    outcome.kind !== 'bind-rejected' ||
    outcome.code !== expected.bindErrorCode ||
    outcome.closed !== closes
  ) {
    throw new StepFailure(stepIndex, expected, outcome);
  }
}

function assertCapabilityDeclaration(
  stepIndex: number,
  frame: unknown,
  unsupported: ReadonlySet<string>,
): void {
  if (!isRecord(frame) || frame['method'] !== 'tesseron/hello') return;
  const params = frame['params'];
  const capabilities = isRecord(params) ? params['capabilities'] : undefined;
  if (!isRecord(capabilities)) {
    throw new StepFailure(stepIndex, { helloCapabilities: 'declared' }, capabilities);
  }
  for (const capability of HELLO_CAPABILITIES) {
    const expected = !unsupported.has(capability);
    if (capabilities[capability] !== expected) {
      throw new StepFailure(
        stepIndex,
        { capability, supported: expected },
        { capability, supported: capabilities[capability] },
      );
    }
  }
}

async function raceWithHostIssue<T>(
  operation: Promise<T>,
  issue: Promise<HostIssue>,
  stepIndex: number,
): Promise<T> {
  return Promise.race([
    operation,
    issue.then((hostIssue) => {
      throw new StepFailure(stepIndex, hostIssue.expected, hostIssue.actual);
    }),
  ]);
}

function expectedForStep(step: FixtureStep): unknown {
  if (step.recv) return step.recv;
  if (step.send) return step.send;
  if (step.connect) return step.connect;
  if (step.reconnect) return step.reconnect;
  if (step.dropTransport) return { dropTransport: true };
  if (step.expectClosed) return step.expectClosed;
  if (step.expectSilence !== undefined) return { silence: step.expectSilence };
  if (step.expectFileMode) return step.expectFileMode;
  return step;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
