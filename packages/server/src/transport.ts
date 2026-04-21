import { Buffer } from 'node:buffer';
import WebSocket from 'ws';
import type { Transport } from '@tesseron/core';

export class NodeWebSocketTransport implements Transport {
  private readonly ws: WebSocket;
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private readonly opened: Promise<void>;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', (err) => reject(err));
    });
    this.ws.on('message', (data: WebSocket.RawData) => {
      let text: string;
      if (typeof data === 'string') {
        text = data;
      } else if (Buffer.isBuffer(data)) {
        text = data.toString('utf-8');
      } else if (Array.isArray(data)) {
        text = Buffer.concat(data).toString('utf-8');
      } else {
        text = Buffer.from(data).toString('utf-8');
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return;
      }
      for (const handler of this.messageHandlers) handler(parsed);
    });
    this.ws.on('close', (_code: number, reason: Buffer) => {
      const text = reason.toString('utf-8');
      for (const handler of this.closeHandlers) handler(text);
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
