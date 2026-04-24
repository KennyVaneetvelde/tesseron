import {
  type ConnectOptions,
  TesseronClient,
  type Transport,
  type WelcomeResult,
} from '@tesseron/core';
import { BrowserWebSocketTransport } from './transport.js';

export * from '@tesseron/core';
export { BrowserWebSocketTransport } from './transport.js';

/**
 * Default gateway endpoint: the Tesseron Vite plugin exposes `/@tesseron/ws`
 * on the same origin as the page, so no separate port is needed.
 * Falls back to a non-browser safe string — in practice the browser always
 * has `location` defined, this branch is only hit during SSR/bundler analysis.
 */
export const DEFAULT_GATEWAY_URL =
  typeof location !== 'undefined'
    ? `${location.origin.replace(/^http/, 'ws')}/@tesseron/ws`
    : 'ws://localhost:5173/@tesseron/ws';

/**
 * Browser-side {@link TesseronClient} with a WebSocket-aware `connect` overload.
 * Pass nothing to use {@link DEFAULT_GATEWAY_URL}, a URL string to connect to
 * another gateway, or a custom {@link Transport} to bypass WebSocket entirely.
 * The optional second argument forwards {@link ConnectOptions} (e.g. session
 * resume) to the core client.
 */
export class WebTesseronClient extends TesseronClient {
  override async connect(
    target?: Transport | string,
    options?: ConnectOptions,
  ): Promise<WelcomeResult> {
    if (target && typeof target !== 'string') {
      return super.connect(target, options);
    }
    const transport = new BrowserWebSocketTransport(target ?? DEFAULT_GATEWAY_URL);
    await transport.ready();
    return super.connect(transport, options);
  }
}

/**
 * Singleton {@link WebTesseronClient} shared across a browser app. Most apps
 * import and use this directly rather than constructing their own.
 */
export const tesseron = new WebTesseronClient();
