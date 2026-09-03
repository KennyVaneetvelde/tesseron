/**
 * Coverage for the host-mint resume contract.
 *
 * Previous behavior (tesseron#68): the plugin rejected *every* `tesseron/resume`
 * because each new browser WebSocket open minted a fresh sessionId and
 * resumeToken host-side, leaving any incoming resume token unverifiable.
 *
 * Current behavior: the plugin owns a {@link Session} keyed by the host-minted
 * `sessionId`. Browser WSes attach via either `tesseron/hello` (create a new
 * Session) or `tesseron/resume` (re-attach to an existing Session if the token
 * matches). A resume request whose `sessionId` is unknown — or whose token
 * doesn't validate — still gets `ResumeFailed` so the SDK can fall back to a
 * fresh hello. The successful-resume path is exercised in
 * `host-mint-resume.test.ts`.
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

describe('Vite plugin / tesseron/resume — rejection paths', () => {
  it('answers ResumeFailed when the sessionId is unknown (no matching Session)', async () => {
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
        app: { id: 'my_app', name: 'My App' },
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
    expect(response.error?.message).toMatch(/No resumable Tesseron session/i);
  });

  it('answers ResumeFailed when sessionId/resumeToken are missing or non-string', async () => {
    const { url } = await bootPlugin();
    const ws = await open(url);

    const response = await send(ws, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tesseron/resume',
      params: {
        protocolVersion: '1.1.0',
        // sessionId omitted
        app: { id: 'my_app', name: 'My App' },
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

    expect(response.id).toBe(7);
    expect(response.error?.code).toBe(TesseronErrorCode.ResumeFailed);
    expect(response.error?.message).toMatch(/malformed|required strings/i);
  });

  it('still synthesizes a fresh hello after a rejected resume on the same socket', async () => {
    // Defensive: make sure the rejection path doesn't poison the Session
    // state and break a subsequent fresh hello on the same socket. (The
    // SDK normally opens a new socket for fallback, but the plugin
    // shouldn't depend on that.)
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
