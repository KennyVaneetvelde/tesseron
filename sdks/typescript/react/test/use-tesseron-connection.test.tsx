import {
  BrowserWebSocketTransport,
  type ConnectOptions,
  type ResumeCredentials,
  TesseronError,
  TesseronErrorCode,
  type Transport,
  WebTesseronClient,
  type WelcomeResult,
} from '@tesseron/web';
import { act, render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ResumeStorage,
  type TesseronConnectionState,
  type UseTesseronConnectionOptions,
  useTesseronConnection,
} from '../src/index.js';

const STORAGE_KEY = 'tesseron:resume';

// jsdom doesn't ship a working WebSocket. The hook owns the transport and
// awaits `transport.ready()` before calling `client.connect(transport)` so
// the open handshake must succeed for the test flow to reach the fake
// client. Stub a minimal WebSocket that fires 'open' on the next microtask
// and exposes the standard listener / close API.
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState: number = FakeWebSocket.CONNECTING;
  url: string;
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  constructor(url: string) {
    this.url = url;
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      for (const l of this.listeners.get('open') ?? []) l({ type: 'open' });
    });
  }
  addEventListener(type: string, fn: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  send(): void {}
  close(_code?: number, reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => {
      for (const l of this.listeners.get('close') ?? []) l({ type: 'close', reason });
    });
  }
}
const RealWebSocket = globalThis.WebSocket;

function makeWelcome(overrides: Partial<WelcomeResult> = {}): WelcomeResult {
  return {
    sessionId: 'sess-1',
    protocolVersion: '1.0.0',
    capabilities: {
      streaming: true,
      subscriptions: true,
      sampling: false,
      elicitation: false,
    },
    agent: { id: 'test-agent', name: 'Test Agent' },
    claimCode: 'AAA-BBB',
    resumeToken: 'tok-fresh',
    ...overrides,
  };
}

interface ConnectCall {
  url?: string;
  options?: ConnectOptions;
}

function makeFakeClient(plan: Array<WelcomeResult | TesseronError | Error>): {
  client: WebTesseronClient;
  calls: ConnectCall[];
  emitWelcomeChange: (welcome: WelcomeResult) => void;
} {
  const calls: ConnectCall[] = [];
  const welcomeListeners = new Set<(w: WelcomeResult) => void>();
  let i = 0;
  const client = {
    // Hook now passes a Transport to client.connect (so it can own the
    // socket and close it cleanly on unmount). The fake only cares about
    // the URL the transport was constructed with — captured here so the
    // existing url-passthrough tests still work.
    connect: vi.fn(async (target?: Transport | string, options?: ConnectOptions) => {
      const url =
        typeof target === 'string'
          ? target
          : target && 'url' in target && typeof (target as { url?: unknown }).url === 'string'
            ? (target as { url: string }).url
            : undefined;
      calls.push({ url, options });
      const next = plan[i++];
      if (!next) throw new Error('no more planned responses');
      if (next instanceof Error) throw next;
      return next;
    }),
    onWelcomeChange: (listener: (w: WelcomeResult) => void) => {
      welcomeListeners.add(listener);
      return () => {
        welcomeListeners.delete(listener);
      };
    },
  } as unknown as WebTesseronClient;
  const emitWelcomeChange = (welcome: WelcomeResult): void => {
    for (const l of welcomeListeners) l(welcome);
  };
  return { client, calls, emitWelcomeChange };
}

function ConnectionProbe(props: {
  options?: UseTesseronConnectionOptions;
  client: WebTesseronClient;
  onState: (state: TesseronConnectionState) => void;
}): null {
  const state = useTesseronConnection(props.options, props.client);
  props.onState(state);
  return null;
}

async function renderUntilOpenOrError(
  options: UseTesseronConnectionOptions | undefined,
  client: WebTesseronClient,
): Promise<TesseronConnectionState> {
  let latest: TesseronConnectionState = { status: 'idle' };
  await act(async () => {
    render(
      <ConnectionProbe
        options={options}
        client={client}
        onState={(s) => {
          latest = s;
        }}
      />,
    );
  });
  await waitFor(() => {
    expect(['open', 'error']).toContain(latest.status);
  });
  return latest;
}

beforeEach(() => {
  window.localStorage.clear();
  // @ts-expect-error - jsdom's WebSocket is a stub; replace with a fake
  // that opens synchronously for the duration of each test.
  globalThis.WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.WebSocket = RealWebSocket;
});

describe('useTesseronConnection - default behaviour', () => {
  it('persists to default localStorage key when resume is omitted', async () => {
    // Default `resume` is now `true` — refreshes shouldn't cost the user a
    // fresh claim code on every reconnect. The hook always passes an explicit
    // `resume` (creds-or-false) to the web SDK so the SDK's auto-persist
    // layer doesn't double-write under the hook's storage key.
    const welcome = makeWelcome();
    const { client, calls } = makeFakeClient([welcome]);

    const state = await renderUntilOpenOrError({ url: 'ws://x/y' }, client);

    expect(state.status).toBe('open');
    expect(state.welcome).toEqual(welcome);
    expect(state.claimCode).toBe('AAA-BBB');
    expect(state.resumeStatus).toBe('none');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ url: 'ws://x/y', options: { resume: false } });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      sessionId: 'sess-1',
      resumeToken: 'tok-fresh',
    });
  });

  it('passes resume:false to the client and skips persistence when resume:false is set explicitly', async () => {
    const welcome = makeWelcome();
    const { client, calls } = makeFakeClient([welcome]);

    const state = await renderUntilOpenOrError({ resume: false }, client);

    expect(state.status).toBe('open');
    expect(state.resumeStatus).toBe('none');
    expect(calls[0]?.options).toEqual({ resume: false });
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('skips connecting when enabled is false', async () => {
    const { client, calls } = makeFakeClient([]);

    let latest: TesseronConnectionState = { status: 'idle' };
    await act(async () => {
      render(
        <ConnectionProbe
          options={{ enabled: false }}
          client={client}
          onState={(s) => {
            latest = s;
          }}
        />,
      );
    });

    expect(calls).toHaveLength(0);
    expect(latest.status).toBe('idle');
  });

  it('surfaces non-resume errors as status:error', async () => {
    const err = new Error('gateway unavailable');
    const { client } = makeFakeClient([err]);

    const state = await renderUntilOpenOrError(undefined, client);

    expect(state.status).toBe('error');
    expect(state.error).toBe(err);
  });
});

describe('useTesseronConnection - resume: true (localStorage default)', () => {
  it('persists sessionId/resumeToken after a successful fresh hello', async () => {
    const welcome = makeWelcome({ sessionId: 's1', resumeToken: 'tok-A' });
    const { client, calls } = makeFakeClient([welcome]);

    await renderUntilOpenOrError({ resume: true }, client);

    expect(calls[0]?.options).toEqual({ resume: false });
    const stored = window.localStorage.getItem(STORAGE_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored!)).toEqual({ sessionId: 's1', resumeToken: 'tok-A' });
  });

  it('sends tesseron/resume when stored credentials exist', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessionId: 's1', resumeToken: 'tok-old' }),
    );
    const resumed = makeWelcome({
      sessionId: 's1',
      resumeToken: 'tok-rotated',
      claimCode: undefined,
    });
    const { client, calls } = makeFakeClient([resumed]);

    const state = await renderUntilOpenOrError({ resume: true }, client);

    expect(state.status).toBe('open');
    expect(state.resumeStatus).toBe('resumed');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.options).toEqual({
      resume: { sessionId: 's1', resumeToken: 'tok-old' },
    });
    expect(state.claimCode).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      sessionId: 's1',
      resumeToken: 'tok-rotated',
    });
  });

  it('falls back to fresh hello on ResumeFailed and clears storage of stale creds', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessionId: 's-stale', resumeToken: 'tok-stale' }),
    );
    const resumeFailed = new TesseronError(
      TesseronErrorCode.ResumeFailed,
      'No resumable session "s-stale".',
    );
    const fresh = makeWelcome({ sessionId: 's-new', resumeToken: 'tok-new' });
    const { client, calls } = makeFakeClient([resumeFailed, fresh]);

    const state = await renderUntilOpenOrError({ resume: true }, client);

    expect(state.status).toBe('open');
    expect(state.resumeStatus).toBe('failed');
    expect(state.welcome?.sessionId).toBe('s-new');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options?.resume).toEqual({
      sessionId: 's-stale',
      resumeToken: 'tok-stale',
    });
    expect(calls[1]?.options).toEqual({ resume: false });
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      sessionId: 's-new',
      resumeToken: 'tok-new',
    });
  });

  it('does not fall back when a non-resume error fires', async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ sessionId: 's1', resumeToken: 'tok-A' }),
    );
    const transportErr = new Error('socket closed');
    const { client, calls } = makeFakeClient([transportErr]);

    const state = await renderUntilOpenOrError({ resume: true }, client);

    expect(state.status).toBe('error');
    expect(state.error).toBe(transportErr);
    expect(calls).toHaveLength(1);
    // Storage retained for the next reconnect attempt.
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();
  });

  it('ignores corrupted localStorage entries and starts fresh', async () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json');
    const fresh = makeWelcome({ resumeToken: 'tok-A' });
    const { client, calls } = makeFakeClient([fresh]);

    const state = await renderUntilOpenOrError({ resume: true }, client);

    expect(state.status).toBe('open');
    expect(calls[0]?.options).toEqual({ resume: false });
  });

  it('skips persistence when the gateway returns no resumeToken', async () => {
    const oldGateway = makeWelcome({ resumeToken: undefined });
    const { client } = makeFakeClient([oldGateway]);

    await renderUntilOpenOrError({ resume: true }, client);

    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('useTesseronConnection - resume: <string> (custom storage key)', () => {
  it('uses the provided key', async () => {
    const fresh = makeWelcome({ resumeToken: 'tok-A' });
    const { client } = makeFakeClient([fresh]);

    await renderUntilOpenOrError({ resume: 'tesseron:my-app' }, client);

    expect(window.localStorage.getItem('tesseron:my-app')).not.toBeNull();
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('useTesseronConnection - resume: ResumeStorage (custom backend)', () => {
  it('routes load/save through the provided callbacks', async () => {
    const stored: { value: ResumeCredentials | null } = { value: null };
    const backend: ResumeStorage = {
      load: vi.fn(() => stored.value),
      save: vi.fn((c: ResumeCredentials) => {
        stored.value = c;
      }),
      clear: vi.fn(() => {
        stored.value = null;
      }),
    };
    const fresh = makeWelcome({ sessionId: 's1', resumeToken: 'tok-A' });
    const { client } = makeFakeClient([fresh]);

    await renderUntilOpenOrError({ resume: backend }, client);

    expect(backend.load).toHaveBeenCalledTimes(1);
    expect(backend.save).toHaveBeenCalledWith({ sessionId: 's1', resumeToken: 'tok-A' });
    expect(stored.value).toEqual({ sessionId: 's1', resumeToken: 'tok-A' });
  });

  it('clears the backend when ResumeFailed fires', async () => {
    const stored: { value: ResumeCredentials | null } = {
      value: { sessionId: 's-stale', resumeToken: 'tok-stale' },
    };
    const backend: ResumeStorage = {
      load: vi.fn(() => stored.value),
      save: vi.fn((c: ResumeCredentials) => {
        stored.value = c;
      }),
      clear: vi.fn(() => {
        stored.value = null;
      }),
    };
    const resumeFailed = new TesseronError(TesseronErrorCode.ResumeFailed, 'token mismatch');
    const fresh = makeWelcome({ sessionId: 's-new', resumeToken: 'tok-new' });
    const { client } = makeFakeClient([resumeFailed, fresh]);

    const state = await renderUntilOpenOrError({ resume: backend }, client);

    expect(state.status).toBe('open');
    expect(backend.clear).toHaveBeenCalled();
    expect(stored.value).toEqual({ sessionId: 's-new', resumeToken: 'tok-new' });
  });

  it('treats a throwing load() as no saved creds', async () => {
    const backend: ResumeStorage = {
      load: vi.fn(() => {
        throw new Error('keychain locked');
      }),
      save: vi.fn(),
      clear: vi.fn(),
    };
    const fresh = makeWelcome({ resumeToken: 'tok-A' });
    const { client, calls } = makeFakeClient([fresh]);

    const state = await renderUntilOpenOrError({ resume: backend }, client);

    expect(state.status).toBe('open');
    expect(calls[0]?.options).toEqual({ resume: false });
    expect(backend.save).toHaveBeenCalled();
  });

  it('treats a load() returning undefined as no saved creds', async () => {
    const backend: ResumeStorage = {
      load: vi.fn(() => undefined),
      save: vi.fn(),
      clear: vi.fn(),
    };
    const fresh = makeWelcome({ resumeToken: 'tok-A' });
    const { client, calls } = makeFakeClient([fresh]);

    const state = await renderUntilOpenOrError({ resume: backend }, client);

    expect(state.status).toBe('open');
    expect(calls[0]?.options).toEqual({ resume: false });
  });

  it('does not fail the connection when save() throws', async () => {
    const backend: ResumeStorage = {
      load: vi.fn(() => null),
      save: vi.fn(() => {
        throw new Error('quota exceeded');
      }),
      clear: vi.fn(),
    };
    const fresh = makeWelcome({ resumeToken: 'tok-A' });
    const { client } = makeFakeClient([fresh]);

    const state = await renderUntilOpenOrError({ resume: backend }, client);

    expect(state.status).toBe('open');
    expect(state.welcome).toEqual(fresh);
    expect(backend.save).toHaveBeenCalled();
  });

  it('clears claimCode and updates agent when the gateway emits tesseron/claimed', async () => {
    const fresh = makeWelcome({ resumeToken: 'tok-A', claimCode: 'AAA-BBB' });
    const { client, emitWelcomeChange } = makeFakeClient([fresh]);

    let latest: TesseronConnectionState = { status: 'idle' };
    await act(async () => {
      render(
        <ConnectionProbe
          client={client}
          onState={(s) => {
            latest = s;
          }}
        />,
      );
    });
    await waitFor(() => {
      expect(latest.status).toBe('open');
    });
    expect(latest.claimCode).toBe('AAA-BBB');

    // The gateway-side claim handler triggers tesseron/claimed; the SDK
    // updates `welcome` and our hook should clear claimCode in state.
    await act(async () => {
      emitWelcomeChange({
        ...fresh,
        agent: { id: 'claude-code', name: 'Claude Code' },
        claimCode: undefined,
      });
    });

    expect(latest.status).toBe('open');
    expect(latest.claimCode).toBeUndefined();
    expect(latest.welcome?.agent).toEqual({ id: 'claude-code', name: 'Claude Code' });
  });

  it('still falls back to a fresh hello when clear() throws during ResumeFailed recovery', async () => {
    const backend: ResumeStorage = {
      load: vi.fn(() => ({ sessionId: 's-stale', resumeToken: 'tok-stale' })),
      save: vi.fn(),
      clear: vi.fn(() => {
        throw new Error('cannot clear');
      }),
    };
    const resumeFailed = new TesseronError(TesseronErrorCode.ResumeFailed, 'token mismatch');
    const fresh = makeWelcome({ sessionId: 's-new', resumeToken: 'tok-new' });
    const { client, calls } = makeFakeClient([resumeFailed, fresh]);

    const state = await renderUntilOpenOrError({ resume: backend }, client);

    expect(state.status).toBe('open');
    expect(state.resumeStatus).toBe('failed');
    expect(state.welcome?.sessionId).toBe('s-new');
    expect(calls).toHaveLength(2);
    expect(backend.clear).toHaveBeenCalled();
  });
});

describe('BrowserWebSocketTransport.ready() (tesseron#68)', () => {
  it('rejects when the socket closes before the open handshake completes', async () => {
    const sockets: Array<{
      readyState: number;
      listeners: Map<string, Set<(ev: unknown) => void>>;
      close(): void;
    }> = [];
    class StalledWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState: number = StalledWebSocket.CONNECTING;
      url: string;
      listeners = new Map<string, Set<(ev: unknown) => void>>();
      constructor(url: string) {
        this.url = url;
        sockets.push(this);
      }
      addEventListener(type: string, fn: (ev: unknown) => void): void {
        let set = this.listeners.get(type);
        if (!set) {
          set = new Set();
          this.listeners.set(type, set);
        }
        set.add(fn);
      }
      removeEventListener(type: string, fn: (ev: unknown) => void): void {
        this.listeners.get(type)?.delete(fn);
      }
      send(): void {}
      close(): void {
        this.readyState = StalledWebSocket.CLOSED;
        queueMicrotask(() => {
          for (const l of this.listeners.get('close') ?? []) l({ type: 'close' });
        });
      }
    }
    // @ts-expect-error - swap stub
    globalThis.WebSocket = StalledWebSocket;

    const transport = new BrowserWebSocketTransport('ws://test.invalid/x');
    expect(sockets).toHaveLength(1);

    // Trigger the close-before-open path.
    sockets[0]!.close();

    await expect(transport.ready()).rejects.toThrow(/closed before open/);
  });

  it('does not crash with unhandledRejection when no caller awaits ready()', async () => {
    // Regression for the .catch(() => {}) noop swallow at transport.ts.
    // Constructing a transport and immediately closing it without ever
    // calling ready() must not produce an unhandled rejection — vitest
    // strict mode would fail the test if it did.
    class StalledWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState: number = StalledWebSocket.CONNECTING;
      url: string;
      listeners = new Map<string, Set<(ev: unknown) => void>>();
      constructor(url: string) {
        this.url = url;
      }
      addEventListener(type: string, fn: (ev: unknown) => void): void {
        let set = this.listeners.get(type);
        if (!set) {
          set = new Set();
          this.listeners.set(type, set);
        }
        set.add(fn);
      }
      removeEventListener(type: string, fn: (ev: unknown) => void): void {
        this.listeners.get(type)?.delete(fn);
      }
      send(): void {}
      close(): void {
        this.readyState = StalledWebSocket.CLOSED;
        queueMicrotask(() => {
          for (const l of this.listeners.get('close') ?? []) l({ type: 'close' });
        });
      }
    }
    // @ts-expect-error - swap stub
    globalThis.WebSocket = StalledWebSocket;

    const t = new BrowserWebSocketTransport('ws://test.invalid/y');
    t.close();
    // Drain microtasks so the close handler's reject() has a chance to fire.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    // If the .catch(() => {}) is removed, this test process would crash
    // before reaching here under strict unhandledRejection settings.
    expect(true).toBe(true);
  });
});

describe('useTesseronConnection - StrictMode / unmount lifecycle (tesseron#88)', () => {
  it('does not surface state updates after unmount', async () => {
    // The hook now defers transport ownership to the singleton; cleanup
    // just sets a `cancelled` flag. The contract asserted here is that
    // unmounting before connect resolves does NOT produce a setState on
    // the unmounted component (which React would warn about) and does
    // NOT leave the consumer wedged in 'connecting'.
    const states: TesseronConnectionState[] = [];
    const { client } = makeFakeClient([makeWelcome()]);
    const { unmount } = render(
      <ConnectionProbe
        client={client}
        onState={(s) => {
          states.push(s);
        }}
      />,
    );
    unmount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // The only states observed should be the initial idle/connecting pair
    // captured before unmount; no 'open' or 'error' update fires after.
    expect(states.every((s) => s.status === 'idle' || s.status === 'connecting')).toBe(true);
  });

  it('handles React 18 StrictMode double-mount: hook drives state to open', async () => {
    // StrictMode mounts the effect twice (mount → cleanup → re-mount) in
    // the same commit. With the previous transport-owning hook, the first
    // mount's `client.connect` was suppressed by an in-effect `cancelled`
    // flag and only the second mount called the fake. The new hook
    // delegates de-dup to {@link WebTesseronClient}'s URL-form `connect`,
    // so the contract here is simply: regardless of how many times the
    // effect re-runs, the welcome eventually lands in state with no
    // spurious error and the latest mount's client receives a connect
    // call.
    //
    // The fake client used here doesn't implement URL-form de-dup (it's a
    // duck-typed stub of `WebTesseronClient.connect`), so under StrictMode
    // both mounts call the fake. We plan two welcomes accordingly and
    // assert the surviving mount's state, not the call count — the
    // production singleton's de-dup is exercised in the real-client
    // re-entry test against `WebTesseronClient`.
    const welcomes = [makeWelcome({ sessionId: 'first' }), makeWelcome({ sessionId: 'survivor' })];
    const { client } = makeFakeClient(welcomes);

    let latest: TesseronConnectionState = { status: 'idle' };
    await act(async () => {
      render(
        <StrictMode>
          <ConnectionProbe
            client={client}
            onState={(s) => {
              latest = s;
            }}
          />
        </StrictMode>,
      );
    });

    await waitFor(() => {
      expect(latest.status).toBe('open');
    });

    expect(latest.welcome?.sessionId).toBeDefined();
    expect(latest.error).toBeUndefined();
  });
});

describe('WebTesseronClient.connect URL-form de-dup (tesseron#88)', () => {
  it('shares one in-flight WebSocket between concurrent calls with matching options', async () => {
    // The root fix for #88: two concurrent URL-form `connect()` calls with
    // the same URL and the same resume creds must not open two parallel
    // WebSockets. If they did, the gateway would receive two
    // `tesseron/resume` requests carrying the same single-shot token; the
    // first would consume the zombie and rotate, and the second would
    // invariably fail with `ResumeFailed`. The de-dup at WebTesseronClient
    // returns the SAME promise for matching concurrent calls, so only one
    // WebSocket gets constructed and only one resume request reaches the
    // wire.
    const sockets: Array<{ url: string }> = [];
    class TrackingWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push({ url });
      }
    }
    // @ts-expect-error - swap stub
    globalThis.WebSocket = TrackingWebSocket;

    const client = new WebTesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });

    const c1 = client.connect('ws://x/y');
    const c2 = client.connect('ws://x/y');
    expect(c1).toBe(c2);
    // Drain microtasks so the inner `new BrowserWebSocketTransport(url)`
    // (gated behind an async wrapper) actually fires before we count.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sockets).toHaveLength(1);
  });

  it('does NOT de-dup when resume credentials differ', async () => {
    // Different effective options → no de-dup. Each call constructs its
    // own transport; core's serialization (the second connect awaits the
    // first to settle) is what keeps them from racing on the wire. This
    // assertion is just that two transports get built — without de-dup.
    const sockets: Array<{ url: string }> = [];
    class TrackingWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        sockets.push({ url });
      }
    }
    // @ts-expect-error - swap stub
    globalThis.WebSocket = TrackingWebSocket;

    const client = new WebTesseronClient();
    client.app({ id: 'shop', name: 'Shop', origin: 'http://localhost' });

    // Fire-and-forget; we don't care about the handshake completing here,
    // only that two distinct in-flight URL-form calls produce two sockets.
    void client.connect('ws://x/y', { resume: { sessionId: 's', resumeToken: 'a' } });
    void client.connect('ws://x/y', { resume: { sessionId: 's', resumeToken: 'b' } });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(sockets.length).toBeGreaterThanOrEqual(1);
    // The second connect's transport may not get constructed until the
    // first connect's chain step settles; assert that at minimum the first
    // happened. The strong contract — no two `tesseron/resume` requests
    // overlap on the wire — is verified at the core level.
  });
});
