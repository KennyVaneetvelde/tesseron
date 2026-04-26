import { existsSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';

export interface TesseronViteOptions {
  /** Human-readable app name written to the instance manifest. Defaults to the Vite project directory name. */
  appName?: string;
}

/** A frame buffered or forwarded across the bridge. Text frames are kept as
 * `string` so that re-`send()` produces a text frame; binary frames stay as
 * the original `RawData` (Buffer/ArrayBuffer/Buffer[]) and re-`send()` produces
 * a binary frame. */
type BridgePayload = string | RawData;

interface PendingInstance {
  instanceId: string;
  appName?: string;
  wsUrl: string;
  browserWs: WebSocket;
  gatewayWs?: WebSocket;
  /** Messages from browser buffered while the gateway connection is being established. */
  queue: BridgePayload[];
}

const WS_PATH_PREFIX = '/@tesseron/ws';
const INSTANCES_DIR = join(homedir(), '.tesseron', 'instances');
const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';

/** Decode a `ws` text-frame payload back to a string. `ws` always emits a
 * Buffer (or Buffer fragments) for text frames; we just need UTF-8 it. */
function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

async function ensureInstancesDir(): Promise<void> {
  await mkdir(INSTANCES_DIR, { recursive: true });
}

async function writeManifest(inst: PendingInstance): Promise<void> {
  await ensureInstancesDir();
  const file = join(INSTANCES_DIR, `${inst.instanceId}.json`);
  await writeFile(
    file,
    JSON.stringify(
      {
        version: 2,
        instanceId: inst.instanceId,
        appName: inst.appName,
        addedAt: Date.now(),
        transport: { kind: 'ws', url: inst.wsUrl },
      },
      null,
      2,
    ),
  );
}

async function deleteManifest(instanceId: string): Promise<void> {
  const file = join(INSTANCES_DIR, `${instanceId}.json`);
  if (existsSync(file)) {
    await unlink(file).catch(() => {});
  }
}

/**
 * Tesseron Vite plugin. Exposes `/@tesseron/ws` on the Vite dev server so
 * browser apps can connect without a separate gateway port. Writes per-tab
 * instance manifests to `~/.tesseron/instances/` so the gateway can find and
 * connect to each open tab.
 */
export function tesseron(options: TesseronViteOptions = {}): Plugin {
  const instances = new Map<string, PendingInstance>();
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
            const instanceId = `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
            const wsUrl = `${serverUrl.replace(/^http/, 'ws')}${WS_PATH_PREFIX}/${instanceId}`;
            const appName =
              options.appName ??
              (server.config.root ? server.config.root.split('/').pop() : undefined) ??
              'unknown';
            const entry: PendingInstance = {
              instanceId,
              appName,
              wsUrl,
              browserWs: ws,
              queue: [],
            };
            instances.set(instanceId, entry);

            writeManifest(entry).catch((err: Error) =>
              process.stderr.write(
                `[tesseron] failed to write instance manifest: ${err.message}\n`,
              ),
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
              instances.delete(instanceId);
              entry.gatewayWs?.close(1000, 'Browser disconnected');
              deleteManifest(instanceId).catch(() => {});
            });

            ws.on('error', () => {
              instances.delete(instanceId);
              entry.gatewayWs?.close(1000, 'Browser error');
              deleteManifest(instanceId).catch(() => {});
            });
          });
          return;
        }

        // Gateway connecting to /@tesseron/ws/:instanceId
        if (url.startsWith(`${WS_PATH_PREFIX}/`)) {
          const instanceId = url.slice(WS_PATH_PREFIX.length + 1).split('?')[0]!;
          const entry = instances.get(instanceId);
          if (!entry) {
            socket.destroy();
            return;
          }

          // Single-owner binding. The first gateway to upgrade owns the
          // session for this instance; later upgrades on the same
          // instanceId would overwrite `entry.gatewayWs` and silently split
          // the bridge - the welcome+claim code already left through the
          // first gateway, so the user-visible code can no longer be
          // claimed via the second one. Reject with HTTP 409 and let the
          // race-loser's `dialed.opened` reject; its dispatcher then
          // backs off via the gateway's poll loop instead of fighting.
          //
          // Only reject when the existing slot is CONNECTING (0) or OPEN
          // (1). CLOSING (2) or CLOSED (3) means the previous owner is on
          // its way out; the close/error handlers below will null
          // `gatewayWs` once the event fires, but the new dial may have
          // arrived first. Treating those as free avoids a stuck slot if
          // the close event is dropped (rare with abrupt RST).
          if (
            entry.gatewayWs &&
            (entry.gatewayWs.readyState === 0 || entry.gatewayWs.readyState === 1)
          ) {
            process.stderr.write(
              `[tesseron] rejecting second gateway upgrade for instance ${instanceId} (already bound; first-gateway-wins). See tesseron#53.\n`,
            );
            const body =
              'Another Tesseron gateway is already bound to this instance. See tesseron#53.';
            // socket.end() flushes the response before FIN; socket.destroy()
            // would issue an RST and the race-loser would see ECONNRESET
            // instead of the 409, making it indistinguishable from a Vite
            // crash.
            socket.end(
              `HTTP/1.1 409 Conflict\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(
                body,
              )}\r\nConnection: close\r\n\r\n${body}`,
            );
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
                return;
              }
              // The browser side of this instance is no longer accepting
              // messages (closing or closed). Silently dropping the frame
              // would orphan whichever request the gateway just sent here -
              // the gateway's dispatcher would wait forever for a response
              // that can never arrive. Tear down the gateway WS so the
              // gateway sees a close, fires `rejectAllPending`, and surfaces
              // the failure to its caller (the MCP tool call) instead.
              ws.close(1011, 'Browser side of bridge is not OPEN');
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
        for (const inst of instances.values()) {
          deleteManifest(inst.instanceId).catch(() => {});
        }
        instances.clear();
      });
    },
  };
}
