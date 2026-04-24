/**
 * Shared harness for the MCP gateway tests.
 *
 * The gateway no longer binds its own WebSocket port (as it did in pre-1.0).
 * Instead, the SDK binds a loopback port and writes `~/.tesseron/tabs/<id>.json`;
 * the gateway dials IN. These helpers mirror that flow in-process, with a
 * per-suite sandbox `$HOME` so parallel vitest runs don't collide and the
 * host's real Claude Code / Claude Desktop gateway isn't a confounding dialer.
 *
 * Flow:
 *   1. `prepareSandbox()` mutates `process.env.HOME` / `USERPROFILE` — must run
 *      before any `@tesseron/server` operation that resolves the tabs dir.
 *   2. Register actions on a `ServerTesseronClient`, call `sdk.connect()` —
 *      it writes the tab file into the sandbox.
 *   3. `dialSdkIntoGateway(gateway, sandbox)` reads the newest tab file and
 *      calls `gateway.connectToApp(tabId, wsUrl)` manually (we don't use
 *      `watchAppsJson` because we want determinism — one SDK per sandbox).
 *   4. The SDK's `connect()` resolves with the welcome; the MCP client can
 *      then claim by code.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface Sandbox {
  dir: string;
  cleanup: () => void;
  previousEnv: {
    HOME: string | undefined;
    USERPROFILE: string | undefined;
    HOMEDRIVE: string | undefined;
    HOMEPATH: string | undefined;
  };
}

/**
 * Create a temp dir and point $HOME / USERPROFILE at it. Returns a cleanup
 * handle that restores the previous env and removes the dir.
 *
 * MUST be called before the first `ServerTesseronClient.connect()` in the
 * suite — because `@tesseron/server`'s transport re-reads `homedir()` lazily,
 * this works from inside `beforeAll` (as long as it runs before any connect).
 */
export function prepareSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'tesseron-test-'));
  const previousEnv = {
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
    HOMEDRIVE: process.env['HOMEDRIVE'],
    HOMEPATH: process.env['HOMEPATH'],
  };
  process.env['HOME'] = dir;
  process.env['USERPROFILE'] = dir;
  // On Windows, homedir() falls back to HOMEDRIVE+HOMEPATH when USERPROFILE
  // is unset. Clear them so USERPROFILE wins unambiguously.
  process.env['HOMEDRIVE'] = '';
  process.env['HOMEPATH'] = '';
  return {
    dir,
    previousEnv,
    cleanup: () => {
      for (const [k, v] of Object.entries(previousEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

export interface TabRecord {
  tabId: string;
  wsUrl: string;
}

/**
 * Poll the sandbox's tabs dir for a tab file written by `ServerTesseronClient.connect()`.
 * Returns the most recently written one (suites that claim multiple SDKs call this
 * once per SDK, using the `since` timestamp to dedupe).
 */
export async function waitForTabFile(
  sandbox: Sandbox,
  options: { since?: number; timeoutMs?: number } = {},
): Promise<TabRecord> {
  const since = options.since ?? 0;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const tabsDir = join(sandbox.dir, '.tesseron', 'tabs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const files = (await readdir(tabsDir)).filter((f) => f.endsWith('.json'));
      // Return the newest matching tab, not just the first. Tests that spin up
      // multiple SDKs in sequence leave a few tab files around; we need to dial
      // the one freshly created by THIS connect() call.
      let best: { tabId: string; wsUrl: string; addedAt: number } | undefined;
      for (const file of files) {
        try {
          const raw = await readFile(join(tabsDir, file), 'utf-8');
          const parsed = JSON.parse(raw) as {
            tabId: string;
            wsUrl: string;
            addedAt?: number;
          };
          const addedAt = parsed.addedAt ?? 0;
          if (addedAt >= since && (!best || addedAt > best.addedAt)) {
            best = { tabId: parsed.tabId, wsUrl: parsed.wsUrl, addedAt };
          }
        } catch {
          // file may have been deleted mid-read; keep scanning
        }
      }
      if (best) return { tabId: best.tabId, wsUrl: best.wsUrl };
    } catch {
      // dir may not exist yet
    }
    await delay(25);
  }
  throw new Error(`no new tab file appeared in ${tabsDir} within ${timeoutMs}ms`);
}

type ConnectFn<R> = () => Promise<R>;

/**
 * Kick off an SDK-side connect, wait for its tab file to appear in the sandbox,
 * and dial the gateway into it. Works for both fresh `sdk.connect()` calls and
 * resume-flavoured `sdk.connect(undefined, { resume: {...} })` calls — the
 * caller passes a nullary function that invokes connect however it wants, we
 * just sequence the dial.
 *
 * Returns the connect promise's result so assertions can check welcome fields
 * (or catch ResumeFailed errors).
 */
export async function dialSdk<R>(
  gateway: { connectToApp: (tabId: string, wsUrl: string) => Promise<void> },
  sandbox: Sandbox,
  connect: ConnectFn<R>,
): Promise<R> {
  const startedAt = Date.now();
  const promise = connect();
  // Attach a catch to suppress unhandled rejection warnings if waitForTabFile
  // throws first (e.g. resume on a dead sandbox).
  promise.catch(() => {});
  const tab = await waitForTabFile(sandbox, { since: startedAt });
  await gateway.connectToApp(tab.tabId, tab.wsUrl);
  return promise;
}
