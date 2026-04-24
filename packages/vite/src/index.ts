import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

export interface TesseronViteOptions {
  /** Human-readable app name written to the tab discovery file. Defaults to the Vite project directory name. */
  appName?: string;
}

interface PendingTab {
  tabId: string;
  appName?: string;
  wsUrl: string;
  browserWs: WebSocket;
  gatewayWs?: WebSocket;
  /** Messages from browser buffered while the gateway connection is being established. */
  queue: RawData[];
}

const WS_PATH_PREFIX = '/@tesseron/ws';
const TABS_DIR = join(homedir(), '.tesseron', 'tabs');
const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';

async function ensureTabsDir(): Promise<void> {
  await mkdir(TABS_DIR, { recursive: true });
}

async function writeTabFile(tab: PendingTab): Promise<void> {
  await ensureTabsDir();
  const file = join(TABS_DIR, `${tab.tabId}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        version: 1,
        tabId: tab.tabId,
        appName: tab.appName,
        wsUrl: tab.wsUrl,
        addedAt: Date.now(),
      },
      null,
      2,
    ),
  );
}

async function deleteTabFile(tabId: string): Promise<void> {
  const file = join(TABS_DIR, `${tabId}.json`);
  if (existsSync(file)) {
    await unlink(file).catch(() => {});
  }
}

/**
 * Tesseron Vite plugin. Exposes `/@tesseron/ws` on the Vite dev server so browser
 * apps can connect without a separate gateway port. Writes per-tab discovery files
 * to `~/.tesseron/tabs/` so the gateway can find and connect to each tab.
 */
export function tesseron(options: TesseronViteOptions = {}): Plugin {
  const tabs = new Map<string, PendingTab>();
  let serverUrl = '';

  return {
    name: 'tesseron',

    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer?.once('listening', () => {
        const addr = server.httpServer?.address();
        if (addr && typeof addr !== 'string') {
          // Use 'localhost' rather than the raw bind address so the URL works on
          // both IPv4 (127.0.0.1) and IPv6 (::1) systems — Vite on Windows
          // commonly binds to ::1, which is not reachable via 127.0.0.1.
          serverUrl = `http://localhost:${addr.port}`;
        }
      });

      server.httpServer?.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
        const url = req.url ?? '';

        // Browser tab connecting to /@tesseron/ws
        if (url === WS_PATH_PREFIX || url === `${WS_PATH_PREFIX}/`) {
          const protocols =
            req.headers['sec-websocket-protocol']?.split(',').map((s: string) => s.trim()) ?? [];
          // Reject if somehow the gateway is trying the plain path
          if (protocols.includes(GATEWAY_SUBPROTOCOL)) return;

          wss.handleUpgrade(req, socket, head, (ws) => {
            const tabId = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const wsUrl = `${serverUrl.replace(/^http/, 'ws')}${WS_PATH_PREFIX}/${tabId}`;
            const appName =
              options.appName ??
              (server.config.root ? server.config.root.split('/').pop() : undefined) ??
              'unknown';
            const entry: PendingTab = { tabId, appName, wsUrl, browserWs: ws, queue: [] };
            tabs.set(tabId, entry);

            writeTabFile(entry).catch((err: Error) =>
              process.stderr.write(`[tesseron] failed to write tab file: ${err.message}\n`),
            );

            ws.on('message', (data: RawData) => {
              if (entry.gatewayWs?.readyState === 1 /* OPEN */) {
                entry.gatewayWs.send(data as Buffer);
              } else {
                entry.queue.push(data);
              }
            });

            ws.on('close', () => {
              tabs.delete(tabId);
              entry.gatewayWs?.close(1000, 'Browser disconnected');
              deleteTabFile(tabId).catch(() => {});
            });

            ws.on('error', () => {
              tabs.delete(tabId);
              entry.gatewayWs?.close(1000, 'Browser error');
              deleteTabFile(tabId).catch(() => {});
            });
          });
          return;
        }

        // Gateway connecting to /@tesseron/ws/:tabId
        if (url.startsWith(`${WS_PATH_PREFIX}/`)) {
          const tabId = url.slice(WS_PATH_PREFIX.length + 1).split('?')[0]!;
          const entry = tabs.get(tabId);
          if (!entry) {
            socket.destroy();
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            entry.gatewayWs = ws;

            // Drain messages buffered while waiting for the gateway
            for (const msg of entry.queue) {
              ws.send(msg as Buffer);
            }
            entry.queue = [];

            ws.on('message', (data: RawData) => {
              if (entry.browserWs.readyState === 1 /* OPEN */) {
                entry.browserWs.send(data as Buffer);
              }
            });

            ws.on('close', () => {
              entry.gatewayWs = undefined;
            });

            ws.on('error', () => {
              entry.gatewayWs = undefined;
            });
          });
          return;
        }
      });

      server.httpServer?.on('close', () => {
        for (const tab of tabs.values()) {
          deleteTabFile(tab.tabId).catch(() => {});
        }
        tabs.clear();
      });
    },
  };
}
