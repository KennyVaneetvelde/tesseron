import {
  type ConnectOptions,
  TesseronClient,
  type Transport,
  type WelcomeResult,
} from '@tesseron/core';
import {
  NodeWebSocketServerTransport,
  type NodeWebSocketServerTransportOptions,
} from './transport.js';

export * from '@tesseron/core';
export {
  NodeWebSocketServerTransport,
  type NodeWebSocketServerTransportOptions,
} from './transport.js';

/**
 * Node-side {@link TesseronClient}. Call `connect()` to bind a WebSocket server
 * on loopback and announce this process to the gateway via `~/.tesseron/tabs/`.
 * The gateway dials in with the `tesseron-gateway` subprotocol; standard Tesseron
 * JSON-RPC traffic flows from there.
 *
 * Pass {@link NodeWebSocketServerTransportOptions} to customise the app name,
 * bind host, or bind port. Pass a custom {@link Transport} to bypass the
 * bind-and-announce flow entirely — useful in tests or when tunnelling through
 * another channel.
 */
export class ServerTesseronClient extends TesseronClient {
  override async connect(
    target?: Transport | NodeWebSocketServerTransportOptions,
    options?: ConnectOptions,
  ): Promise<WelcomeResult> {
    if (target && typeof target === 'object' && 'send' in target && 'onMessage' in target) {
      return super.connect(target as Transport, options);
    }
    const transport = new NodeWebSocketServerTransport(
      target as NodeWebSocketServerTransportOptions | undefined,
    );
    await transport.ready();
    return super.connect(transport, options);
  }
}

/**
 * Singleton {@link ServerTesseronClient} shared across a Node process. Most
 * backends import and use this directly rather than constructing their own.
 */
export const tesseron = new ServerTesseronClient();
