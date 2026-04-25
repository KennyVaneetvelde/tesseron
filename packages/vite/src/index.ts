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

/** A frame buffered or forwarded across the bridge. Text frames are kept as
 * `string` so that re-`send()` produces a text frame; binary frames stay as
 * the original `RawData` (Buffer/ArrayBuffer/Buffer[]) and re-`send()` produces
 * a binary frame. */
type BridgePayload = string | RawData;

interface PendingTab {
  tabId: string;
  appName?: string;
  wsUrl: string;
  browserWs: WebSocket;
  gatewayWs?: WebSocket;
  /** Messages from browser buffered while the gateway connection is being established. */
  queue: BridgePayload[];
}

const WS_PATH_PREFIX = '/@tesseron/ws';
const TABS_DIR = join(homedir(), '.tesseron', 'tabs');
const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';

/** Decode a `ws` text-frame payload back to a string. `ws` always emits a
 * Buffer (or Buffer fragments) for text frames; we just need UTF-8 it. */
function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

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

            ws.on('message', (data: RawData, isBinary: boolean) => {
              // `ws` hands us a Buffer for both text and binary frames. Calling
              // send(Buffer) without options forwards as a binary frame, which
              // the browser receives as a Blob and the @tesseron/web transport
              // drops (it only handles string frames). Decode text frames back
              // to a string so the frame type round-trips correctly.
              const payload: RawData | string = isBinary ? data : rawDataToString(data);
              if (entry.gatewayWs?.readyState === 1 /* OPEN */) {
                entry.gatewayWs.send(payload);
              } else {
                entry.queue.push(payload);
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

            // Drain messages buffered while waiting for the gateway. Each
            // entry preserves its original frame type (string for text,
            // Buffer/etc. for binary) so re-`send` re-emits the correct frame.
            for (const msg of entry.queue) {
              ws.send(msg);
            }
            entry.queue = [];

            ws.on('message', (data: RawData, isBinary: boolean) => {
              const payload: RawData | string = isBinary ? data : rawDataToString(data);
              if (entry.browserWs.readyState === 1 /* OPEN */) {
                entry.browserWs.send(payload);
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
