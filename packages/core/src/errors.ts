import { TesseronErrorCode } from './protocol.js';

/**
 * Wire shape of a {@link TesseronError} as surfaced to MCP agents via the
 * `structuredContent` field of a failed `tools/call` result. Lets agents
 * branch programmatically on `code` (e.g. retry on `TransportClosed` but not
 * on `HandlerError`) instead of regex-matching the human-readable text body.
 */
export interface TesseronStructuredError {
  /** Numeric code; compare against {@link TesseronErrorCode} values. */
  code: number;
  /** Error-specific payload (same shape as {@link TesseronError.data}); omitted when undefined. */
  data?: unknown;
}

/**
 * Base class for all typed errors the SDK surfaces. Maps 1:1 onto JSON-RPC
 * error responses; subclasses narrow to specific {@link TesseronErrorCode} values.
 */
export class TesseronError extends Error {
  /** Numeric error code from {@link TesseronErrorCode}. */
  readonly code: number;
  /**
   * Structured payload whose shape depends on `code`:
   * - `InputValidation` / `HandlerError` on a validation failure → `StandardSchemaV1.Issue[]`
   * - `SamplingNotAvailable` / `ElicitationNotAvailable` → `{ clientName: string }` when known
   * - otherwise typically `undefined`.
   */
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'TesseronError';
    this.code = code;
    this.data = data;
  }
}

/** Options for {@link SamplingNotAvailableError}. */
export interface SamplingNotAvailableOptions {
  /** Name of the connected MCP client, when known, for a clearer error message. */
  clientName?: string;
}

/**
 * Thrown from {@link ActionContext.sample} when the connected MCP client did not
 * advertise `sampling/createMessage` support during its `initialize` handshake.
 * Handlers that want a graceful fallback should first check
 * `ctx.agentCapabilities.sampling`.
 */
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

/** Options for {@link ElicitationNotAvailableError}. */
export interface ElicitationNotAvailableOptions {
  /** Name of the connected MCP client, when known, for a clearer error message. */
  clientName?: string;
}

/**
 * Thrown from {@link ActionContext.elicit} when the connected MCP client did not
 * advertise elicitation support. {@link ActionContext.confirm} collapses this
 * condition to `false` instead; `elicit` throws because structured input has
 * no safe default.
 */
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

/**
 * Thrown when recursive sampling exceeds the configured depth limit, to prevent
 * a sampled response from triggering further sampling in an unbounded loop.
 */
export class SamplingDepthExceededError extends TesseronError {
  constructor(depth: number) {
    super(TesseronErrorCode.SamplingDepthExceeded, `Sampling depth limit (${depth}) exceeded.`);
    this.name = 'SamplingDepthExceededError';
  }
}

/**
 * Thrown when an invocation is cancelled by the caller (e.g. the agent sent
 * `actions/cancel`). The action's `ctx.signal` fires first; handlers that catch
 * this should clean up and rethrow.
 */
export class CancelledError extends TesseronError {
  constructor() {
    super(TesseronErrorCode.Cancelled, 'Action invocation was cancelled.');
    this.name = 'CancelledError';
  }
}

/**
 * Thrown when an invocation exceeds the timeout configured via
 * {@link ActionBuilder.timeout}. `ctx.signal` aborts with this as its `reason`.
 */
export class TimeoutError extends TesseronError {
  constructor(timeoutMs: number) {
    super(TesseronErrorCode.Timeout, `Action timed out after ${timeoutMs}ms.`);
    this.name = 'TimeoutError';
  }
}
