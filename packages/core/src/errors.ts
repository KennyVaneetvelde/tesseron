import { TesseronErrorCode } from './protocol.js';

export class TesseronError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'TesseronError';
    this.code = code;
    this.data = data;
  }
}

export interface SamplingNotAvailableOptions {
  clientName?: string;
}

export class SamplingNotAvailableError extends TesseronError {
  readonly clientName?: string;

  constructor(options: SamplingNotAvailableOptions = {}) {
    const who = options.clientName ? `"${options.clientName}"` : 'the connected MCP client';
    super(
      TesseronErrorCode.SamplingNotAvailable,
      `This action requires sampling/createMessage support, but ${who} did not advertise that capability during MCP initialization. Ask the user to run this action with a client that supports sampling, or provide a non-sampling fallback.`,
      options.clientName ? { clientName: options.clientName } : undefined,
    );
    this.name = 'SamplingNotAvailableError';
    this.clientName = options.clientName;
  }
}

export interface ElicitationNotAvailableOptions {
  clientName?: string;
}

export class ElicitationNotAvailableError extends TesseronError {
  readonly clientName?: string;

  constructor(options: ElicitationNotAvailableOptions = {}) {
    const who = options.clientName ? `"${options.clientName}"` : 'the connected MCP client';
    super(
      TesseronErrorCode.ElicitationNotAvailable,
      `This action requires elicitation support, but ${who} did not advertise that capability during MCP initialization.`,
      options.clientName ? { clientName: options.clientName } : undefined,
    );
    this.name = 'ElicitationNotAvailableError';
    this.clientName = options.clientName;
  }
}

export class SamplingDepthExceededError extends TesseronError {
  constructor(depth: number) {
    super(TesseronErrorCode.SamplingDepthExceeded, `Sampling depth limit (${depth}) exceeded.`);
    this.name = 'SamplingDepthExceededError';
  }
}

export class CancelledError extends TesseronError {
  constructor() {
    super(TesseronErrorCode.Cancelled, 'Action invocation was cancelled.');
    this.name = 'CancelledError';
  }
}

export class TimeoutError extends TesseronError {
  constructor(timeoutMs: number) {
    super(TesseronErrorCode.Timeout, `Action timed out after ${timeoutMs}ms.`);
    this.name = 'TimeoutError';
  }
}
