import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { LogLevel } from './protocol.js';

export interface AgentCapabilities {
  sampling: boolean;
  elicitation: boolean;
  subscriptions: boolean;
}

export interface InvokingAgent {
  id: string;
  name: string;
}

export interface ClientContext {
  origin: string;
  route?: string;
  userAgent?: string;
}

export interface ProgressUpdate {
  message?: string;
  percent?: number;
  data?: unknown;
}

export interface SampleRequest<T> {
  prompt: string;
  schema?: StandardSchemaV1<T>;
  jsonSchema?: unknown;
  maxTokens?: number;
}

export interface ConfirmRequest {
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

export interface ActionContext {
  signal: AbortSignal;
  agentCapabilities: AgentCapabilities;
  agent: InvokingAgent;
  client: ClientContext;
  progress(update: ProgressUpdate): void;
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
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
}
