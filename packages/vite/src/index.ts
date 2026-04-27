import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentIdentity, WelcomeResult } from '@tesseron/core';
import { PROTOCOL_VERSION, TesseronErrorCode } from '@tesseron/core';
import { constantTimeEqual, parseBindSubprotocol, validateAppId } from '@tesseron/core/internal';
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
  /** Sliding TTL deadline; gateway skips manifests past this time. */
  expiresAt: number;
  boundAgent: AgentIdentity | null;
}

/** Default sliding TTL on a host-minted claim — 10 minutes from `mintedAt`. */
const HOST_MINT_TTL_MS = 10 * 60 * 1000;
/** How often the plugin rewrites the manifest with a fresh `mintedAt` / `expiresAt`. */
const HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
/** Bind-mismatch failures inside the rolling window before lock-out. */
const BIND_FAILURE_THRESHOLD = 5;
/** Rolling window for failure counting (ms). */
const BIND_FAILURE_WINDOW_MS = 60_000;
/** Lock-out duration once the threshold is crossed (ms). */
const BIND_FAILURE_LOCKOUT_MS = 60_000;

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
  /** Bind-failure timestamps for the rate limit's rolling window. */
  bindFailureTimes: number[];
  /** Lock-out deadline (ms epoch) when set; until then bind upgrades get HTTP 429. */
  bindLockoutUntil: number;
  /** Heartbeat timer rewriting the manifest every {@link HEARTBEAT_INTERVAL_MS}. */
  heartbeatTimer?: ReturnType<typeof setInterval>;
  /**
   * Cached SDK `tesseron/hello` frame. The plugin answers hello
   * immediately on arrival (so the SDK can show the host-minted claim
   * code straight away) and replays the cached frame to the gateway
   * once a v1.2 dial with the bind subprotocol completes.
   */
  cachedHello?: { id: unknown; params: unknown };
  /** True after the plugin has synthesized and sent the welcome to the SDK. */
  helloAnswered: boolean;
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
            const mintedAt = Date.now();
            const hostMintedClaim: HostMintedClaim = {
              code: mintClaimCode(),
              sessionId: mintSessionId(),
              resumeToken: mintResumeToken(),
              mintedAt,
              expiresAt: mintedAt + HOST_MINT_TTL_MS,
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
              bindFailureTimes: [],
              bindLockoutUntil: 0,
              helloAnswered: false,
            };
            instances.set(instanceId, entry);

            writeInstanceManifest(entry).catch((err: Error) =>
              process.stderr.write(
                `[tesseron] failed to write instance manifest: ${err.message}\n`,
              ),
            );

            // Heartbeat: refresh expiresAt every half-TTL while the
            // SDK is alive and unbound. Stops once boundAgent !== null
            // (claim consumed) or the entry is removed (browser closed).
            const heartbeat = setInterval(() => {
              if (!instances.has(instanceId) || entry.hostMintedClaim.boundAgent !== null) {
                clearInterval(heartbeat);
                entry.heartbeatTimer = undefined;
                return;
              }
              const now = Date.now();
              entry.hostMintedClaim.mintedAt = now;
              entry.hostMintedClaim.expiresAt = now + HOST_MINT_TTL_MS;
              writeInstanceManifest(entry).catch((err: Error) =>
                process.stderr.write(
                  `[tesseron] heartbeat manifest write failed: ${err.message}\n`,
                ),
              );
            }, HEARTBEAT_INTERVAL_MS);
            heartbeat.unref?.();
            entry.heartbeatTimer = heartbeat;

            ws.on('message', (data: RawData, isBinary: boolean) => {
              // `ws` hands us a Buffer for both text and binary frames. Calling
              // send(Buffer) without options forwards as a binary frame, which
              // the browser receives as a Blob and the @tesseron/web transport
              // drops (it only handles string frames). Decode text frames back
              // to a string so the frame type round-trips correctly.
              const payload: RawData | string = isBinary ? data : rawDataToString(data);
              // Pre-hello local handler. Two responsibilities:
              // (1) Synthesize the welcome for `tesseron/hello` immediately
              //     so the user sees the host-minted claim code without
              //     waiting for a gateway dial — see the synthesizer
              //     branch below. The cached hello is later replayed to
              //     the gateway when it dials with the bind subprotocol;
              //     the gateway's reply is then discarded (the SDK
              //     already saw the synthesized welcome).
              // (2) Reject `tesseron/resume` locally with ResumeFailed
              //     because the host mints fresh sessionId/resumeToken
              //     at every WS open — any incoming resume's tokens
              //     belong to a previous instance the host can't
              //     validate. See tesseron#68.
              // Once hello is answered, frames flow to the gateway.
              if (!entry.helloAnswered && !isBinary) {
                const parsed = parseJsonFrame(payload);
                const method =
                  parsed !== null && typeof parsed === 'object'
                    ? (parsed as { method?: unknown }).method
                    : undefined;

                if (method === 'tesseron/resume') {
                  const m = parsed as { id?: unknown };
                  ws.send(
                    JSON.stringify({
                      jsonrpc: '2.0',
                      id: m.id ?? null,
                      error: {
                        code: TesseronErrorCode.ResumeFailed,
                        message:
                          'Host-minted session does not honour resume; the previous session ended when the page reloaded. The SDK will fall back to a fresh tesseron/hello.',
                      },
                    }),
                  );
                  // Intentionally leave entry.helloAnswered = false so
                  // the SDK's fallback hello on the same socket still
                  // hits the synthesizer below.
                  return;
                }

                if (method === 'tesseron/hello') {
                  const m = parsed as { id?: unknown; params?: { app?: { id?: unknown } } };
                  // Validate the app.id before synthesizing — defends
                  // against the SDK trying to claim a reserved id (e.g.
                  // 'tesseron') or a malformed identifier. The legacy
                  // path got this for free from the gateway's hello
                  // handler; with the host synthesizing locally we
                  // re-apply the same validation here so the SDK's
                  // connect() promise rejects with a clear message
                  // rather than appearing to succeed and breaking
                  // later.
                  const appId = m.params?.app?.id;
                  if (typeof appId === 'string') {
                    try {
                      validateAppId(appId);
                    } catch (err) {
                      const reason = err instanceof Error ? err.message : String(err);
                      ws.send(
                        JSON.stringify({
                          jsonrpc: '2.0',
                          id: m.id ?? null,
                          error: {
                            code: -32600,
                            message: reason,
                          },
                        }),
                      );
                      entry.helloAnswered = true;
                      return;
                    }
                  }
                  entry.cachedHello = { id: m.id, params: m.params };
                  entry.helloAnswered = true;
                  const synthesized: WelcomeResult = {
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
                  ws.send(
                    JSON.stringify({
                      jsonrpc: '2.0',
                      id: m.id ?? null,
                      result: synthesized,
                    }),
                  );
                  return;
                }
              }
              if (entry.gatewayWs?.readyState === 1 /* OPEN */) {
                entry.gatewayWs.send(payload);
              } else {
                entry.queue.push(payload);
              }
            });

            ws.on('close', () => {
              instances.delete(instanceId);
              if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
              entry.gatewayWs?.close(1000, 'Browser disconnected');
              deleteManifest(instanceId).catch(() => {});
            });

            ws.on('error', () => {
              instances.delete(instanceId);
              if (entry.heartbeatTimer) clearInterval(entry.heartbeatTimer);
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
            // Rate-limit lockout. Once the rolling window crosses
            // BIND_FAILURE_THRESHOLD mismatches, every subsequent bind
            // upgrade gets HTTP 429 for BIND_FAILURE_LOCKOUT_MS — long
            // enough to make sustained brute force expensive without
            // breaking a legitimate retry loop.
            const now = Date.now();
            if (now < entry.bindLockoutUntil) {
              const body =
                'Too many bind failures; this instance is locked out. Reload the tab to mint a fresh session.';
              socket.end(
                `HTTP/1.1 429 Too Many Requests\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
              );
              return;
            }
            // Constant-time compare against the minted code to deny a
            // timing-side-channel attacker enumerating prefixes via
            // upgrade-rejection latency.
            if (!constantTimeEqual(bind.code, entry.hostMintedClaim.code)) {
              const cutoff = now - BIND_FAILURE_WINDOW_MS;
              while (entry.bindFailureTimes.length > 0 && entry.bindFailureTimes[0]! < cutoff) {
                entry.bindFailureTimes.shift();
              }
              entry.bindFailureTimes.push(now);
              if (entry.bindFailureTimes.length >= BIND_FAILURE_THRESHOLD) {
                entry.bindLockoutUntil = now + BIND_FAILURE_LOCKOUT_MS;
                entry.bindFailureTimes = [];
                process.stderr.write(
                  `[tesseron] bind rate-limit triggered for instance ${instanceId}; locked out for ${BIND_FAILURE_LOCKOUT_MS}ms\n`,
                );
              } else {
                process.stderr.write(
                  `[tesseron] rejecting bind subprotocol upgrade for instance ${instanceId} (code mismatch)\n`,
                );
              }
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
            // Reset failure counter on successful bind.
            entry.bindFailureTimes = [];
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

          // Legacy v1.1 gateway dials (no bind subprotocol) are now
          // rejected. The plugin has already minted a host-side claim
          // code and synthesized a welcome to the SDK; allowing a
          // legacy auto-dial through would produce a second, conflicting
          // welcome from the gateway and confuse the SDK's already-
          // resolved hello promise. Users running an old gateway against
          // a new plugin need to upgrade the gateway alongside.
          //
          // The 426 Upgrade Required response signals "the protocol you
          // dialed with is incompatible; switch to a newer one" — the
          // closest HTTP status to "v1.2 required."
          if (!entry.boundViaSubprotocol) {
            process.stderr.write(
              `[tesseron] rejecting legacy auto-dial for instance ${instanceId}: gateway must speak v1.2 (use the tesseron-bind.<code> subprotocol). Upgrade @tesseron/mcp to >= 2.4.0.\n`,
            );
            const body =
              'This Tesseron host requires a v1.2-compatible gateway (tesseron-bind subprotocol). Upgrade @tesseron/mcp to >= 2.4.0.';
            socket.end(
              `HTTP/1.1 426 Upgrade Required\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
            );
            return;
          }

          wss.handleUpgrade(req, socket, head, (ws) => {
            entry.gatewayWs = ws;

            // V3 path: the gateway has authenticated via the bind
            // subprotocol. Replay the SDK's cached hello to the gateway
            // with a unique internal id, and discard the gateway's
            // welcome reply by id (the SDK already received the
            // synthesized welcome on its hello). Subsequent traffic
            // flows in both directions normally.
            //
            // The cached hello is captured by the browser-side WS
            // handler when the SDK first sends `tesseron/hello`. If a
            // gateway somehow dials before the SDK has sent hello (race
            // we've never observed because the SDK sends hello on open),
            // we fall through to the queue-drain branch below — the
            // SDK's hello will arrive later and follow the live-bound
            // forward path.
            if (entry.cachedHello !== undefined) {
              entry.helloReplayId = `__tesseron-host-replay-${globalThis.crypto.randomUUID()}`;
              const replayFrame = JSON.stringify({
                jsonrpc: '2.0',
                id: entry.helloReplayId,
                method: 'tesseron/hello',
                params: entry.cachedHello.params,
              });
              ws.send(replayFrame);
            }
            for (const msg of entry.queue) {
              if (!isHelloRequest(msg)) ws.send(msg);
            }
            entry.queue = [];

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
