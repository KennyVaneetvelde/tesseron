import type { Transport } from '@tesseron/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TesseronGateway } from '../src/index.js';

/**
 * Tests the gateway's protocol-version handshake policy:
 *  - exact match: silent.
 *  - minor mismatch (1.0.x ↔ 1.1.x): accepted with stderr warn.
 *  - major mismatch: hard rejected with `-32000 ProtocolMismatch`.
 *
 * Drives the gateway directly through a paired in-memory transport so the
 * binding doesn't matter — `handleConnection` is binding-neutral.
 */

interface PairedTransport {
  forGateway: Transport;
  forSdk: Transport;
}

function pair(): PairedTransport {
  const sdkMessageHandlers: Array<(m: unknown) => void> = [];
  const gatewayMessageHandlers: Array<(m: unknown) => void> = [];
  const sdkCloseHandlers: Array<(reason?: string) => void> = [];
  const gatewayCloseHandlers: Array<(reason?: string) => void> = [];

  const forGateway: Transport = {
    send(message: unknown): void {
      queueMicrotask(() => {
        for (const h of sdkMessageHandlers) h(message);
      });
    },
    onMessage(handler) {
      gatewayMessageHandlers.push(handler);
    },
    onClose(handler) {
      gatewayCloseHandlers.push(handler);
    },
    close() {
      for (const h of gatewayCloseHandlers) h('test close');
    },
  };

  const forSdk: Transport = {
    send(message: unknown): void {
      queueMicrotask(() => {
        for (const h of gatewayMessageHandlers) h(message);
      });
    },
    onMessage(handler) {
      sdkMessageHandlers.push(handler);
    },
    onClose(handler) {
      sdkCloseHandlers.push(handler);
    },
    close() {
      for (const h of sdkCloseHandlers) h('test close');
    },
  };

  return { forGateway, forSdk };
}

async function sendHello(
  forSdk: Transport,
  protocolVersion: string,
): Promise<{ id: 1; result?: unknown; error?: { code: number; message: string } }> {
  const responsePromise = new Promise<{
    id: 1;
    result?: unknown;
    error?: { code: number; message: string };
  }>((resolve) => {
    forSdk.onMessage((msg) => {
      const m = msg as { id?: number };
      if (m.id === 1) resolve(msg as never);
    });
  });
  forSdk.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'tesseron/hello',
    params: {
      protocolVersion,
      app: { id: 'vt_app', name: 'version test', origin: 'http://localhost' },
      actions: [],
      resources: [],
      capabilities: { streaming: true, subscriptions: true, sampling: false, elicitation: false },
    },
  });
  return responsePromise;
}

describe('protocol version handshake', () => {
  let gateway: TesseronGateway;

  beforeEach(() => {
    gateway = new TesseronGateway();
  });

  afterEach(async () => {
    await gateway.stop();
  });

  it('accepts an exact-version hello', async () => {
    const { forGateway, forSdk } = pair();
    gateway.handleConnection(forGateway);
    const resp = await sendHello(forSdk, '1.2.0');
    expect(resp.error).toBeUndefined();
    expect((resp.result as { protocolVersion: string }).protocolVersion).toBe('1.2.0');
  });

  it('accepts a minor-mismatch hello (1.x ↔ 1.y)', async () => {
    const { forGateway, forSdk } = pair();
    gateway.handleConnection(forGateway);
    const resp = await sendHello(forSdk, '1.0.0');
    expect(resp.error).toBeUndefined();
    expect((resp.result as { protocolVersion: string }).protocolVersion).toBe('1.2.0');
  });

  it('hard-rejects a major-mismatch hello with -32000 ProtocolMismatch', async () => {
    const { forGateway, forSdk } = pair();
    gateway.handleConnection(forGateway);
    const resp = await sendHello(forSdk, '2.0.0');
    expect(resp.result).toBeUndefined();
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toMatch(/Major version mismatch/);
  });
});
