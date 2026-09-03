import {
  type ConnectOptions,
  type ResumeCredentials,
  TesseronClient,
  TesseronError,
  TesseronErrorCode,
  type Transport,
  type WelcomeResult,
} from '@tesseron/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RESUME_STORAGE_KEY, type ResumeStorage, WebTesseronClient } from '../src/index.js';

/**
 * jsdom doesn't ship a working WebSocket. `BrowserWebSocketTransport` calls
 * `new globalThis.WebSocket(url)` inside its constructor, so for these tests
 * we drop in a fake that opens on the next microtask and exposes the
 * standard listener surface the transport touches. Patterned on the
 * React test's FakeWebSocket — the protocol layer is stubbed separately
 * (see `parentConnect` below), so the socket here only needs to satisfy
 * `BrowserWebSocketTransport.ready()`.
 */
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
    protocolVersion: '1.1.0',
    capabilities: {
      streaming: true,
      subscriptions: true,
      sampling: false,
      elicitation: false,
    },
    agent: { id: 'pending', name: 'Awaiting agent' },
    claimCode: 'AAA-BBB',
    resumeToken: 'tok-fresh',
    ...overrides,
  };
}

/**
 * Tests run against a real {@link WebTesseronClient} so they exercise the
 * new auto-persist branches, the dedup map, and the ResumeFailed fallback
 * path. The protocol layer (`TesseronClient.connect`) is stubbed because we
 * care about WHAT the SDK forwards, not how `tesseron/hello` is serialised.
 */
interface ParentCall {
  transport: Transport;
  options: ConnectOptions | undefined;
}
function stubParentConnect(plan: Array<WelcomeResult | Error>): {
  parentConnect: ReturnType<typeof vi.fn<typeof TesseronClient.prototype.connect>>;
  calls: ParentCall[];
} {
  const calls: ParentCall[] = [];
  let i = 0;
  const impl: typeof TesseronClient.prototype.connect = async (target, options) => {
    calls.push({ transport: target as Transport, options });
    const next = plan[i++];
    if (!next) throw new Error('no more planned parent responses');
    if (next instanceof Error) throw next;
    return next;
  };
  // `vi.spyOn` with `mockImplementation` keeps the original signature in scope
  // but loses it at the type level on the returned spy. Mirror the implementation
  // on a typed mock and feed it through, so assertions like `toHaveBeenCalledTimes`
  // stay typed.
  const parentConnect = vi.fn<typeof TesseronClient.prototype.connect>(impl);
  vi.spyOn(TesseronClient.prototype, 'connect').mockImplementation(parentConnect);
  return { parentConnect, calls };
}

beforeEach(() => {
  window.localStorage.clear();
  // @ts-expect-error - jsdom's WebSocket is missing; swap in the fake.
  globalThis.WebSocket = FakeWebSocket;
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.WebSocket = RealWebSocket;
});

describe('WebTesseronClient.connect - default auto-persist (resume omitted)', () => {
  it('persists the rotated resumeToken after a fresh hello', async () => {
    const { calls } = stubParentConnect([makeWelcome({ resumeToken: 'tok-A' })]);

    const client = new WebTesseronClient();
    const welcome = await client.connect('ws://x/y');

    expect(welcome.resumeToken).toBe('tok-A');
    // No saved creds were loaded, so super.connect() was called without a `resume` field.
    expect(calls[0]?.options).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(DEFAULT_RESUME_STORAGE_KEY)!)).toEqual({
      sessionId: 'sess-1',
      resumeToken: 'tok-A',
    });
  });

  it('loads saved creds and forwards them to tesseron/resume', async () => {
    window.localStorage.setItem(
      DEFAULT_RESUME_STORAGE_KEY,
      JSON.stringify({ sessionId: 's-saved', resumeToken: 'tok-saved' }),
    );
    const { calls } = stubParentConnect([
      makeWelcome({ sessionId: 's-saved', resumeToken: 'tok-rotated', claimCode: undefined }),
    ]);

    const client = new WebTesseronClient();
    const welcome = await client.connect('ws://x/y');

    expect(calls[0]?.options?.resume).toEqual({
      sessionId: 's-saved',
      resumeToken: 'tok-saved',
    });
    expect(welcome.resumeToken).toBe('tok-rotated');
    // After successful resume, the rotated token must overwrite the stale one.
    expect(JSON.parse(window.localStorage.getItem(DEFAULT_RESUME_STORAGE_KEY)!)).toEqual({
      sessionId: 's-saved',
      resumeToken: 'tok-rotated',
    });
  });

  it('clears storage and falls back to fresh hello on ResumeFailed', async () => {
    window.localStorage.setItem(
      DEFAULT_RESUME_STORAGE_KEY,
      JSON.stringify({ sessionId: 's-stale', resumeToken: 'tok-stale' }),
    );
    const { calls } = stubParentConnect([
      new TesseronError(TesseronErrorCode.ResumeFailed, 'No resumable session "s-stale".'),
      makeWelcome({ sessionId: 's-new', resumeToken: 'tok-new' }),
    ]);

    const client = new WebTesseronClient();
    const welcome = await client.connect('ws://x/y');

    expect(welcome.sessionId).toBe('s-new');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.options?.resume).toEqual({
      sessionId: 's-stale',
      resumeToken: 'tok-stale',
    });
    expect(calls[1]?.options).toEqual({});
    expect(JSON.parse(window.localStorage.getItem(DEFAULT_RESUME_STORAGE_KEY)!)).toEqual({
      sessionId: 's-new',
      resumeToken: 'tok-new',
    });
  });

  it('does not fall back on non-resume errors', async () => {
    const err = new Error('gateway unavailable');
    const { calls } = stubParentConnect([err]);

    const client = new WebTesseronClient();
    await expect(client.connect('ws://x/y')).rejects.toBe(err);
    expect(calls).toHaveLength(1);
  });
});

describe('WebTesseronClient.connect - resume: false', () => {
  it('skips storage entirely (no load, no save)', async () => {
    window.localStorage.setItem(
      DEFAULT_RESUME_STORAGE_KEY,
      JSON.stringify({ sessionId: 's-leftover', resumeToken: 'tok-leftover' }),
    );
    const { calls } = stubParentConnect([makeWelcome({ resumeToken: 'tok-new' })]);

    const client = new WebTesseronClient();
    await client.connect('ws://x/y', { resume: false });

    // Even though there were saved creds, no resume was attempted...
    expect(calls[0]?.options).toEqual({});
    // ...and the storage was untouched.
    expect(JSON.parse(window.localStorage.getItem(DEFAULT_RESUME_STORAGE_KEY)!)).toEqual({
      sessionId: 's-leftover',
      resumeToken: 'tok-leftover',
    });
  });
});

describe('WebTesseronClient.connect - resume: <string> (custom localStorage key)', () => {
  it('uses the provided key for load and save', async () => {
    const KEY = 'tesseron:my-app';
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ sessionId: 's-app', resumeToken: 'tok-app' }),
    );
    const { calls } = stubParentConnect([
      makeWelcome({ sessionId: 's-app', resumeToken: 'tok-rotated', claimCode: undefined }),
    ]);

    const client = new WebTesseronClient();
    await client.connect('ws://x/y', { resume: KEY });

    expect(calls[0]?.options?.resume).toEqual({ sessionId: 's-app', resumeToken: 'tok-app' });
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual({
      sessionId: 's-app',
      resumeToken: 'tok-rotated',
    });
    expect(window.localStorage.getItem(DEFAULT_RESUME_STORAGE_KEY)).toBeNull();
  });
});

describe('WebTesseronClient.connect - resume: ResumeStorage (custom backend)', () => {
  it('round-trips creds through the backend', async () => {
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
    stubParentConnect([makeWelcome({ resumeToken: 'tok-A' })]);

    const client = new WebTesseronClient();
    await client.connect('ws://x/y', { resume: backend });

    expect(backend.load).toHaveBeenCalledTimes(1);
    expect(backend.save).toHaveBeenCalledWith({ sessionId: 'sess-1', resumeToken: 'tok-A' });
    expect(stored.value).toEqual({ sessionId: 'sess-1', resumeToken: 'tok-A' });
  });

  it('treats a throwing load() as no saved creds', async () => {
    const backend: ResumeStorage = {
      load: vi.fn(() => {
        throw new Error('keychain locked');
      }),
      save: vi.fn(),
      clear: vi.fn(),
    };
    const { calls } = stubParentConnect([makeWelcome()]);

    const client = new WebTesseronClient();
    await client.connect('ws://x/y', { resume: backend });

    expect(calls[0]?.options).toEqual({});
    expect(backend.save).toHaveBeenCalled();
  });
});

describe('WebTesseronClient.connect - resume: ResumeCredentials (explicit, no auto-persist)', () => {
  it('forwards the creds and does not touch storage', async () => {
    stubParentConnect([
      makeWelcome({ sessionId: 's1', resumeToken: 'tok-rotated', claimCode: undefined }),
    ]);

    const client = new WebTesseronClient();
    await client.connect('ws://x/y', {
      resume: { sessionId: 's1', resumeToken: 'tok-explicit' },
    });

    // Explicit-creds form is the legacy contract — the caller manages
    // storage, so the SDK must not write to its default key.
    expect(window.localStorage.getItem(DEFAULT_RESUME_STORAGE_KEY)).toBeNull();
  });
});

describe('WebTesseronClient.connect - URL-form dedup', () => {
  it('shares a single connect promise across concurrent calls with matching resume options', async () => {
    const { parentConnect } = stubParentConnect([makeWelcome()]);

    const client = new WebTesseronClient();
    const a = client.connect('ws://x/y');
    const b = client.connect('ws://x/y');

    expect(a).toBe(b);
    await a;
    // Only one underlying super.connect() call despite two outer awaits.
    expect(parentConnect).toHaveBeenCalledTimes(1);
  });

  it('does not dedup when resume option differs', async () => {
    stubParentConnect([makeWelcome(), makeWelcome({ sessionId: 's-other' })]);

    const client = new WebTesseronClient();
    const a = client.connect('ws://x/y', { resume: false });
    const b = client.connect('ws://x/y', { resume: 'tesseron:other' });

    expect(a).not.toBe(b);
    await Promise.all([a, b]);
  });
});

describe('WebTesseronClient.connect - transport-form (no auto-persist)', () => {
  it('rejects storage-shaped resume options when the caller supplies a transport', async () => {
    const transport = { ready: () => Promise.resolve() } as unknown as Transport;
    const client = new WebTesseronClient();

    await expect(client.connect(transport, { resume: true })).rejects.toThrow(/URL form/);
    await expect(client.connect(transport, { resume: 'tesseron:x' })).rejects.toThrow(/URL form/);
  });
});
