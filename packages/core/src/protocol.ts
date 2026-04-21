export const PROTOCOL_VERSION = '0.2.0' as const;
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
} as const;

export type TesseronErrorCodeValue = (typeof TesseronErrorCode)[keyof typeof TesseronErrorCode];

export interface TesseronCapabilities {
  streaming: boolean;
  subscriptions: boolean;
  sampling: boolean;
  elicitation: boolean;
}

export interface AppMetadata {
  id: string;
  name: string;
  description?: string;
  origin: string;
  iconUrl?: string;
  version?: string;
}

export interface ActionAnnotations {
  readOnly?: boolean;
  destructive?: boolean;
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

export interface HelloParams {
  protocolVersion: string;
  app: AppMetadata;
  actions: ActionManifestEntry[];
  resources: ResourceManifestEntry[];
  capabilities: TesseronCapabilities;
}

export interface WelcomeResult {
  sessionId: string;
  protocolVersion: string;
  capabilities: TesseronCapabilities;
  agent: AgentIdentity;
  claimCode?: string;
}

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
  'resources/subscribe': { params: ResourceSubscribeParams; result: void };
  'resources/unsubscribe': { params: ResourceUnsubscribeParams; result: void };
}

export interface TesseronNotifications {
  'actions/progress': ActionProgressParams;
  'actions/cancel': ActionCancelParams;
  'actions/list_changed': { actions: ActionManifestEntry[] };
  'resources/list_changed': { resources: ResourceManifestEntry[] };
  'resources/updated': ResourceUpdatedParams;
  log: LogParams;
}
