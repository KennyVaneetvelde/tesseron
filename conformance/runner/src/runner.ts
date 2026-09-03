import { type ChildProcess, type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { EndpointConnectionController } from './connection.js';
import {
  type HostIssue,
  StepFailure,
  needsImplicitConnection,
  openImplicitConnection,
  runFixtureSteps,
} from './engine.js';
import { loadFixtures, matchesIdGlob, parseUnsupported } from './fixtures.js';
import type { Endpoint, FixtureDocument, FixtureFailure, SuiteReport } from './types.js';

const HOST_READY_TIMEOUT_MS = 5_000;
const HOST_EXIT_ALLOWANCE_MS = 500;
const STDERR_TAIL_LIMIT = 4_096;

export interface RunOptions {
  hostCommand: string;
  fixturesDirectory: string;
  only?: string;
  unsupported?: string;
}

export async function runSuite(options: RunOptions): Promise<SuiteReport> {
  const fixtures = await loadFixtures(options.fixturesDirectory);
  const selected = options.only
    ? fixtures.filter((fixture) => matchesIdGlob(fixture.id, options.only!))
    : fixtures;
  if (selected.length === 0) {
    throw new Error(`No fixtures matched ${JSON.stringify(options.only)}`);
  }
  const unsupported = parseUnsupported(options.unsupported);
  const passed: string[] = [];
  const skipped: Array<{ id: string; missing: string[] }> = [];
  const failed: FixtureFailure[] = [];

  for (const fixture of selected) {
    const missing = fixture.requires.filter((requirement) => unsupported.has(requirement));
    if (missing.length > 0) {
      skipped.push({ id: fixture.id, missing });
      continue;
    }
    const failure = await runFixture(fixture, options.hostCommand, unsupported);
    if (failure) failed.push(failure);
    else passed.push(fixture.id);
  }

  const report: SuiteReport = {
    passed,
    skipped,
    failed,
    summary: { passed: passed.length, skipped: skipped.length, failed: failed.length },
    exitCode: failed.length === 0 ? 0 : 1,
  };
  return report;
}

async function runFixture(
  fixture: FixtureDocument,
  hostCommand: string,
  unsupported: ReadonlySet<string>,
): Promise<FixtureFailure | undefined> {
  let host: LaunchedHost | undefined;
  let controller: EndpointConnectionController | undefined;
  try {
    host = await LaunchedHost.start(hostCommand, fixture);
    controller = new EndpointConnectionController(host.endpoint);
    if (needsImplicitConnection(fixture.steps)) {
      await openImplicitConnection(controller, host.issue);
    }
    await runFixtureSteps(fixture, controller, unsupported, host.issue);
    host.throwIfIssue();
    host.markCompleted();
    await controller.closeAll();
    await host.finish();
    host.throwIfIssue();
    return undefined;
  } catch (error) {
    host?.markCompleted();
    await controller?.closeAll().catch(() => {});
    await host?.finish().catch(() => {});
    if (error instanceof StepFailure) {
      return {
        id: fixture.id,
        stepIndex: Math.max(0, error.stepIndex),
        expected: error.expected,
        actual: error.actual,
      };
    }
    if (error instanceof HostLaunchFailure) {
      return { id: fixture.id, stepIndex: 0, expected: error.expected, actual: error.actual };
    }
    return {
      id: fixture.id,
      stepIndex: 0,
      expected: { fixture: 'completed without an internal runner error' },
      actual: { error: errorMessage(error) },
    };
  }
}

class HostLaunchFailure extends Error {
  constructor(
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    super('Host launch failed');
    this.name = 'HostLaunchFailure';
  }
}

/**
 * Rewrites a `--host` that is nothing but a path into its quoted absolute form.
 *
 * The host is launched through a shell, and cmd.exe ends the command token at
 * the first `/`, so `--host "build/tesseron-conformance-host"` dies as
 * `'build' is not recognized` before the host process exists. Every compiled
 * SDK names its host that way, the example in `conformance/README.md`
 * included, and an absolute path resolves on both shells.
 *
 * A command with arguments (`node dist/bin.js`) does not name a file, so it
 * falls through untouched and keeps its shell semantics.
 */
export function resolveHostCommand(
  hostCommand: string,
  workingDirectory: string = process.cwd(),
  platform: NodeJS.Platform = process.platform,
): string {
  const candidate = resolve(workingDirectory, hostCommand.trim());
  // Windows hangs the extension off the file, not the command: `cargo build`
  // writes tesseron-conformance-host.exe and the fixture author still writes
  // the name without it.
  const executable =
    existingFile(candidate) ??
    (platform === 'win32' ? existingFile(`${candidate}.exe`) : undefined);
  return executable ? `"${executable}"` : hostCommand;
}

function existingFile(candidate: string): string | undefined {
  try {
    return statSync(candidate, { throwIfNoEntry: false })?.isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

class LaunchedHost {
  readonly issue: Promise<HostIssue>;
  private issueValue?: HostIssue;
  private resolveIssue!: (issue: HostIssue) => void;
  private completed = false;
  private exited = false;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly temporaryDirectory: string,
    readonly endpoint: Endpoint,
    private readonly observer: HostProcessObserver,
  ) {
    this.issue = new Promise<HostIssue>((resolve) => {
      this.resolveIssue = resolve;
    });
  }

  static async start(hostCommand: string, fixture: FixtureDocument): Promise<LaunchedHost> {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'tesseron-conformance-'));
    if (process.platform !== 'win32') await chmod(temporaryDirectory, 0o700);
    const fixturePath = join(temporaryDirectory, 'fixture.json');
    await writeFile(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });

    const child = spawn(resolveHostCommand(hostCommand), {
      cwd: process.cwd(),
      env: { ...process.env, TESSERON_CONFORMANCE_FIXTURE: fixturePath },
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    const observer = new HostProcessObserver(child, fixture);
    try {
      const endpoint = await observer.readiness;
      const host = new LaunchedHost(child, temporaryDirectory, endpoint, observer);
      host.monitor();
      return host;
    } catch (error) {
      child.stdin.end();
      await forceKillHost(child);
      await rm(temporaryDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  markCompleted(): void {
    this.completed = true;
  }

  throwIfIssue(): void {
    if (this.issueValue) {
      throw new HostLaunchFailure(this.issueValue.expected, this.issueValue.actual);
    }
  }

  async finish(): Promise<void> {
    this.completed = true;
    if (!this.exited) {
      this.child.stdin.end();
      const exited = await waitForExit(this.child, HOST_EXIT_ALLOWANCE_MS);
      if (!exited) await forceKillHost(this.child);
    }
    await rm(this.temporaryDirectory, { recursive: true, force: true });
  }

  private monitor(): void {
    this.observer.onIssue((issue) => {
      if (issue.kind === 'exit') {
        this.exited = true;
        if (!this.completed) this.publishIssue(issue.expected, issue.actual);
        return;
      }
      this.publishIssue(issue.expected, issue.actual);
    });
  }

  private publishIssue(expected: unknown, actual: unknown): void {
    if (this.issueValue) return;
    this.issueValue = { expected, actual };
    this.resolveIssue(this.issueValue);
  }
}

interface ObservedHostIssue extends HostIssue {
  kind: 'exit' | 'stdout';
}

class HostProcessObserver {
  readonly readiness: Promise<Endpoint>;
  private stderr = '';
  private issue?: ObservedHostIssue;
  private issueHandler?: (issue: ObservedHostIssue) => void;

  constructor(child: ChildProcessWithoutNullStreams, fixture: FixtureDocument) {
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-STDERR_TAIL_LIMIT);
    });
    const stdout = createInterface({ input: child.stdout });
    this.readiness = new Promise<Endpoint>((resolve, reject) => {
      let readinessReceived = false;
      let failed = false;
      const timer = setTimeout(() => {
        fail(
          { stdout: 'one readiness line within 5000 ms' },
          { timeoutMs: HOST_READY_TIMEOUT_MS, stderr: this.stderrTail() },
        );
      }, HOST_READY_TIMEOUT_MS);
      const fail = (expected: unknown, actual: unknown): void => {
        if (failed || readinessReceived) return;
        failed = true;
        clearTimeout(timer);
        reject(new HostLaunchFailure(expected, actual));
      };
      stdout.on('line', (line) => {
        if (failed) return;
        if (readinessReceived) {
          this.publish({
            kind: 'stdout',
            expected: { stdout: 'exactly one readiness line' },
            actual: { extraStdoutLine: line, stderr: this.stderrTail() },
          });
          return;
        }
        let endpoint: Endpoint;
        try {
          endpoint = parseEndpoint(line, fixture);
        } catch (error) {
          fail({ stdout: 'a valid loopback readiness line' }, { line, error: errorMessage(error) });
          return;
        }
        readinessReceived = true;
        clearTimeout(timer);
        resolve(endpoint);
      });
      child.once('exit', (code, signal) => {
        if (!readinessReceived) {
          fail(
            { host: 'running after its readiness line' },
            { exitCode: code, signal, stderr: this.stderrTail() },
          );
          return;
        }
        this.publish({
          kind: 'exit',
          expected: { host: 'running until the fixture completes' },
          actual: { exitCode: code, signal, stderr: this.stderrTail() },
        });
      });
    });
  }

  onIssue(handler: (issue: ObservedHostIssue) => void): void {
    this.issueHandler = handler;
    if (this.issue) handler(this.issue);
  }

  private publish(issue: ObservedHostIssue): void {
    if (this.issue) return;
    this.issue = issue;
    this.issueHandler?.(issue);
  }

  private stderrTail(): string {
    return this.stderr.trim().slice(-STDERR_TAIL_LIMIT);
  }
}

function parseEndpoint(line: string, fixture: FixtureDocument): Endpoint {
  const wsPrefix = 'tesseron-conformance-url=';
  const udsPrefix = 'tesseron-conformance-uds=';
  if (line.startsWith(wsPrefix)) {
    const value = line.slice(wsPrefix.length);
    const url = new URL(value);
    if (url.protocol !== 'ws:' || !isLoopback(url.hostname)) {
      throw new Error('WebSocket readiness URL must use ws:// on loopback');
    }
    return { kind: 'ws', url: url.toString() };
  }
  if (line.startsWith(udsPrefix)) {
    const path = line.slice(udsPrefix.length);
    if (!fixture.requires.includes('uds')) {
      throw new Error('UDS readiness is valid only for a fixture requiring uds');
    }
    if (!isAbsolute(path)) throw new Error('UDS readiness path must be absolute');
    return { kind: 'uds', path };
  }
  throw new Error('Unknown readiness line');
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' || normalized === '::1' || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

async function forceKillHost(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.once('error', () => resolve());
      killer.once('exit', () => resolve());
    });
  } else if (child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill('SIGKILL');
  }
  await waitForExit(child, HOST_EXIT_ALLOWANCE_MS);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', exited);
      resolve(false);
    }, timeoutMs);
    const exited = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', exited);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
