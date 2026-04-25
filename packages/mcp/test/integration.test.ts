import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { TesseronError, TesseronErrorCode, type TesseronStructuredError } from '@tesseron/core';
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
  client = new Client({ name: 'test-agent', version: '0.0.0' });
  await client.connect(agentSide);
});

afterAll(async () => {
  await client.close().catch(() => {});
  await gateway.stop().catch(() => {});
  sandbox.cleanup();
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

async function connectSdk(
  sdk: ServerTesseronClient,
  options?: Parameters<ServerTesseronClient['connect']>[1],
): Promise<Awaited<ReturnType<ServerTesseronClient['connect']>>> {
  return dialSdk(gateway, sandbox, () => sdk.connect(undefined, options));
}

async function listToolNames(): Promise<string[]> {
  const result = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
  return result.tools.map((t) => t.name);
}

interface CallOutcome {
  text: string;
  isError: boolean;
  structuredContent?: TesseronStructuredError;
}

async function callTool(name: string, args: unknown): Promise<CallOutcome> {
  const result = await client.request(
    { method: 'tools/call', params: { name, arguments: (args ?? {}) as Record<string, unknown> } },
    CallToolResultSchema,
  );
  const text = result.content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('');
  return {
    text,
    isError: result.isError === true,
    // The MCP SDK types this as an opaque Record; our gateway only emits
    // TesseronStructuredError-shaped payloads, so the cast enables typed
    // access to .code and .data in assertions.
    structuredContent: result.structuredContent as TesseronStructuredError | undefined,
  };
}

async function setupAndClaim(
  appId: string,
  register: (sdk: ServerTesseronClient) => void,
): Promise<{ sdk: ServerTesseronClient; claimCode: string }> {
  const sdk = newSdk();
  sdk.app({ id: appId, name: `${appId} app`, origin: 'http://localhost' });
  register(sdk);
  const welcome = await connectSdk(sdk);
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
    expect(result.structuredContent?.code).toBe(TesseronErrorCode.InputValidation);
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
    // Plain handler throws become InternalError via the dispatcher's
    // toErrorPayload fallback. HandlerError is reserved for SDK-internal
    // schema failures (sampling result, elicitation content, strict output).
    expect(result.structuredContent?.code).toBe(TesseronErrorCode.InternalError);
  });

  it('propagates TesseronError.data into structuredContent', async () => {
    // Guards the conditional `.data` spread in errorResult: .code alone would
    // pass even if a refactor silently dropped the data branch.
    const issues = [{ message: 'name required', path: ['name'] }];
    await setupAndClaim('propagate1', (s) => {
      s.action('boom').handler(() => {
        throw new TesseronError(TesseronErrorCode.InputValidation, 'bad input', issues);
      });
    });

    const result = await callTool('propagate1__boom', {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe(TesseronErrorCode.InputValidation);
    expect(result.structuredContent?.data).toEqual(issues);
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
    const welcome = await connectSdk(sdk);
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
    const welcome = await connectSdk(sdk);
    expect(welcome.resumeToken).toBeTruthy();
    expect(typeof welcome.resumeToken).toBe('string');
    // base64url, 24 bytes → 32 chars, no padding
    expect(welcome.resumeToken!.length).toBe(32);
    expect(welcome.resumeToken).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('resumes a claimed session on a fresh SDK instance', async () => {
    // First SDK: open + claim.
    const sdk1 = newSdk();
    sdk1.app({ id: 'rsm1', name: 'rsm1', origin: 'http://localhost' });
    sdk1.action('greet').handler(() => 'hi-before');
    const welcome1 = await connectSdk(sdk1);
    await callTool('tesseron__claim_session', { code: welcome1.claimCode! });
    expect(await listToolNames()).toContain('rsm1__greet');

    // Simulate tab refresh: drop the socket.
    await sdk1.disconnect();
    await new Promise((r) => setTimeout(r, 100));
    expect(await listToolNames()).not.toContain('rsm1__greet');

    // Fresh SDK, same app, resume with the stashed credentials.
    const sdk2 = newSdk();
    sdk2.app({ id: 'rsm1', name: 'rsm1', origin: 'http://localhost' });
    sdk2.action('greet').handler(() => 'hi-after');
    const welcome2 = await connectSdk(sdk2, {
      resume: {
        sessionId: welcome1.sessionId,
        resumeToken: welcome1.resumeToken!,
      },
    });

    expect(welcome2.sessionId).toBe(welcome1.sessionId);
    expect(welcome2.resumeToken).toBeTruthy();
    // Token rotates on every successful resume (one-shot).
    expect(welcome2.resumeToken).not.toBe(welcome1.resumeToken);
    // Already claimed, no new claim code issued.
    expect(welcome2.claimCode).toBeUndefined();

    // Give the bridge a beat to re-advertise.
    await new Promise((r) => setTimeout(r, 50));
    expect(await listToolNames()).toContain('rsm1__greet');

    // Handler from the fresh SDK is the one that runs.
    const result = await callTool('rsm1__greet', {});
    expect(result.text).toBe('hi-after');
  });

  it('rejects resume with a bad token', async () => {
    const sdk1 = newSdk();
    sdk1.app({ id: 'rsm2', name: 'rsm2', origin: 'http://localhost' });
    sdk1.action('greet').handler(() => 'hi');
    const welcome1 = await connectSdk(sdk1);
    await callTool('tesseron__claim_session', { code: welcome1.claimCode! });
    await sdk1.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const sdk2 = newSdk();
    sdk2.app({ id: 'rsm2', name: 'rsm2', origin: 'http://localhost' });
    sdk2.action('greet').handler(() => 'hi');
    await expect(
      connectSdk(sdk2, {
        resume: {
          sessionId: welcome1.sessionId,
          resumeToken: '0000000000000000000000000000000x', // 32 chars, wrong value
        },
      }),
    ).rejects.toThrow(/invalid resumetoken/i);
  });

  it('rejects resume with an unknown session id', async () => {
    const sdk = newSdk();
    sdk.app({ id: 'unk1', name: 'unk1', origin: 'http://localhost' });
    sdk.action('x').handler(() => 'x');
    await expect(
      connectSdk(sdk, {
        resume: {
          sessionId: 's_does_not_exist',
          resumeToken: '00000000000000000000000000000000',
        },
      }),
    ).rejects.toThrow(/no resumable session/i);
  });

  it('rejects resume of an unclaimed zombie (caller should fall back to hello)', async () => {
    const sdk1 = newSdk();
    sdk1.app({ id: 'unc1', name: 'unc1', origin: 'http://localhost' });
    sdk1.action('x').handler(() => 'x');
    const welcome1 = await connectSdk(sdk1);
    // Deliberately don't claim.
    await sdk1.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const sdk2 = newSdk();
    sdk2.app({ id: 'unc1', name: 'unc1', origin: 'http://localhost' });
    sdk2.action('x').handler(() => 'x');
    await expect(
      connectSdk(sdk2, {
        resume: {
          sessionId: welcome1.sessionId,
          resumeToken: welcome1.resumeToken!,
        },
      }),
    ).rejects.toThrow(/never claimed/i);
  });

  it('rotates the resumeToken so the previous one no longer works', async () => {
    const sdk1 = newSdk();
    sdk1.app({ id: 'rot1', name: 'rot1', origin: 'http://localhost' });
    sdk1.action('x').handler(() => 'x');
    const welcome1 = await connectSdk(sdk1);
    await callTool('tesseron__claim_session', { code: welcome1.claimCode! });
    await sdk1.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const sdk2 = newSdk();
    sdk2.app({ id: 'rot1', name: 'rot1', origin: 'http://localhost' });
    sdk2.action('x').handler(() => 'x');
    const welcome2 = await connectSdk(sdk2, {
      resume: {
        sessionId: welcome1.sessionId,
        resumeToken: welcome1.resumeToken!,
      },
    });
    expect(welcome2.resumeToken).not.toBe(welcome1.resumeToken);

    await sdk2.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Reusing the OLD token must fail.
    const sdk3 = newSdk();
    sdk3.app({ id: 'rot1', name: 'rot1', origin: 'http://localhost' });
    sdk3.action('x').handler(() => 'x');
    await expect(
      connectSdk(sdk3, {
        resume: {
          sessionId: welcome1.sessionId,
          resumeToken: welcome1.resumeToken!,
        },
      }),
    ).rejects.toThrow(/invalid resumetoken/i);

    // But the rotated token (from welcome2) still works.
    const sdk4 = newSdk();
    sdk4.app({ id: 'rot1', name: 'rot1', origin: 'http://localhost' });
    sdk4.action('x').handler(() => 'x');
    const welcome4 = await connectSdk(sdk4, {
      resume: {
        sessionId: welcome1.sessionId,
        resumeToken: welcome2.resumeToken!,
      },
    });
    expect(welcome4.sessionId).toBe(welcome1.sessionId);
  });

  it('refuses a cross-app resume attempt (app B cannot hijack app A session)', async () => {
    // Security boundary: the app_id carried in the resume params must match
    // the app id of the zombie being resumed. Without this check, any app
    // that learned another app's sessionId + resumeToken (via shared storage,
    // a bug, or a leak) could inherit its claimed MCP tool surface.
    const sdkA = newSdk();
    sdkA.app({ id: 'owner_app', name: 'owner_app', origin: 'http://localhost' });
    sdkA.action('x').handler(() => 'x');
    const welcomeA = await connectSdk(sdkA);
    await callTool('tesseron__claim_session', { code: welcomeA.claimCode! });
    await sdkA.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    const sdkB = newSdk();
    sdkB.app({ id: 'hijacker_app', name: 'hijacker_app', origin: 'http://localhost' });
    sdkB.action('x').handler(() => 'x');
    await expect(
      connectSdk(sdkB, {
        resume: {
          sessionId: welcomeA.sessionId,
          resumeToken: welcomeA.resumeToken!,
        },
      }),
    ).rejects.toThrow(/not "hijacker_app"/i);
  });

  it('rejects reserved app ids during handshake', async () => {
    const sdk = newSdk();
    sdk.app({ id: 'tesseron', name: 'evil', origin: 'http://localhost' });
    sdk.action('x').handler(() => 'x');

    await expect(connectSdk(sdk)).rejects.toThrow(/reserved/i);
  });

  it('rejects malformed app ids during handshake', async () => {
    const sdk = newSdk();
    sdk.app({ id: 'BAD-ID', name: 'bad', origin: 'http://localhost' });
    sdk.action('x').handler(() => 'x');

    await expect(connectSdk(sdk)).rejects.toThrow(/invalid app id/i);
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

  it('auto-derives JSON Schema from validators that expose toJSONSchema (Zod 4 path)', async () => {
    // Mirrors the bug from issue #43: callers that follow the documented
    // `.input(z.object(...))` idiom (without passing JSON Schema as the
    // second argument) used to ship every action with a permissive
    // `{type:'object', additionalProperties:true}` because no auto-derive
    // existed in core. Here we verify the typed schema reaches the agent.
    const zodLikeSchema = {
      '~standard': {
        version: 1,
        vendor: 'zod',
        validate: (value: unknown) => ({ value }),
      },
      toJSONSchema: () => ({
        type: 'object',
        properties: {
          clipId: { type: 'string' },
          volume: { type: 'number', minimum: 0, maximum: 1 },
        },
        required: ['clipId', 'volume'],
      }),
    } as never;
    await setupAndClaim('schema_autoderive', (s) => {
      s.action('set_audio_volume')
        .input(zodLikeSchema)
        .handler(() => ({ ok: true }));
    });
    const tools = await client.request({ method: 'tools/list' }, ListToolsResultSchema);
    const tool = tools.tools.find((t) => t.name === 'schema_autoderive__set_audio_volume');
    expect(tool).toBeTruthy();
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        volume: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['clipId', 'volume'],
    });
    // The bug symptom — what the agent saw before the fix:
    expect(tool?.inputSchema).not.toEqual({ type: 'object', additionalProperties: true });
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
  async function buildBridge(toolSurface: 'dynamic' | 'meta' | 'both'): Promise<{
    gateway: TesseronGateway;
    client: Client;
    sdk: ServerTesseronClient;
    cleanup: () => Promise<void>;
  }> {
    // Each test needs its own gateway + sandbox because the toolSurface mode is
    // a gateway-level config. The shared top-level sandbox is fine to reuse as
    // HOME — the tab file ids are unique per SDK connect, and we only connect
    // one SDK per bridge, so there's no cross-talk.
    const gw = new TesseronGateway();
    const br = new McpAgentBridge({ gateway: gw, toolSurface });
    const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
    await br.connect(gatewaySide);
    const c = new Client({ name: 'mode-test', version: '0.0.0' });
    await c.connect(agentSide);
    const sdk = new ServerTesseronClient();
    sdk.app({ id: 'modeapp', name: 'mode test', origin: 'http://localhost' });
    sdk.action('ping').handler(() => 'pong');
    const welcome = await dialSdk(gw, sandbox, () => sdk.connect());
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
    const { client: c, cleanup } = await buildBridge('dynamic');
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
    const { client: c, cleanup } = await buildBridge('meta');
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
    const { client: c, cleanup } = await buildBridge('both');
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

describe('Resume options', () => {
  async function buildResumeBridge(
    opts: { resumeTtlMs?: number; maxZombies?: number } = {},
  ): Promise<{
    gateway: TesseronGateway;
    connect: (
      sdk: ServerTesseronClient,
      options?: Parameters<ServerTesseronClient['connect']>[1],
    ) => Promise<Awaited<ReturnType<ServerTesseronClient['connect']>>>;
    agentClient: Client;
    newSdk: () => ServerTesseronClient;
    cleanup: () => Promise<void>;
  }> {
    // Each test needs its own gateway so resume-ttl / max-zombies options apply
    // per-suite. We reuse the top-level sandbox — tab IDs are unique per SDK.
    const gw = new TesseronGateway(opts);
    const br = new McpAgentBridge({ gateway: gw });
    const [agentSide, gatewaySide] = InMemoryTransport.createLinkedPair();
    await br.connect(gatewaySide);
    const c = new Client({ name: 'resume-opts-test', version: '0.0.0' });
    await c.connect(agentSide);
    const sdks: ServerTesseronClient[] = [];
    return {
      gateway: gw,
      connect: (sdk, options) => dialSdk(gw, sandbox, () => sdk.connect(undefined, options)),
      agentClient: c,
      newSdk: () => {
        const sdk = new ServerTesseronClient();
        sdks.push(sdk);
        return sdk;
      },
      cleanup: async () => {
        await Promise.all(sdks.map((s) => s.disconnect().catch(() => {})));
        await c.close().catch(() => {});
        await gw.stop().catch(() => {});
      },
    };
  }

  async function claim(agentClient: Client, code: string): Promise<void> {
    const r = await agentClient.request(
      { method: 'tools/call', params: { name: 'tesseron__claim_session', arguments: { code } } },
      CallToolResultSchema,
    );
    expect(r.isError).toBeFalsy();
  }

  it('evicts zombies past their TTL (resume after TTL fails with no-resumable-session)', async () => {
    const { connect, agentClient, newSdk, cleanup } = await buildResumeBridge({
      resumeTtlMs: 150,
    });
    try {
      const sdk1 = newSdk();
      sdk1.app({ id: 'ttl1', name: 'ttl1', origin: 'http://localhost' });
      sdk1.action('x').handler(() => 'x');
      const welcome1 = await connect(sdk1);
      await claim(agentClient, welcome1.claimCode!);
      await sdk1.disconnect();
      // Wait past the TTL so the eviction timer fires.
      await new Promise((r) => setTimeout(r, 300));

      const sdk2 = newSdk();
      sdk2.app({ id: 'ttl1', name: 'ttl1', origin: 'http://localhost' });
      sdk2.action('x').handler(() => 'x');
      await expect(
        connect(sdk2, {
          resume: {
            sessionId: welcome1.sessionId,
            resumeToken: welcome1.resumeToken!,
          },
        }),
      ).rejects.toThrow(/no resumable session/i);
    } finally {
      await cleanup();
    }
  });

  it('resumeTtlMs: 0 disables zombification; immediate resume fails', async () => {
    const { connect, agentClient, newSdk, cleanup } = await buildResumeBridge({
      resumeTtlMs: 0,
    });
    try {
      const sdk1 = newSdk();
      sdk1.app({ id: 'ttl0', name: 'ttl0', origin: 'http://localhost' });
      sdk1.action('x').handler(() => 'x');
      const welcome1 = await connect(sdk1);
      await claim(agentClient, welcome1.claimCode!);
      await sdk1.disconnect();
      await new Promise((r) => setTimeout(r, 100));

      const sdk2 = newSdk();
      sdk2.app({ id: 'ttl0', name: 'ttl0', origin: 'http://localhost' });
      sdk2.action('x').handler(() => 'x');
      await expect(
        connect(sdk2, {
          resume: {
            sessionId: welcome1.sessionId,
            resumeToken: welcome1.resumeToken!,
          },
        }),
      ).rejects.toThrow(/no resumable session/i);
    } finally {
      await cleanup();
    }
  });

  it('maxZombies: 0 disables zombification entirely', async () => {
    // Regression guard: before the fix, maxZombies=0 was silently ignored —
    // the cap-eviction branch found an empty map and fell through to insert
    // the new zombie anyway, so the cap did nothing.
    const { connect, agentClient, newSdk, cleanup } = await buildResumeBridge({
      maxZombies: 0,
    });
    try {
      const sdk1 = newSdk();
      sdk1.app({ id: 'maxz0', name: 'maxz0', origin: 'http://localhost' });
      sdk1.action('x').handler(() => 'x');
      const welcome1 = await connect(sdk1);
      await claim(agentClient, welcome1.claimCode!);
      await sdk1.disconnect();
      await new Promise((r) => setTimeout(r, 100));

      const sdk2 = newSdk();
      sdk2.app({ id: 'maxz0', name: 'maxz0', origin: 'http://localhost' });
      sdk2.action('x').handler(() => 'x');
      await expect(
        connect(sdk2, {
          resume: {
            sessionId: welcome1.sessionId,
            resumeToken: welcome1.resumeToken!,
          },
        }),
      ).rejects.toThrow(/no resumable session/i);
    } finally {
      await cleanup();
    }
  });

  it('maxZombies: 2 evicts the oldest zombie FIFO when the cap is reached', async () => {
    const { connect, agentClient, newSdk, cleanup } = await buildResumeBridge({
      maxZombies: 2,
    });
    try {
      async function spawnAndDrop(id: string) {
        const sdk = newSdk();
        sdk.app({ id, name: id, origin: 'http://localhost' });
        sdk.action('x').handler(() => 'x');
        const w = await connect(sdk);
        await claim(agentClient, w.claimCode!);
        await sdk.disconnect();
        await new Promise((r) => setTimeout(r, 60));
        return w;
      }
      const wa = await spawnAndDrop('cap_a');
      const wb = await spawnAndDrop('cap_b');
      const wc = await spawnAndDrop('cap_c');

      // cap_a was oldest; inserting cap_c should have evicted it.
      const sdkA2 = newSdk();
      sdkA2.app({ id: 'cap_a', name: 'cap_a', origin: 'http://localhost' });
      sdkA2.action('x').handler(() => 'x');
      await expect(
        connect(sdkA2, {
          resume: { sessionId: wa.sessionId, resumeToken: wa.resumeToken! },
        }),
      ).rejects.toThrow(/no resumable session/i);

      // cap_b and cap_c are still within the cap and must resume.
      const sdkB2 = newSdk();
      sdkB2.app({ id: 'cap_b', name: 'cap_b', origin: 'http://localhost' });
      sdkB2.action('x').handler(() => 'x');
      const wb2 = await connect(sdkB2, {
        resume: { sessionId: wb.sessionId, resumeToken: wb.resumeToken! },
      });
      expect(wb2.sessionId).toBe(wb.sessionId);

      const sdkC2 = newSdk();
      sdkC2.app({ id: 'cap_c', name: 'cap_c', origin: 'http://localhost' });
      sdkC2.action('x').handler(() => 'x');
      const wc2 = await connect(sdkC2, {
        resume: { sessionId: wc.sessionId, resumeToken: wc.resumeToken! },
      });
      expect(wc2.sessionId).toBe(wc.sessionId);
    } finally {
      await cleanup();
    }
  });

  it('rejects malformed resume params (non-string sessionId) with a typed ResumeFailed', async () => {
    // Before the consolidated input guard, a non-string sessionId reached
    // `zombieSessions.get(...)` or `Buffer.from(...)` below and escaped as
    // an untyped InternalError instead of the ResumeFailed the ConnectOptions
    // contract promises.
    const { connect, newSdk, cleanup } = await buildResumeBridge();
    try {
      const sdk = newSdk();
      sdk.app({ id: 'bad1', name: 'bad1', origin: 'http://localhost' });
      sdk.action('x').handler(() => 'x');
      await expect(
        connect(sdk, {
          resume: {
            sessionId: 12345 as unknown as string,
            resumeToken: 'any-value',
          },
        }),
      ).rejects.toThrow(/invalid tesseron\/resume request/i);
    } finally {
      await cleanup();
    }
  });

  it('replaces the session manifest on resume (added tool appears, removed tool disappears)', async () => {
    const { connect, agentClient, newSdk, cleanup } = await buildResumeBridge();
    try {
      async function listTools() {
        const r = await agentClient.request({ method: 'tools/list' }, ListToolsResultSchema);
        return r.tools.map((t) => t.name);
      }

      const sdk1 = newSdk();
      sdk1.app({ id: 'man1', name: 'man1', origin: 'http://localhost' });
      sdk1.action('keep').handler(() => 'keep');
      sdk1.action('removeMe').handler(() => 'remove');
      const welcome1 = await connect(sdk1);
      await claim(agentClient, welcome1.claimCode!);
      await new Promise((r) => setTimeout(r, 50));
      let tools = await listTools();
      expect(tools).toContain('man1__keep');
      expect(tools).toContain('man1__removeMe');

      await sdk1.disconnect();
      await new Promise((r) => setTimeout(r, 100));

      // Fresh build: `removeMe` is gone, `newAction` is new.
      const sdk2 = newSdk();
      sdk2.app({ id: 'man1', name: 'man1', origin: 'http://localhost' });
      sdk2.action('keep').handler(() => 'still-here');
      sdk2.action('newAction').handler(() => 'new');
      await connect(sdk2, {
        resume: { sessionId: welcome1.sessionId, resumeToken: welcome1.resumeToken! },
      });
      await new Promise((r) => setTimeout(r, 50));

      tools = await listTools();
      expect(tools).toContain('man1__keep');
      expect(tools).toContain('man1__newAction');
      expect(tools).not.toContain('man1__removeMe');
    } finally {
      await cleanup();
    }
  });
});
