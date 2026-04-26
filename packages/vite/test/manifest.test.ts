/**
 * Coverage for the Vite plugin's instance-manifest writer. Avoids booting a
 * full Vite dev server — the writer is exported as `writeInstanceManifest`
 * specifically so the manifest contract can be locked without one.
 *
 * Asserts the two pieces of the contract introduced for tesseron#53:
 *  - the v2 manifest carries `pid: process.pid` so a sibling gateway can
 *    tombstone the file when the Vite dev server crashes;
 *  - the manifest path is resolved lazily (after `prepareSandbox()` mutates
 *    `HOME`/`USERPROFILE`) so test sandboxes don't pollute the real
 *    `~/.tesseron/instances/`.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeInstanceManifest } from '../src/index.js';

let sandbox: string;
let previousEnv: { HOME: string | undefined; USERPROFILE: string | undefined };

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tesseron-vite-test-'));
  previousEnv = {
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
  };
  // Sandbox the home dir AFTER the module has loaded — the plugin must
  // resolve `homedir()` at call time, not at import time, for this to
  // redirect. Regression-guards the lazy `getInstancesDir()` switch.
  process.env['HOME'] = sandbox;
  process.env['USERPROFILE'] = sandbox;
});

afterAll(() => {
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

describe('writeInstanceManifest', () => {
  it('writes a v2 manifest stamped with the current process pid', async () => {
    const instanceId = 'inst-test-1';
    await writeInstanceManifest({
      instanceId,
      appName: 'pid-stamp-test',
      wsUrl: 'ws://localhost:5173/@tesseron/ws/inst-test-1',
    });

    const path = join(sandbox, '.tesseron', 'instances', `${instanceId}.json`);
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

    expect(parsed['version']).toBe(2);
    expect(parsed['instanceId']).toBe(instanceId);
    expect(parsed['appName']).toBe('pid-stamp-test');
    expect(parsed['pid']).toBe(process.pid);
    expect(parsed['transport']).toEqual({
      kind: 'ws',
      url: 'ws://localhost:5173/@tesseron/ws/inst-test-1',
    });
    expect(typeof parsed['addedAt']).toBe('number');
  });

  it('honours HOME/USERPROFILE redirection set after import (lazy resolution)', async () => {
    // Same suite-level sandbox; this test exists explicitly to fail loudly
    // if the writer ever regresses to a module-level `INSTANCES_DIR =
    // join(homedir(), …)` constant — that would write to the real home
    // dir and the assertion below would never see the file.
    const instanceId = 'inst-test-lazy';
    await writeInstanceManifest({
      instanceId,
      appName: 'lazy-test',
      wsUrl: 'ws://localhost:5173/@tesseron/ws/inst-test-lazy',
    });
    const path = join(sandbox, '.tesseron', 'instances', `${instanceId}.json`);
    expect(() => readFileSync(path, 'utf-8')).not.toThrow();
  });
});
