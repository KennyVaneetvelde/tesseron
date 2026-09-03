import { describe, expect, it, vi } from 'vitest';
import { JSONRPC_VERSION, TesseronError } from '../src/index.js';
import { JsonRpcDispatcher } from '../src/internal.js';

function pair(): {
  a: JsonRpcDispatcher;
  b: JsonRpcDispatcher;
  sentByA: unknown[];
  sentByB: unknown[];
} {
  const sentByA: unknown[] = [];
  const sentByB: unknown[] = [];
  const a = new JsonRpcDispatcher((m) => {
    sentByA.push(m);
    queueMicrotask(() => b.receive(m));
  });
  const b = new JsonRpcDispatcher((m) => {
    sentByB.push(m);
    queueMicrotask(() => a.receive(m));
  });
  return { a, b, sentByA, sentByB };
}

describe('JsonRpcDispatcher', () => {
  it('routes request → response across a pair', async () => {
    const { a, b } = pair();
    b.on('echo', (params: unknown) => `echo:${(params as { msg: string }).msg}`);
    const result = await a.request('echo', { msg: 'hi' });
    expect(result).toBe('echo:hi');
  });

  it('delivers notifications without responses', async () => {
    const { a, b, sentByB } = pair();
    const handler = vi.fn();
    b.onNotification('ping', handler);
    a.notify('ping', { ts: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(handler).toHaveBeenCalledWith({ ts: 1 });
    expect(sentByB).toHaveLength(0);
  });

  it('rejects pending request when handler throws', async () => {
    const { a, b } = pair();
    b.on('boom', () => {
      throw new Error('explode');
    });
    await expect(a.request('boom', {})).rejects.toBeInstanceOf(TesseronError);
  });

  it('replies with method-not-found when no handler is registered', async () => {
    const { a } = pair();
    await expect(a.request('missing', {})).rejects.toMatchObject({
      message: expect.stringContaining('Method not found'),
    });
  });

  it('emits well-formed JSON-RPC envelopes', () => {
    const sent: unknown[] = [];
    const d = new JsonRpcDispatcher((m) => sent.push(m));
    d.notify('hello', { x: 1 });
    expect(sent).toEqual([{ jsonrpc: JSONRPC_VERSION, method: 'hello', params: { x: 1 } }]);
  });
});
