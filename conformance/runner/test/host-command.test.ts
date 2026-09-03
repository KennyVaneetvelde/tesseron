import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveHostCommand } from '../src/runner.js';

let workingDirectory: string;

beforeAll(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), 'tesseron-host-command-'));
  await mkdir(join(workingDirectory, 'build'), { recursive: true });
  await writeFile(join(workingDirectory, 'build', 'compiled-host'), '');
  await writeFile(join(workingDirectory, 'build', 'windows-host.exe'), '');
});

afterAll(async () => {
  await rm(workingDirectory, { recursive: true, force: true });
});

describe('resolveHostCommand', () => {
  it('turns a relative forward-slash path into a quoted absolute one', () => {
    expect(resolveHostCommand('build/compiled-host', workingDirectory, 'linux')).toBe(
      `"${resolve(workingDirectory, 'build/compiled-host')}"`,
    );
  });

  it('finds the .exe Windows hangs off a name written without one', () => {
    expect(resolveHostCommand('build/windows-host', workingDirectory, 'win32')).toBe(
      `"${resolve(workingDirectory, 'build/windows-host.exe')}"`,
    );
  });

  it('leaves the .exe fallback to Windows', () => {
    expect(resolveHostCommand('build/windows-host', workingDirectory, 'linux')).toBe(
      'build/windows-host',
    );
  });

  it('leaves a command with arguments alone, because it is not a path', () => {
    expect(resolveHostCommand('node dist/bin.js', workingDirectory, 'linux')).toBe(
      'node dist/bin.js',
    );
    expect(resolveHostCommand('build/compiled-host --verbose', workingDirectory, 'linux')).toBe(
      'build/compiled-host --verbose',
    );
  });

  it('leaves a name that resolves to nothing alone', () => {
    expect(resolveHostCommand('tesseron-conformance-host', workingDirectory, 'linux')).toBe(
      'tesseron-conformance-host',
    );
  });

  it('leaves a directory alone', () => {
    expect(resolveHostCommand('build', workingDirectory, 'linux')).toBe('build');
  });

  it('quotes an absolute path so a space in it cannot split the command', () => {
    const absolute = resolve(workingDirectory, 'build/compiled-host');
    expect(resolveHostCommand(absolute, workingDirectory, 'linux')).toBe(`"${absolute}"`);
  });
});
