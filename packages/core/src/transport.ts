export interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(reason?: string): void;
}

export class TransportClosedError extends Error {
  constructor(reason?: string) {
    super(reason ? `Transport closed: ${reason}` : 'Transport closed');
    this.name = 'TransportClosedError';
  }
}
