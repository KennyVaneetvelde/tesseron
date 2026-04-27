/**
 * Coverage for tesseron#68: the host-mint Vite plugin must respond to
 * `tesseron/resume` directly. The plugin mints a fresh sessionId and
 * resumeToken at every WS open, so any incoming resume's tokens belong
 * to a previous instance the host can no longer validate. Without an
 * explicit handler, the resume frame sat in the queue waiting for a
 * gateway dial that never arrives for an unclaimed instance — the SDK
 * hung at `status: 'connecting'` forever.
 *
 * The fix answers ResumeFailed (-32011) so the SDK clears its stored
 * creds and falls back to a fresh `tesseron/hello`.
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
  sandbox = mkdtempSync(join(tmpdir(), 'tesseron-vite-resume-'));
  previousEnv = {
    HOME: process.env['HOME'],
    USERPROFILE: process.env['USERPROFILE'],
  };
  // Sandbox manifest writes so this test doesn't pollute the real
  // `~/.tesseron/instances/`. Mirrors the manifest test setup.
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
  // Let the plugin's async manifest deletes settle so afterAll's sandbox
  // teardown doesn't race with in-flight writePrivateFile renames.
  await new Promise<void>((resolve) => setImmediate(resolve));
});

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

async function bootPlugin(): Promise<{ url: string }> {
  const httpServer = createServer();
  servers.push(httpServer);
  // Build a minimal ViteDevServer mock that exercises the plugin's
  // `configureServer` path — only `httpServer` and `config.root` are
  // touched.
  const mockServer = {
    httpServer,
    config: { root: '/test/project' },
  };
  const plugin = tesseron({ appName: 'resume-test' });
  // configureServer is typed for the real Vite type but accepts our
  // partial mock at runtime.
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

describe('Vite plugin / tesseron/resume on host-mint path (tesseron#68)', () => {
  it('answers tesseron/resume with ResumeFailed instead of hanging', async () => {
    const { url } = await bootPlugin();
    const ws = await open(url);

    const response = await send(ws, {
      jsonrpc: '2.0',
      id: 99,
      method: 'tesseron/resume',
      params: {
        protocolVersion: '1.1.0',
        sessionId: 'sess-from-previous-page-load',
        resumeToken: 'tok-stale',
        app: { id: 'my-app', name: 'My App' },
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

    expect(response.jsonrpc).toBe('2.0');
    expect(response.id).toBe(99);
    expect(response.result).toBeUndefined();
    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(TesseronErrorCode.ResumeFailed);
    expect(response.error?.message).toMatch(/host-minted session does not honour resume/i);
  });

  it('still synthesizes a fresh hello after a rejected resume on the same socket', async () => {
    // Defensive: make sure the resume rejection path doesn't poison
    // entry.helloAnswered or otherwise break the subsequent fresh hello
    // the SDK falls back to. (The SDK normally does the fresh hello on
    // a *new* socket, but the plugin shouldn't depend on that.)
    const { url } = await bootPlugin();
    const ws = await open(url);

    await send(ws, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tesseron/resume',
      params: {
        protocolVersion: '1.1.0',
        sessionId: 'stale',
        resumeToken: 'stale',
        app: { id: 'fallback_test', name: 'Fallback' },
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

    const helloResponse = await send(ws, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tesseron/hello',
      params: {
        protocolVersion: '1.1.0',
        app: { id: 'fallback_test', name: 'Fallback' },
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

    expect(helloResponse.id).toBe(2);
    expect(helloResponse.error).toBeUndefined();
    const result = helloResponse.result as Record<string, unknown> | undefined;
    expect(result?.['claimCode']).toBeTypeOf('string');
    expect(result?.['sessionId']).toBeTypeOf('string');
    expect(result?.['resumeToken']).toBeTypeOf('string');
  });
});
