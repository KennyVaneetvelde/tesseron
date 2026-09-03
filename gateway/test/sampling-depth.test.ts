import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { ServerTesseronClient } from '@tesseron/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { McpAgentBridge, TesseronGateway } from '../src/index.js';
import { type Sandbox, dialSdk, prepareSandbox } from './setup.js';

let sandbox: Sandbox;
let gateway: TesseronGateway;
let bridge: McpAgentBridge;
let client: Client;
let activeSdks: ServerTesseronClient[] = [];

beforeAll(async () => {
  sandbox = prepareSandbox();
  gateway = new TesseronGateway();
  bridge = new McpAgentBridge({ gateway });
  const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
  await bridge.connect(gatewaySide);
  client = new Client(
    { name: 'sampling-depth-agent', version: '0.0.0' },
    { capabilities: { sampling: {} } },
  );
  await client.connect(agentSide);
});

afterAll(async () => {
  await client.close().catch(() => {});
  await gateway.stop().catch(() => {});
  sandbox.cleanup();
});

afterEach(async () => {
  await Promise.all(activeSdks.map((sdk) => sdk.disconnect().catch(() => {})));
  activeSdks = [];
  await new Promise((resolve) => setTimeout(resolve, 60));
});

async function setupAndClaim(
  appId: string,
  register: (sdk: ServerTesseronClient) => void,
): Promise<void> {
  const sdk = new ServerTesseronClient();
  activeSdks.push(sdk);
  sdk.app({ id: appId, name: `${appId} app`, origin: 'http://localhost' });
  register(sdk);
  const welcome = await dialSdk(gateway, sandbox, () => sdk.connect());
  await client.request(
    {
      method: 'tools/call',
      params: { name: 'tesseron__claim_session', arguments: { code: welcome.claimCode! } },
    },
    CallToolResultSchema,
  );
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
}

async function callTool(name: string): Promise<{ text: string; isError: boolean }> {
  const result = await client.request(
    { method: 'tools/call', params: { name, arguments: {} } },
    CallToolResultSchema,
  );
  return {
    text: result.content.map((content) => (content.type === 'text' ? content.text : '')).join(''),
    isError: result.isError === true,
  };
}

function deferSamplingResponses(): {
  waitForSamplingRequests: (count: number) => Promise<void>;
  resolveAll: () => void;
} {
  const pendingResponses: Array<(result: { content: string }) => void> = [];
  let waitingForRequests: { count: number; resolve: () => void } | undefined;

  gateway.setSamplingHandler(
    () =>
      new Promise<{ content: string }>((resolve) => {
        pendingResponses.push(resolve);
        if (waitingForRequests && pendingResponses.length >= waitingForRequests.count) {
          const { resolve: resolveWaiter } = waitingForRequests;
          waitingForRequests = undefined;
          resolveWaiter();
        }
      }),
  );

  return {
    waitForSamplingRequests(count) {
      if (pendingResponses.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => {
        waitingForRequests = { count, resolve };
      });
    },
    resolveAll() {
      for (const [index, resolve] of pendingResponses.entries()) {
        resolve({ content: `response-${index + 1}` });
      }
      pendingResponses.length = 0;
    },
  };
}

function samplingErrorCode(error: unknown): number | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'number'
  ) {
    return error.code;
  }
  return undefined;
}

describe('sampling depth limit', () => {
  it('allows three outstanding sampling requests for one invocation', async () => {
    const samplingResponses = deferSamplingResponses();
    await setupAndClaim('depth_three', (sdk) => {
      sdk.action('sampleThree').handler(async (_input, ctx) => {
        return (
          await Promise.all([
            ctx.sample({ prompt: 'first' }),
            ctx.sample({ prompt: 'second' }),
            ctx.sample({ prompt: 'third' }),
          ])
        ).join(',');
      });
    });

    const actionResult = callTool('depth_three__sampleThree');
    await samplingResponses.waitForSamplingRequests(3);
    samplingResponses.resolveAll();

    await expect(actionResult).resolves.toEqual({
      isError: false,
      text: 'response-1,response-2,response-3',
    });
  });

  it('rejects a fourth outstanding sampling request with SamplingDepthExceeded', async () => {
    const samplingResponses = deferSamplingResponses();
    await setupAndClaim('depth_four', (sdk) => {
      sdk.action('sampleFour').handler(async (_input, ctx) => {
        const results = await Promise.allSettled([
          ctx.sample({ prompt: 'first' }),
          ctx.sample({ prompt: 'second' }),
          ctx.sample({ prompt: 'third' }),
          ctx.sample({ prompt: 'fourth' }),
        ]);
        return results
          .map((result) =>
            result.status === 'fulfilled' ? result.value : samplingErrorCode(result.reason),
          )
          .join(',');
      });
    });

    const actionResult = callTool('depth_four__sampleFour');
    await samplingResponses.waitForSamplingRequests(3);
    samplingResponses.resolveAll();

    await expect(actionResult).resolves.toEqual({
      isError: false,
      text: 'response-1,response-2,response-3,-32008',
    });
  });

  it('does not share sampling depth between independent invocations', async () => {
    const samplingResponses = deferSamplingResponses();
    await setupAndClaim('independent_depth', (sdk) => {
      sdk.action('sampleThree').handler(async (_input, ctx) => {
        return (
          await Promise.all([
            ctx.sample({ prompt: 'first' }),
            ctx.sample({ prompt: 'second' }),
            ctx.sample({ prompt: 'third' }),
          ])
        ).join(',');
      });
      sdk.action('sampleOne').handler(async (_input, ctx) => ctx.sample({ prompt: 'fourth' }));
    });

    const threeSampleResult = callTool('independent_depth__sampleThree');
    await samplingResponses.waitForSamplingRequests(3);
    const oneSampleResult = callTool('independent_depth__sampleOne');
    await samplingResponses.waitForSamplingRequests(4);
    samplingResponses.resolveAll();

    await expect(threeSampleResult).resolves.toEqual({
      isError: false,
      text: 'response-1,response-2,response-3',
    });
    await expect(oneSampleResult).resolves.toEqual({ isError: false, text: 'response-4' });
  });
});
