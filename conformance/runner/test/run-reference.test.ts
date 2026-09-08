import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let workingDirectory: string;
let launcherPath: string;

beforeAll(async () => {
  workingDirectory = await mkdtemp(join(tmpdir(), 'tesseron-reference-launcher-'));
  launcherPath = join(workingDirectory, 'conformance/run-reference.mjs');
  await mkdir(join(workingDirectory, 'conformance/runner/dist'), { recursive: true });
  await copyFile(new URL('../../run-reference.mjs', import.meta.url), launcherPath);
  await writeFile(
    join(workingDirectory, 'conformance/runner/dist/tesseron-conformance.cjs'),
    `process.stdout.write(JSON.stringify({
  arguments: process.argv.slice(2),
  unsupported: process.env.TESSERON_CONFORMANCE_UNSUPPORTED,
  directory: process.cwd(),
}));
process.exitCode = 7;
`,
  );
});

afterAll(async () => {
  await rm(workingDirectory, { recursive: true, force: true });
});

describe('hub conformance launcher', () => {
  it.each([
    { hostArguments: [] },
    { hostArguments: ['--host', ''] },
    { hostArguments: ['--host', '   '] },
  ])('rejects a missing or blank explicit host: %j', ({ hostArguments }) => {
    const result = spawnSync(process.execPath, [launcherPath, ...hostArguments], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--host is required');
    expect(result.stdout).toBe('');
  });

  it('rejects --host without a value', () => {
    const result = spawnSync(process.execPath, [launcherPath, '--host'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--host needs a value');
    expect(result.stdout).toBe('');
  });

  it('forwards an explicit host, live fixtures, options, unsupported tags, and runner exit status', () => {
    const hostCommand = 'node "C:/SDK checkout/conformance-host.js"';
    const result = spawnSync(
      process.execPath,
      [
        launcherPath,
        '--host',
        hostCommand,
        '--unsupported',
        'host-minted-claim,uds',
        '--only',
        'actions/*',
        '--json',
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: { ...process.env, TESSERON_CONFORMANCE_UNSUPPORTED: 'sampling' },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(7);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      JSON.stringify({
        arguments: [
          '--host',
          hostCommand,
          '--fixtures',
          join(workingDirectory, 'conformance/fixtures'),
          '--only',
          'actions/*',
          '--json',
        ],
        unsupported: 'host-minted-claim,uds',
        directory: workingDirectory,
      }),
    );
  });
});
