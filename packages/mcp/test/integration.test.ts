import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { ServerTesseronClient } from '@tesseron/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { McpAgentBridge, TesseronGateway } from '../src/index.js';

const PORT = 7800;
const URL = `ws://127.0.0.1:${PORT}`;

let gateway: TesseronGateway;
let bridge: McpAgentBridge;
let client: Client;
let activeSdks: ServerTesseronClient[] = [];

beforeAll(async () => {
  gateway = new TesseronGateway({ port: PORT });
  await gateway.start();
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

afterEach(async () => {
  await Promise.all(
    activeSdks.map((s) =>
      s.disconnect().catch(() => {
        /* ignore */
      }),
    ),
  );
  activeSdks = [];
  // give the gateway a beat to reap closed sessions
  await new Promise((r) => setTimeout(r, 60));
});

function newSdk(): ServerTesseronClient {
  const sdk = new ServerTesseronClient();
  activeSdks.push(sdk);
  return sdk;
}

async function listToolNames(): Promise<string[]> {
  const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
  return result.tools.map((t) => t.name);
}

interface CallOutcome {
  text: string;
  isError: boolean;
}

async function callTool(name: string, args: unknown): Promise<CallOutcome> {
  const result = await client.request(
    { method: 'tools/call', params: { name, arguments: (args ?? {}) as Record<string, unknown> } },
    CallToolResultSchema,
  );
  const text = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('');
  return { text, isError: result.isError === true };
}

async function setupAndClaim(
  appId: string,
  register: (sdk: ServerTesseronClient) => void,
): Promise<{ sdk: ServerTesseronClient; claimCode: string }> {
  const sdk = newSdk();
  sdk.app({ id: appId, name: `${appId} app`, origin: 'http://localhost' });
  register(sdk);
  const welcome = await sdk.connect(URL);
  const code = welcome.claimCode;
  expect(code, 'gateway should always issue a claim code').toBeTruthy();
  const claimResult = await callTool('tesseron__claim_session', { code: code! });
  expect(claimResult.isError, `claim with code ${code!} should succeed`).toBe(false);
  return { sdk, claimCode: code! };
}

const stringNameSchema: StandardSchemaV1<{ name: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (v) => {
      if (typeof v !== 'object' || v === null) {
        return { issues: [{ message: 'object required' }] };
      }
      const o = v as { name?: unknown };
      if (typeof o.name !== 'string') {
        return { issues: [{ message: 'name must be a string' }] };
      }
      return { value: { name: o.name } };
    },
  },
};

describe('Tesseron MCP integration', () => {
  it('exposes claim + meta-dispatcher tools before any session is claimed (default: both)', async () => {
    const tools = await listToolNames();
    expect(tools).toEqual([
      'tesseron__claim_session',
      'tesseron__list_actions',
      'tesseron__invoke_action',
      'tesseron__read_resource',
    ]);
  });

  it('completes the click-to-connect handshake and invokes a simple action', async () => {
    await setupAndClaim('shop1', (s) => {
      s.action('greet')
        .describe('greet')
        .handler(() => 'hello');
    });

    expect(await listToolNames()).toContain('shop1__greet');
    const result = await callTool('shop1__greet', {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe('hello');
  });

  it('round-trips complex nested input and output data', async () => {
    interface SearchInput {
      filter: { status: string; limit: number };
    }
    interface SearchOutput {
      items: Array<{ id: string; tags: string[]; meta: { score: number } }>;
      total: number;
    }
    await setupAndClaim('crm', (s) => {
      s.action<SearchInput, SearchOutput>('searchOrders')
        .describe('Search orders')
        .handler(({ filter }) => ({
          items: [
            { id: '1', tags: ['urgent', 'paid'], meta: { score: 0.9 } },
            { id: '2', tags: [filter.status], meta: { score: 0.5 } },
          ],
          total: 2,
        }));
    });

    const result = await callTool('crm__searchOrders', {
      filter: { status: 'open', limit: 10 },
    });
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text) as SearchOutput;
    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.tags).toContain('urgent');
    expect(parsed.items[1]?.tags).toContain('open');
    expect(parsed.total).toBe(2);
  });

  it('surfaces a validation error when input does not match the schema', async () => {
    await setupAndClaim('val1', (s) => {
      s.action<{ name: string }, string>('greet')
        .input(stringNameSchema)
        .handler(({ name }) => `hi ${name}`);
    });

    const result = await callTool('val1__greet', { name: 42 });
    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toContain('invalid input');
  });

  it('surfaces handler errors with their original message', async () => {
    await setupAndClaim('err1', (s) => {
      s.action('boom').handler(() => {
        throw new Error('something broke in the handler');
      });
    });

    const result = await callTool('err1__boom', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('something broke in the handler');
  });

  it('rejects unknown claim codes', async () => {
    const result = await callTool('tesseron__claim_session', { code: 'XXXX-XX' });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no pending session/i);
  });

  it('rejects double-claim attempts on the same code', async () => {
    const sdk = newSdk();
    sdk.app({ id: 'dbl1', name: 'dbl', origin: 'http://localhost' });
    sdk.action('a').handler(() => 'a');
    const welcome = await sdk.connect(URL);
    const code = welcome.claimCode!;

    const r1 = await callTool('tesseron__claim_session', { code });
    expect(r1.isError).toBe(false);

    const r2 = await callTool('tesseron__claim_session', { code });
    expect(r2.isError).toBe(true);
  });

  it('routes calls to the correct session by app prefix', async () => {
    await setupAndClaim('a1', (s) => {
      s.action('whoami').handler(() => 'I am a1');
    });
    await setupAndClaim('a2', (s) => {
      s.action('whoami').handler(() => 'I am a2');
    });

    const r1 = await callTool('a1__whoami', {});
    const r2 = await callTool('a2__whoami', {});
    expect(r1.text).toBe('I am a1');
    expect(r2.text).toBe('I am a2');
  });

  it("removes a session's tools when its WebSocket disconnects", async () => {
    const { sdk } = await setupAndClaim('eph1', (s) => {
      s.action('boop').handler(() => 'b');
    });

    expect(await listToolNames()).toContain('eph1__boop');

    await sdk.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    expect(await listToolNames()).not.toContain('eph1__boop');
  });

  it('rejects in-flight invocations when the session WebSocket closes mid-call', async () => {
    // Invariant: when a session socket closes mid-call, the gateway must reject
    // the pending dispatcher request, not just clear its active-invocations map.
    // Otherwise `tools/call` hangs until the MCP client's own timeout expires.
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });

    const { sdk } = await setupAndClaim('flight1', (s) => {
      s.action('hang').handler(async () => {
        await blocker;
        return 'never';
      });
    });

    try {
      const callPromise = callTool('flight1__hang', {});
      // Give the call a beat to land on the SDK side before we yank the socket.
      await new Promise((r) => setTimeout(r, 50));

      await sdk.disconnect();

      const result = await Promise.race([
        callPromise,
        new Promise<CallOutcome>((_, reject) =>
          setTimeout(() => reject(new Error('callTool hung past 2s')), 2000),
        ),
      ]);
      expect(result.isError).toBe(true);
      expect(result.text.toLowerCase()).toMatch(/transport|socket|closed|disconnect/);
    } finally {
      // Release the handler so the awaiting promise in the SDK can finalize,
      // regardless of whether the assertions above passed or the race timed out.
      release();
    }
  });

  it('issues a resumeToken in the welcome response', async () => {
    const sdk = newSdk();
    sdk.app({ id: 'tok1', name: 'tok', origin: 'http://localhost' });
    sdk.action('ping').handler(() => 'pong');
    const welcome = await sdk.connect(URL);
    expect(welcome.resumeToken).toBeTruthy();
    expect(typeof welcome.resumeToken).toBe('string');
    // base64url, 24 bytes → 32 chars, no padding
    expect(welcome.resumeToken!.length).toBe(32);
    expect(welcome.resumeToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects reserved app ids during handshake', async () => {
    const sdk = newSdk();
    sdk.app({ id: 'tesseron', name: 'evil', origin: 'http://localhost' });
    sdk.action('x').handler(() => 'x');

    await expect(sdk.connect(URL)).rejects.toThrow(/reserved/i);
  });

  it('rejects malformed app ids during handshake', async () => {
    const sdk = newSdk();
    sdk.app({ id: 'BAD-ID', name: 'bad', origin: 'http://localhost' });
    sdk.action('x').handler(() => 'x');

    await expect(sdk.connect(URL)).rejects.toThrow(/invalid app id/i);
  });

  it('passes through arbitrary input when no input schema is declared', async () => {
    await setupAndClaim('ns1', (s) => {
      s.action('echoArg').handler((input) => JSON.stringify(input));
    });

    const result = await callTool('ns1__echoArg', { x: 1, y: [2, 3], nested: { ok: true } });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ x: 1, y: [2, 3], nested: { ok: true } });
  });

  it('enforces action timeouts and surfaces a Timeout error', async () => {
    await setupAndClaim('to1', (s) => {
      s.action('slow')
        .timeout({ ms: 50 })
        .handler(async (_input, ctx) => {
          await new Promise((r) => setTimeout(r, 250));
          if (ctx.signal.aborted) {
            throw ctx.signal.reason instanceof Error ? ctx.signal.reason : new Error('aborted');
          }
          return 'done';
        });
    });

    const start = Date.now();
    const result = await callTool('to1__slow', {});
    const elapsed = Date.now() - start;

    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toMatch(/timed out|timeout/);
    // handler keeps running ~250ms even after abort fires (cooperative cancellation)
    expect(elapsed).toBeLessThan(800);
  });

  it('runs concurrent invocations on the same action independently', async () => {
    await setupAndClaim('cc1', (s) => {
      s.action<{ delayMs: number; tag: string }, string>('echoDelayed').handler(
        async ({ delayMs, tag }) => {
          await new Promise((r) => setTimeout(r, delayMs));
          return tag;
        },
      );
    });

    const [a, b, c] = await Promise.all([
      callTool('cc1__echoDelayed', { delayMs: 100, tag: 'A' }),
      callTool('cc1__echoDelayed', { delayMs: 50, tag: 'B' }),
      callTool('cc1__echoDelayed', { delayMs: 25, tag: 'C' }),
    ]);
    expect(a.text).toBe('A');
    expect(b.text).toBe('B');
    expect(c.text).toBe('C');
  });

  it('reports input schema in tools/list so agents can introspect arguments', async () => {
    await setupAndClaim('schema1', (s) => {
      s.action('greet')
        .input(stringNameSchema, {
          type: 'object',
          properties: { name: { type: 'string', description: 'the person to greet' } },
          required: ['name'],
          additionalProperties: false,
        })
        .handler(({ name }: { name: string }) => `hi ${name}`);
    });

    const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
    const greet = tools.tools.find((t) => t.name === 'schema1__greet');
    expect(greet).toBeTruthy();
    expect(greet?.inputSchema).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
  });

  it('tesseron__invoke_action dispatches to the handler of a claimed session', async () => {
    await setupAndClaim('dispatch1', (s) => {
      s.action('echo')
        .describe('echo the text back')
        .handler(({ text }: { text: string }) => ({ said: text }));
    });
    const result = await callTool('tesseron__invoke_action', {
      app_id: 'dispatch1',
      action: 'echo',
      args: { text: 'hello meta' },
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ said: 'hello meta' });
  });

  it('tesseron__list_actions enumerates claimed sessions with schemas and URIs', async () => {
    await setupAndClaim('listable', (s) => {
      s.action('ping').handler(() => 'pong');
      s.resource('stats').read(() => ({ total: 1 }));
    });
    const result = await callTool('tesseron__list_actions', {});
    expect(result.isError).toBe(false);
    const payload = JSON.parse(result.text) as {
      mcp_server_name: string;
      sessions: Array<{
        app_id: string;
        actions: Array<{ action: string; mcp_tool_name: string }>;
        resources: Array<{
          uri: string;
          name: string;
          read_via: {
            preferred: { tool: string; arguments: { app_id: string; name: string } };
            fallback: { tool: string; arguments: { server: string; uri: string } };
          };
        }>;
      }>;
    };
    expect(payload.mcp_server_name).toBe('tesseron');
    const entry = payload.sessions.find((a) => a.app_id === 'listable');
    expect(entry).toBeTruthy();
    expect(
      entry?.actions.some((a) => a.action === 'ping' && a.mcp_tool_name === 'listable__ping'),
    ).toBe(true);
    const stats = entry?.resources.find((r) => r.uri === 'tesseron://listable/stats');
    expect(stats).toBeTruthy();
    expect(stats?.read_via.preferred.tool).toBe('tesseron__read_resource');
    expect(stats?.read_via.preferred.arguments).toEqual({ app_id: 'listable', name: 'stats' });
    expect(stats?.read_via.fallback.arguments).toEqual({
      server: 'tesseron',
      uri: 'tesseron://listable/stats',
    });
  });

  it('tesseron__read_resource reads a resource without needing the client-side MCP server name', async () => {
    await setupAndClaim('res1', (s) => {
      s.resource('stats').read(() => ({ total: 42 }));
    });
    const result = await callTool('tesseron__read_resource', {
      app_id: 'res1',
      name: 'stats',
    });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ total: 42 });
  });

  it('tesseron__read_resource returns a helpful error for unknown resources', async () => {
    await setupAndClaim('res2', (s) => {
      s.resource('stats').read(() => ({ total: 0 }));
    });
    const result = await callTool('tesseron__read_resource', {
      app_id: 'res2',
      name: 'missing',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('stats');
  });
});

describe('Tool surface modes', () => {
  async function buildBridge(
    port: number,
    toolSurface: 'dynamic' | 'meta' | 'both',
  ): Promise<{
    gateway: TesseronGateway;
    client: Client;
    sdk: ServerTesseronClient;
    cleanup: () => Promise<void>;
  }> {
    const gw = new TesseronGateway({ port });
    await gw.start();
    const br = new McpAgentBridge({ gateway: gw, toolSurface });
    const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
    await br.connect(gatewaySide);
    const c = new Client({ name: 'mode-test', version: '0.0.0' });
    await c.connect(agentSide);
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'modeapp', name: 'mode test', origin: 'http://localhost' });
    sdk.action('ping').handler(() => 'pong');
    const welcome = await sdk.connect(`ws://127.0.0.1:${port}`);
    const claim = await c.request(
      {
        method: 'tools/call',
        params: { name: 'tesseron__claim_session', arguments: { code: welcome.claimCode } },
      },
      CallToolResultSchema,
    );
    expect(claim.isError).toBeFalsy();
    return {
      gateway: gw,
      client: c,
      sdk,
      cleanup: async () => {
        await sdk.disconnect().catch(() => {});
        await c.close().catch(() => {});
        await gw.stop().catch(() => {});
      },
    };
  }

  it('dynamic: advertises claim + per-app tools, no meta dispatcher', async () => {
    const { client: c, cleanup } = await buildBridge(7801, 'dynamic');
    try {
      const result = await c.request({ method: 'tools/list' }, ListToolsResultSchema);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('tesseron__claim_session');
      expect(names).toContain('modeapp__ping');
      expect(names).not.toContain('tesseron__list_actions');
      expect(names).not.toContain('tesseron__invoke_action');
      expect(names).not.toContain('tesseron__read_resource');
    } finally {
      await cleanup();
    }
  });

  it('meta: advertises claim + meta dispatcher only, no per-app tools', async () => {
    const { client: c, cleanup } = await buildBridge(7802, 'meta');
    try {
      const result = await c.request({ method: 'tools/list' }, ListToolsResultSchema);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('tesseron__claim_session');
      expect(names).toContain('tesseron__list_actions');
      expect(names).toContain('tesseron__invoke_action');
      expect(names).toContain('tesseron__read_resource');
      expect(names).not.toContain('modeapp__ping');
      // dispatcher still works even though the per-app tool isn't listed
      const dispatched = await c.request(
        {
          method: 'tools/call',
          params: {
            name: 'tesseron__invoke_action',
            arguments: { app_id: 'modeapp', action: 'ping', args: {} },
          },
        },
        CallToolResultSchema,
      );
      expect(dispatched.isError).toBeFalsy();
    } finally {
      await cleanup();
    }
  });

  it('both (default): advertises claim + meta dispatcher + per-app tools', async () => {
    const { client: c, cleanup } = await buildBridge(7803, 'both');
    try {
      const result = await c.request({ method: 'tools/list' }, ListToolsResultSchema);
      const names = result.tools.map((t) => t.name);
      expect(names).toContain('tesseron__claim_session');
      expect(names).toContain('tesseron__list_actions');
      expect(names).toContain('tesseron__invoke_action');
      expect(names).toContain('tesseron__read_resource');
      expect(names).toContain('modeapp__ping');
    } finally {
      await cleanup();
    }
  });
});
