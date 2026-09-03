import { Buffer } from 'node:buffer';
import { connect as netConnect } from 'node:net';
import type { Transport, TransportSpec } from '@tesseron/core';
import { formatBindSubprotocol } from '@tesseron/core/internal';
import { type RawData, WebSocket } from 'ws';

/**
 * WebSocket subprotocol the gateway uses when connecting outbound to a Tesseron
 * app. Mirrored on the host side by `@tesseron/server`'s `NodeWebSocketServerTransport`
 * and `@tesseron/vite`'s bridge.
 */
export const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';

/**
 * Per-dial options the gateway threads through to the dialer.
 *
 * `bindCode` is the host-minted claim code the gateway carries on the WS
 * upgrade as a `tesseron-bind.<code>` subprotocol element. The host
 * (`@tesseron/vite`, `@tesseron/server`) validates this against its
 * in-memory `hostMintedClaim.code`; a mismatch rejects the upgrade.
 * Absent for legacy auto-dials. See tesseron#60.
 */
export interface DialerOptions {
  bindCode?: string;
}

/**
 * Internal handle returned by a {@link GatewayDialer}. Wraps a {@link Transport}
 * with the underlying connection's lifecycle hooks. The gateway uses these
 * hooks to remove the instance from `connected` once the channel closes; the
 * `Transport` itself is what `handleConnection` registers handlers on.
 *
 * `dial()` is **synchronous** — the caller MUST register `transport.onMessage`
 * (via `handleConnection`) before yielding to the event loop, otherwise an
 * in-process peer that sends `tesseron/hello` before any await tick is missed.
 */
export interface DialedTransport {
  transport: Transport;
  /** Resolves once the underlying channel is open and ready for `send()`. */
  opened: Promise<void>;
  /** Fires when the underlying channel closes for any reason. */
  onClose(handler: () => void): void;
  /** Forces the channel shut. Must eventually trigger the registered close handlers. */
  close(reason?: string): void;
}

/**
 * Strategy that produces a {@link DialedTransport} from a {@link TransportSpec}.
 * The gateway picks a dialer by `spec.kind` and delegates the actual outbound
 * connection. Add a new binding by implementing this once and registering it
 * on the gateway.
 */
export interface GatewayDialer<K extends TransportSpec['kind'] = TransportSpec['kind']> {
  readonly kind: K;
  dial(spec: Extract<TransportSpec, { kind: K }>, options?: DialerOptions): DialedTransport;
}

/**
 * Dials a `ws://` URL with the `tesseron-gateway` subprotocol. The session /
 * handshake code in `gateway.handleConnection` operates on the returned
 * {@link Transport} the same way it does for inbound connections.
 *
 * Synchronous: creates the WebSocket and attaches the raw `message` listener
 * in the same call frame so the gateway can register its message handler
 * before the in-process WS pumps a `tesseron/hello` synchronously.
 */
export class WsDialer implements GatewayDialer<'ws'> {
  readonly kind = 'ws' as const;

  dial(spec: { kind: 'ws'; url: string }, options: DialerOptions = {}): DialedTransport {
    // When the gateway is dialing in response to a host-minted-claim
    // `tesseron__claim_session` call, attach the bind code as a second
    // subprotocol element (`tesseron-bind.<code>`). The host's upgrade
    // handler parses this and validates against its in-memory
    // `hostMintedClaim.code`; a mismatch produces a 4xx response on the
    // upgrade and the dial rejects. See `@tesseron/core/bind-subprotocol`.
    const subprotocols: string[] = [GATEWAY_SUBPROTOCOL];
    if (options.bindCode !== undefined) {
      subprotocols.push(formatBindSubprotocol(options.bindCode));
    }
    const ws = new WebSocket(spec.url, subprotocols);

    const messageHandlers: Array<(message: unknown) => void> = [];
    const closeHandlers: Array<(reason?: string) => void> = [];

    ws.on('message', (data: RawData) => {
      const text = rawDataToString(data);
      if (text === null) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      for (const h of messageHandlers) h(parsed);
    });
    ws.on('close', (_code: number, reason: Buffer) => {
      const text = reason?.toString('utf-8') ?? '';
      for (const h of closeHandlers) h(text || undefined);
    });

    const opened = new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', (err: Error) =>
        reject(new Error(`Failed to connect to ${spec.url}: ${err.message}`)),
      );
    });

    const transport: Transport = {
      send(message: unknown): void {
        // Let `ws.send` throw escape: the underlying socket may be in a state
        // where the send silently no-ops (CLOSING) but emits no `close` event
        // for a long time, or `JSON.stringify` may throw on a circular result.
        // Swallowing here strands whichever pending request was waiting on
        // this response. The session-dispatcher wrapper in `gateway.ts` catches
        // the throw and closes the channel so `rejectAllPending` rejects the
        // request with `TransportClosedError` instead of hanging.
        ws.send(JSON.stringify(message));
      },
      onMessage(handler: (message: unknown) => void): void {
        messageHandlers.push(handler);
      },
      onClose(handler: (reason?: string) => void): void {
        closeHandlers.push(handler);
      },
      close(reason?: string): void {
        ws.close(1000, reason);
      },
      // Liveness probe (tesseron#92). Reports true once `ws.readyState` enters
      // CLOSING (2) or CLOSED (3). Routing-side selectors filter on this to
      // avoid forwarding work to a socket whose close event is in flight but
      // hasn't run the gateway's cleanup yet.
      isClosed(): boolean {
        const s = ws.readyState;
        return s === ws.CLOSING || s === ws.CLOSED;
      },
    };

    return {
      transport,
      opened,
      onClose(handler: () => void): void {
        ws.once('close', handler);
      },
      close(reason?: string): void {
        ws.close(1000, reason);
      },
    };
  }
}

/**
 * Dials a Unix domain socket with NDJSON framing (one JSON message per `\n`-
 * terminated line). The kernel's same-UID enforcement on the socket inode (mode
 * 0600 in a 0700 directory under `~/.tesseron/sockets/`) is the only access
 * control — the threat model matches loopback WS + claim code.
 *
 * NDJSON is safe because `JSON.stringify` produces no raw `\n` (newlines inside
 * strings are escaped as `\\n`), so a line-splitter can recover messages
 * unambiguously.
 */
export class UdsDialer implements GatewayDialer<'uds'> {
  readonly kind = 'uds' as const;

  dial(spec: { kind: 'uds'; path: string }, options: DialerOptions = {}): DialedTransport {
    // UDS doesn't have a WS subprotocol — the equivalent for the v3
    // host-mint flow is sending `tesseron/bind { code }` as the very
    // first NDJSON frame after connect, before any other traffic. The
    // host validates the code against its in-memory `hostMintedClaim`
    // in constant time and replies success or closes the channel. The
    // file-mode-based UID enforcement on the socket inode is still the
    // first gate; bind is the second (matching the WS path's two-gate
    // model: same-user UID + bind subprotocol). See tesseron#60.
    const socket = netConnect({ path: spec.path });

    const messageHandlers: Array<(message: unknown) => void> = [];
    const closeHandlers: Array<(reason?: string) => void> = [];

    // Bind handshake state. While `bindResponseId` is set, incoming
    // frames are filtered for the matching response and not forwarded
    // to messageHandlers (the gateway hasn't registered them yet
    // anyway, but the dispatcher's contract is "no spurious frames"
    // so we keep the channel quiet pre-bind).
    let bindResponseId: string | undefined;
    let bindResolve: (() => void) | undefined;
    let bindReject: ((err: Error) => void) | undefined;

    let buffer = '';
    socket.setEncoding('utf-8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            newlineIndex = buffer.indexOf('\n');
            continue;
          }
          if (
            bindResponseId !== undefined &&
            typeof parsed === 'object' &&
            parsed !== null &&
            (parsed as { id?: unknown }).id === bindResponseId
          ) {
            const msg = parsed as {
              id: string;
              result?: unknown;
              error?: { code?: number; message?: string };
            };
            const resolveFn = bindResolve;
            const rejectFn = bindReject;
            bindResponseId = undefined;
            bindResolve = undefined;
            bindReject = undefined;
            if (msg.error !== undefined) {
              const reason = msg.error.message ?? `code ${msg.error.code ?? '<unknown>'}`;
              rejectFn?.(new Error(`tesseron/bind rejected: ${reason}`));
            } else {
              resolveFn?.();
            }
          } else {
            for (const h of messageHandlers) h(parsed);
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => {
      if (bindReject !== undefined) {
        const rejectFn = bindReject;
        bindResolve = undefined;
        bindReject = undefined;
        bindResponseId = undefined;
        rejectFn(new Error('UDS closed before tesseron/bind completed'));
      }
      for (const h of closeHandlers) h();
    });
    socket.on('error', () => {
      // 'close' fires after 'error' on net.Socket; let onClose handle teardown.
    });

    const opened = new Promise<void>((resolve, reject) => {
      socket.once('connect', () => {
        if (options.bindCode === undefined) {
          resolve();
          return;
        }
        const id = `__tesseron-bind-${globalThis.crypto.randomUUID()}`;
        bindResponseId = id;
        bindResolve = resolve;
        bindReject = reject;
        try {
          socket.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id,
              method: 'tesseron/bind',
              params: { code: options.bindCode },
            })}\n`,
          );
        } catch (err) {
          bindResponseId = undefined;
          bindResolve = undefined;
          bindReject = undefined;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
      socket.once('error', (err: Error) =>
        reject(new Error(`Failed to connect to ${spec.path}: ${err.message}`)),
      );
    });

    const transport: Transport = {
      send(message: unknown): void {
        // Same rationale as WsDialer.send: let the throw escape so the
        // session-dispatcher wrapper in `gateway.ts` can close the channel
        // and unblock the peer. Silent swallow strands pending requests.
        socket.write(`${JSON.stringify(message)}\n`);
      },
      onMessage(handler: (message: unknown) => void): void {
        messageHandlers.push(handler);
      },
      onClose(handler: (reason?: string) => void): void {
        closeHandlers.push(handler);
      },
      close(_reason?: string): void {
        socket.end();
      },
      // Liveness probe (tesseron#92). Mirrors WsDialer's: returns true once
      // the underlying socket is destroyed or no longer writable. `destroyed`
      // covers the post-close state; `!writable` catches the half-closed
      // window where the peer FIN'd but the local side hasn't yet emitted
      // `close`. Side-effect-free.
      isClosed(): boolean {
        return socket.destroyed || socket.writable === false;
      },
    };

    return {
      transport,
      opened,
      onClose(handler: () => void): void {
        socket.once('close', handler);
      },
      close(_reason?: string): void {
        socket.end();
      },
    };
  }
}

function rawDataToString(data: RawData): string | null {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf-8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf-8');
  return null;
}
