/**
 * Coverage for the cross-gateway discovery + claim-ownership safety net
 * shipped for tesseron#53. Two pieces:
 *
 *   1. SDK writes `pid` into its instance manifest, and the gateway
 *      tombstones manifests whose pid is gone. This stops a long-running
 *      gateway from re-dialling dead WS endpoints forever after the SDK
 *      crashed without unlinking its file.
 *
 *   2. When a gateway mints a claim code it drops a breadcrumb at
 *      `~/.tesseron/claims/<CODE>.json`. A sibling gateway (a parallel
 *      Claude Code session, a leftover dev gateway) that receives the
 *      `tesseron__claim_session` for that code now reports "claim code
 *      belongs to gateway pid N" instead of the previous opaque "no
 *      pending session". The breadcrumb is removed on successful claim,
 *      on unclaimed close, and on gateway shutdown.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  LoggingMessageNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ServerTesseronClient } from '@tesseron/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isPidAlive } from '../src/gateway.js';
import { McpAgentBridge, TesseronGateway } from '../src/index.js';
import { type Sandbox, dialSdk, prepareSandbox, waitForInstanceFile } from './setup.js';

let sandbox: Sandbox;

beforeAll(() => {
  sandbox = prepareSandbox();
});

afterAll(() => {
  sandbox.cleanup();
});

/** Pick a pid that has just exited and is almost certainly not yet recycled.
 *  Spawn a no-op child synchronously, capture its pid, let it exit. If this
 *  test ever flakes with `isPidAlive` returning true here, the OS recycled
 *  the pid between spawn and probe — possible on aggressive-pid-reuse Linux
 *  containers and short-lived Windows pids, vanishingly rare on a dev box. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
  if (child.pid === undefined) throw new Error('failed to spawn helper to harvest a dead pid');
  // spawnSync only returns once the child has exited, so child.pid is dead.
  return child.pid;
}

describe('SDK manifest carries pid + gateway tombstones dead manifests', () => {
  it('@tesseron/server writes its own pid into the v2 instance manifest', async () => {
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'pid_check', name: 'pid check', origin: 'http://localhost' });
    const startedAt = Date.now();
    const promise = sdk.connect();
    promise.catch(() => {});
    const inst = await waitForInstanceFile(sandbox, { since: startedAt });
    const file = join(sandbox.dir, '.tesseron', 'instances', `${inst.instanceId}.json`);
    const parsed = JSON.parse(await readFile(file, 'utf-8')) as { pid?: number };
    expect(parsed.pid).toBe(process.pid);
    await sdk.disconnect().catch(() => {});
  });

  it('gateway tombstones a stale manifest whose pid is dead and never dials it', async () => {
    const dir = join(sandbox.dir, '.tesseron', 'instances');
    await mkdir(dir, { recursive: true });
    const dead = deadPid();
    expect(isPidAlive(dead)).toBe(false);
    const stalePath = join(dir, 'inst-stale-1.json');
    await writeFile(
      stalePath,
      JSON.stringify({
        version: 2,
        instanceId: 'inst-stale-1',
        appName: 'ghost',
        addedAt: Date.now() - 60_000,
        pid: dead,
        // Bogus URL — we'd see a connect attempt against this if filtering
        // didn't work. Pinning to an obviously-dead host:port surfaces the
        // bug as a tested-for "didn't dial".
        transport: { kind: 'ws', url: 'ws://127.0.0.1:1/never' },
      }),
    );

    const gateway = new TesseronGateway();
    let dialedDead = false;
    const stop = gateway.watchInstances();
    const originalConnect = gateway.connectToApp.bind(gateway);
    gateway.connectToApp = (id, spec) => {
      if (spec.kind === 'ws' && spec.url.includes('1/never')) {
        dialedDead = true;
      }
      return originalConnect(id, spec);
    };

    // Give the watcher one polling tick to see the file.
    await new Promise((r) => setTimeout(r, 200));

    expect(dialedDead).toBe(false);
    expect(existsSync(stalePath)).toBe(false);

    stop();
    await gateway.stop();
  });

  it('gateway leaves manifests without a pid alone (back-compat with older SDKs)', async () => {
    const dir = join(sandbox.dir, '.tesseron', 'instances');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'inst-legacy-1.json');
    await writeFile(
      path,
      JSON.stringify({
        version: 2,
        instanceId: 'inst-legacy-1',
        appName: 'legacy',
        addedAt: Date.now(),
        // No `pid` field.
        transport: { kind: 'ws', url: 'ws://127.0.0.1:2/legacy' },
      }),
    );

    const gateway = new TesseronGateway();
    const stop = gateway.watchInstances();
    await new Promise((r) => setTimeout(r, 200));
    // File must still be there: pid-less manifests are unfiltered (a dial
    // attempt may still fail against the dead URL, but the manifest itself
    // doesn't get tombstoned without an explicit liveness signal).
    expect(existsSync(path)).toBe(true);
    stop();
    await gateway.stop();
  });
});

describe('claim record breadcrumb in ~/.tesseron/claims/', () => {
  let gateway: TesseronGateway;
  let bridge: McpAgentBridge;
  let client: Client;

  beforeAll(async () => {
    gateway = new TesseronGateway();
    bridge = new McpAgentBridge({ gateway });
    const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
    await bridge.connect(gatewaySide);
    client = new Client({ name: 'test-agent', version: '0.0.0' });
    await client.connect(agentSide);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
    await gateway.stop().catch(() => {});
  });

  function claimFile(code: string): string {
    return join(sandbox.dir, '.tesseron', 'claims', `${code.toUpperCase()}.json`);
  }

  async function callClaim(code: string): Promise<{ text: string; isError: boolean }> {
    const result = await client.request(
      { method: 'tools/call', params: { name: 'tesseron__claim_session', arguments: { code } } },
      CallToolResultSchema,
    );
    return {
      text: result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join(''),
      isError: result.isError === true,
    };
  }

  // Legacy breadcrumb mechanism is only exercised when the gateway mints
  // the claim code itself (v1.1 path). Once tesseron#60 lands, the
  // shared `dialSdk` test helper passes the host-minted bind subprotocol
  // through, which routes the gateway's hello handler down the v3
  // already-claimed path — that path doesn't write a breadcrumb because
  // the gateway scans manifests directly in `claimSession`. The
  // breadcrumb code stays in the gateway for back-compat with v1.1
  // SDKs in the wild; testing it now requires a hand-rolled legacy
  // manifest fixture (no hostMintedClaim) which the existing fixtures
  // don't model. Skipped pending a follow-up that adds a legacy SDK
  // mock; not deleted because the production code path still runs for
  // pre-2.4 SDKs.
  it.skip('writes a claim record on hello and removes it on successful claim', async () => {
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'claim_record_a', name: 'A', origin: 'http://localhost' });
    sdk.action('noop').handler(() => 'ok');
    const welcome = await dialSdk(gateway, sandbox, () => sdk.connect());
    const code = welcome.claimCode!;

    // Hello fired writeClaimRecord fire-and-forget; give the write a tick.
    await new Promise((r) => setTimeout(r, 50));

    const path = claimFile(code);
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    expect(parsed['code']).toBe(code);
    expect(parsed['gatewayPid']).toBe(process.pid);
    expect(parsed['appId']).toBe('claim_record_a');

    // Claim from the same gateway — record must disappear.
    const result = await callClaim(code);
    expect(result.isError).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(path)).toBe(false);

    await sdk.disconnect().catch(() => {});
  });

  it.skip('removes the claim record when an unclaimed session closes', async () => {
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'claim_record_b', name: 'B', origin: 'http://localhost' });
    sdk.action('noop').handler(() => 'ok');
    const welcome = await dialSdk(gateway, sandbox, () => sdk.connect());
    const code = welcome.claimCode!;
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(claimFile(code))).toBe(true);

    // Disconnect before claiming — record must clean itself up.
    await sdk.disconnect().catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(claimFile(code))).toBe(false);
  });

  it('reports a foreign-pid hint when the claim code belongs to a sibling gateway', async () => {
    // Simulate a sibling gateway by hand-writing a breadcrumb for a code we
    // don't own locally. Use this process's own pid so the liveness check
    // returns alive — `kind: 'foreign'` is what we want to assert on.
    const code = 'WXYZ-99';
    const file = claimFile(code);
    await mkdir(join(sandbox.dir, '.tesseron', 'claims'), { recursive: true });
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        code,
        sessionId: 's_other',
        appId: 'other_app',
        appName: 'Other App',
        gatewayPid: process.pid,
        mintedAt: Date.now() - 5_000,
      }),
    );

    const result = await callClaim(code);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('different Tesseron gateway');
    expect(result.text).toContain(String(process.pid));
    expect(result.text).toContain('Other App');
  });

  it('reports a stale-pid hint and tombstones the breadcrumb when the owner is gone', async () => {
    const code = 'STAL-01';
    const file = claimFile(code);
    await mkdir(join(sandbox.dir, '.tesseron', 'claims'), { recursive: true });
    const dead = deadPid();
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        code,
        sessionId: 's_stale',
        appId: 'stale_app',
        appName: 'Stale App',
        gatewayPid: dead,
        mintedAt: Date.now() - 60_000,
      }),
    );

    const result = await callClaim(code);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('no longer running');
    expect(result.text).toContain(String(dead));

    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(file)).toBe(false);
  });

  it('falls back to the original "no pending session" message when no breadcrumb exists', async () => {
    const result = await callClaim('NONE-99');
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No pending session found');
    expect(result.text).not.toContain('different Tesseron gateway');
    expect(result.text).not.toContain('no longer running');
  });
});

describe('gateway dial outcomes are forwarded as MCP logging notifications', () => {
  it('forwards dial-success and tombstone events to the connected MCP client', async () => {
    // Standalone bridge wired to a Client so we can capture
    // notifications/message frames. Uses its own gateway so the parent
    // suite's bridge isn't stealing events.
    const localGateway = new TesseronGateway();
    const localBridge = new McpAgentBridge({ gateway: localGateway });
    const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
    await localBridge.connect(gatewaySide);
    const localClient = new Client({ name: 'log-capture', version: '0.0.0' });
    const messages: Array<{ logger?: string; data: Record<string, unknown> }> = [];
    localClient.setNotificationHandler(LoggingMessageNotificationSchema, (note) => {
      const params = note.params as { logger?: string; data: Record<string, unknown> };
      messages.push({ logger: params.logger, data: params.data });
    });
    await localClient.connect(agentSide);

    // Drop a stale-pid manifest into the sandbox; the discovery loop
    // tombstones it on the next tick and emits a discovery log event.
    const dir = join(sandbox.dir, '.tesseron', 'instances');
    await mkdir(dir, { recursive: true });
    const dead = deadPid();
    await writeFile(
      join(dir, 'inst-log-test.json'),
      JSON.stringify({
        version: 2,
        instanceId: 'inst-log-test',
        appName: 'log capture',
        addedAt: Date.now(),
        pid: dead,
        transport: { kind: 'ws', url: 'ws://127.0.0.1:1/log-test' },
      }),
    );
    const stop = localGateway.watchInstances();
    await new Promise((r) => setTimeout(r, 250));

    const tombstone = messages.find(
      (m) =>
        m.logger === 'tesseron.discovery' &&
        typeof m.data['message'] === 'string' &&
        m.data['message'].includes('tombstoned stale instance manifest inst-log-test'),
    );
    expect(tombstone, 'expected an MCP logging notification for the tombstone').toBeDefined();
    expect(tombstone?.data['instanceId']).toBe('inst-log-test');
    expect(tombstone?.data['pid']).toBe(dead);

    // Now do a real successful dial via a live SDK and confirm we see the
    // 'connected to app instance' event come through too.
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'log_dial', name: 'log dial', origin: 'http://localhost' });
    sdk.action('noop').handler(() => 'ok');
    await dialSdk(localGateway, sandbox, () => sdk.connect());

    const connected = messages.find(
      (m) =>
        m.logger === 'tesseron.discovery' &&
        typeof m.data['message'] === 'string' &&
        m.data['message'].includes('connected to app instance'),
    );
    expect(connected, 'expected an MCP logging notification for the dial-success').toBeDefined();
    expect(connected?.data['transport']).toBe('ws');

    stop();
    await sdk.disconnect().catch(() => {});
    await localClient.close().catch(() => {});
    await localGateway.stop();
  });
});

describe('gateway.stop() sweeps claim records for unclaimed sessions', () => {
  it.skip('removes pending claim breadcrumbs by the time stop() resolves', async () => {
    // Use a fresh gateway (separate from the one bound in the parent suite)
    // so this test owns the lifecycle and can call stop() without
    // interfering with subsequent tests.
    const localGateway = new TesseronGateway();
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'stop_sweep', name: 'Stop Sweep', origin: 'http://localhost' });
    sdk.action('noop').handler(() => 'ok');
    const welcome = await dialSdk(localGateway, sandbox, () => sdk.connect());
    const code = welcome.claimCode!;
    const path = join(sandbox.dir, '.tesseron', 'claims', `${code.toUpperCase()}.json`);
    // The hello handler stashes the write promise on the session, so as
    // long as we let the microtask queue drain once, the file is on disk.
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(path)).toBe(true);

    // Stop the gateway. The internal sweep awaits the unlink promises, so
    // by the time stop() resolves the breadcrumb must already be gone —
    // no extra sleep needed (regression test: a `void`-fire-and-forget
    // implementation would leave the file there at this point).
    await localGateway.stop();
    expect(existsSync(path)).toBe(false);

    await sdk.disconnect().catch(() => {});
  });
});
