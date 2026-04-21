import {
  ActionBuilderImpl,
  type BuilderRegistry,
  ResourceBuilderImpl,
} from './builder-impl.js';
import type { ActionBuilder, RegisteredAction, RegisteredResource, ResourceBuilder } from './builder.js';
import type {
  ActionContext,
  ConfirmRequest,
  ElicitRequest,
  ProgressUpdate,
  SampleRequest,
} from './context.js';
import {
  CancelledError,
  TesseronError,
  ElicitationNotAvailableError,
  SamplingNotAvailableError,
  TimeoutError,
} from './errors.js';
import {
  type ActionInvokeParams,
  type ActionManifestEntry,
  type ActionResultPayload,
  type AppMetadata,
  type TesseronCapabilities,
  TesseronErrorCode,
  type HelloParams,
  PROTOCOL_VERSION,
  type ResourceManifestEntry,
  type ResourceReadParams,
  type ResourceReadResult,
  type ResourceSubscribeParams,
  type ResourceUnsubscribeParams,
  type WelcomeResult,
} from './protocol.js';
import { JsonRpcDispatcher } from './dispatcher.js';
import {
  CONFIRM_REQUESTED_SCHEMA,
  PERMISSIVE_ELICIT_SCHEMA,
  assertValidElicitSchema,
  permissiveJsonSchema,
  standardValidate,
} from './schema-helpers.js';
import { type Transport, TransportClosedError } from './transport.js';

export interface AppConfig {
  id: string;
  name: string;
  description?: string;
  iconUrl?: string;
  version?: string;
  origin?: string;
}

export const SDK_CAPABILITIES: TesseronCapabilities = {
  streaming: true,
  subscriptions: true,
  sampling: true,
  elicitation: true,
};

interface RegisteredActionWithSchema extends RegisteredAction {
  inputJsonSchema?: unknown;
  outputJsonSchema?: unknown;
}

interface RegisteredResourceWithSchema extends RegisteredResource {
  outputJsonSchema?: unknown;
}

interface ActiveSubscription {
  resourceName: string;
  unsubscribe: () => void;
}

export class TesseronClient implements BuilderRegistry {
  private appConfig?: AppMetadata;
  private readonly actions = new Map<string, RegisteredActionWithSchema>();
  private readonly resources = new Map<string, RegisteredResourceWithSchema>();
  private readonly invocations = new Map<string, AbortController>();
  private readonly subscriptions = new Map<string, ActiveSubscription>();

  private dispatcher?: JsonRpcDispatcher;
  private transport?: Transport;
  private welcome?: WelcomeResult;

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

  action<I = unknown, O = unknown>(name: string): ActionBuilder<I, O> {
    return new ActionBuilderImpl<I, O>(name, this) as unknown as ActionBuilder<I, O>;
  }

  resource<T = unknown>(name: string): ResourceBuilder<T> {
    return new ResourceBuilderImpl<T>(name, this) as unknown as ResourceBuilder<T>;
  }

  registerAction(action: RegisteredAction): void {
    this.actions.set(action.name, action as RegisteredActionWithSchema);
    if (this.dispatcher && this.welcome) {
      this.dispatcher.notify('actions/list_changed', { actions: this.actionManifest() });
    }
  }

  registerResource(resource: RegisteredResource): void {
    this.resources.set(resource.name, resource as RegisteredResourceWithSchema);
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

  async connect(transport: Transport): Promise<WelcomeResult> {
    if (!this.appConfig) {
      throw new Error('Tesseron: call app({ id, name }) before connect().');
    }
    this.transport = transport;
    const dispatcher = new JsonRpcDispatcher((message) => transport.send(message));
    this.dispatcher = dispatcher;

    transport.onMessage((message) => dispatcher.receive(message));
    transport.onClose((reason) => {
      dispatcher.rejectAllPending(new TransportClosedError(reason));
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
    dispatcher.on('resources/read', (params) => this.handleResourceRead(params as ResourceReadParams));
    dispatcher.on('resources/subscribe', (params) =>
      this.handleResourceSubscribe(params as ResourceSubscribeParams),
    );
    dispatcher.on('resources/unsubscribe', (params) => {
      this.handleResourceUnsubscribe(params as ResourceUnsubscribeParams);
    });

    const hello: HelloParams = {
      protocolVersion: PROTOCOL_VERSION,
      app: this.appConfig,
      actions: this.actionManifest(),
      resources: this.resourceManifest(),
      capabilities: SDK_CAPABILITIES,
    };
    const welcome = await dispatcher.request('tesseron/hello', hello);
    this.welcome = welcome;
    return welcome;
  }

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
          const validated = await standardValidate(req.schema, result.content);
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
      log: (level, message, meta) => {
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
      throw new TesseronError(TesseronErrorCode.ActionNotFound, `Resource not readable: ${params.name}`);
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
