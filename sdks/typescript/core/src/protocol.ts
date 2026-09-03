/**
 * Tesseron wire-protocol version sent in {@link HelloParams.protocolVersion}.
 * Major-version mismatches are hard-rejected by the gateway; minor-version
 * mismatches log a warning.
 *
 * 1.2.0 introduces the host-mint claim flow (tesseron#60): the
 * `tesseron-bind.<code>` WebSocket subprotocol element, the
 * `tesseron/bind` JSON-RPC method (UDS), `hostMintedClaim` in the
 * instance manifest, and `tesseron/claimed.agentCapabilities`.
 */
export const PROTOCOL_VERSION = '1.2.0' as const;
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
  ResumeFailed: -32011,
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
 * Result of the `tesseron/hello` handshake (and `tesseron/resume`). Carries the
 * session id, the capabilities the MCP client will honour, the connected
 * agent's identity (filled once a bridge attaches), the `claimCode` the user
 * pastes into their MCP client to link this session, and an opaque
 * `resumeToken` the caller can stash wherever fits their app to rejoin this
 * session after a transport drop.
 */
export interface WelcomeResult {
  sessionId: string;
  protocolVersion: string;
  capabilities: TesseronCapabilities;
  agent: AgentIdentity;
  /**
   * 6-character pairing code the user enters in their MCP client. Present on
   * every `tesseron/hello` response. Always **absent** on a successful
   * `tesseron/resume` response: the gateway only permits resume for
   * already-claimed sessions, so re-issuing a pairing code would be a no-op
   * at best and a UI confusion at worst.
   */
  claimCode?: string;
  /**
   * Server-issued token that, together with {@link WelcomeResult.sessionId},
   * lets a reconnecting SDK rejoin this session via `tesseron/resume` after the
   * transport drops. Rotated on every successful resume (one-shot) — callers
   * that persist it MUST overwrite with the freshest value from each handshake.
   *
   * Optional on the wire for backwards-compatibility with gateways that pre-date
   * the resume extension; new gateways always populate it.
   */
  resumeToken?: string;
}

/** Identity advertised by the MCP client that claimed this session. */
export interface AgentIdentity {
  id: string;
  name: string;
}

/**
 * Parameters of the `tesseron/resume` request sent by the SDK when it already
 * has a `sessionId` + `resumeToken` pair from a prior handshake and wants to
 * rejoin an existing (possibly-claimed) session instead of opening a fresh one.
 *
 * Carries the same `app` / `actions` / `resources` / `capabilities` as a
 * regular `tesseron/hello` because a fresh app build may have added, removed,
 * or changed them since the previous connect. The gateway updates the session's
 * registered manifest from these fields on a successful resume.
 */
export interface ResumeParams extends HelloParams {
  /** Opaque session identifier returned in the prior {@link WelcomeResult}. */
  sessionId: string;
  /**
   * Opaque token returned in the prior {@link WelcomeResult}. Gateway compares
   * against the stored token in constant time and rotates it on success; the
   * freshly-returned {@link WelcomeResult.resumeToken} is the one to persist.
   */
  resumeToken: string;
}

/**
 * Result of the `tesseron/resume` request. Same shape as {@link WelcomeResult}
 * — `sessionId` matches the param, `resumeToken` is rotated, and `claimCode`
 * is always absent (the gateway only permits resume for already-claimed
 * sessions, so there is no pairing code to re-issue).
 */
export type ResumeResult = WelcomeResult;

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

/**
 * Parameters of the `tesseron/bind` request a v1.2 gateway sends as the
 * very first frame after a UDS connect, when dialing a host-minted
 * manifest. Replaces the WebSocket `tesseron-bind.<code>` subprotocol
 * element on transports without a subprotocol concept of their own.
 *
 * The host validates `code` against its in-memory `hostMintedClaim.code`
 * in constant time. On success: replies `{ ok: true }`, marks the bind
 * authoritative, and proceeds with the v3 hello-replay flow. On
 * mismatch: replies with `Unauthorized` and closes the channel.
 */
export interface BindParams {
  code: string;
}

/** Response to `tesseron/bind`. Only `{ ok: true }` is meaningful. */
export interface BindResult {
  ok: true;
}

export interface TesseronMethods {
  'tesseron/hello': { params: HelloParams; result: WelcomeResult };
  'tesseron/resume': { params: ResumeParams; result: ResumeResult };
  'tesseron/bind': { params: BindParams; result: BindResult };
  'sampling/request': { params: SamplingRequestParams; result: SamplingResult };
  'elicitation/request': { params: ElicitationRequestParams; result: ElicitationResult };
  'actions/invoke': { params: ActionInvokeParams; result: ActionResultPayload };
  'resources/read': { params: ResourceReadParams; result: ResourceReadResult };
  'resources/subscribe': { params: ResourceSubscribeParams; result: undefined };
  'resources/unsubscribe': { params: ResourceUnsubscribeParams; result: undefined };
}

/**
 * Parameters of the `tesseron/claimed` notification sent by the gateway to the
 * SDK when an agent calls `tesseron__claim_session` on a session that was
 * previously in the awaiting-claim state. After this notification fires, the
 * session's `claimCode` is consumed and no longer claimable; consumers
 * displaying the code should clear it.
 */
export interface ClaimedParams {
  /** Identity of the agent that just claimed this session. */
  agent: AgentIdentity;
  /** Unix epoch milliseconds at which the gateway processed the claim. */
  claimedAt: number;
  /**
   * Negotiated capability bits the gateway will honour for this session
   * (sampling / elicitation depend on whether the attached MCP client
   * advertised them; streaming / subscriptions are always `true`). When
   * present, the SDK overwrites `WelcomeResult.capabilities` so action
   * handlers gating on `ctx.agentCapabilities.sampling` see authoritative
   * values rather than the SDK's own pre-claim defaults.
   *
   * Optional for back-compat with v1.1 gateways that didn't carry the
   * field; v1.1 SDKs that don't see it keep using the welcome-time
   * capabilities, which were authoritative in v1.1 because the gateway
   * minted the welcome itself. Required-in-spirit for v1.2 hosts that
   * synthesize the welcome — without it, `ctx.agentCapabilities`
   * reports the SDK's *own* capabilities, not the gateway's. See
   * tesseron#60.
   */
  agentCapabilities?: TesseronCapabilities;
}

export interface TesseronNotifications {
  'actions/progress': ActionProgressParams;
  'actions/cancel': ActionCancelParams;
  'actions/list_changed': { actions: ActionManifestEntry[] };
  'resources/list_changed': { resources: ResourceManifestEntry[] };
  'resources/updated': ResourceUpdatedParams;
  'tesseron/claimed': ClaimedParams;
  log: LogParams;
}
