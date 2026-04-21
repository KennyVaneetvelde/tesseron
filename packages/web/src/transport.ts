import type { Transport } from '@tesseron/core';

export class BrowserWebSocketTransport implements Transport {
  private readonly ws: WebSocket;
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener(
        'error',
        () => reject(new Error(`WebSocket connection failed: ${url}`)),
        { once: true },
      );
    });
    this.ws.addEventListener('message', (ev) => {
      const data = ev.data;
      if (typeof data !== 'string') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      for (const handler of this.messageHandlers) handler(parsed);
    });
    this.ws.addEventListener('close', (ev) => {
      for (const handler of this.closeHandlers) handler(ev.reason);
    });
  }

  async ready(): Promise<void> {
    await this.opened;
  }

  send(message: unknown): void {
    this.ws.send(JSON.stringify(message));
  }

  onMessage(handler: (message: unknown) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (reason?: string) => void): void {
    this.closeHandlers.push(handler);
  }

  close(reason?: string): void {
    this.ws.close(1000, reason);
  }
}
