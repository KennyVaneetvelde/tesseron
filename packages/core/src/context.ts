import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { LogLevel } from './protocol.js';

/**
 * Features advertised by the connected MCP client. Handlers should check these
 * before calling {@link ActionContext.sample} or {@link ActionContext.elicit}
 * on flows where a graceful fallback is required.
 */
export interface AgentCapabilities {
  /** `true` if the client supports `sampling/createMessage`. */
  sampling: boolean;
  /** `true` if the client supports elicitation (user prompting). */
  elicitation: boolean;
  /** `true` if the client honours resource subscriptions. */
  subscriptions: boolean;
}

/** Identity of the MCP client that invoked the action. */
export interface InvokingAgent {
  /** Stable client identifier as advertised during MCP `initialize` (e.g. `claude-ai`). */
  id: string;
  /** Human-readable client name (e.g. `Claude`). */
  name: string;
}

/** Contextual metadata about the web/server app that registered the action. */
export interface ClientContext {
  /** Browser origin or server-declared origin the session was established from. */
  origin: string;
  /** Optional route/path hint supplied by the app at invocation time. */
  route?: string;
  /** User-agent string when the SDK runs in a browser. */
  userAgent?: string;
}

/** Payload for {@link ActionContext.progress}. All fields optional; send whichever are available. */
export interface ProgressUpdate {
  /** Short status line shown to the user. */
  message?: string;
  /** Completion percentage (0–100). Must increase monotonically within an invocation. */
  percent?: number;
  /** Free-form structured data forwarded to `notifications/progress._meta`. */
  data?: unknown;
}

/** Payload for {@link ActionContext.sample}. */
export interface SampleRequest<T> {
  /** Prompt sent to the agent's LLM. */
  prompt: string;
  /** Optional runtime validator for the returned content. */
  schema?: StandardSchemaV1<T>;
  /** Optional JSON Schema the MCP client can use to constrain the model output. */
  jsonSchema?: unknown;
  /** Maximum tokens the sampling call may consume (default 1024 on the bridge side). */
  maxTokens?: number;
}

/** Payload for {@link ActionContext.confirm}. */
export interface ConfirmRequest {
  /** Yes/no prompt shown to the user. */
  question: string;
}

export interface ElicitRequest<T> {
  question: string;
  /** Runtime validator for the returned content. */
  schema: StandardSchemaV1<T>;
  /**
   * JSON Schema sent to the MCP client so it can render the right form.
   * Optional with a permissive fallback (text input labelled "response"),
   * but for good UX callers should derive it from their validator:
   *   ctx.elicit({ question, schema, jsonSchema: z.toJSONSchema(schema) })
   */
  jsonSchema?: unknown;
}

/**
 * Runtime context passed to every {@link ActionHandler}. Use it to emit progress,
 * log, request user confirmation or input, call the agent's LLM, and observe cancellation.
 */
export interface ActionContext {
  /** Aborts when the caller cancels or the action timeout fires. Forward to `fetch`/`AbortController`-aware APIs. */
  signal: AbortSignal;
  /** Snapshot of what the connected MCP client supports. */
  agentCapabilities: AgentCapabilities;
  /** Identity of the MCP client currently invoking this action. */
  agent: InvokingAgent;
  /** Origin/route metadata about the registering app. */
  client: ClientContext;
  /** Emits a progress notification. Percent must strictly increase within an invocation. */
  progress(update: ProgressUpdate): void;
  /**
   * Asks the agent's LLM to complete `req.prompt`. When `req.schema` is set the
   * result is validated before being returned.
   * @throws {SamplingNotAvailableError} If the client did not advertise sampling.
   */
  sample<T = string>(req: SampleRequest<T>): Promise<T>;
  /**
   * Ask the user a yes/no question. Returns `true` only on explicit accept.
   * Decline, cancel, and absence of elicitation capability all collapse to
   * `false` — the safe default for destructive-op confirmations.
   */
  confirm(req: ConfirmRequest): Promise<boolean>;
  /**
   * Prompt the user for structured content. Resolves with the validated value
   * on accept, `null` on decline or cancel. Throws `ElicitationNotAvailableError`
   * when the client didn't advertise elicitation — structured data has no safe
   * default, so the handler must branch explicitly.
   */
  elicit<T>(req: ElicitRequest<T>): Promise<T | null>;
  /** Emits a structured log entry forwarded over MCP `notifications/message`. */
  log(entry: LogEntry): void;
}

/** Payload for {@link ActionContext.log}. */
export interface LogEntry {
  /** Severity level (maps to MCP logging levels). */
  level: LogLevel;
  /** Human-readable message. */
  message: string;
  /** Optional structured metadata merged into the MCP `data` field. */
  meta?: Record<string, unknown>;
}
