import type { Transport } from '@tesseron/core';

export class BrowserWebSocketTransport implements Transport {
  /** WebSocket endpoint this transport was constructed with. Exposed for
   * diagnostics and for hooks/tests that need to verify which URL the
   * underlying socket targets. */
  readonly url: string;
  private readonly ws: WebSocket;
  private readonly messageHandlers: Array<(message: unknown) => void> = [];
  private readonly closeHandlers: Array<(reason?: string) => void> = [];
  private readonly opened: Promise<void>;

  constructor(url: string) {
    this.url = url;
    this.ws = new WebSocket(url);
    this.opened = new Promise<void>((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener(
        'error',
        () => reject(new Error(`WebSocket connection failed: ${url}`)),
        { once: true },
      );
      // Backstop: if the socket closes before any caller awaits
      // ready(), nothing else settles the promise. (`error` may or may
      // not fire on a CONNECTING.close() depending on platform; `close`
      // always does.) Reject from the close listener so the hook's
      // connect promise unwinds instead of hanging forever — see
      // tesseron#68. Once 'open' has resolved, this reject() is a no-op
      // (Promise constructor only honours the first settle), so a
      // normal teardown after a successful connect doesn't surface as
      // an error to anyone awaiting ready().
      this.ws.addEventListener(
        'close',
        () => reject(new Error(`WebSocket closed before open: ${url}`)),
        { once: true },
      );
    });
    // Attach a no-op .catch to suppress unhandled-rejection at the
    // microtask boundary. Without this, a transport that's constructed
    // and immediately closed (StrictMode mount→cleanup before any
    // caller awaits ready()) trips Node's strict-mode unhandled-
    // rejection — which under vitest with `unhandledRejection: 'strict'`
    // crashes the test process, not just warns. The .catch() returns
    // a new promise; `this.opened`'s state is unchanged, so a later
    // `await this.ready()` still sees the rejection.
    this.opened.catch(() => {});
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
