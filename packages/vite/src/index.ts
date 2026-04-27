import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentIdentity, HelloParams, WelcomeResult } from '@tesseron/core';
import { PROTOCOL_VERSION } from '@tesseron/core';
import { constantTimeEqual, parseBindSubprotocol } from '@tesseron/core/internal';
import type { Plugin, ViteDevServer } from 'vite';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import { mintClaimCode, mintResumeToken, mintSessionId } from './claim-mint.js';
import { writePrivateFile } from './fs-hygiene.js';

export interface TesseronViteOptions {
  /** Human-readable app name written to the instance manifest. Defaults to the Vite project directory name. */
  appName?: string;
}

/** A frame buffered or forwarded across the bridge. Text frames are kept as
 * `string` so that re-`send()` produces a text frame; binary frames stay as
 * the original `RawData` (Buffer/ArrayBuffer/Buffer[]) and re-`send()` produces
 * a binary frame. */
type BridgePayload = string | RawData;

/** Mirrors `HostMintedClaim` from `@tesseron/core/transport-spec`. The local */
/* alias keeps the Vite plugin from depending on the core type's import */
/* surface for what's a single-property descriptor used here. */
interface HostMintedClaim {
  code: string;
  sessionId: string;
  resumeToken: string;
  mintedAt: number;
  boundAgent: AgentIdentity | null;
}

interface PendingInstance {
  instanceId: string;
  appName?: string;
  wsUrl: string;
  browserWs: WebSocket;
  gatewayWs?: WebSocket;
  /** Messages from browser buffered while the gateway connection is being established. */
  queue: BridgePayload[];
  /**
   * Locally-minted claim metadata (tesseron#60). Populated at instance
   * creation; published to the gateway via the manifest's `hostMintedClaim`
   * field. Drives both the synthesized welcome the plugin sends to the SDK
   * on a v1.2 gateway dial and the constant-time bind-subprotocol check on
   * the gateway upgrade.
   */
  hostMintedClaim: HostMintedClaim;
  /**
   * Set when the gateway dialed with a valid `tesseron-bind.<code>`
   * subprotocol element. From here the plugin synthesizes the welcome
   * locally and uses an internal id to discard the gateway's reply to the
   * replayed hello (see {@link helloReplayId}). Absent ⇒ legacy gateway
   * dial; the plugin behaves exactly as it did pre-tesseron#60.
   */
  boundViaSubprotocol: boolean;
  /**
   * JSON-RPC id used when replaying the cached hello to the gateway in v3
   * mode. The gateway's response carries the same id; the plugin drops
   * that frame instead of forwarding it to the SDK (the SDK already saw
   * the plugin's synthesized welcome).
   */
  helloReplayId?: string;
}

const WS_PATH_PREFIX = '/@tesseron/ws';
const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';

/**
 * Resolve the instance-discovery directory at call time rather than module
 * load. Tests (and long-lived processes that change `$HOME` at runtime) need
 * this — capturing at load meant a sandbox set via `process.env.HOME` after
 * the plugin was imported wrote to the host's real `~/.tesseron/instances/`.
 * Mirrors the lazy pattern in `@tesseron/server`.
 */
function getInstancesDir(): string {
  return join(homedir(), '.tesseron', 'instances');
}

function generateInstanceId(): string {
  // CSPRNG-sourced like the rest of `~/.tesseron/*` writes. Instance IDs
  // aren't bearer tokens (the gateway still requires the standard
  // handshake), but the consistency with claim/session/resume token
  // generation matters for security review.
  const buf = new Uint8Array(4);
  globalThis.crypto.getRandomValues(buf);
  const rand = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
  return `inst-${Date.now().toString(36)}-${rand}`;
}

/** Decode a `ws` text-frame payload back to a string. `ws` always emits a
 * Buffer (or Buffer fragments) for text frames; we just need UTF-8 it. */
function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

/**
 * Parse a queued bridge payload back to JSON, or null if it isn't a JSON
 * text frame. Used by the v3 path to identify the SDK's hello request and
 * the gateway's reply to the replayed hello.
 */
function parseJsonFrame(payload: BridgePayload | string): unknown {
  let text: string;
  if (typeof payload === 'string') {
    text = payload;
  } else if (Buffer.isBuffer(payload)) {
    text = payload.toString('utf8');
  } else if (Array.isArray(payload)) {
    text = Buffer.concat(payload).toString('utf8');
  } else {
    text = Buffer.from(payload as ArrayBuffer).toString('utf8');
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * `true` iff the payload is a JSON-RPC request whose `method` is
 * `tesseron/hello`. Used to find the SDK's hello frame in the queue at
 * v3-bind time so the plugin can synthesize a welcome and replay the
 * frame to the gateway.
 */
function isHelloRequest(payload: BridgePayload | string): boolean {
  const parsed = parseJsonFrame(payload);
  return (
    parsed !== null &&
    typeof parsed === 'object' &&
    (parsed as { method?: unknown }).method === 'tesseron/hello'
  );
}

/** Minimal subset of {@link PendingInstance} the manifest writer needs.
 *  Exported alongside {@link writeInstanceManifest} so a test can call the
 *  helper directly without standing up a real WebSocket. */
export interface InstanceManifestInput {
  instanceId: string;
  appName?: string;
  wsUrl: string;
  /**
   * When set, the manifest advertises `helloHandledByHost: true` and a
   * matching `hostMintedClaim`. Omitted callers (e.g. legacy tests) get the
   * pre-tesseron#60 manifest shape exactly.
   */
  hostMintedClaim?: HostMintedClaim;
}

/**
 * Exported so the manifest contract can be unit-tested without booting a Vite
 * dev server. `process.pid` and `Date.now()` still come from the runtime, so
 * a test asserts on the pid stamp by inspecting the produced file.
 *
 * Uses {@link writePrivateFile} so the manifest lands with mode 0o600 inside
 * a 0o700 parent dir — a sibling local process under the same user can no
 * longer enumerate/read instance manifests just by walking `~/.tesseron/`.
 */
export async function writeInstanceManifest(inst: InstanceManifestInput): Promise<void> {
  const file = join(getInstancesDir(), `${inst.instanceId}.json`);
  // The manifest schema doesn't bump major when host-mint fields land —
  // released v1.1 gateways do a strict `data.version !== 2` check, so a
  // bumped tag would silently skip every v3 file. New fields are optional;
  // old gateways read the manifest as their existing v2 shape. See
  // `@tesseron/core/transport-spec.ts` for the authoritative contract.
  const payload: Record<string, unknown> = {
    version: 2,
    instanceId: inst.instanceId,
    appName: inst.appName,
    addedAt: Date.now(),
    // Stamp the Vite dev-server pid so a gateway that boots later can
    // probe `process.kill(pid, 0)` and skip manifests whose owning process
    // is already dead (e.g. a Vite session killed without a clean
    // `httpServer.close`, leaving an orphan `<id>.json`). See tesseron#53.
    pid: process.pid,
    transport: { kind: 'ws', url: inst.wsUrl },
  };
  if (inst.hostMintedClaim !== undefined) {
    payload['helloHandledByHost'] = true;
    payload['hostMintedClaim'] = inst.hostMintedClaim;
  }
  await writePrivateFile(file, JSON.stringify(payload, null, 2));
}

async function deleteManifest(instanceId: string): Promise<void> {
  const file = join(getInstancesDir(), `${instanceId}.json`);
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
            const instanceId = generateInstanceId();
            const wsUrl = `${serverUrl.replace(/^http/, 'ws')}${WS_PATH_PREFIX}/${instanceId}`;
            const appName =
              options.appName ??
              (server.config.root ? server.config.root.split('/').pop() : undefined) ??
              'unknown';
            // Mint the host-side claim metadata at instance creation. The
            // code is what the user pastes into the MCP agent; the
            // sessionId / resumeToken populate the synthesized welcome
            // the plugin sends to the SDK in v3 mode. The mint always
            // happens — even for old-gateway environments — because the
            // plugin doesn't know yet whether the upcoming gateway dial
            // will speak v1.2. The v1.1 path simply ignores the host-mint
            // values and lets the gateway mint its own. See tesseron#60.
            const hostMintedClaim: HostMintedClaim = {
              code: mintClaimCode(),
              sessionId: mintSessionId(),
              resumeToken: mintResumeToken(),
              mintedAt: Date.now(),
              boundAgent: null,
            };
            const entry: PendingInstance = {
              instanceId,
              appName,
              wsUrl,
              browserWs: ws,
              queue: [],
              hostMintedClaim,
              boundViaSubprotocol: false,
            };
            instances.set(instanceId, entry);

            writeInstanceManifest(entry).catch((err: Error) =>
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

          // Parse the `Sec-WebSocket-Protocol` header for a bind element.
          // A v1.2 gateway sends `tesseron-gateway, tesseron-bind.<code>`
          // when it dials in response to `tesseron__claim_session`. The
          // host validates the bind code against its in-memory mint
          // before accepting the upgrade — a mismatch produces a 403,
          // a missing bind element (legacy v1.1 dial) takes the legacy
          // path. See `@tesseron/core/bind-subprotocol`.
          const protoHeader = req.headers['sec-websocket-protocol'];
          const bind = parseBindSubprotocol(
            Array.isArray(protoHeader) ? protoHeader.join(', ') : protoHeader,
          );
          if (bind.code !== null) {
            // Constant-time compare against the minted code to deny a
            // timing-side-channel attacker enumerating prefixes via
            // upgrade-rejection latency.
            if (!constantTimeEqual(bind.code, entry.hostMintedClaim.code)) {
              process.stderr.write(
                `[tesseron] rejecting bind subprotocol upgrade for instance ${instanceId} (code mismatch)\n`,
              );
              const body = 'Bind code does not match the host-minted claim.';
              socket.end(
                `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
              );
              return;
            }
            if (entry.hostMintedClaim.boundAgent !== null) {
              const body = 'Claim has already been bound; mint a fresh session.';
              socket.end(
                `HTTP/1.1 409 Conflict\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
              );
              return;
            }
            entry.boundViaSubprotocol = true;
          } else if (bind.reason !== undefined) {
            // Header was malformed (multiple bind elements, bad grammar).
            // Reject with 400 — a well-behaved gateway never sends this.
            process.stderr.write(`[tesseron] rejecting bind upgrade: ${bind.reason}\n`);
            const body = `Malformed bind subprotocol: ${bind.reason}`;
            socket.end(
              `HTTP/1.1 400 Bad Request\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            );
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            entry.gatewayWs = ws;

            if (entry.boundViaSubprotocol) {
              // V3 path: the gateway has authenticated via the bind
              // subprotocol. The plugin synthesizes the welcome to the
              // SDK using its minted credentials, then replays the
              // cached SDK hello to the gateway with a unique internal
              // id and discards the gateway's reply by id. Subsequent
              // traffic flows in both directions normally.
              const helloFrame = entry.queue.find((m) => isHelloRequest(m));
              if (helloFrame !== undefined) {
                const helloMsg = parseJsonFrame(helloFrame) as {
                  id?: unknown;
                  params?: HelloParams;
                };
                const sdkHelloId = helloMsg.id ?? null;
                const helloParams = helloMsg.params;

                // Synthesize the welcome to the SDK. Sentinel agent
                // matches the existing `tesseron/welcome` shape for an
                // unclaimed session — the gateway's `tesseron/claimed`
                // notification (forwarded later) flips it to the real
                // identity AND overwrites `capabilities` with the
                // gateway's authoritative bits via the new
                // `agentCapabilities` field on the notification.
                //
                // **Conservative pre-claim capabilities.** The host has
                // no way of knowing which sampling / elicitation
                // features the eventual MCP client supports, so it
                // reports `false` for both. Action handlers that gate
                // on `ctx.agentCapabilities.sampling` will see this as
                // "not available" until the claimed notification flips
                // it. Echoing `helloParams.capabilities` here would
                // surface the SDK's *own* capability bits — wrong, and
                // the source of a sampling-handler bug where the
                // capability check passes locally but the gateway
                // can't actually deliver.
                const synthesizedWelcome: WelcomeResult = {
                  sessionId: entry.hostMintedClaim.sessionId,
                  protocolVersion: PROTOCOL_VERSION,
                  capabilities: {
                    streaming: true,
                    subscriptions: true,
                    sampling: false,
                    elicitation: false,
                  },
                  agent: { id: 'pending', name: 'Awaiting agent' },
                  claimCode: entry.hostMintedClaim.code,
                  resumeToken: entry.hostMintedClaim.resumeToken,
                };
                const welcomeResponse = {
                  jsonrpc: '2.0' as const,
                  id: sdkHelloId,
                  result: synthesizedWelcome,
                };
                if (entry.browserWs.readyState === 1) {
                  entry.browserWs.send(JSON.stringify(welcomeResponse));
                }

                // Replay the hello to the gateway with a UUID-anchored id
                // we can drop on the way back. The id has to be
                // collision-resistant across instances: two instances
                // bound within the same millisecond would otherwise
                // share an id and the cross-instance discard logic
                // would drop each other's frames. `crypto.randomUUID()`
                // is 122 bits of entropy and unique per call.
                entry.helloReplayId = `__tesseron-host-replay-${globalThis.crypto.randomUUID()}`;
                const replayFrame = JSON.stringify({
                  jsonrpc: '2.0',
                  id: entry.helloReplayId,
                  method: 'tesseron/hello',
                  params: helloParams,
                });
                ws.send(replayFrame);
              }
              // Forward any remaining queued (non-hello) messages to the
              // gateway as in the legacy path.
              for (const msg of entry.queue) {
                if (!isHelloRequest(msg)) ws.send(msg);
              }
              entry.queue = [];
            } else {
              // Legacy v1.1 path: drain the queue (incl. the SDK's
              // hello) to the gateway. The gateway mints its own claim
              // code and the plugin's hostMintedClaim is unused for
              // this session — harmless dead state until the manifest
              // is unlinked on browser close.
              for (const msg of entry.queue) {
                ws.send(msg);
              }
              entry.queue = [];
            }

            ws.on('message', (data: RawData, isBinary: boolean) => {
              const payload: RawData | string = isBinary ? data : rawDataToString(data);
              // V3 mode: drop the gateway's reply to the replayed hello
              // — the SDK already received the synthesized welcome from
              // the plugin. Inspect by JSON-RPC id; everything else
              // forwards as in the legacy path.
              if (entry.boundViaSubprotocol && entry.helloReplayId !== undefined) {
                const text = typeof payload === 'string' ? payload : rawDataToString(payload);
                const msg = parseJsonFrame(text);
                if (
                  msg !== null &&
                  typeof msg === 'object' &&
                  'id' in msg &&
                  (msg as { id?: unknown }).id === entry.helloReplayId
                ) {
                  // Capture agent identity if the response carries it,
                  // for later updating the manifest's `boundAgent`.
                  const result = (msg as { result?: { agent?: AgentIdentity } }).result;
                  if (result?.agent !== undefined) {
                    entry.hostMintedClaim.boundAgent = result.agent;
                  }
                  entry.helloReplayId = undefined;
                  return;
                }
              }
              if (entry.browserWs.readyState === 1 /* OPEN */) {
                entry.browserWs.send(payload);
                return;
              }
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
