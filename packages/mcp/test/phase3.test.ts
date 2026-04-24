import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolResultSchema,
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  EmptyResultSchema,
  ListResourcesResultSchema,
  ProgressNotificationSchema,
  ReadResourceResultSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { StandardSchemaV1 } from '@standard-schema/spec';
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
    { name: 'phase3-agent', version: '0.0.0' },
    {
      capabilities: {
        sampling: {},
        elicitation: {},
      },
    },
  );
  await client.connect(agentSide);
});

afterAll(async () => {
  await client.close().catch(() => {});
  await gateway.stop().catch(() => {});
  sandbox.cleanup();
});

afterEach(async () => {
  await Promise.all(activeSdks.map((s) => s.disconnect().catch(() => {})));
  activeSdks = [];
  await new Promise((r) => setTimeout(r, 60));
});

function newSdk(): ServerTesseronClient {
  const sdk = new ServerTesseronClient();
  activeSdks.push(sdk);
  return sdk;
}

async function callTool(
  name: string,
  args: unknown,
  options?: { progressToken?: string | number; signal?: AbortSignal },
): Promise<{ text: string; isError: boolean }> {
  const params: {
    name: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  } = {
    name,
    arguments: (args ?? {}) as Record<string, unknown>,
  };
  if (options?.progressToken !== undefined) {
    params._meta = { progressToken: options.progressToken };
  }
  const result = await client.request(
    { method: 'tools/call', params },
    CallToolResultSchema,
    options?.signal ? { signal: options.signal } : undefined,
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
  const welcome = await dialSdk(gateway, sandbox, () => sdk.connect());
  const code = welcome.claimCode!;
  await client.request(
    { method: 'tools/call', params: { name: 'tesseron__claim_session', arguments: { code } } },
    CallToolResultSchema,
  );
  return { sdk, claimCode: code };
}

describe('Phase 3 — streaming progress forwarding', () => {
  it('forwards ctx.progress() updates to MCP notifications/progress', async () => {
    await setupAndClaim('prog1', (s) => {
      s.action('work').handler(async (_input, ctx) => {
        ctx.progress({ percent: 25, message: 'q1' });
        await new Promise((r) => setTimeout(r, 10));
        ctx.progress({ percent: 50, message: 'q2' });
        await new Promise((r) => setTimeout(r, 10));
        ctx.progress({ percent: 75, message: 'q3' });
        await new Promise((r) => setTimeout(r, 10));
        return 'done';
      });
    });

    const received: Array<{ progress: number; message?: string }> = [];
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      received.push({
        progress: notification.params.progress,
        message: notification.params.message,
      });
    });

    const result = await callTool('prog1__work', {}, { progressToken: 'tok-1' });
    expect(result.isError).toBe(false);
    expect(result.text).toBe('done');
    // Progress notifications are best-effort; allow some race tolerance
    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBeGreaterThanOrEqual(2);
    expect(received.some((p) => p.message === 'q1')).toBe(true);
    expect(received.some((p) => p.message === 'q3')).toBe(true);
  });

  // Regression coverage for tesseron#2: the bridge must only emit
  // notifications/progress when the caller opted in with _meta.progressToken.
  // Clients that never send a progressToken (e.g. Claude Code as of 2026-04)
  // will not see progress — that is the spec-correct behavior, not a bug.
  it('does not emit notifications/progress when tools/call has no progressToken', async () => {
    await setupAndClaim('prog2', (s) => {
      s.action('work').handler(async (_input, ctx) => {
        ctx.progress({ percent: 33, message: 'one' });
        await new Promise((r) => setTimeout(r, 10));
        ctx.progress({ percent: 66, message: 'two' });
        return 'done';
      });
    });

    const received: Array<{ progress: number; message?: string }> = [];
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      received.push({
        progress: notification.params.progress,
        message: notification.params.message,
      });
    });

    const result = await callTool('prog2__work', {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe('done');
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual([]);
  });

  // Regression coverage for tesseron#6: message-only ctx.progress() calls must
  // reuse the last observed percent rather than emitting progress=0, which would
  // violate MCP's monotonic-increase rule.
  it('reuses lastProgress for message-only updates so progress stays monotonic', async () => {
    await setupAndClaim('prog3', (s) => {
      s.action('work').handler(async (_input, ctx) => {
        ctx.progress({ percent: 30, message: 'first' });
        await new Promise((r) => setTimeout(r, 10));
        ctx.progress({ message: 'thinking...' });
        await new Promise((r) => setTimeout(r, 10));
        ctx.progress({ percent: 70, message: 'last' });
        await new Promise((r) => setTimeout(r, 10));
        return 'done';
      });
    });

    const received: Array<{ progress: number; message?: string }> = [];
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      received.push({
        progress: notification.params.progress,
        message: notification.params.message,
      });
    });

    const result = await callTool('prog3__work', {}, { progressToken: 'tok-3' });
    expect(result.isError).toBe(false);
    expect(result.text).toBe('done');
    await new Promise((r) => setTimeout(r, 50));

    // Filter to this invocation's messages (handlers from prior tests may have leaked).
    const ours = received.filter(
      (p) => p.message === 'first' || p.message === 'thinking...' || p.message === 'last',
    );
    expect(ours.map((p) => p.progress)).toEqual([30, 30, 70]);
  });

  // Defends against a misbehaving handler that emits a decreasing percent.
  // The bridge must ignore the regression and keep the last observed cursor.
  it('ignores out-of-order percent decreases to keep progress monotonic', async () => {
    await setupAndClaim('prog4', (s) => {
      s.action('work').handler(async (_input, ctx) => {
        ctx.progress({ percent: 50, message: 'alpha' });
        await new Promise((r) => setTimeout(r, 10));
        ctx.progress({ percent: 10, message: 'beta' });
        await new Promise((r) => setTimeout(r, 10));
        return 'done';
      });
    });

    const received: Array<{ progress: number; message?: string }> = [];
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      received.push({
        progress: notification.params.progress,
        message: notification.params.message,
      });
    });

    const result = await callTool('prog4__work', {}, { progressToken: 'tok-4' });
    expect(result.isError).toBe(false);
    expect(result.text).toBe('done');
    await new Promise((r) => setTimeout(r, 50));

    const ours = received.filter((p) => p.message === 'alpha' || p.message === 'beta');
    expect(ours.map((p) => p.progress)).toEqual([50, 50]);
  });

  // Cleanup: reusing the same progressToken across two sequential tools/call
  // invocations must not leak the cursor from the first into the second.
  it('does not leak progress cursor across sequential calls with the same progressToken', async () => {
    await setupAndClaim('prog5', (s) => {
      s.action('first').handler(async (_input, ctx) => {
        ctx.progress({ percent: 80, message: 'first-done' });
        await new Promise((r) => setTimeout(r, 10));
        return 'ok';
      });
      s.action('second').handler(async (_input, ctx) => {
        // If state leaked from the previous call, the bridge would still hold 80
        // and this message-only update would emit progress=80.
        ctx.progress({ message: 'second-start' });
        await new Promise((r) => setTimeout(r, 10));
        ctx.progress({ percent: 40, message: 'second-mid' });
        await new Promise((r) => setTimeout(r, 10));
        return 'ok';
      });
    });

    const received: Array<{ progress: number; message?: string }> = [];
    client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
      received.push({
        progress: notification.params.progress,
        message: notification.params.message,
      });
    });

    const firstCall = await callTool('prog5__first', {}, { progressToken: 'shared-tok' });
    expect(firstCall.isError).toBe(false);
    await new Promise((r) => setTimeout(r, 30));

    const secondCall = await callTool('prog5__second', {}, { progressToken: 'shared-tok' });
    expect(secondCall.isError).toBe(false);
    await new Promise((r) => setTimeout(r, 50));

    const secondStart = received.find((p) => p.message === 'second-start');
    const secondMid = received.find((p) => p.message === 'second-mid');
    expect(secondStart?.progress).toBe(0);
    expect(secondMid?.progress).toBe(40);
  });
});

describe('Phase 3 — cancellation forwarding', () => {
  it('aborts an in-flight handler when the MCP request is cancelled', async () => {
    let signalAborted = false;
    let handlerSettled = false;
    await setupAndClaim('cancel1', (s) => {
      s.action('wait')
        .timeout({ ms: 5000 })
        .handler(async (_input, ctx) => {
          await new Promise<void>((resolve) => {
            ctx.signal.addEventListener('abort', () => {
              signalAborted = true;
              resolve();
            });
          });
          handlerSettled = true;
          throw new Error('handler-saw-abort');
        });
    });

    const controller = new AbortController();
    const callPromise = callTool('cancel1__wait', {}, { signal: controller.signal });

    setTimeout(() => controller.abort(), 50);

    await expect(callPromise).rejects.toThrow();
    // The handler should observe the abort within a reasonable window
    await new Promise((r) => setTimeout(r, 150));
    expect(signalAborted).toBe(true);
    expect(handlerSettled).toBe(true);
  });
});

describe('Phase 3 — sampling round trip', () => {
  it("lets a handler call ctx.sample() and receive the agent's text response", async () => {
    let observedPrompt = '';
    client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
      const firstMessage = request.params.messages[0];
      const content = firstMessage?.content;
      if (content && typeof content === 'object' && 'type' in content && content.type === 'text') {
        observedPrompt = (content as { text: string }).text;
      }
      return {
        role: 'assistant',
        model: 'test-model',
        content: { type: 'text', text: `you said: ${observedPrompt}` },
      };
    });

    await setupAndClaim('samp1', (s) => {
      s.action<{ topic: string }, string>('summarize').handler(async ({ topic }, ctx) => {
        const reply = await ctx.sample({ prompt: `summarize ${topic}` });
        return reply;
      });
    });

    const result = await callTool('samp1__summarize', { topic: 'TypeScript' });
    expect(result.isError).toBe(false);
    expect(observedPrompt).toBe('summarize TypeScript');
    expect(result.text).toBe('you said: summarize TypeScript');
  });

  // Regression: ctx.sample with a schema must JSON-decode the string content
  // before validating. Pre-fix, the SDK handed the raw string from
  // result.content straight to standardValidate, so any z.object(...) schema
  // tripped "Expected object, received string". The docs already promised
  // validated values; the client.ts implementation didn't parse.
  it('JSON-decodes the sampling result before schema validation', async () => {
    client.setRequestHandler(CreateMessageRequestSchema, async () => ({
      role: 'assistant',
      model: 'json-model',
      // Return a JSON-encoded object as the sampling content; the SDK must
      // parse it before validating against the schema.
      content: { type: 'text', text: JSON.stringify({ titles: ['A', 'B', 'C'] }) },
    }));

    const titlesSchema: StandardSchemaV1<{ titles: string[] }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (v) => {
          if (
            typeof v !== 'object' ||
            v === null ||
            !Array.isArray((v as { titles?: unknown }).titles)
          ) {
            return { issues: [{ message: 'expected { titles: string[] }' }] };
          }
          return { value: v as { titles: string[] } };
        },
      },
    };

    type Out = { titles: string[] };
    await setupAndClaim('samp_json', (s) => {
      s.action<Record<string, never>, Out>('suggest').handler(async (_input, ctx) => {
        return ctx.sample<Out>({
          prompt: 'Suggest 3 titles',
          schema: titlesSchema,
        });
      });
    });

    const result = await callTool('samp_json__suggest', {});
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toEqual({ titles: ['A', 'B', 'C'] });
  });

  // Regression: if the LLM returns non-JSON but the handler declared a schema,
  // the SDK must produce a clear HandlerError rather than passing the string
  // through to validation and failing with a confusing "Expected object" message.
  it('throws a HandlerError with a clear message when schema is set but content is not JSON', async () => {
    client.setRequestHandler(CreateMessageRequestSchema, async () => ({
      role: 'assistant',
      model: 'garbage-model',
      content: { type: 'text', text: 'not json at all' },
    }));

    const anySchema: StandardSchemaV1<{ ok: boolean }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: () => ({ value: { ok: true } }),
      },
    };

    await setupAndClaim('samp_badjson', (s) => {
      s.action('trysample').handler(async (_input, ctx) => {
        return ctx.sample({ prompt: 'whatever', schema: anySchema });
      });
    });

    const result = await callTool('samp_badjson__trysample', {});
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/not valid JSON/i);
  });
});

describe('Phase 3 — elicitation round trip', () => {
  it('lets a handler call ctx.elicit() and receive a structured user response', async () => {
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      expect(request.params.message).toBe('Which warehouse?');
      return {
        action: 'accept',
        content: { warehouseId: 'WH-7' },
      };
    });

    const warehouseSchema: StandardSchemaV1<{ warehouseId: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (v) => {
          if (typeof v !== 'object' || v === null) {
            return { issues: [{ message: 'object required' }] };
          }
          const o = v as { warehouseId?: unknown };
          if (typeof o.warehouseId !== 'string') {
            return { issues: [{ message: 'warehouseId must be string' }] };
          }
          return { value: { warehouseId: o.warehouseId } };
        },
      },
    };

    await setupAndClaim('elic1', (s) => {
      s.action('checkStock').handler(async (_input, ctx) => {
        const answer = await ctx.elicit({
          question: 'Which warehouse?',
          schema: warehouseSchema,
          jsonSchema: {
            type: 'object',
            properties: {
              warehouseId: { type: 'string', description: 'Warehouse identifier (e.g. WH-7)' },
            },
            required: ['warehouseId'],
          },
        });
        if (!answer) return 'declined';
        return `checking stock at ${answer.warehouseId}`;
      });
    });

    const result = await callTool('elic1__checkStock', {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe('checking stock at WH-7');
  });

  it('ctx.elicit() returns null when the user declines, without throwing', async () => {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));

    const dummySchema: StandardSchemaV1<{ x: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (v) => ({ value: v as { x: string } }),
      },
    };

    await setupAndClaim('elic2', (s) => {
      s.action('ask').handler(async (_input, ctx) => {
        const answer = await ctx.elicit({
          question: 'anything?',
          schema: dummySchema,
          jsonSchema: {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
          },
        });
        return answer === null ? 'declined' : 'accepted';
      });
    });

    const result = await callTool('elic2__ask', {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe('declined');
  });

  it('ctx.elicit() returns null on cancel too', async () => {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' }));

    const dummySchema: StandardSchemaV1<{ x: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (v) => ({ value: v as { x: string } }),
      },
    };

    await setupAndClaim('elic3', (s) => {
      s.action('ask').handler(async (_input, ctx) => {
        const answer = await ctx.elicit({
          question: 'anything?',
          schema: dummySchema,
          jsonSchema: {
            type: 'object',
            properties: { x: { type: 'string' } },
            required: ['x'],
          },
        });
        return answer === null ? 'no-content' : 'content';
      });
    });

    const result = await callTool('elic3__ask', {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe('no-content');
  });

  it('ctx.elicit() with an invalid jsonSchema throws InvalidParams before any wire traffic', async () => {
    // No elicit handler should ever be invoked — failure is purely on the SDK send path.
    let elicitCalls = 0;
    client.setRequestHandler(ElicitRequestSchema, async () => {
      elicitCalls++;
      return { action: 'accept', content: {} };
    });

    const dummySchema: StandardSchemaV1<unknown> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (v) => ({ value: v }),
      },
    };

    await setupAndClaim('elic4', (s) => {
      s.action('badSchema').handler(async (_input, ctx) => {
        await ctx.elicit({
          question: '?',
          schema: dummySchema,
          jsonSchema: { type: 'array' },
        });
        return 'never reached';
      });
    });

    const result = await callTool('elic4__badSchema', {});
    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toMatch(/jsonschema.*type.*object/);
    expect(elicitCalls).toBe(0);
  });
});

describe('Phase 3 — ctx.confirm', () => {
  it('returns true on accept and sends an empty-properties requestedSchema', async () => {
    let lastRequestedSchema: unknown;
    client.setRequestHandler(ElicitRequestSchema, async (request) => {
      lastRequestedSchema = request.params.requestedSchema;
      return { action: 'accept' };
    });

    await setupAndClaim('conf1', (s) => {
      s.action('wipe').handler(async (_input, ctx) => {
        const ok = await ctx.confirm({ question: 'Wipe?' });
        return ok ? 'wiped' : 'kept';
      });
    });

    const result = await callTool('conf1__wipe', {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe('wiped');
    // Regression guard: the exact schema ctx.confirm sends. Any change here
    // is a wire-visible UX change — review against Claude Code rendering.
    expect(lastRequestedSchema).toEqual({
      type: 'object',
      properties: {},
      required: [],
    });
  });

  it('returns false on decline', async () => {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));

    await setupAndClaim('conf2', (s) => {
      s.action('wipe').handler(async (_input, ctx) => {
        const ok = await ctx.confirm({ question: 'Wipe?' });
        return ok ? 'wiped' : 'kept';
      });
    });

    const result = await callTool('conf2__wipe', {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe('kept');
  });

  it('returns false on cancel', async () => {
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' }));

    await setupAndClaim('conf3', (s) => {
      s.action('wipe').handler(async (_input, ctx) => {
        const ok = await ctx.confirm({ question: 'Wipe?' });
        return ok ? 'wiped' : 'kept';
      });
    });

    const result = await callTool('conf3__wipe', {});
    expect(result.isError).toBe(false);
    expect(result.text).toBe('kept');
  });
});

describe('Phase 3 — ctx.signal aborts pending confirm/elicit', () => {
  it('action timeout aborts a pending ctx.confirm instead of hanging the handler', async () => {
    client.setRequestHandler(ElicitRequestSchema, () => new Promise(() => {}));

    await setupAndClaim('abort1', (s) => {
      s.action('willTimeoutConfirm')
        .timeout({ ms: 200 })
        .handler(async (_input, ctx) => {
          const ok = await ctx.confirm({ question: 'will never resolve' });
          return ok ? 'yes' : 'no';
        });
    });

    const started = Date.now();
    const result = await callTool('abort1__willTimeoutConfirm', {});
    const elapsed = Date.now() - started;
    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toMatch(/timed out|200ms/);
    // If the dispatcher.request doesn't observe signal, the handler would hang
    // until the MCP side times out (~60s) — 2s ceiling is a comfortable guard.
    expect(elapsed).toBeLessThan(2000);
  });

  it('action timeout aborts a pending ctx.elicit', async () => {
    client.setRequestHandler(ElicitRequestSchema, () => new Promise(() => {}));

    const dummySchema: StandardSchemaV1<{ x: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (v) => ({ value: v as { x: string } }),
      },
    };

    await setupAndClaim('abort2', (s) => {
      s.action('willTimeoutElicit')
        .timeout({ ms: 200 })
        .handler(async (_input, ctx) => {
          await ctx.elicit({
            question: 'will never resolve',
            schema: dummySchema,
            jsonSchema: {
              type: 'object',
              properties: { x: { type: 'string' } },
              required: ['x'],
            },
          });
          return 'never';
        });
    });

    const started = Date.now();
    const result = await callTool('abort2__willTimeoutElicit', {});
    const elapsed = Date.now() - started;
    expect(result.isError).toBe(true);
    expect(result.text.toLowerCase()).toMatch(/timed out|200ms/);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('Phase 3 — resources exposure', () => {
  it("lists and reads a session's resources via MCP", async () => {
    let currentRoute = '/orders/123';
    await setupAndClaim('res1', (s) => {
      s.resource<string>('currentRoute')
        .describe('Current route')
        .read(() => currentRoute);
    });

    const resources = await client.request({ method: 'resources/list' }, ListResourcesResultSchema);
    const target = resources.resources.find((r) => r.name === 'res1__currentRoute');
    expect(target).toBeTruthy();
    expect(target?.uri).toBe('tesseron://res1/currentRoute');

    const read = await client.request(
      { method: 'resources/read', params: { uri: target?.uri } },
      ReadResourceResultSchema,
    );
    const content = read.contents[0]!;
    expect(content.text).toBe('/orders/123');

    currentRoute = '/orders/456';
    const read2 = await client.request(
      { method: 'resources/read', params: { uri: target?.uri } },
      ReadResourceResultSchema,
    );
    expect(read2.contents[0]?.text).toBe('/orders/456');
  });

  it('forwards resource subscription updates from SDK to MCP notifications', async () => {
    let emitFn: ((value: unknown) => void) | undefined;
    await setupAndClaim('res2', (s) => {
      s.resource<string>('selected')
        .describe('Currently selected item')
        .read(() => 'initial')
        .subscribe((emit) => {
          emitFn = emit;
          return () => {
            emitFn = undefined;
          };
        });
    });

    const updates: string[] = [];
    client.setNotificationHandler(ResourceUpdatedNotificationSchema, (notification) => {
      updates.push(notification.params.uri);
    });

    const uri = 'tesseron://res2/selected';
    await client.request({ method: 'resources/subscribe', params: { uri } }, EmptyResultSchema);
    await new Promise((r) => setTimeout(r, 50));

    expect(typeof emitFn).toBe('function');
    emitFn?.('item-1');
    emitFn?.('item-2');
    await new Promise((r) => setTimeout(r, 50));

    expect(updates.filter((u) => u === uri).length).toBeGreaterThanOrEqual(2);

    await client.request({ method: 'resources/unsubscribe', params: { uri } }, EmptyResultSchema);
  });
});
