import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RESOURCE_READ_TIMEOUT_MS,
  PROTOCOL_VERSION,
  TesseronClient,
  TesseronErrorCode,
  type Transport,
} from '../src/index.js';
import { JsonRpcDispatcher } from '../src/internal.js';

interface PairedSetup {
  client: TesseronClient;
  gateway: JsonRpcDispatcher;
}

function setup(): PairedSetup {
  let clientMessageHandler: ((m: unknown) => void) | undefined;
  let clientCloseHandler: ((reason?: string) => void) | undefined;

  const gateway = new JsonRpcDispatcher((m) => {
    queueMicrotask(() => clientMessageHandler?.(m));
  });

  const transport: Transport = {
    send: (m) => {
      queueMicrotask(() => gateway.receive(m));
    },
    onMessage: (h) => {
      clientMessageHandler = h;
    },
    onClose: (h) => {
      clientCloseHandler = h;
    },
    close: () => {
      clientCloseHandler?.('test close');
    },
  };

  gateway.on('tesseron/hello', () => ({
    sessionId: 'test-session',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { streaming: false, subscriptions: false, sampling: false, elicitation: false },
    agent: { id: 'test-agent', name: 'Test Agent' },
    claimCode: 'TEST-CD',
  }));

  const client = new TesseronClient();
  client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });

  // The transport is held by the client after connect(); return both pieces.
  void transport;
  return { client, gateway };
}

describe('TesseronClient end-to-end', () => {
  it('handshakes and surfaces the claim code in the welcome', async () => {
    const { client, gateway } = setup();

    let clientMessageHandler: ((m: unknown) => void) | undefined;
    const transport: Transport = {
      send: (m) => queueMicrotask(() => gateway.receive(m)),
      onMessage: (h) => {
        clientMessageHandler = h;
      },
      onClose: () => {},
      close: () => {},
    };
    // Re-wire so gateway sends to this transport's handler
    const originalSend = gateway.send as (m: unknown) => void;
    Object.assign(gateway, {
      send: (m: unknown) => queueMicrotask(() => clientMessageHandler?.(m)),
    });
    void originalSend;

    const welcome = await client.connect(transport);
    expect(welcome.sessionId).toBe('test-session');
    expect(welcome.claimCode).toBe('TEST-CD');
  });

  it('routes actions/invoke to the registered handler and returns the result', async () => {
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });
    client
      .action('greet')
      .describe('Greets a person')
      .handler(async (input: unknown) => `hello ${(input as { name: string }).name}`);

    let clientMessageHandler: ((m: unknown) => void) | undefined;
    const gateway = new JsonRpcDispatcher((m) => {
      queueMicrotask(() => clientMessageHandler?.(m));
    });
    gateway.on('tesseron/hello', () => ({
      sessionId: 'test',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { streaming: false, subscriptions: false, sampling: false, elicitation: false },
      agent: { id: 'a', name: 'a' },
    }));

    const transport: Transport = {
      send: (m) => queueMicrotask(() => gateway.receive(m)),
      onMessage: (h) => {
        clientMessageHandler = h;
      },
      onClose: () => {},
      close: () => {},
    };

    await client.connect(transport);

    const result = await gateway.request('actions/invoke', {
      name: 'greet',
      input: { name: 'world' },
      invocationId: 'inv1',
    });

    expect(result).toEqual({ invocationId: 'inv1', output: 'hello world' });
  });

  it('surfaces ActionNotFound when the action is unknown', async () => {
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });

    let clientMessageHandler: ((m: unknown) => void) | undefined;
    const gateway = new JsonRpcDispatcher((m) => {
      queueMicrotask(() => clientMessageHandler?.(m));
    });
    gateway.on('tesseron/hello', () => ({
      sessionId: 'test',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { streaming: false, subscriptions: false, sampling: false, elicitation: false },
      agent: { id: 'a', name: 'a' },
    }));

    const transport: Transport = {
      send: (m) => queueMicrotask(() => gateway.receive(m)),
      onMessage: (h) => {
        clientMessageHandler = h;
      },
      onClose: () => {},
      close: () => {},
    };

    await client.connect(transport);

    await expect(
      gateway.request('actions/invoke', {
        name: 'nope',
        input: {},
        invocationId: 'x',
      }),
    ).rejects.toMatchObject({ code: -32003 });
  });
});

async function setupConnectedClient(
  register: (c: TesseronClient) => void,
): Promise<{ client: TesseronClient; gateway: JsonRpcDispatcher }> {
  const client = new TesseronClient();
  client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });
  register(client);

  let clientMessageHandler: ((m: unknown) => void) | undefined;
  const gateway = new JsonRpcDispatcher((m) => {
    queueMicrotask(() => clientMessageHandler?.(m));
  });
  gateway.on('tesseron/hello', () => ({
    sessionId: 'test',
    protocolVersion: PROTOCOL_VERSION,
    capabilities: { streaming: false, subscriptions: false, sampling: false, elicitation: false },
    agent: { id: 'a', name: 'a' },
  }));

  const transport: Transport = {
    send: (m) => queueMicrotask(() => gateway.receive(m)),
    onMessage: (h) => {
      clientMessageHandler = h;
    },
    onClose: () => {},
    close: () => {},
  };

  await client.connect(transport);
  return { client, gateway };
}

describe('TesseronClient resource reads', () => {
  it('returns the reader value for a quick resource read', async () => {
    const { gateway } = await setupConnectedClient((c) => {
      c.resource('compositions').read(() => [{ id: 'cmp1' }, { id: 'cmp2' }]);
    });

    const result = await gateway.request('resources/read', { name: 'compositions' });

    expect(result).toEqual({ value: [{ id: 'cmp1' }, { id: 'cmp2' }] });
  });

  it('still surfaces synchronous reader errors as JSON-RPC errors', async () => {
    const { gateway } = await setupConnectedClient((c) => {
      c.resource('boom').read(() => {
        throw new Error('reader exploded');
      });
    });

    await expect(gateway.request('resources/read', { name: 'boom' })).rejects.toMatchObject({
      message: expect.stringContaining('reader exploded'),
    });
  });

  it('rejects with TimeoutError when the reader hangs past the default cap', async () => {
    vi.useFakeTimers();
    try {
      const { gateway } = await setupConnectedClient((c) => {
        c.resource('hangingResource').read(() => new Promise(() => {}));
      });

      const pending = gateway.request('resources/read', { name: 'hangingResource' });
      // Swallow rejection asynchronously so vitest doesn't see it as
      // unhandled while we advance timers.
      pending.catch(() => {});

      await vi.advanceTimersByTimeAsync(DEFAULT_RESOURCE_READ_TIMEOUT_MS + 10);

      await expect(pending).rejects.toMatchObject({
        code: TesseronErrorCode.Timeout,
        message: expect.stringContaining('Resource read "hangingResource"'),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
