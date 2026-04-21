import { TesseronClient, type Transport, type WelcomeResult } from '@tesseron/core';
import { NodeWebSocketTransport } from './transport.js';

export * from '@tesseron/core';
export { NodeWebSocketTransport } from './transport.js';

export const DEFAULT_GATEWAY_URL = 'ws://localhost:7475';

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

export const tesseron = new ServerTesseronClient();
