import { Buffer } from 'node:buffer';
import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { type Server, createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Transport } from '@tesseron/core';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';

/**
 * Resolves the tab-discovery directory on every call rather than at module
 * load. Tests (and long-lived processes that change `$HOME` at runtime) need
 * this — capturing at load time meant a test sandbox set via `process.env.HOME`
 * before `beforeAll` was ignored because the module had already been evaluated.
 */
function getTabsDir(): string {
  return join(homedir(), '.tesseron', 'tabs');
}

function generateTabId(): string {
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface NodeWebSocketServerTransportOptions {
  /** App name written to the tab discovery file. Defaults to `'node'`. */
  appName?: string;
  /** Host/interface to bind. Defaults to `'127.0.0.1'` (loopback-only). */
  host?: string;
  /** Port to bind. Defaults to `0` (OS picks a free port). */
  port?: number;
}

/**
 * Transport that hosts a one-shot WebSocket server on loopback and announces
 * itself to the Tesseron gateway by writing `~/.tesseron/tabs/<tabId>.json`.
 * The gateway watches that directory, dials the advertised URL (using the
 * `tesseron-gateway` WS subprotocol), and the two ends then exchange the
 * standard Tesseron JSON-RPC traffic.
 *
 * The server accepts exactly one connection — the first client speaking the
 * `tesseron-gateway` subprotocol wins. Subsequent upgrade attempts are rejected.
 */
export class NodeWebSocketServerTransport implements Transport {
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private readonly opened: Promise<void>;
  private readonly tabId: string;
  private readonly options: NodeWebSocketServerTransportOptions;
  private server?: Server;
  private wss?: WebSocketServer;
  private ws?: WebSocket;
  private tabFile?: string;
  /** Messages queued before the gateway dials in. Drained on connection. */
  private readonly sendQueue: string[] = [];

  constructor(options: NodeWebSocketServerTransportOptions = {}) {
    this.options = options;
    this.tabId = generateTabId();
    this.opened = this.listen();
  }

  private async listen(): Promise<void> {
    const host = this.options.host ?? '127.0.0.1';
    const port = this.options.port ?? 0;
    const server = createServer();
    this.server = server;

    const wss = new WebSocketServer({ noServer: true });
    this.wss = wss;

    server.on('upgrade', (req, socket, head) => {
      const protocols =
        req.headers['sec-websocket-protocol']?.split(',').map((s) => s.trim()) ?? [];
      if (!protocols.includes(GATEWAY_SUBPROTOCOL)) {
        socket.destroy();
        return;
      }
      if (this.ws) {
        // Already bound to a gateway; reject duplicates.
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => this.attachGateway(ws));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Failed to obtain listening address');
    }
    const wsUrl = `ws://${host}:${addr.port}/`;
    await this.writeTabFile(wsUrl);
  }

  private attachGateway(ws: WebSocket): void {
    this.ws = ws;

    // Drain anything the caller tried to send before the gateway showed up.
    for (const msg of this.sendQueue) {
      ws.send(msg);
    }
    this.sendQueue.length = 0;

    ws.on('message', (data: RawData) => {
      let text: string;
      if (typeof data === 'string') {
        text = data;
      } else if (Buffer.isBuffer(data)) {
        text = data.toString('utf-8');
      } else if (Array.isArray(data)) {
        text = Buffer.concat(data).toString('utf-8');
      } else {
        text = Buffer.from(data).toString('utf-8');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      for (const handler of this.messageHandlers) handler(parsed);
    });

    ws.on('close', (_code: number, reason: Buffer) => {
      const text = reason.toString('utf-8');
      for (const handler of this.closeHandlers) handler(text);
    });
  }

  private async writeTabFile(wsUrl: string): Promise<void> {
    const tabsDir = getTabsDir();
    if (!existsSync(tabsDir)) {
      await mkdir(tabsDir, { recursive: true });
    }
    this.tabFile = join(tabsDir, `${this.tabId}.json`);
    await writeFile(
      this.tabFile,
      JSON.stringify(
        {
          version: 1,
          tabId: this.tabId,
          appName: this.options.appName ?? 'node',
          wsUrl,
          addedAt: Date.now(),
        },
        null,
        2,
      ),
    );
  }

  /** Resolves once the WS server is listening and the tab file has been written. */
  async ready(): Promise<void> {
    await this.opened;
  }

  send(message: unknown): void {
    const raw = JSON.stringify(message);
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      this.ws.send(raw);
    } else {
      this.sendQueue.push(raw);
    }
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandlers.push(handler);
  }

  close(reason?: string): void {
    if (this.tabFile && existsSync(this.tabFile)) {
      unlink(this.tabFile).catch(() => {});
    }
    this.ws?.close(1000, reason);
    this.wss?.close();
    this.server?.close();
  }
}
