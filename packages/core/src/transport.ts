import { TesseronError } from './errors.js';
import { TesseronErrorCode } from './protocol.js';

/**
 * Bidirectional JSON-RPC channel between a {@link TesseronClient} and a gateway.
 * Implementations must deliver messages reliably in order on a single session
 * (the SDK does not retry or reorder). The `@tesseron/web` and `@tesseron/server`
 * packages provide WebSocket implementations; custom transports can bridge any
 * duplex channel (postMessage, stdio, in-memory, etc.).
 *
 * Lifecycle:
 * 1. Caller constructs the transport (and completes any async handshake).
 * 2. `TesseronClient.connect(transport)` registers handlers via `onMessage` / `onClose`
 *    and begins calling `send(message)` with JSON-RPC objects (already serialized-
 *    ready; implementations typically `JSON.stringify` before writing to the wire).
 * 3. When the peer delivers a message, the implementation invokes the registered
 *    `onMessage` handler with the parsed object.
 * 4. On termination, the implementation invokes `onClose` exactly once with an
 *     optional human-readable reason.
 */
export interface Transport {
  /** Send a JSON-RPC message to the peer. Should not throw on transient errors — buffer or drop as appropriate. */
  send(message: unknown): void;
  /** Register the single inbound-message handler. Called once by `TesseronClient.connect`. */
  onMessage(handler: (message: unknown) => void): void;
  /** Register the single close handler. Called once by `TesseronClient.connect`. */
  onClose(handler: (reason?: string) => void): void;
  /** Close the channel. Must eventually trigger the registered `onClose` handler. */
  close(reason?: string): void;
}

/**
 * Thrown when a pending JSON-RPC request is rejected because the transport
 * closed before a response arrived. Surfaces on `await` calls that were in
 * flight at the time of disconnect.
 */
export class TransportClosedError extends TesseronError {
  constructor(reason?: string) {
    super(
      TesseronErrorCode.TransportClosed,
      reason ? `Transport closed: ${reason}` : 'Transport closed',
    );
    this.name = 'TransportClosedError';
  }
}
