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
import { readFile, readdir } from 'node:fs/promises';
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

export interface InstanceRecord {
  instanceId: string;
  spec: { kind: 'ws'; url: string } | { kind: 'uds'; path: string };
  /** Present when the host wrote a v1.2 `helloHandledByHost` manifest. */
  hostMintedClaim?: {
    code: string;
    sessionId: string;
    resumeToken: string;
  };
}

/**
 * Poll the sandbox's instances dir for a v2 manifest written by `ServerTesseronClient.connect()`.
 * Falls back to the legacy `tabs/` dir for older SDK builds in transition.
 * Returns the most recently written one (suites that claim multiple SDKs call this
 * once per SDK, using the `since` timestamp to dedupe).
 */
export async function waitForInstanceFile(
  sandbox: Sandbox,
  options: { since?: number; timeoutMs?: number } = {},
): Promise<InstanceRecord> {
  const since = options.since ?? 0;
  const timeoutMs = options.timeoutMs ?? 4_000;
  const instancesDir = join(sandbox.dir, '.tesseron', 'instances');
  const tabsDir = join(sandbox.dir, '.tesseron', 'tabs');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let best:
      | {
          instanceId: string;
          spec: InstanceRecord['spec'];
          addedAt: number;
          hostMintedClaim?: InstanceRecord['hostMintedClaim'];
        }
      | undefined;
    // v2 manifests
    try {
      const files = (await readdir(instancesDir)).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = await readFile(join(instancesDir, file), 'utf-8');
          const parsed = JSON.parse(raw) as {
            version?: number;
            instanceId?: string;
            transport?: InstanceRecord['spec'];
            addedAt?: number;
            helloHandledByHost?: boolean;
            hostMintedClaim?: {
              code: string;
              sessionId: string;
              resumeToken: string;
            };
          };
          if (parsed.version !== 2 || !parsed.instanceId || !parsed.transport) continue;
          const addedAt = parsed.addedAt ?? 0;
          if (addedAt >= since && (!best || addedAt > best.addedAt)) {
            best = {
              instanceId: parsed.instanceId,
              spec: parsed.transport,
              addedAt,
              hostMintedClaim:
                parsed.helloHandledByHost === true && parsed.hostMintedClaim !== undefined
                  ? parsed.hostMintedClaim
                  : undefined,
            };
          }
        } catch {
          // race with deletion; skip
        }
      }
    } catch {
      // dir may not exist yet
    }
    // v1 fallback: tabs/<id>.json with `wsUrl`
    try {
      const files = (await readdir(tabsDir)).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        try {
          const raw = await readFile(join(tabsDir, file), 'utf-8');
          const parsed = JSON.parse(raw) as {
            tabId?: string;
            wsUrl?: string;
            addedAt?: number;
          };
          if (!parsed.tabId || !parsed.wsUrl) continue;
          const addedAt = parsed.addedAt ?? 0;
          if (addedAt >= since && (!best || addedAt > best.addedAt)) {
            best = {
              instanceId: parsed.tabId,
              spec: { kind: 'ws', url: parsed.wsUrl },
              addedAt,
            };
          }
        } catch {
          // race with deletion; skip
        }
      }
    } catch {
      // dir may not exist yet
    }
    if (best)
      return {
        instanceId: best.instanceId,
        spec: best.spec,
        ...(best.hostMintedClaim ? { hostMintedClaim: best.hostMintedClaim } : {}),
      };
    await delay(25);
  }
  throw new Error(
    `no new instance manifest appeared in ${instancesDir} (or legacy ${tabsDir}) within ${timeoutMs}ms`,
  );
}

type ConnectFn<R> = () => Promise<R>;

/**
 * Kick off an SDK-side connect, wait for its instance manifest to appear in
 * the sandbox, and dial the gateway into it. Works for both fresh
 * `sdk.connect()` calls and resume-flavoured `sdk.connect(undefined, { resume:
 * {...} })` calls — the caller passes a nullary function that invokes connect
 * however it wants, we just sequence the dial.
 *
 * Returns the connect promise's result so assertions can check welcome fields
 * (or catch ResumeFailed errors).
 */
export async function dialSdk<R>(
  gateway: {
    connectToApp: (
      instanceId: string,
      spec: InstanceRecord['spec'],
      options?: {
        bindCode?: string;
        hostMintedSessionId?: string;
        hostMintedResumeToken?: string;
      },
    ) => Promise<void>;
  },
  sandbox: Sandbox,
  connect: ConnectFn<R>,
): Promise<R> {
  const startedAt = Date.now();
  const promise = connect();
  promise.catch(() => {});
  const inst = await waitForInstanceFile(sandbox, { since: startedAt });
  // When the host wrote a v1.2 `helloHandledByHost` manifest, dial with
  // the bind subprotocol that authenticates the v3 path. The host has
  // already minted the claim code and the gateway must reuse the
  // host-side ids so the SDK's stored sessionId/resumeToken line up.
  // Hosts that wrote a legacy v1.1 manifest fall through to the
  // bind-less dial; the gateway's hello handler mints fresh in that
  // path.
  if (inst.hostMintedClaim !== undefined) {
    await gateway.connectToApp(inst.instanceId, inst.spec, {
      bindCode: inst.hostMintedClaim.code,
      hostMintedSessionId: inst.hostMintedClaim.sessionId,
      hostMintedResumeToken: inst.hostMintedClaim.resumeToken,
    });
  } else {
    await gateway.connectToApp(inst.instanceId, inst.spec);
  }
  return promise;
}
