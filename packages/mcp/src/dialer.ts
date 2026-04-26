import { Buffer } from 'node:buffer';
import { connect as netConnect } from 'node:net';
import type { Transport, TransportSpec } from '@tesseron/core';
import { type RawData, WebSocket } from 'ws';

/**
 * WebSocket subprotocol the gateway uses when connecting outbound to a Tesseron
 * app. Mirrored on the host side by `@tesseron/server`'s `NodeWebSocketServerTransport`
 * and `@tesseron/vite`'s bridge.
 */
export const GATEWAY_SUBPROTOCOL = 'tesseron-gateway';

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
  dial(spec: Extract<TransportSpec, { kind: K }>): DialedTransport;
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

  dial(spec: { kind: 'ws'; url: string }): DialedTransport {
    const ws = new WebSocket(spec.url, [GATEWAY_SUBPROTOCOL]);

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

  dial(spec: { kind: 'uds'; path: string }): DialedTransport {
    const socket = netConnect({ path: spec.path });

    const messageHandlers: Array<(message: unknown) => void> = [];
    const closeHandlers: Array<(reason?: string) => void> = [];

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
            for (const h of messageHandlers) h(parsed);
          } catch {
            // skip malformed line
          }
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => {
      for (const h of closeHandlers) h();
    });
    socket.on('error', () => {
      // 'close' fires after 'error' on net.Socket; let onClose handle teardown.
    });

    const opened = new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
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
