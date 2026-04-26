import { ActionBuilderImpl, type BuilderRegistry, ResourceBuilderImpl } from './builder-impl.js';
import type {
  ActionBuilder,
  ActionDefinition,
  ResourceBuilder,
  ResourceDefinition,
} from './builder.js';
import type {
  ActionContext,
  ConfirmRequest,
  ElicitRequest,
  ProgressUpdate,
  SampleRequest,
} from './context.js';
import { JsonRpcDispatcher } from './dispatcher.js';
import {
  CancelledError,
  ElicitationNotAvailableError,
  SamplingNotAvailableError,
  TesseronError,
  TimeoutError,
} from './errors.js';
import {
  type ActionInvokeParams,
  type ActionManifestEntry,
  type ActionResultPayload,
  type AppMetadata,
  type HelloParams,
  PROTOCOL_VERSION,
  type ResourceManifestEntry,
  type ResourceReadParams,
  type ResourceReadResult,
  type ResourceSubscribeParams,
  type ResourceUnsubscribeParams,
  type ResumeParams,
  type TesseronCapabilities,
  TesseronErrorCode,
  type WelcomeResult,
} from './protocol.js';
import {
  CONFIRM_REQUESTED_SCHEMA,
  PERMISSIVE_ELICIT_SCHEMA,
  assertValidElicitSchema,
  permissiveJsonSchema,
  standardValidate,
} from './schema-helpers.js';
import { type Transport, TransportClosedError } from './transport.js';

/**
 * Credentials returned by a previous {@link WelcomeResult} that let the SDK
 * rejoin that session via `tesseron/resume` instead of opening a fresh one.
 * Storage of this pair is the implementer's responsibility — stash it in
 * localStorage, a cookie, an Electron store, the OS keychain, whatever fits
 * the app.
 */
export interface ResumeCredentials {
  /** `sessionId` from the prior {@link WelcomeResult}. */
  sessionId: string;
  /**
   * `resumeToken` from the prior {@link WelcomeResult}. Rotated on every
   * successful resume; persist the value returned in each handshake.
   */
  resumeToken: string;
}

/**
 * Optional arguments to {@link TesseronClient.connect}. Currently supports
 * opting into session resume; more may be added in future minor versions.
 */
export interface ConnectOptions {
  /**
   * If provided, the SDK sends `tesseron/resume` with these credentials
   * instead of `tesseron/hello`. On a successful resume the returned
   * {@link WelcomeResult} carries the same `sessionId` and a freshly-rotated
   * `resumeToken`. On failure (unknown session, TTL elapsed, token mismatch)
   * the request rejects with a {@link TesseronError} of code
   * {@link TesseronErrorCode.ResumeFailed}; callers typically fall back to a
   * plain `connect()` at that point.
   *
   * **Resume does NOT restore resource subscriptions.** `resources/subscribe`
   * bindings on the prior socket are torn down when the transport closes and
   * are not replayed; if the app relied on push updates, re-subscribe after
   * the resume handshake resolves.
   */
  resume?: ResumeCredentials;
}

/**
 * App identity sent to the gateway during the `tesseron/hello` handshake.
 * Pass this to {@link TesseronClient.app}.
 */
export interface AppConfig {
  /** Stable machine-readable identifier used as the MCP tool-name prefix (`<id>__<action>`). */
  id: string;
  /** Human-readable name shown in client UIs and claim prompts. */
  name: string;
  /** Optional short description surfaced to the agent in the manifest. */
  description?: string;
  /** Optional absolute URL of an icon the agent may display. */
  iconUrl?: string;
  /** Optional app version string; purely informational. */
  version?: string;
  /** Browser/page origin. Defaults to `globalThis.location.origin` when omitted. */
  origin?: string;
}

export const SDK_CAPABILITIES: TesseronCapabilities = {
  streaming: true,
  subscriptions: true,
  sampling: true,
  elicitation: true,
};

interface ActionDefinitionWithSchema extends ActionDefinition {
  inputJsonSchema?: unknown;
  outputJsonSchema?: unknown;
}

interface ResourceDefinitionWithSchema extends ResourceDefinition {
  outputJsonSchema?: unknown;
}

interface ActiveSubscription {
  resourceName: string;
  unsubscribe: () => void;
}

/**
 * Registers actions and resources and connects them to a Tesseron gateway so
 * an MCP client (Claude, Cursor, etc.) can invoke them. Call {@link TesseronClient.app}
 * once to declare identity, chain {@link TesseronClient.action} / {@link TesseronClient.resource}
 * builders to expose capabilities, then call {@link TesseronClient.connect} with a
 * {@link Transport}. Most apps use the `@tesseron/web` or `@tesseron/server` singleton
 * rather than constructing this directly.
 *
 * @example
 * ```ts
 * tesseron.app({ id: 'todo', name: 'Todo' });
 * tesseron.action('addTodo')
 *   .input(z.object({ text: z.string() }))
 *   .handler(async ({ text }) => todos.add(text));
 * await tesseron.connect();
 * ```
 */
export class TesseronClient implements BuilderRegistry {
  private appConfig?: AppMetadata;
  private readonly actions = new Map<string, ActionDefinitionWithSchema>();
  private readonly resources = new Map<string, ResourceDefinitionWithSchema>();
  private readonly invocations = new Map<string, AbortController>();
  private readonly subscriptions = new Map<string, ActiveSubscription>();

  private dispatcher?: JsonRpcDispatcher;
  private transport?: Transport;
  private welcome?: WelcomeResult;

  /**
   * Sets the app identity included in the `tesseron/hello` handshake.
   * Must be called before {@link TesseronClient.connect}.
   */
  app(config: AppConfig): this {
    this.appConfig = {
      id: config.id,
      name: config.name,
      description: config.description,
      iconUrl: config.iconUrl,
      version: config.version,
      origin: config.origin ?? resolveOrigin(),
    };
    return this;
  }

  /**
   * Starts building an action the agent can invoke as an MCP tool. The action
   * is registered only after {@link ActionBuilder.handler} is called.
   */
  action<I = unknown, O = unknown>(name: string): ActionBuilder<I, O> {
    return new ActionBuilderImpl<I, O>(name, this) as unknown as ActionBuilder<I, O>;
  }

  /**
   * Starts building a resource the agent can read (and optionally subscribe to).
   * The resource is registered when {@link ResourceBuilder.read} or
   * {@link ResourceBuilder.subscribe} is called.
   */
  resource<T = unknown>(name: string): ResourceBuilder<T> {
    return new ResourceBuilderImpl<T>(name, this) as unknown as ResourceBuilder<T>;
  }

  registerAction(action: ActionDefinition): void {
    this.actions.set(action.name, action as ActionDefinitionWithSchema);
    if (this.dispatcher && this.welcome) {
      this.dispatcher.notify('actions/list_changed', { actions: this.actionManifest() });
    }
  }

  registerResource(resource: ResourceDefinition): void {
    this.resources.set(resource.name, resource as ResourceDefinitionWithSchema);
    if (this.dispatcher && this.welcome) {
      this.dispatcher.notify('resources/list_changed', { resources: this.resourceManifest() });
    }
  }

  removeAction(name: string): void {
    if (this.actions.delete(name) && this.dispatcher && this.welcome) {
      this.dispatcher.notify('actions/list_changed', { actions: this.actionManifest() });
    }
  }

  removeResource(name: string): void {
    if (this.resources.delete(name) && this.dispatcher && this.welcome) {
      this.dispatcher.notify('resources/list_changed', { resources: this.resourceManifest() });
    }
  }

  /**
   * Sends `tesseron/hello` (or `tesseron/resume` if {@link ConnectOptions.resume}
   * is provided) over the given transport and installs handlers for action
   * invocations and resource reads. Resolves with the gateway's
   * {@link WelcomeResult}: includes the claim code the user enters into their
   * MCP client on fresh handshakes, and a `resumeToken` the caller can stash
   * for a later reconnect.
   * @throws {Error} If called before {@link TesseronClient.app}.
   */
  async connect(transport: Transport, options?: ConnectOptions): Promise<WelcomeResult> {
    if (!this.appConfig) {
      throw new Error('Tesseron: call app({ id, name }) before connect().');
    }
    // If a previous transport is still attached (e.g. HMR re-ran the module
    // and re-invoked `connect()` on the same singleton), close it now. The
    // alternative — silently orphaning the old socket — leaves a phantom
    // "claimed" session on the gateway side, and the bridge's by-app-id
    // lookup picks that dead session before the freshly-claimed one.
    if (this.transport && this.transport !== transport) {
      this.transport.close();
    }
    this.transport = transport;
    const dispatcher = new JsonRpcDispatcher((message) => transport.send(message));
    this.dispatcher = dispatcher;

    transport.onMessage((message) => dispatcher.receive(message));
    transport.onClose((reason) => {
      dispatcher.rejectAllPending(new TransportClosedError(reason));
      // Only clear instance state if it still belongs to *this* transport.
      // A stale onClose from a previously-attached transport firing after
      // a reconnect would otherwise trample the new dispatcher and welcome.
      if (this.dispatcher !== dispatcher) return;
      this.dispatcher = undefined;
      this.welcome = undefined;
      for (const ctrl of this.invocations.values()) ctrl.abort();
      this.invocations.clear();
      for (const sub of this.subscriptions.values()) sub.unsubscribe();
      this.subscriptions.clear();
    });

    dispatcher.on('actions/invoke', (params) => this.handleInvoke(params as ActionInvokeParams));
    dispatcher.onNotification('actions/cancel', (params) => {
      this.handleCancel(params as { invocationId: string });
    });
    dispatcher.on('resources/read', (params) =>
      this.handleResourceRead(params as ResourceReadParams),
    );
    dispatcher.on('resources/subscribe', (params) => {
      this.handleResourceSubscribe(params as ResourceSubscribeParams);
      return undefined;
    });
    dispatcher.on('resources/unsubscribe', (params) => {
      this.handleResourceUnsubscribe(params as ResourceUnsubscribeParams);
      return undefined;
    });

    const baseParams = {
      protocolVersion: PROTOCOL_VERSION,
      app: this.appConfig,
      actions: this.actionManifest(),
      resources: this.resourceManifest(),
      capabilities: SDK_CAPABILITIES,
    };
    const welcome = options?.resume
      ? await dispatcher.request('tesseron/resume', {
          ...baseParams,
          sessionId: options.resume.sessionId,
          resumeToken: options.resume.resumeToken,
        } satisfies ResumeParams)
      : await dispatcher.request('tesseron/hello', baseParams satisfies HelloParams);
    this.welcome = welcome;
    return welcome;
  }

  /**
   * Closes the underlying transport. In-flight invocations are aborted and
   * active subscriptions are torn down via the transport's close handler.
   */
  async disconnect(): Promise<void> {
    this.transport?.close();
  }

  getWelcome(): WelcomeResult | undefined {
    return this.welcome;
  }

  private actionManifest(): ActionManifestEntry[] {
    return Array.from(this.actions.values()).map((a) => ({
      name: a.name,
      description: a.description,
      inputSchema: a.inputJsonSchema ?? permissiveJsonSchema(),
      outputSchema: a.outputJsonSchema,
      annotations: a.annotations,
      timeoutMs: a.timeoutMs,
    }));
  }

  private resourceManifest(): ResourceManifestEntry[] {
    return Array.from(this.resources.values()).map((r) => ({
      name: r.name,
      description: r.description,
      outputSchema: r.outputJsonSchema,
      subscribable: typeof r.subscriber === 'function',
    }));
  }

  private async handleInvoke(params: ActionInvokeParams): Promise<ActionResultPayload> {
    const action = this.actions.get(params.name);
    if (!action) {
      throw new TesseronError(TesseronErrorCode.ActionNotFound, `Action not found: ${params.name}`);
    }

    let input: unknown = params.input;
    if (action.inputSchema) {
      const result = await standardValidate(action.inputSchema, params.input);
      if (!result.ok) {
        throw new TesseronError(TesseronErrorCode.InputValidation, 'Invalid input', result.issues);
      }
      input = result.value;
    }

    const controller = new AbortController();
    this.invocations.set(params.invocationId, controller);
    const timeoutId = setTimeout(() => {
      controller.abort(new TimeoutError(action.timeoutMs));
    }, action.timeoutMs);

    const ctx: ActionContext = {
      signal: controller.signal,
      agentCapabilities: this.welcome?.capabilities ?? {
        sampling: false,
        elicitation: false,
        subscriptions: false,
      },
      agent: this.welcome?.agent ?? { id: 'unknown', name: 'unknown' },
      client: {
        origin: this.appConfig?.origin ?? 'unknown',
        route: params.client?.route,
        userAgent: resolveUserAgent(),
      },
      progress: (update: ProgressUpdate) => {
        this.dispatcher?.notify('actions/progress', {
          invocationId: params.invocationId,
          message: update.message,
          percent: update.percent,
          data: update.data,
        });
      },
      sample: async <T>(req: SampleRequest<T>): Promise<T> => {
        if (!this.welcome?.capabilities.sampling) {
          throw new SamplingNotAvailableError();
        }
        const dispatcher = this.dispatcher;
        if (!dispatcher) throw new SamplingNotAvailableError();
        const result = await dispatcher.request(
          'sampling/request',
          {
            invocationId: params.invocationId,
            prompt: req.prompt,
            schema: req.jsonSchema,
            maxTokens: req.maxTokens,
          },
          { signal: controller.signal },
        );
        if (req.schema) {
          // MCP sampling returns a text string; when a schema is declared the
          // caller expects the LLM output to be JSON. Parse first, validate
          // second, so `schema: z.object(...)` works against `content: "{...}"`.
          let decoded: unknown = result.content;
          if (typeof decoded === 'string') {
            try {
              decoded = JSON.parse(decoded);
            } catch (parseError) {
              throw new TesseronError(
                TesseronErrorCode.HandlerError,
                'Sampling result was not valid JSON (schema was declared, so JSON was expected)',
                { raw: decoded, parseError: (parseError as Error).message },
              );
            }
          }
          const validated = await standardValidate(req.schema, decoded);
          if (!validated.ok) {
            throw new TesseronError(
              TesseronErrorCode.HandlerError,
              'Sampling result failed schema validation',
              validated.issues,
            );
          }
          return validated.value;
        }
        return result.content as T;
      },
      confirm: async (req: ConfirmRequest): Promise<boolean> => {
        // Safe default: if we can't prompt, the user didn't say yes. Callers
        // use `if (!(await ctx.confirm(...))) return;` — works correctly
        // whether or not the MCP client supports elicitation.
        if (!this.welcome?.capabilities.elicitation) return false;
        const dispatcher = this.dispatcher;
        if (!dispatcher) return false;
        const result = await dispatcher.request(
          'elicitation/request',
          {
            invocationId: params.invocationId,
            question: req.question,
            schema: CONFIRM_REQUESTED_SCHEMA,
          },
          { signal: controller.signal },
        );
        return result.action === 'accept';
      },
      elicit: async <T>(req: ElicitRequest<T>): Promise<T | null> => {
        if (!this.welcome?.capabilities.elicitation) {
          throw new ElicitationNotAvailableError();
        }
        const dispatcher = this.dispatcher;
        if (!dispatcher) throw new ElicitationNotAvailableError();
        const jsonSchema = req.jsonSchema ?? PERMISSIVE_ELICIT_SCHEMA;
        assertValidElicitSchema(jsonSchema);
        const result = await dispatcher.request(
          'elicitation/request',
          {
            invocationId: params.invocationId,
            question: req.question,
            schema: jsonSchema,
          },
          { signal: controller.signal },
        );
        if (result.action !== 'accept') return null;
        const validated = await standardValidate(req.schema, result.value);
        if (!validated.ok) {
          throw new TesseronError(
            TesseronErrorCode.HandlerError,
            'Elicitation content failed schema validation',
            validated.issues,
          );
        }
        return validated.value;
      },
      log: ({ level, message, meta }) => {
        this.dispatcher?.notify('log', {
          invocationId: params.invocationId,
          level,
          message,
          meta,
        });
      },
    };

    try {
      const output = await action.handler(input, ctx);
      if (action.outputSchema && action.strictOutput) {
        const result = await standardValidate(action.outputSchema, output);
        if (!result.ok) {
          throw new TesseronError(
            TesseronErrorCode.HandlerError,
            'Output failed strict validation',
            result.issues,
          );
        }
      }
      return { invocationId: params.invocationId, output };
    } catch (error) {
      if (controller.signal.aborted) {
        if (controller.signal.reason instanceof TimeoutError) throw controller.signal.reason;
        throw new CancelledError();
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      this.invocations.delete(params.invocationId);
    }
  }

  private handleCancel(params: { invocationId: string }): void {
    this.invocations.get(params.invocationId)?.abort();
  }

  private async handleResourceRead(params: ResourceReadParams): Promise<ResourceReadResult> {
    const resource = this.resources.get(params.name);
    if (!resource?.reader) {
      throw new TesseronError(
        TesseronErrorCode.ActionNotFound,
        `Resource not readable: ${params.name}`,
      );
    }
    const value = await resource.reader();
    return { value };
  }

  private handleResourceSubscribe(params: ResourceSubscribeParams): void {
    const resource = this.resources.get(params.name);
    if (!resource?.subscriber) {
      throw new TesseronError(
        TesseronErrorCode.ActionNotFound,
        `Resource not subscribable: ${params.name}`,
      );
    }
    const unsubscribe = resource.subscriber((value: unknown) => {
      this.dispatcher?.notify('resources/updated', {
        subscriptionId: params.subscriptionId,
        value,
      });
    });
    this.subscriptions.set(params.subscriptionId, {
      resourceName: params.name,
      unsubscribe,
    });
  }

  private handleResourceUnsubscribe(params: ResourceUnsubscribeParams): void {
    const sub = this.subscriptions.get(params.subscriptionId);
    if (!sub) return;
    sub.unsubscribe();
    this.subscriptions.delete(params.subscriptionId);
  }
}

function resolveOrigin(): string {
  if (typeof globalThis !== 'undefined') {
    const loc = (globalThis as { location?: { origin?: string } }).location;
    if (loc?.origin) return loc.origin;
  }
  return 'unknown';
}

function resolveUserAgent(): string | undefined {
  if (typeof globalThis !== 'undefined') {
    const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
    if (nav?.userAgent) return nav.userAgent;
  }
  return undefined;
}
