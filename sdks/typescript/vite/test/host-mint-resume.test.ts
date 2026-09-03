/**
 * Coverage for the host-mint resume path introduced with the SessionManager.
 *
 * Scenario: a browser opens a WebSocket, sends `tesseron/hello`, gets a
 * welcome with a sessionId+resumeToken. The browser closes (refresh, tab
 * close). A fresh browser WebSocket opens within the idle TTL window and
 * sends `tesseron/resume` with those credentials. The plugin re-attaches
 * the new browser to the same {@link Session} — same sessionId, rotated
 * resumeToken, no new claim code, gateway-side bridge unaffected.
 *
 * Without a real gateway in the test harness we exercise only the host
 * side. The Session stays in the "unbound" state (no gateway dial), but
 * that's enough to verify the WS-level resume contract: the second
 * connect's welcome carries the same sessionId, a different (rotated)
 * resumeToken, and no claimCode.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TesseronErrorCode } from '@tesseron/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { tesseron } from '../src/index.js';

let sandbox: string;
let previousEnv: { HOME: string | undefined; USERPROFILE: string | undefined };

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'tesseron-vite-resume-success-'));
  previousEnv = {
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
  };
  process.env['HOME'] = sandbox;
  process.env['USERPROFILE'] = sandbox;
});

afterAll(() => {
  for (const [k, v] of Object.entries(previousEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(sandbox, { recursive: true, force: true });
});

const servers: Server[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets) {
    try {
      ws.close();
    } catch {
      // already closing
    }
  }
  sockets.length = 0;
  for (const s of servers) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  servers.length = 0;
  await new Promise<void>((resolve) => setImmediate(resolve));
});

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface BootOptions {
  /** Forwarded to the plugin. Tests that need a 0-TTL teardown set this. */
  sessionIdleTtlMs?: number;
}

async function bootPlugin(opts: BootOptions = {}): Promise<{ url: string }> {
  const httpServer = createServer();
  servers.push(httpServer);
  const mockServer = {
    httpServer,
    config: { root: '/test/project' },
  };
  const plugin = tesseron({ appName: 'resume-success-test', ...opts });
  (plugin.configureServer as (s: unknown) => void)(mockServer);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') throw new Error('listen failed');
  return { url: `ws://127.0.0.1:${addr.port}/@tesseron/ws` };
}

async function send(ws: WebSocket, frame: unknown): Promise<JsonRpcResponse> {
  return new Promise<JsonRpcResponse>((resolve, reject) => {
    const onMessage = (data: Buffer): void => {
      try {
        const text = data.toString('utf8');
        const parsed = JSON.parse(text) as JsonRpcResponse;
        ws.off('message', onMessage);
        resolve(parsed);
      } catch (err) {
        reject(err as Error);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify(frame));
  });
}

async function open(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err) => reject(err));
  });
  return ws;
}

async function helloAndCaptureCreds(
  url: string,
  appId: string,
): Promise<{ ws: WebSocket; sessionId: string; resumeToken: string; claimCode: string }> {
  const ws = await open(url);
  const response = await send(ws, {
    jsonrpc: '2.0',
    id: 'h1',
    method: 'tesseron/hello',
    params: {
      protocolVersion: '1.1.0',
      app: { id: appId, name: appId },
      actions: [],
      resources: [],
      capabilities: {
        streaming: true,
        subscriptions: true,
        sampling: false,
        elicitation: false,
      },
    },
  });
  expect(response.error).toBeUndefined();
  const result = response.result as Record<string, unknown> | undefined;
  if (
    typeof result?.['sessionId'] !== 'string' ||
    typeof result?.['resumeToken'] !== 'string' ||
    typeof result?.['claimCode'] !== 'string'
  ) {
    throw new Error('hello did not return expected creds');
  }
  return {
    ws,
    sessionId: result['sessionId'] as string,
    resumeToken: result['resumeToken'] as string,
    claimCode: result['claimCode'] as string,
  };
}

async function waitForClose(ws: WebSocket): Promise<void> {
  if (ws.readyState === ws.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once('close', () => resolve());
  });
}

describe('Vite plugin / host-mint resume — success path', () => {
  it('re-attaches a new browser WS to the same Session on valid resume', async () => {
    const { url } = await bootPlugin();
    const first = await helloAndCaptureCreds(url, 'my_app');

    // Simulate a page refresh: close the first browser WS, then open a new
    // one and send `tesseron/resume` with the stored creds.
    first.ws.close();
    await waitForClose(first.ws);

    const ws2 = await open(url);
    const response = await send(ws2, {
      jsonrpc: '2.0',
      id: 'r1',
      method: 'tesseron/resume',
      params: {
        protocolVersion: '1.1.0',
        sessionId: first.sessionId,
        resumeToken: first.resumeToken,
        app: { id: 'my_app', name: 'my_app' },
        actions: [],
        resources: [],
        capabilities: {
          streaming: true,
          subscriptions: true,
          sampling: false,
          elicitation: false,
        },
      },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as Record<string, unknown> | undefined;
    // Same sessionId — this is what the SDK persists and what makes refresh
    // resume invisible to the agent.
    expect(result?.['sessionId']).toBe(first.sessionId);
    // No claim code on a successful resume; the session is already
    // host-claimed and the user would otherwise be re-prompted for nothing.
    expect(result?.['claimCode']).toBeUndefined();
    // Token rotated to a different value than the one the SDK sent.
    expect(result?.['resumeToken']).toBeTypeOf('string');
    expect(result?.['resumeToken']).not.toBe(first.resumeToken);
  });

  it('rejects a second resume with the now-stale token (rotation is single-shot)', async () => {
    const { url } = await bootPlugin();
    const first = await helloAndCaptureCreds(url, 'my_app');
    first.ws.close();
    await waitForClose(first.ws);

    const ws2 = await open(url);
    const successResponse = await send(ws2, {
      jsonrpc: '2.0',
      id: 'r1',
      method: 'tesseron/resume',
      params: {
        protocolVersion: '1.1.0',
        sessionId: first.sessionId,
        resumeToken: first.resumeToken,
        app: { id: 'my_app', name: 'my_app' },
        actions: [],
        resources: [],
        capabilities: {
          streaming: true,
          subscriptions: true,
          sampling: false,
          elicitation: false,
        },
      },
    });
    expect(successResponse.error).toBeUndefined();

    // Same token, second time — must fail (the previous resume rotated it).
    ws2.close();
    await waitForClose(ws2);
    const ws3 = await open(url);
    const response2 = await send(ws3, {
      jsonrpc: '2.0',
      id: 'r2',
      method: 'tesseron/resume',
      params: {
        protocolVersion: '1.1.0',
        sessionId: first.sessionId,
        resumeToken: first.resumeToken, // the original, now stale token
        app: { id: 'my_app', name: 'my_app' },
        actions: [],
        resources: [],
        capabilities: {
          streaming: true,
          subscriptions: true,
          sampling: false,
          elicitation: false,
        },
      },
    });
    expect(response2.error?.code).toBe(TesseronErrorCode.ResumeFailed);
  });

  it('does not resume after the idle TTL elapses (TTL=0 path)', async () => {
    // sessionIdleTtlMs: 0 makes browser close destroy the Session immediately
    // — equivalent to a TTL that has already elapsed by the time the resume
    // arrives. Verifies the destruction path actually deregisters the
    // sessionId from the manager.
    const { url } = await bootPlugin({ sessionIdleTtlMs: 0 });
    const first = await helloAndCaptureCreds(url, 'my_app');
    first.ws.close();
    await waitForClose(first.ws);
    // Give the close handler a microtask tick to run the destroy().
    await new Promise<void>((resolve) => setImmediate(resolve));

    const ws2 = await open(url);
    const response = await send(ws2, {
      jsonrpc: '2.0',
      id: 'r1',
      method: 'tesseron/resume',
      params: {
        protocolVersion: '1.1.0',
        sessionId: first.sessionId,
        resumeToken: first.resumeToken,
        app: { id: 'my_app', name: 'my_app' },
        actions: [],
        resources: [],
        capabilities: {
          streaming: true,
          subscriptions: true,
          sampling: false,
          elicitation: false,
        },
      },
    });
    expect(response.error?.code).toBe(TesseronErrorCode.ResumeFailed);
    expect(response.error?.message).toMatch(/No resumable Tesseron session/i);
  });

  it('rejects resume with the correct sessionId but a wrong token (constant-time compare)', async () => {
    const { url } = await bootPlugin();
    const first = await helloAndCaptureCreds(url, 'my_app');
    first.ws.close();
    await waitForClose(first.ws);

    const ws2 = await open(url);
    // Same length as the real token but with a different value — exercises
    // the length-equal branch of the constant-time compare.
    const tamperedToken = first.resumeToken.split('').reverse().join('');
    const response = await send(ws2, {
      jsonrpc: '2.0',
      id: 'r1',
      method: 'tesseron/resume',
      params: {
        protocolVersion: '1.1.0',
        sessionId: first.sessionId,
        resumeToken: tamperedToken,
        app: { id: 'my_app', name: 'my_app' },
        actions: [],
        resources: [],
        capabilities: {
          streaming: true,
          subscriptions: true,
          sampling: false,
          elicitation: false,
        },
      },
    });
    expect(response.error?.code).toBe(TesseronErrorCode.ResumeFailed);
  });
});
