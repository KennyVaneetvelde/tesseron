/**
 * End-to-end coverage for the server-side host-mint flow (tesseron#60
 * follow-up): a real `ServerTesseronClient` mints its own claim, the
 * gateway scans manifests on `claimSession`, dials with bind subprotocol,
 * and the SDK side observes a session born claimed.
 *
 * Distinct from `host-mint-claim.test.ts` which uses a hand-rolled fake
 * host. This test exercises the production NodeWebSocketServerTransport
 * to assert the full SDK ↔ transport ↔ gateway round-trip works against
 * the real Vite/Node host implementation.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ServerTesseronClient } from '@tesseron/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpAgentBridge, TesseronGateway } from '../src/index.js';
import { type Sandbox, prepareSandbox } from './setup.js';

let sandbox: Sandbox;
let gateway: TesseronGateway;
let bridge: McpAgentBridge;
let client: Client;
const activeSdks: ServerTesseronClient[] = [];

beforeAll(async () => {
  sandbox = prepareSandbox();
  gateway = new TesseronGateway();
  gateway.watchInstances();
  bridge = new McpAgentBridge({ gateway });
  const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
  await bridge.connect(gatewaySide);
  client = new Client({ name: 'host-mint-test', version: '0.0.0' });
  await client.connect(agentSide);
});

afterAll(async () => {
  for (const s of activeSdks) await s.disconnect().catch(() => {});
  await client.close().catch(() => {});
  await gateway.stop().catch(() => {});
  sandbox.cleanup();
});

describe('server-side host-mint flow (tesseron#60)', () => {
  it('lets a ServerTesseronClient mint locally and claim via the gateway scan path', async () => {
    const sdk = new ServerTesseronClient();
    activeSdks.push(sdk);
    sdk.app({ id: 'mintapp', name: 'mint app', origin: 'http://localhost' });
    sdk.action('echo').handler((input: unknown) => input);

    // Wait briefly for the manifest to land in the sandbox so the
    // gateway's discovery loop sees `helloHandledByHost: true` and
    // remembers the entry without auto-dialing.
    const connectPromise = sdk.connect();
    // Discovery loop polls every 2 s; give it time plus margin.
    await new Promise((r) => setTimeout(r, 2500));

    // Read the host-minted claim code out of the disk manifest. In
    // production the user pastes this into Claude; here we read it
    // directly so we can drive the MCP `tesseron__claim_session` call.
    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const instancesDir = join(sandbox.dir, '.tesseron', 'instances');
    const files = await readdir(instancesDir);
    expect(files.length).toBeGreaterThan(0);
    const manifests = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => JSON.parse(await readFile(join(instancesDir, f), 'utf-8'))),
    );
    type ManifestRow = {
      helloHandledByHost?: boolean;
      hostMintedClaim?: { code: string; sessionId: string; resumeToken: string };
    };
    const hostMint = (manifests as ManifestRow[]).find(
      (m) => m.helloHandledByHost === true && m.hostMintedClaim !== undefined,
    );
    expect(hostMint, 'manifest carries host-mint fields').toBeTruthy();
    const code = hostMint?.hostMintedClaim?.code as string;
    const expectedSessionId = hostMint?.hostMintedClaim?.sessionId as string;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{2}$/);

    // MCP client claims via the public `tesseron__claim_session` tool.
    // Race the SDK's connect promise against this — once the gateway
    // dials with bind subprotocol and the v3 hello handler fires, both
    // the bridge's tool result and the SDK's connect should resolve.
    const claimResult = await client.request(
      {
        method: 'tools/call',
        params: { name: 'tesseron__claim_session', arguments: { code } },
      },
      CallToolResultSchema,
    );
    expect(claimResult.isError, 'claim should succeed').not.toBe(true);

    const welcome = await connectPromise;
    // Critical contract: the SDK's stored sessionId must match the
    // host-minted value, not a freshly-generated gateway one.
    expect(welcome.sessionId).toBe(expectedSessionId);
    expect(welcome.claimCode).toBe(code);

    // The bridge fires `tools/list_changed` after the gateway emits
    // `sessions-changed`; give it a tick to land before listing.
    await new Promise((r) => setTimeout(r, 100));
    const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
    const toolNames = tools.tools.map((t) => t.name);
    expect(toolNames).toContain('mintapp__echo');
  });

  it('exposes expiresAt on the manifest (TTL field)', async () => {
    const sdk = new ServerTesseronClient();
    activeSdks.push(sdk);
    sdk.app({ id: 'ttlapp', name: 'ttl app', origin: 'http://localhost' });
    void sdk.connect().catch(() => {
      // disconnect during cleanup may abort the connect; ignore
    });
    await new Promise((r) => setTimeout(r, 2500));

    const { readdir, readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const instancesDir = join(sandbox.dir, '.tesseron', 'instances');
    const files = await readdir(instancesDir);
    const manifests = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map(async (f) => JSON.parse(await readFile(join(instancesDir, f), 'utf-8'))),
    );
    type ManifestRow = {
      hostMintedClaim?: { code: string; mintedAt: number; expiresAt?: number };
    };
    const ttlapp = (manifests as ManifestRow[]).find(
      (m) =>
        m.hostMintedClaim !== undefined &&
        // Identify by code that we'll mint fresh — read from any of the
        // manifests since the test isolates per-sandbox.
        typeof m.hostMintedClaim.expiresAt === 'number',
    );
    expect(ttlapp).toBeTruthy();
    const minted = ttlapp?.hostMintedClaim;
    expect(minted?.expiresAt).toBeGreaterThan(minted?.mintedAt ?? 0);
    // Default TTL is 10 min = 600_000 ms.
    expect((minted?.expiresAt ?? 0) - (minted?.mintedAt ?? 0)).toBe(600_000);
  });
});
