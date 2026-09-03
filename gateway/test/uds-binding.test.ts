import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ServerTesseronClient } from '@tesseron/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpAgentBridge, TesseronGateway } from '../src/index.js';
import { type Sandbox, prepareSandbox, waitForInstanceFile } from './setup.js';

/**
 * End-to-end test of the `uds` transport binding. Mirrors the WS integration
 * test but binds a Unix domain socket on the SDK side and exercises the
 * `UdsDialer` on the gateway side. Skips on Windows where the AF_UNIX
 * file-mode model differs (documented limitation).
 */

// Windows spike outcome: Node's `net.listen({ path })` on Windows binds a
// **named pipe**, not a file-system socket. Listening on a path under
// `os.tmpdir()` returns EACCES because the kernel expects `\\.\pipe\<name>`.
// The `uds` binding is therefore a Linux/macOS feature in 1.1; a separate
// `pipe` binding tracks the Windows path-translation as follow-up work.
const skipOnWindows = process.platform === 'win32';
const describeOrSkip = skipOnWindows ? describe.skip : describe;

let sandbox: Sandbox;
let gateway: TesseronGateway;
let bridge: McpAgentBridge;
let client: Client;

beforeAll(async () => {
  if (skipOnWindows) return;
  sandbox = prepareSandbox();
  gateway = new TesseronGateway();
  bridge = new McpAgentBridge({ gateway });
  const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
  await bridge.connect(gatewaySide);
  client = new Client(
    { name: 'uds-test-agent', version: '0.0.0' },
    { capabilities: { sampling: {}, elicitation: {} } },
  );
  await client.connect(agentSide);
});

afterAll(async () => {
  if (skipOnWindows) return;
  await client.close().catch(() => {});
  await gateway.stop().catch(() => {});
  sandbox.cleanup();
});

describeOrSkip('UDS binding (uds dialer + UnixSocketServerTransport)', () => {
  it('completes hello/welcome and invokes an action over a unix socket', async () => {
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'uds_app', name: 'uds app', origin: 'uds://local' });
    sdk
      .action('echo')
      .describe('Echoes the input string')
      .handler((input) => ({ echoed: (input as { value?: string } | undefined)?.value ?? '' }));

    const startedAt = Date.now();
    const connectPromise = sdk.connect({ transport: 'uds' });
    const inst = await waitForInstanceFile(sandbox, { since: startedAt - 50 });
    expect(inst.spec.kind).toBe('uds');
    if (inst.hostMintedClaim !== undefined) {
      await gateway.connectToApp(inst.instanceId, inst.spec, {
        bindCode: inst.hostMintedClaim.code,
        hostMintedSessionId: inst.hostMintedClaim.sessionId,
        hostMintedResumeToken: inst.hostMintedClaim.resumeToken,
      });
    } else {
      await gateway.connectToApp(inst.instanceId, inst.spec);
    }
    const welcome = await connectPromise;
    expect(welcome.claimCode).toBeTruthy();

    // Claim through the MCP bridge.
    const claim = await client.request(
      {
        method: 'tools/call',
        params: { name: 'tesseron__claim_session', arguments: { code: welcome.claimCode } },
      },
      CallToolResultSchema,
    );
    expect(claim.isError).not.toBe(true);

    // Confirm the action shows up on the MCP tool surface, then invoke it.
    const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
    expect(tools.tools.some((t) => t.name.endsWith('uds_app__echo'))).toBe(true);

    const callResult = await client.request(
      {
        method: 'tools/call',
        params: {
          name: tools.tools.find((t) => t.name.endsWith('uds_app__echo'))?.name ?? '',
          arguments: { value: 'hello-uds' },
        },
      },
      CallToolResultSchema,
    );
    expect(callResult.isError).not.toBe(true);
    const text = callResult.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
    expect(text).toContain('hello-uds');

    await sdk.disconnect().catch(() => {});
  });
});
