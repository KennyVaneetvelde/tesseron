/**
 * Tesseron wire-protocol version sent in {@link HelloParams.protocolVersion}.
 * Major-version mismatches are hard-rejected by the gateway; minor-version
 * mismatches log a warning.
 */
export const PROTOCOL_VERSION = '1.0.0' as const;
/** JSON-RPC version used for every message. */
export const JSONRPC_VERSION = '2.0' as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  method: string;
  params?: P;
}

export interface JsonRpcSuccessResponse<R = unknown> {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorResponse {
  jsonrpc: typeof JSONRPC_VERSION;
  id: JsonRpcId;
  error: JsonRpcErrorPayload;
}

export type JsonRpcResponse<R = unknown> = JsonRpcSuccessResponse<R> | JsonRpcErrorResponse;

export interface JsonRpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcMessage<P = unknown, R = unknown> =
  | JsonRpcRequest<P>
  | JsonRpcNotification<P>
  | JsonRpcResponse<R>;

/**
 * Numeric codes for every error the SDK raises. Codes in `-32xxx` follow the
 * JSON-RPC reserved range; Tesseron-specific codes start at `-32000`. Use
 * {@link TesseronError.code} to branch on these.
 */
export const TesseronErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  ProtocolMismatch: -32000,
  Cancelled: -32001,
  Timeout: -32002,
  ActionNotFound: -32003,
  InputValidation: -32004,
  HandlerError: -32005,
  SamplingNotAvailable: -32006,
  ElicitationNotAvailable: -32007,
  SamplingDepthExceeded: -32008,
  Unauthorized: -32009,
  TransportClosed: -32010,
} as const;

export type TesseronErrorCodeValue = (typeof TesseronErrorCode)[keyof typeof TesseronErrorCode];

/** Feature flags exchanged during the `tesseron/hello` handshake. */
export interface TesseronCapabilities {
  /** `true` if the peer can send/receive progress and log notifications during an invocation. */
  streaming: boolean;
  /** `true` if the peer honours `resources/subscribe`. */
  subscriptions: boolean;
  /** `true` if the peer can service `sampling/request`. On the gateway side, mirrors the MCP client's `sampling` capability. */
  sampling: boolean;
  /** `true` if the peer can service `elicitation/request`. On the gateway side, mirrors the MCP client's `elicitation` capability. */
  elicitation: boolean;
}

/** App identity as carried on the wire; differs from {@link AppConfig} in that `origin` is required. */
export interface AppMetadata {
  id: string;
  name: string;
  description?: string;
  origin: string;
  iconUrl?: string;
  version?: string;
}

/** MCP-aligned tool hints surfaced in the action manifest. */
export interface ActionAnnotations {
  /** `true` if the action has no side effects (agents may skip confirmation UIs). */
  readOnly?: boolean;
  /** `true` if the action can destroy or mutate state in a non-idempotent way. */
  destructive?: boolean;
  /** `true` if the client should confirm with the user before invoking. */
  requiresConfirmation?: boolean;
}

export interface ActionManifestEntry {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: ActionAnnotations;
  timeoutMs?: number;
}

export interface ResourceManifestEntry {
  name: string;
  description: string;
  outputSchema?: unknown;
  subscribable: boolean;
}

/** Parameters of the `tesseron/hello` request sent by the SDK on connect. */
export interface HelloParams {
  protocolVersion: string;
  app: AppMetadata;
  actions: ActionManifestEntry[];
  resources: ResourceManifestEntry[];
  capabilities: TesseronCapabilities;
}

/**
 * Result of the `tesseron/hello` handshake. Carries the session id, the
 * capabilities the MCP client will honour, the connected agent's identity
 * (filled once a bridge attaches), and the `claimCode` the user pastes into
 * their MCP client to link this session.
 */
export interface WelcomeResult {
  sessionId: string;
  protocolVersion: string;
  capabilities: TesseronCapabilities;
  agent: AgentIdentity;
  claimCode?: string;
}

/** Identity advertised by the MCP client that claimed this session. */
export interface AgentIdentity {
  id: string;
  name: string;
}

export interface ActionInvokeParams {
  name: string;
  input: unknown;
  invocationId: string;
  client?: { route?: string };
}

export interface ActionProgressParams {
  invocationId: string;
  message?: string;
  percent?: number;
  data?: unknown;
}

export interface ActionResultPayload {
  invocationId: string;
  output: unknown;
}

export interface ActionCancelParams {
  invocationId: string;
}

export interface ResourceReadParams {
  name: string;
}

export interface ResourceReadResult {
  value: unknown;
}

export interface ResourceSubscribeParams {
  name: string;
  subscriptionId: string;
}

export interface ResourceUnsubscribeParams {
  subscriptionId: string;
}

export interface ResourceUpdatedParams {
  subscriptionId: string;
  value: unknown;
}

export interface SamplingRequestParams {
  invocationId: string;
  prompt: string;
  schema?: unknown;
  maxTokens?: number;
}

export interface SamplingResult {
  content: unknown;
}

export interface ElicitationRequestParams {
  invocationId: string;
  question: string;
  schema: unknown;
}

export interface ElicitationResult {
  /**
   * Mirrors the MCP elicit `action`: `accept` carries `value`; `decline` and
   * `cancel` do not. SDK callers use `ctx.confirm` for yes/no (action-only)
   * or `ctx.elicit` for structured content (action + value).
   */
  action: 'accept' | 'decline' | 'cancel';
  value?: unknown;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogParams {
  invocationId?: string;
  level: LogLevel;
  message: string;
  meta?: Record<string, unknown>;
}

export interface TesseronMethods {
  'tesseron/hello': { params: HelloParams; result: WelcomeResult };
  'sampling/request': { params: SamplingRequestParams; result: SamplingResult };
  'elicitation/request': { params: ElicitationRequestParams; result: ElicitationResult };
  'actions/invoke': { params: ActionInvokeParams; result: ActionResultPayload };
  'resources/read': { params: ResourceReadParams; result: ResourceReadResult };
  'resources/subscribe': { params: ResourceSubscribeParams; result: undefined };
  'resources/unsubscribe': { params: ResourceUnsubscribeParams; result: undefined };
}

export interface TesseronNotifications {
  'actions/progress': ActionProgressParams;
  'actions/cancel': ActionCancelParams;
  'actions/list_changed': { actions: ActionManifestEntry[] };
  'resources/list_changed': { resources: ResourceManifestEntry[] };
  'resources/updated': ResourceUpdatedParams;
  log: LogParams;
}
