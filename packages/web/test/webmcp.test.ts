import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  ElicitationNotAvailableError,
  PROTOCOL_VERSION,
  SamplingNotAvailableError,
  TesseronErrorCode,
  type Transport,
  type WelcomeResult,
} from '@tesseron/core';
import { JsonRpcDispatcher } from '@tesseron/core/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebTesseronClient } from '../src/index.js';

interface RegisteredWebMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  execute(input: unknown): Promise<unknown>;
}

class FakeWebMcpModelContext {
  readonly tools = new Map<string, RegisteredWebMcpTool>();
  readonly registerTool = vi.fn((tool: RegisteredWebMcpTool) => {
    this.tools.set(tool.name, tool);
  });
  readonly unregisterTool = vi.fn((name: string) => {
    this.tools.delete(name);
  });
}

function exposeModelContext(
  host: Document | Navigator,
  modelContext: FakeWebMcpModelContext,
): void {
  Object.defineProperty(host, 'modelContext', { configurable: true, value: modelContext });
}

function clearModelContexts(): void {
  Reflect.deleteProperty(document, 'modelContext');
  Reflect.deleteProperty(navigator, 'modelContext');
}

function createConnectedTransport(
  capabilities: WelcomeResult['capabilities'] = {
    streaming: false,
    subscriptions: false,
    sampling: false,
    elicitation: false,
  },
): Transport {
  let clientMessageHandler: ((message: unknown) => void) | undefined;
  let clientCloseHandler: ((reason?: string) => void) | undefined;
  let closed = false;
  const gateway = new JsonRpcDispatcher((message) => {
    queueMicrotask(() => clientMessageHandler?.(message));
  });
  gateway.on('tesseron/hello', () => ({
    sessionId: 'webmcp-test',
    protocolVersion: PROTOCOL_VERSION,
    capabilities,
    agent: { id: 'gateway-agent', name: 'Gateway Agent' },
  }));
  return {
    send: (message) => queueMicrotask(() => gateway.receive(message)),
    onMessage: (handler) => {
      clientMessageHandler = handler;
    },
    onClose: (handler) => {
      clientCloseHandler = handler;
    },
    close: () => {
      if (closed) return;
      closed = true;
      clientCloseHandler?.('test close');
    },
  };
}

function createClient(): WebTesseronClient {
  return new WebTesseronClient().app({
    id: 'webmcp-test',
    name: 'WebMCP test',
    origin: 'https://example.test',
  });
}

afterEach(() => {
  clearModelContexts();
  vi.restoreAllMocks();
});

describe('WebTesseronClient WebMCP bridge', () => {
  it('registers current actions on enabled connect with the hello-manifest schema', async () => {
    const modelContext = new FakeWebMcpModelContext();
    exposeModelContext(document, modelContext);
    const inputJsonSchema = {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
      additionalProperties: false,
    };
    const inputSchema: StandardSchemaV1<{ message: string }> = {
      '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => {
          if (
            typeof value === 'object' &&
            value !== null &&
            'message' in value &&
            typeof value.message === 'string'
          ) {
            return { value: { message: value.message.trim() } };
          }
          return { issues: [{ message: 'expected a message string' }] };
        },
      },
    };
    const handler = vi.fn(({ message }: { message: string }) => ({ echoed: message }));
    const client = createClient();
    client
      .action('echo')
      .describe('Echo a message')
      .input(inputSchema, inputJsonSchema)
      .handler(handler);

    await client.connect(createConnectedTransport(), { resume: false, webmcp: true });

    expect(modelContext.registerTool).toHaveBeenCalledTimes(1);
    const tool = modelContext.tools.get('echo');
    expect(tool).toMatchObject({
      name: 'echo',
      description: 'Echo a message',
      inputSchema: inputJsonSchema,
    });
    await expect(tool?.execute({ message: 42 })).rejects.toMatchObject({
      code: TesseronErrorCode.InputValidation,
    });
    expect(handler).not.toHaveBeenCalled();
    await expect(tool?.execute({ message: '  hello  ' })).resolves.toEqual({ echoed: 'hello' });
    expect(handler).toHaveBeenCalledWith(
      { message: 'hello' },
      expect.objectContaining({
        agentCapabilities: { sampling: false, elicitation: false, subscriptions: false },
      }),
    );
  });

  it('does not register actions when webmcp is disabled', async () => {
    const modelContext = new FakeWebMcpModelContext();
    exposeModelContext(document, modelContext);
    const client = createClient();
    client.action('noop').handler(() => undefined);

    await client.connect(createConnectedTransport(), { resume: false });

    expect(modelContext.registerTool).not.toHaveBeenCalled();
  });

  it('logs at debug level and keeps connecting when the API is absent', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const client = createClient();
    client.action('noop').handler(() => undefined);

    await expect(
      client.connect(createConnectedTransport(), { resume: false, webmcp: true }),
    ).resolves.toMatchObject({ sessionId: 'webmcp-test' });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('modelContext'));
  });

  it('falls back to navigator.modelContext after checking document.modelContext', async () => {
    const modelContext = new FakeWebMcpModelContext();
    exposeModelContext(navigator, modelContext);
    const client = createClient();
    client.action('noop').handler(() => undefined);

    await client.connect(createConnectedTransport(), { resume: false, webmcp: true });

    expect(modelContext.tools.has('noop')).toBe(true);
  });

  it('unregisters removed actions and all remaining tools on disconnect', async () => {
    const modelContext = new FakeWebMcpModelContext();
    exposeModelContext(document, modelContext);
    const client = createClient();
    client.action('first').handler(() => undefined);
    client.action('second').handler(() => undefined);
    await client.connect(createConnectedTransport(), { resume: false, webmcp: true });

    client.removeAction('first');
    expect(modelContext.unregisterTool).toHaveBeenCalledWith('first');
    expect(modelContext.tools.has('first')).toBe(false);

    await client.disconnect();
    expect(modelContext.unregisterTool).toHaveBeenCalledWith('second');
    expect(modelContext.tools).toHaveLength(0);
  });

  it('registers actions added after connect', async () => {
    const modelContext = new FakeWebMcpModelContext();
    exposeModelContext(document, modelContext);
    const client = createClient();
    await client.connect(createConnectedTransport(), { resume: false, webmcp: true });

    client
      .action('late')
      .describe('Added later')
      .handler(() => 'ready');

    expect(modelContext.tools.get('late')).toMatchObject({
      name: 'late',
      description: 'Added later',
    });
  });

  it('keeps agent-dependent context methods unavailable for direct WebMCP calls', async () => {
    const modelContext = new FakeWebMcpModelContext();
    exposeModelContext(document, modelContext);
    const client = createClient();
    client.action('capabilities').handler(async (_input, context) => {
      const confirmed = await context.confirm({ question: 'Continue?' });
      let samplingUnavailable = false;
      let elicitationUnavailable = false;
      try {
        await context.sample({ prompt: 'Say hello' });
      } catch (error) {
        samplingUnavailable = error instanceof SamplingNotAvailableError;
      }
      try {
        await context.elicit({
          question: 'Your name?',
          schema: {
            '~standard': {
              version: 1,
              vendor: 'test',
              validate: (value) => ({ value }),
            },
          },
        });
      } catch (error) {
        elicitationUnavailable = error instanceof ElicitationNotAvailableError;
      }
      return { confirmed, samplingUnavailable, elicitationUnavailable };
    });
    await client.connect(
      createConnectedTransport({
        streaming: true,
        subscriptions: true,
        sampling: true,
        elicitation: true,
      }),
      { resume: false, webmcp: true },
    );

    await expect(modelContext.tools.get('capabilities')?.execute({})).resolves.toEqual({
      confirmed: false,
      samplingUnavailable: true,
      elicitationUnavailable: true,
    });
  });
});
