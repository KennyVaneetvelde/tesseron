import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ServerTesseronClient } from '@tesseron/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  McpAgentBridge,
  SamplingNotAvailableError,
  TesseronErrorCode,
  TesseronGateway,
} from '../src/index.js';
import { type Sandbox, prepareSandbox, waitForInstanceFile } from './setup.js';

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
  // Client advertises NO capabilities — mirrors a client like Claude Code that doesn't
  // implement sampling/createMessage.
  client = new Client({ name: 'no-sampling-agent', version: '0.0.0' }, { capabilities: {} });
  await client.connect(agentSide);
});

afterAll(async () => {
  await client.close().catch(() => {});
  await gateway.stop().catch(() => {});
  sandbox.cleanup();
});

async function connectSdkAndClaim(sdk: ServerTesseronClient): Promise<string> {
  const startedAt = Date.now();
  const connectPromise = sdk.connect();
  const inst = await waitForInstanceFile(sandbox, { since: startedAt - 50 });
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
  const code = welcome.claimCode;
  if (!code) throw new Error('host did not return a claim code');
  await client.request(
    {
      method: 'tools/call',
      params: { name: 'tesseron__claim_session', arguments: { code } },
    },
    CallToolResultSchema,
  );
  // Wait for the gateway's `tesseron/claimed` notification to have
  // been processed by the SDK's welcome listener so subsequent reads
  // of `getWelcome().agent` / `.capabilities` reflect the claimed
  // values rather than the synthesized pre-claim sentinel.
  await new Promise<void>((resolve) => {
    if (sdk.getWelcome()?.agent.id !== 'pending') {
      resolve();
      return;
    }
    const off = sdk.onWelcomeChange(() => {
      off();
      resolve();
    });
  });
  return code;
}

async function callTool(name: string, args: unknown): Promise<{ text: string; isError: boolean }> {
  const result = await client.request(
    {
      method: 'tools/call',
      params: { name, arguments: (args ?? {}) as Record<string, unknown> },
    },
    CallToolResultSchema,
  );
  const text = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('');
  return { text, isError: result.isError === true };
}

describe('sampling capability detection', () => {
  it('reports sampling: false to the SDK when the MCP client did not advertise the capability', async () => {
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'capapp', name: 'cap app', origin: 'http://localhost' });
    let observed: { sampling: boolean; elicitation: boolean } | undefined;
    sdk.action('probe').handler((_input, ctx) => {
      observed = {
        sampling: ctx.agentCapabilities.sampling,
        elicitation: ctx.agentCapabilities.elicitation,
      };
      return observed;
    });
    await connectSdkAndClaim(sdk);
    const welcome = sdk.getWelcome();
    expect(welcome?.capabilities.sampling).toBe(false);
    expect(welcome?.capabilities.elicitation).toBe(false);
    // Reflect the client's real identity so handlers can include it in user-facing errors.
    expect(welcome?.agent.name).toBe('no-sampling-agent');

    const result = await callTool('capapp__probe', {});
    expect(result.isError).toBe(false);
    expect(observed).toEqual({ sampling: false, elicitation: false });

    await sdk.disconnect();
  });

  it("throws SamplingNotAvailableError from ctx.sample when the client can't sample", async () => {
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'samp_nocap', name: 'samp nocap', origin: 'http://localhost' });
    let caughtError: unknown;
    sdk.action('suggest').handler(async (_input, ctx) => {
      try {
        await ctx.sample({ prompt: 'whatever' });
        return { ok: true };
      } catch (error) {
        caughtError = error;
        throw error;
      }
    });
    await connectSdkAndClaim(sdk);

    const result = await callTool('samp_nocap__suggest', {});
    expect(result.isError).toBe(true);
    // The actionable, structured error name surfaces to the caller so they can branch on it.
    expect(caughtError).toBeInstanceOf(SamplingNotAvailableError);
    expect((caughtError as SamplingNotAvailableError).code).toBe(
      TesseronErrorCode.SamplingNotAvailable,
    );
    expect((caughtError as SamplingNotAvailableError).message).toMatch(/sampling\/createMessage/);

    await sdk.disconnect();
  });

  it('lets a handler gracefully fall back when ctx.agentCapabilities.sampling is false', async () => {
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'samp_fallback', name: 'samp fallback', origin: 'http://localhost' });
    sdk.action('suggest').handler((_input, ctx) => {
      if (!ctx.agentCapabilities.sampling) {
        return { added: 0, reason: "client doesn't support sampling" };
      }
      return { added: 1 };
    });
    await connectSdkAndClaim(sdk);

    const result = await callTool('samp_fallback__suggest', {});
    expect(result.isError).toBe(false);
    expect(result.text).toContain("doesn't support sampling");

    await sdk.disconnect();
  });
});
