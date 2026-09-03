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

  it('serializes connect() re-entry: prior is superseded, new handshake waits for drain (regression #88)', async () => {
    // Regression for #88. Two re-entries used to race over `this.transport`:
    // call 2 closed call 1's socket mid-handshake, frames in flight on either
    // socket — including the gateway's `tesseron/resume` response — could be
    // lost, and a claimed session ended up displaying a fresh claim code
    // instead of resuming. The fix:
    //   1. Eagerly closes the prior transport on re-entry so the prior
    //      connect's pending hello/resume rejects via `TransportClosedError`
    //      instead of hanging forever.
    //   2. Awaits the prior connect's settlement AND the prior transport's
    //      `onClose` drain before installing a new dispatcher and sending
    //      the new handshake. Without the drain wait, a late-firing onClose
    //      could trample the new dispatcher's state.
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });

    type Pair = {
      transport: Transport;
      gateway: JsonRpcDispatcher;
      sentHellos: number;
      release: (welcome: unknown) => void;
      closed: boolean;
    };

    const makePair = (sessionId: string): Pair => {
      let release!: (welcome: unknown) => void;
      const helloGate = new Promise<unknown>((r) => {
        release = r;
      });
      const pair: Pair = {
        transport: undefined as unknown as Transport,
        gateway: undefined as unknown as JsonRpcDispatcher,
        sentHellos: 0,
        release,
        closed: false,
      };
      let clientMessageHandler: ((m: unknown) => void) | undefined;
      let clientCloseHandler: ((reason?: string) => void) | undefined;
      const gateway = new JsonRpcDispatcher((m) => {
        queueMicrotask(() => clientMessageHandler?.(m));
      });
      gateway.on('tesseron/hello', async () => {
        pair.sentHellos += 1;
        const w = await helloGate;
        return w as {
          sessionId: string;
          protocolVersion: typeof PROTOCOL_VERSION;
          capabilities: {
            streaming: boolean;
            subscriptions: boolean;
            sampling: boolean;
            elicitation: boolean;
          };
          agent: { id: string; name: string };
        };
      });
      const transport: Transport = {
        send: (m) => queueMicrotask(() => gateway.receive(m)),
        onMessage: (h) => {
          clientMessageHandler = h;
        },
        onClose: (h) => {
          clientCloseHandler = h;
        },
        close: () => {
          if (pair.closed) return;
          pair.closed = true;
          clientCloseHandler?.(`closed-${sessionId}`);
        },
      };
      pair.transport = transport;
      pair.gateway = gateway;
      return pair;
    };

    const p1 = makePair('a');
    const p2 = makePair('b');

    const c1 = client.connect(p1.transport);
    // First handshake reaches the gateway.
    await new Promise((r) => setImmediate(r));
    expect(p1.sentHellos).toBe(1);
    expect(p1.closed).toBe(false);

    // Second connect supersedes the first: closes p1 synchronously, fails
    // c1 with TransportClosedError, queues the new handshake behind the
    // drain. The new handshake's `tesseron/hello` only fires after p1's
    // onClose has finished cleaning up — i.e., on the next microtask tick.
    const c2 = client.connect(p2.transport);
    expect(p1.closed).toBe(true);
    await expect(c1).rejects.toMatchObject({ name: 'TransportClosedError' });

    // After the chain unblocks, p2's hello reaches the (p2) gateway.
    await new Promise((r) => setImmediate(r));
    expect(p2.sentHellos).toBe(1);

    p2.release({
      sessionId: 'sess-2',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        streaming: false,
        subscriptions: false,
        sampling: false,
        elicitation: false,
      },
      agent: { id: 'b', name: 'b' },
    });
    const w2 = await c2;
    expect(w2.sessionId).toBe('sess-2');
  });

  it('aborts middle members of a 3+ rapid re-entry chain so only the latest doConnect runs (regression #88)', async () => {
    // Without the version-check supersede, a 3+ deep synchronous re-entry
    // could leak the middle transport: by the time c3's chain step ran,
    // c2's doConnect had attached t2, c3 hadn't seen it (its sync eager
    // close looked at the t1-or-undefined this.transport), and c3 then
    // overwrote this.transport=t3 without closing t2 — a phantom session
    // on the gateway, exactly the symptom we're fixing for two-call.
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });

    type Pair = {
      transport: Transport;
      gateway: JsonRpcDispatcher;
      sentHellos: number;
      release: (welcome: unknown) => void;
      closed: boolean;
    };
    const makePair = (sessionId: string): Pair => {
      let release!: (welcome: unknown) => void;
      const helloGate = new Promise<unknown>((r) => {
        release = r;
      });
      const pair: Pair = {
        transport: undefined as unknown as Transport,
        gateway: undefined as unknown as JsonRpcDispatcher,
        sentHellos: 0,
        release,
        closed: false,
      };
      let clientMessageHandler: ((m: unknown) => void) | undefined;
      let clientCloseHandler: ((reason?: string) => void) | undefined;
      const gateway = new JsonRpcDispatcher((m) => {
        queueMicrotask(() => clientMessageHandler?.(m));
      });
      gateway.on('tesseron/hello', async () => {
        pair.sentHellos += 1;
        const w = await helloGate;
        return w as {
          sessionId: string;
          protocolVersion: typeof PROTOCOL_VERSION;
          capabilities: {
            streaming: boolean;
            subscriptions: boolean;
            sampling: boolean;
            elicitation: boolean;
          };
          agent: { id: string; name: string };
        };
      });
      const transport: Transport = {
        send: (m) => queueMicrotask(() => gateway.receive(m)),
        onMessage: (h) => {
          clientMessageHandler = h;
        },
        onClose: (h) => {
          clientCloseHandler = h;
        },
        close: () => {
          if (pair.closed) return;
          pair.closed = true;
          clientCloseHandler?.(`closed-${sessionId}`);
        },
      };
      pair.transport = transport;
      pair.gateway = gateway;
      return pair;
    };

    const p1 = makePair('a');
    const p2 = makePair('b');
    const p3 = makePair('c');

    // Three synchronous re-entries: only p3 should reach the gateway.
    const c1 = client.connect(p1.transport);
    const c2 = client.connect(p2.transport);
    const c3 = client.connect(p3.transport);

    // c1 and c2 are superseded by c3's higher version and reject before
    // their doConnect runs; their transports were never attached, so no
    // hello goes out on either.
    await expect(c1).rejects.toMatchObject({ name: 'TransportClosedError' });
    await expect(c2).rejects.toMatchObject({ name: 'TransportClosedError' });

    // p3's hello reaches the gateway after the chain settles.
    await new Promise((r) => setImmediate(r));
    expect(p1.sentHellos).toBe(0);
    expect(p2.sentHellos).toBe(0);
    expect(p3.sentHellos).toBe(1);

    p3.release({
      sessionId: 'sess-3',
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {
        streaming: false,
        subscriptions: false,
        sampling: false,
        elicitation: false,
      },
      agent: { id: 'c', name: 'c' },
    });
    const w3 = await c3;
    expect(w3.sessionId).toBe('sess-3');
  });

  it('disconnect() during a pending chain step aborts the in-flight handshake (regression #88)', async () => {
    // disconnect() previously only called `this.transport?.close()`. If
    // the chain step was still awaiting `prior` or `priorClosed` when
    // disconnect() fired, `this.transport` was undefined (doConnect
    // hadn't run), so the close was a no-op and the handshake proceeded
    // to attach a transport against the caller's intent. Now disconnect
    // bumps `connectVersion`, so the pending step bails at its supersede
    // check before it ever reaches doConnect.
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });

    let helloFired = false;
    let clientMessageHandler: ((m: unknown) => void) | undefined;
    let clientCloseHandler: ((reason?: string) => void) | undefined;
    const gateway = new JsonRpcDispatcher((m) => {
      queueMicrotask(() => clientMessageHandler?.(m));
    });
    gateway.on('tesseron/hello', () => {
      helloFired = true;
      return {
        sessionId: 'should-not-attach',
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          streaming: false,
          subscriptions: false,
          sampling: false,
          elicitation: false,
        },
        agent: { id: 'a', name: 'a' },
      };
    });
    const transport: Transport = {
      send: (m) => queueMicrotask(() => gateway.receive(m)),
      onMessage: (h) => {
        clientMessageHandler = h;
      },
      onClose: (h) => {
        clientCloseHandler = h;
      },
      close: () => clientCloseHandler?.('disconnected'),
    };

    // A first connect with no chain prior so its `await prior` is a
    // no-op; the supersede yield inside the chain step is what we're
    // exercising.
    const c1 = client.connect(transport);
    // disconnect immediately, before the IIFE has yielded back from
    // its `await Promise.resolve()`. The version bump means c1's chain
    // step throws TransportClosedError instead of proceeding to
    // doConnect → sending hello.
    await client.disconnect();
    await expect(c1).rejects.toMatchObject({ name: 'TransportClosedError' });
    // No hello reached the gateway — the handshake was actually aborted.
    expect(helloFired).toBe(false);
  });

  it('eager-closes a previously-settled connect on a fresh re-entry (HMR module re-execution)', async () => {
    // After a successful connect, the chain promise resolves and is
    // cleared. A subsequent connect (HMR re-running module-scope code,
    // a deliberate reconnect, etc.) must still close the prior transport
    // and complete a fresh handshake — otherwise the gateway sees a
    // phantom claimed session against a dead socket.
    const client = new TesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });

    type Pair = {
      transport: Transport;
      gateway: JsonRpcDispatcher;
      closed: boolean;
    };
    const makePair = (sessionId: string): Pair => {
      const pair: Pair = {
        transport: undefined as unknown as Transport,
        gateway: undefined as unknown as JsonRpcDispatcher,
        closed: false,
      };
      let clientMessageHandler: ((m: unknown) => void) | undefined;
      let clientCloseHandler: ((reason?: string) => void) | undefined;
      const gateway = new JsonRpcDispatcher((m) => {
        queueMicrotask(() => clientMessageHandler?.(m));
      });
      gateway.on('tesseron/hello', () => ({
        sessionId,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {
          streaming: false,
          subscriptions: false,
          sampling: false,
          elicitation: false,
        },
        agent: { id: sessionId, name: sessionId },
      }));
      const transport: Transport = {
        send: (m) => queueMicrotask(() => gateway.receive(m)),
        onMessage: (h) => {
          clientMessageHandler = h;
        },
        onClose: (h) => {
          clientCloseHandler = h;
        },
        close: () => {
          if (pair.closed) return;
          pair.closed = true;
          clientCloseHandler?.(`closed-${sessionId}`);
        },
      };
      pair.transport = transport;
      pair.gateway = gateway;
      return pair;
    };

    const p1 = makePair('one');
    const p2 = makePair('two');

    const w1 = await client.connect(p1.transport);
    expect(w1.sessionId).toBe('one');
    expect(p1.closed).toBe(false);

    // Fresh re-entry on the settled chain — the prior transport must be
    // closed before the new handshake begins.
    const w2 = await client.connect(p2.transport);
    expect(w2.sessionId).toBe('two');
    expect(p1.closed).toBe(true);
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
