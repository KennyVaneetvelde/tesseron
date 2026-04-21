import { TesseronError } from './errors.js';
import { TesseronErrorCode } from './protocol.js';

export interface Transport {
  send(message: unknown): void;
  onMessage(handler: (message: unknown) => void): void;
  onClose(handler: (reason?: string) => void): void;
  close(reason?: string): void;
}

export class TransportClosedError extends TesseronError {
  constructor(reason?: string) {
    super(
      TesseronErrorCode.TransportClosed,
      reason ? `Transport closed: ${reason}` : 'Transport closed',
    );
    this.name = 'TransportClosedError';
  }
}
