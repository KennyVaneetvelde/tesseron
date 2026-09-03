import { TesseronError } from './errors.js';
import {
  JSONRPC_VERSION,
  type JsonRpcErrorPayload,
  type JsonRpcErrorResponse,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcSuccessResponse,
  TesseronErrorCode,
  type TesseronMethods,
  type TesseronNotifications,
} from './protocol.js';

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface RequestOptions {
  /**
   * Optional AbortSignal; when it fires, the pending request rejects with
   * `signal.reason` (if it's an Error) or a generic abort Error. The
   * outstanding pending entry is dropped from the dispatcher map so a late
   * response from the peer is a no-op.
   */
  signal?: AbortSignal;
}

export class JsonRpcDispatcher {
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly handlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private nextId = 1;

  constructor(private readonly send: (message: unknown) => void) {}

  on<M extends keyof TesseronMethods>(
    method: M,
    handler: (
      params: TesseronMethods[M]['params'],
    ) => Promise<TesseronMethods[M]['result']> | TesseronMethods[M]['result'],
  ): void;
  on(method: string, handler: RequestHandler): void;
  on(method: string, handler: RequestHandler): void {
    this.handlers.set(method, handler);
  }

  onNotification<N extends keyof TesseronNotifications>(
    method: N,
    handler: (params: TesseronNotifications[N]) => void,
  ): void;
  onNotification(method: string, handler: NotificationHandler): void;
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  request<M extends keyof TesseronMethods>(
    method: M,
    params: TesseronMethods[M]['params'],
    options?: RequestOptions,
  ): Promise<TesseronMethods[M]['result']>;
  request(method: string, params: unknown, options?: RequestOptions): Promise<unknown>;
  request(method: string, params: unknown, options?: RequestOptions): Promise<unknown> {
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(abortReason(signal));
    }
    const id = this.nextId++;
    const message: JsonRpcRequest = { jsonrpc: JSONRPC_VERSION, id, method, params };
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        reject(abortReason(signal));
      };
      const wrappedResolve = (value: unknown): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const wrappedReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject });
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        this.send(message);
      } catch (e) {
        wrappedReject(e as Error);
      }
    });
  }

  notify<N extends keyof TesseronNotifications>(method: N, params: TesseronNotifications[N]): void;
  notify(method: string, params: unknown): void;
  notify(method: string, params: unknown): void {
    const message: JsonRpcNotification = { jsonrpc: JSONRPC_VERSION, method, params };
    this.send(message);
  }

  receive(message: unknown): void {
    if (!isJsonRpcEnvelope(message)) return;
    if (typeof message.method === 'string') {
      if ('id' in message && message.id !== undefined) {
        // Suppress unhandled rejections from `handleRequest`. The transport
        // wrappers in `@tesseron/core` and `@tesseron/mcp` already close the
        // channel on send failure so the peer learns about the broken
        // request via `rejectAllPending`; we don't want a noisy unhandled
        // rejection on top of that. Any other handler-internal failure has
        // already been turned into a JSON-RPC error response by
        // `handleRequest` itself, so there is nothing meaningful left to do
        // here.
        this.handleRequest(message as unknown as JsonRpcRequest).catch(() => {});
      } else {
        this.handleNotification(message as unknown as JsonRpcNotification);
      }
    } else if ('id' in message && ('result' in message || 'error' in message)) {
      this.handleResponse(message as unknown as JsonRpcSuccessResponse | JsonRpcErrorResponse);
    }
  }

  rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      this.sendError(request.id, {
        code: TesseronErrorCode.MethodNotFound,
        message: `Method not found: ${request.method}`,
      });
      return;
    }
    try {
      const result = await handler(request.params);
      const response: JsonRpcSuccessResponse = {
        jsonrpc: JSONRPC_VERSION,
        id: request.id,
        result: result ?? null,
      };
      this.send(response);
    } catch (error) {
      this.sendError(request.id, toErrorPayload(error));
    }
  }

  private handleNotification(notification: JsonRpcNotification): void {
    this.notificationHandlers.get(notification.method)?.(notification.params);
  }

  private handleResponse(response: JsonRpcSuccessResponse | JsonRpcErrorResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if ('error' in response) {
      const { code, message, data } = response.error;
      pending.reject(new TesseronError(code, message, data));
    } else {
      pending.resolve(response.result);
    }
  }

  private sendError(id: JsonRpcId, error: JsonRpcErrorPayload): void {
    const response: JsonRpcErrorResponse = { jsonrpc: JSONRPC_VERSION, id, error };
    this.send(response);
  }
}

interface JsonRpcEnvelope {
  jsonrpc: typeof JSONRPC_VERSION;
  method?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
  params?: unknown;
}

function isJsonRpcEnvelope(value: unknown): value is JsonRpcEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { jsonrpc?: unknown };
  return candidate.jsonrpc === JSONRPC_VERSION;
}

function abortReason(signal: AbortSignal | undefined): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error('Request aborted');
}

function toErrorPayload(error: unknown): JsonRpcErrorPayload {
  if (error instanceof TesseronError) {
    return { code: error.code, message: error.message, data: error.data };
  }
  if (error instanceof Error) {
    return { code: TesseronErrorCode.InternalError, message: error.message };
  }
  return { code: TesseronErrorCode.InternalError, message: String(error) };
}
