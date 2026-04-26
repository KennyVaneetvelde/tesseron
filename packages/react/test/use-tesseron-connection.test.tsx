import {
  type ConnectOptions,
  type ResumeCredentials,
  TesseronError,
  TesseronErrorCode,
  type WebTesseronClient,
  type WelcomeResult,
} from '@tesseron/web';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type ResumeStorage,
  type TesseronConnectionState,
  type UseTesseronConnectionOptions,
  useTesseronConnection,
} from '../src/index.js';

const STORAGE_KEY = 'tesseron:resume';

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
    connect: vi.fn(async (url?: string, options?: ConnectOptions) => {
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useTesseronConnection - default behaviour (no resume)', () => {
  it('calls connect(url) with no second argument', async () => {
    const welcome = makeWelcome();
    const { client, calls } = makeFakeClient([welcome]);

    const state = await renderUntilOpenOrError({ url: 'ws://x/y' }, client);

    expect(state.status).toBe('open');
    expect(state.welcome).toEqual(welcome);
    expect(state.claimCode).toBe('AAA-BBB');
    expect(state.resumeStatus).toBe('none');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ url: 'ws://x/y', options: undefined });
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

    expect(calls[0]?.options).toBeUndefined();
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
    expect(calls[1]?.options).toBeUndefined();
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
    expect(calls[0]?.options).toBeUndefined();
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
    expect(calls[0]?.options).toBeUndefined();
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
    expect(calls[0]?.options).toBeUndefined();
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
