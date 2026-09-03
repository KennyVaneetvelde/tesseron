/**
 * Regression for tesseron#92.
 *
 * Two sessions for the same `app.id` coexist briefly in the gateway's claimed
 * map: an older live one and a newer one whose transport has died but whose
 * `onClose` handler hasn't run yet (a long-tailed WS close event under load).
 *
 * Before the fix, `latestClaimedByApp` picked the session with the newest
 * `claimedAt` unconditionally. If that was the dead one, every subsequent
 * `tools/call` from the agent forwarded `actions/invoke` to the closed
 * transport, the SDK side never replied, and the MCP tool call hung until
 * the upstream client's own timeout.
 *
 * After the fix, the selector skips any session whose
 * `transport.isClosed?.()` reports true. The live (older) session wins, the
 * invocation returns its real result, and no hang occurs.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ServerTesseronClient } from '@tesseron/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpAgentBridge, TesseronGateway } from '../src/index.js';
import { type Sandbox, dialSdk, prepareSandbox } from './setup.js';

let sandbox: Sandbox;
let gateway: TesseronGateway;
let bridge: McpAgentBridge;
let client: Client;

beforeAll(async () => {
  sandbox = prepareSandbox();
  gateway = new TesseronGateway();
  bridge = new McpAgentBridge({ gateway });
  const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
  await bridge.connect(gatewaySide);
  client = new Client({ name: 'dead-session-test', version: '0.0.0' }, { capabilities: {} });
  await client.connect(agentSide);
});

afterAll(async () => {
  await client.close().catch(() => {});
  await gateway.stop().catch(() => {});
  sandbox.cleanup();
});

async function callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const r = await client.request(
    { method: 'tools/call', params: { name, arguments: args as Record<string, unknown> } },
    CallToolResultSchema,
  );
  return {
    text: r.content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    isError: r.isError === true,
  };
}

describe('latestClaimedByApp (tesseron#92): liveness filter', () => {
  it('routes around a session whose transport reports closed even when it has the newer claimedAt', async () => {
    // SDK A is the older session. It claims first; its claimedAt is earlier
    // than B's. It stays live throughout the test.
    const sdkA = new ServerTesseronClient();
    sdkA.app({ id: 'dead_repro', name: 'Dead-session repro', origin: 'http://localhost' });
    sdkA.action('which').handler(() => ({ which: 'A_live' }));
    const welcomeA = await dialSdk(gateway, sandbox, () => sdkA.connect());
    expect((await callTool('tesseron__claim_session', { code: welcomeA.claimCode })).isError).toBe(
      false,
    );

    // SDK B is the newer session. Its claimedAt is later than A's, so before
    // the fix it would always be picked. We connect, claim, then forge a
    // dead transport on its session object — without triggering the gateway's
    // onClose handler, mirroring the long-tailed-close race described in the
    // bug report.
    const sdkB = new ServerTesseronClient();
    sdkB.app({ id: 'dead_repro', name: 'Dead-session repro', origin: 'http://localhost' });
    sdkB.action('which').handler(() => ({ which: 'B_dead' }));
    const welcomeB = await dialSdk(gateway, sandbox, () => sdkB.connect());
    expect((await callTool('tesseron__claim_session', { code: welcomeB.claimCode })).isError).toBe(
      false,
    );

    // Force a tiny gap so B's claimedAt is strictly greater than A's; the
    // dialer-side timing usually produces this on its own but the test
    // wants a deterministic order regardless of host clock resolution.
    const claimedSessions = gateway.getClaimedSessions();
    const sessionA = claimedSessions.find((s) => s.id === welcomeA.sessionId);
    const sessionB = claimedSessions.find((s) => s.id === welcomeB.sessionId);
    if (!sessionA || !sessionB) throw new Error('expected both sessions claimed');
    sessionB.claimedAt = (sessionA.claimedAt ?? 0) + 1;

    // Override the transport's liveness probe to report closed. The gateway's
    // sessions map still treats B as `claimed: true` (onClose hasn't fired),
    // exactly matching the bug-report scenario. We don't tear down the real
    // transport because that would race the onClose handler and remove B
    // from `sessions` before the test selector runs.
    sessionB.transport.isClosed = () => true;

    // Invoke action against the shared app.id. With the liveness filter in
    // place, the selector must skip B and return A's handler result. Without
    // the filter, the call would forward to B's dead-but-not-cleaned-up
    // transport and hang past any reasonable test timeout.
    const result = await Promise.race([
      callTool('tesseron__invoke_action', {
        app_id: 'dead_repro',
        action: 'which',
        args: {},
      }),
      new Promise<{ text: string; isError: boolean }>((_, rej) =>
        setTimeout(() => rej(new Error('TIMEOUT after 3s - invoke hung on dead session')), 3000),
      ),
    ]);

    expect(result.isError).toBe(false);
    expect(result.text).toContain('A_live');
    expect(result.text).not.toContain('B_dead');

    await sdkA.disconnect().catch(() => {});
    await sdkB.disconnect().catch(() => {});
  });

  it('also filters dead sessions out of resource reads', async () => {
    // Same scenario, but exercising the read path. Both paths share
    // latestClaimedByApp, so they're paired in this regression to lock
    // both surfaces.
    const sdkA = new ServerTesseronClient();
    sdkA.app({ id: 'dead_repro_r', name: 'Dead resource repro', origin: 'http://localhost' });
    sdkA.resource('which').read(() => ({ which: 'A_live' }));
    const welcomeA = await dialSdk(gateway, sandbox, () => sdkA.connect());
    expect((await callTool('tesseron__claim_session', { code: welcomeA.claimCode })).isError).toBe(
      false,
    );

    const sdkB = new ServerTesseronClient();
    sdkB.app({ id: 'dead_repro_r', name: 'Dead resource repro', origin: 'http://localhost' });
    sdkB.resource('which').read(() => ({ which: 'B_dead' }));
    const welcomeB = await dialSdk(gateway, sandbox, () => sdkB.connect());
    expect((await callTool('tesseron__claim_session', { code: welcomeB.claimCode })).isError).toBe(
      false,
    );

    const claimed = gateway.getClaimedSessions();
    const sessionA = claimed.find((s) => s.id === welcomeA.sessionId);
    const sessionB = claimed.find((s) => s.id === welcomeB.sessionId);
    if (!sessionA || !sessionB) throw new Error('expected both sessions claimed');
    sessionB.claimedAt = (sessionA.claimedAt ?? 0) + 1;
    sessionB.transport.isClosed = () => true;

    const result = await Promise.race([
      callTool('tesseron__read_resource', { app_id: 'dead_repro_r', name: 'which' }),
      new Promise<{ text: string; isError: boolean }>((_, rej) =>
        setTimeout(() => rej(new Error('TIMEOUT after 3s - read hung on dead session')), 3000),
      ),
    ]);

    expect(result.isError).toBe(false);
    expect(result.text).toContain('A_live');
    expect(result.text).not.toContain('B_dead');

    await sdkA.disconnect().catch(() => {});
    await sdkB.disconnect().catch(() => {});
  });

  it('returns no-claimed-session when ALL live candidates are dead (no silent route to a closed transport)', async () => {
    // Single-session edge: the lone session for an app is dead and there's
    // no live alternative. The bug-report scenario (B newer, A live) is the
    // common shape; this covers the case where the user only ever paired
    // one session and it died.
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'lone_dead', name: 'Lone dead repro', origin: 'http://localhost' });
    sdk.action('which').handler(() => ({ which: 'never_invoked' }));
    const welcome = await dialSdk(gateway, sandbox, () => sdk.connect());
    expect((await callTool('tesseron__claim_session', { code: welcome.claimCode })).isError).toBe(
      false,
    );

    const session = gateway.getClaimedSessions().find((s) => s.id === welcome.sessionId);
    if (!session) throw new Error('expected session claimed');
    session.transport.isClosed = () => true;

    // The error result should be the same "no claimed session" message the
    // bridge returns when no session is present at all - i.e. a clean
    // fail-fast, NOT a hang on the dead transport.
    const result = await Promise.race([
      callTool('tesseron__invoke_action', {
        app_id: 'lone_dead',
        action: 'which',
        args: {},
      }),
      new Promise<{ text: string; isError: boolean }>((_, rej) =>
        setTimeout(() => rej(new Error('TIMEOUT after 3s - lone-dead invoke hung')), 3000),
      ),
    ]);

    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toMatch(/no claimed session|not found|claim/);

    await sdk.disconnect().catch(() => {});
  });
});
