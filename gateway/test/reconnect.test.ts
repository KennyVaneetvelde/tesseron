import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@tesseron/core';
import { ServerTesseronClient } from '@tesseron/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpAgentBridge, TesseronGateway } from '../src/index.js';
import { type Sandbox, dialSdk, prepareSandbox } from './setup.js';

/**
 * Two interlocking guarantees, both motivated by the HMR-driven hang in
 * `tesseron__read_resource` from issue #40:
 *
 *  1. (Bridge defense in depth) When more than one claimed session shares an
 *     `app.id`, the bridge picks the most-recently-claimed one. A naive
 *     `Map`-iteration `find` returned the oldest, which after HMR was the
 *     phantom session whose transport was already gone — so the read hung.
 *
 *  2. (Root cause) Calling `client.connect()` again on the same singleton
 *     while a transport is still attached now closes the previous transport
 *     instead of orphaning it. Without this, HMR-driven re-mounts left two
 *     sockets alive on the gateway side simultaneously.
 */

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
  client = new Client({ name: 'reconnect-test', version: '0.0.0' }, { capabilities: {} });
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

describe('reconnect / HMR resilience', () => {
  it('routes resource reads to the most recently claimed session for an app.id', async () => {
    // Two SDKs, both registering the same app.id. Mirrors the HMR scenario
    // where the old socket lingers as a "claimed" session in the gateway map
    // while the user has already reclaimed via the new socket.
    const stateA = { items: [{ id: 'OLD' }] };
    const sdkA = new ServerTesseronClient();
    sdkA.app({ id: 'multi_repro', name: 'Multi Repro', origin: 'http://localhost' });
    sdkA.resource('media_library').read(() => stateA.items);

    const welcomeA = await dialSdk(gateway, sandbox, () => sdkA.connect());
    expect((await callTool('tesseron__claim_session', { code: welcomeA.claimCode })).isError).toBe(
      false,
    );

    const stateB = { items: [{ id: 'NEW' }] };
    const sdkB = new ServerTesseronClient();
    sdkB.app({ id: 'multi_repro', name: 'Multi Repro', origin: 'http://localhost' });
    sdkB.resource('media_library').read(() => stateB.items);

    const welcomeB = await dialSdk(gateway, sandbox, () => sdkB.connect());
    expect((await callTool('tesseron__claim_session', { code: welcomeB.claimCode })).isError).toBe(
      false,
    );

    const result = await Promise.race([
      callTool('tesseron__read_resource', { app_id: 'multi_repro', name: 'media_library' }),
      new Promise<{ text: string; isError: boolean }>((_, rej) =>
        setTimeout(() => rej(new Error('TIMEOUT after 3s — read_resource hung')), 3000),
      ),
    ]);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('NEW');
    expect(result.text).not.toContain('OLD');

    await sdkA.disconnect().catch(() => {});
    await sdkB.disconnect().catch(() => {});
  });

  it('routes action invocations to the most recently claimed session for an app.id', async () => {
    // Same fix; invokeAction goes through the same `find` codepath the read
    // path does. Cover both so a future regression on either is caught.
    const sdkA = new ServerTesseronClient();
    sdkA.app({ id: 'invoke_repro', name: 'Invoke Repro', origin: 'http://localhost' });
    sdkA.action('which').handler(() => ({ which: 'OLD' }));
    const welcomeA = await dialSdk(gateway, sandbox, () => sdkA.connect());
    expect((await callTool('tesseron__claim_session', { code: welcomeA.claimCode })).isError).toBe(
      false,
    );

    const sdkB = new ServerTesseronClient();
    sdkB.app({ id: 'invoke_repro', name: 'Invoke Repro', origin: 'http://localhost' });
    sdkB.action('which').handler(() => ({ which: 'NEW' }));
    const welcomeB = await dialSdk(gateway, sandbox, () => sdkB.connect());
    expect((await callTool('tesseron__claim_session', { code: welcomeB.claimCode })).isError).toBe(
      false,
    );

    const result = await Promise.race([
      callTool('tesseron__invoke_action', {
        app_id: 'invoke_repro',
        action: 'which',
        args: {},
      }),
      new Promise<{ text: string; isError: boolean }>((_, rej) =>
        setTimeout(() => rej(new Error('TIMEOUT after 3s — invoke hung')), 3000),
      ),
    ]);
    expect(result.isError).toBe(false);
    expect(result.text).toContain('NEW');

    await sdkA.disconnect().catch(() => {});
    await sdkB.disconnect().catch(() => {});
  });

  it('closes the previous transport when connect() is called again on the same client', async () => {
    // Prove the SDK-side root cause is fixed. The first transport's `close`
    // method should be invoked when the second connect() runs.
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'reconnect_root', name: 'Reconnect Root', origin: 'http://localhost' });
    sdk.action('ping').handler(() => ({ ok: true }));

    let firstClosed = false;
    const messageHandlers: Array<(m: unknown) => void> = [];
    const closeHandlers: Array<(reason?: string) => void> = [];
    const fakeTransport: Transport = {
      send() {
        // Pretend to talk to a peer; never respond, never error.
      },
      onMessage(h) {
        messageHandlers.push(h);
      },
      onClose(h) {
        closeHandlers.push(h);
      },
      close() {
        firstClosed = true;
        for (const h of closeHandlers) h('reconnected');
      },
    };

    // Attach the fake transport directly to the underlying TesseronClient
    // (skips the bind-and-announce wrapper). Don't await the welcome — the
    // fake transport never responds; we only care about the close behavior.
    const helloPromise = sdk.connect(fakeTransport).catch(() => {});

    // Now call connect again with a real bind-and-announce transport. Should
    // close the fake one.
    expect(firstClosed).toBe(false);
    const welcome = await dialSdk(gateway, sandbox, () => sdk.connect());
    expect(firstClosed).toBe(true);
    expect(welcome.sessionId).toBeTruthy();
    await helloPromise;

    await sdk.disconnect().catch(() => {});
  });
});
