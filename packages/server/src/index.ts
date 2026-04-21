import { TesseronClient, type Transport, type WelcomeResult } from '@tesseron/core';
import { NodeWebSocketTransport } from './transport.js';

export * from '@tesseron/core';
export { NodeWebSocketTransport } from './transport.js';

/** Default gateway endpoint the Node client connects to when no URL is provided. */
export const DEFAULT_GATEWAY_URL = 'ws://localhost:7475';

/**
 * Node-side {@link TesseronClient} with a WebSocket-aware `connect` overload.
 * Pass nothing to use {@link DEFAULT_GATEWAY_URL}, a URL string to connect to
 * another gateway, or a custom {@link Transport} to bypass WebSocket entirely.
 */
export class ServerTesseronClient extends TesseronClient {
  override async connect(target?: Transport | string): Promise<WelcomeResult> {
    if (target && typeof target !== 'string') {
      return super.connect(target);
    }
    const transport = new NodeWebSocketTransport(target ?? DEFAULT_GATEWAY_URL);
    await transport.ready();
    return super.connect(transport);
  }
}

/**
 * Singleton {@link ServerTesseronClient} shared across a Node process. Most
 * backends import and use this directly rather than constructing their own.
 */
export const tesseron = new ServerTesseronClient();
