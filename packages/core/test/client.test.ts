import { describe, expect, it } from 'vitest';
import {
  type ActionContext,
  PROTOCOL_VERSION,
  TesseronClient,
  TesseronErrorCode,
  TimeoutError,
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

  it('closes the transport when send() throws so the peer is not stranded', async () => {
    // Regression: an SDK response that fails to send (closing socket, JSON
    // serialisation failure on a circular result, ...) used to be silently
    // swallowed, stranding the peer's pending request forever. The wrapped
    // send must call transport.close() on any throw so transport.onClose
    // fires on the peer side and its rejectAllPending surfaces an error
    // instead of a hang.
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });
    client.resource('compositions').read(() => 'fine');

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

    let allowSend = true;
    let closed = false;
    const transport: Transport = {
      send: (m) => {
        if (!allowSend) throw new Error('socket dead');
        queueMicrotask(() => gateway.receive(m));
      },
      onMessage: (h) => {
        clientMessageHandler = h;
      },
      onClose: () => {},
      close: () => {
        closed = true;
      },
    };

    await client.connect(transport);

    // Now make subsequent sends fail (simulates the socket dying between the
    // hello response and the next response).
    allowSend = false;
    // Trigger a request the SDK will try to respond to. The send wrapper
    // should close the transport on the throw.
    void gateway.request('resources/read', { name: 'compositions' }).catch(() => {});
    // Drain microtasks so handleResourceRead runs.
    await new Promise((r) => setImmediate(r));

    expect(closed).toBe(true);
  });

  it('clears welcome.claimCode and updates agent when tesseron/claimed arrives', async () => {
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
      agent: { id: 'pending', name: 'Awaiting agent' },
      claimCode: 'CWGS-ND',
    }));

    const transport: Transport = {
      send: (m) => queueMicrotask(() => gateway.receive(m)),
      onMessage: (h) => {
        clientMessageHandler = h;
      },
      onClose: () => {},
      close: () => {},
    };

    const welcome = await client.connect(transport);
    expect(welcome.claimCode).toBe('CWGS-ND');
    expect(client.getWelcome()?.claimCode).toBe('CWGS-ND');

    const observed: Array<{ agentId: string; claimCode?: string }> = [];
    client.onWelcomeChange((w) => {
      observed.push({ agentId: w.agent.id, claimCode: w.claimCode });
    });

    // Gateway fires tesseron/claimed when an agent claims the session.
    gateway.notify('tesseron/claimed', {
      agent: { id: 'claude-code', name: 'Claude Code' },
      claimedAt: 1000,
    });
    // Drain the queueMicrotask cascade.
    await new Promise((r) => setImmediate(r));

    expect(observed).toEqual([{ agentId: 'claude-code', claimCode: undefined }]);
    expect(client.getWelcome()?.claimCode).toBeUndefined();
    expect(client.getWelcome()?.agent).toEqual({ id: 'claude-code', name: 'Claude Code' });
  });

  it('frees the wire with -32002 Timeout when the handler ignores ctx.signal', async () => {
    // Regression for #85: a handler awaiting a non-AbortSignal-aware promise
    // (modern-screenshot.domToPng, <img>.decode, etc.) used to hang the wire
    // forever — the agent's pending tools/call sat indefinitely because
    // `await action.handler(...)` never resolved. Now the SDK races the
    // handler against the abort signal so the timeout response always fires.
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });
    client
      .action('hangs')
      .timeout({ ms: 30 })
      // Intentionally ignore ctx.signal — represents a third-party promise
      // that doesn't accept an AbortSignal.
      .handler(() => new Promise<never>(() => {}));

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
        name: 'hangs',
        input: {},
        invocationId: 'inv-timeout',
      }),
    ).rejects.toMatchObject({ code: TesseronErrorCode.Timeout });
  });

  it('frees the wire with -32001 Cancelled when actions/cancel arrives on a stuck handler', async () => {
    // Companion to the timeout case: actions/cancel from the agent must also
    // free the wire even when the handler doesn't observe ctx.signal.
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });
    client
      .action('hangs')
      .timeout({ ms: 60_000 })
      .handler(() => new Promise<never>(() => {}));

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

    const pending = gateway.request('actions/invoke', {
      name: 'hangs',
      input: {},
      invocationId: 'inv-cancel',
    });
    // Let the SDK pick up the invoke before we cancel.
    await new Promise((r) => setImmediate(r));
    gateway.notify('actions/cancel', { invocationId: 'inv-cancel' });

    await expect(pending).rejects.toMatchObject({ code: TesseronErrorCode.Cancelled });
  });

  it('ctx.withTimeout resolves on success and rejects with TimeoutError on the inner deadline', async () => {
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });
    const captured: { resolved?: unknown; rejected?: unknown } = {};
    client
      .action('inner')
      .timeout({ ms: 5_000 })
      .handler(async (_input: unknown, ctx: ActionContext) => {
        // Fast inner promise resolves within the deadline.
        const ok = await ctx.withTimeout(Promise.resolve('ok'), 50);
        captured.resolved = ok;
        // Slow inner promise misses the deadline; helper rejects with TimeoutError.
        try {
          await ctx.withTimeout(new Promise<never>(() => {}), 20);
        } catch (err) {
          captured.rejected = err;
        }
        return 'done';
      });

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
      name: 'inner',
      input: {},
      invocationId: 'inv-with-timeout',
    });
    expect(result).toEqual({ invocationId: 'inv-with-timeout', output: 'done' });
    expect(captured.resolved).toBe('ok');
    expect(captured.rejected).toBeInstanceOf(TimeoutError);
    expect((captured.rejected as TimeoutError).code).toBe(TesseronErrorCode.Timeout);
  });
});
