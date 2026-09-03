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
  type ClaimedParams,
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
  private readonly welcomeListeners = new Set<(welcome: WelcomeResult) => void>();

  private dispatcher?: JsonRpcDispatcher;
  private transport?: Transport;
  private welcome?: WelcomeResult;
  /**
   * Promise representing the most recent in-flight `connect()`. New connect
   * calls await this before they touch transport state, so two re-entries
   * never run hello/resume on overlapping sockets. See {@link TesseronClient.connect}.
   */
  private connectChain?: Promise<WelcomeResult>;
  /**
   * Resolves when {@link transport}'s `onClose` handler has finished
   * draining state for the currently-attached transport. Allows a new
   * `connect()` to wait for full teardown before starting a fresh handshake.
   */
  private transportClosed?: Promise<void>;
  /**
   * Monotonic counter incremented on every `connect()` entry. Each chain
   * step captures its own version and bails before {@link doConnect} if a
   * later call has superseded it — so 3+ synchronous re-entries don't leak
   * the middle transport (it's never attached). See tesseron#88.
   */
  private connectVersion = 0;

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
   *
   * **Re-entry safety.** Two concurrent `connect()` calls (StrictMode mount
   * → cleanup → remount, HMR re-running module-scope `connect()`, an
   * auth-gate flipping `enabled` rapidly) used to race on `this.transport`:
   * the second call closed the first call's socket mid-handshake, frames in
   * flight on either socket — including the gateway's `tesseron/resume`
   * response — were lost, and a claimed session ended up displaying a
   * fresh claim code instead of resuming. See tesseron#88. The new attempt
   * now awaits the prior attempt's settlement and the prior transport's
   * `onClose` drain before starting its own handshake, so the gateway's
   * resume bookkeeping never sees overlapping requests.
   *
   * @throws {Error} If called before {@link TesseronClient.app}.
   */
  async connect(transport: Transport, options?: ConnectOptions): Promise<WelcomeResult> {
    if (!this.appConfig) {
      throw new Error('Tesseron: call app({ id, name }) before connect().');
    }
    this.connectVersion += 1;
    const myVersion = this.connectVersion;

    // Sync supersede pass: close whichever transport is currently attached.
    // The immediately-prior `connect()` may be hanging on a hello/resume
    // the gateway will never reply to (dead socket, gateway shutdown,
    // never-responding test fake) — closing the socket lets that connect's
    // pending RPC reject via `TransportClosedError` and unblocks our
    // `await prior` below. The chain step below ALSO closes after `await
    // prior` resolves, to catch the case where the prior connect attached
    // its transport during the microtask gap between our entry here and
    // the chain step running.
    const initialPrior = this.transport;
    if (initialPrior && initialPrior !== transport) {
      try {
        initialPrior.close();
      } catch {
        // Transport may already be closing/closed; the onClose drain
        // still fires on its own.
      }
    }

    // Queue this connect after the prior one's settlement. Awaiting the
    // prior promise (success OR failure) plus its transport's onClose
    // drain guarantees we never start a new hello/resume while the
    // previous one is still mid-flight. Critically, the gateway's resume
    // handler is single-shot — it consumes the zombie session on the
    // first valid request and rotates the token — so two overlapping
    // `tesseron/resume` calls with the same stored credentials would
    // invariably leave the second one with `ResumeFailed`.
    const prior = this.connectChain;
    const next = (async (): Promise<WelcomeResult> => {
      // Yield to allow other synchronous `connect()` calls to increment
      // `connectVersion` before we observe it. Without this yield, the
      // first connect's IIFE runs straight through its version check
      // (still version=1) and reaches `doConnect` before any subsequent
      // call has had a chance to bump the counter — leaking transport
      // attachments the supersede flow was supposed to prevent.
      await Promise.resolve();
      if (prior) {
        try {
          await prior;
        } catch {
          // Prior connect failed (transport closed by us above, network
          // error, gateway rejection); we still want to proceed with this
          // attempt. The failure is the prior caller's problem.
        }
      }
      // If three-or-more connects landed synchronously, we're a middle
      // member of the chain whose transport (`transport` arg) is no
      // longer the one the caller wants live. Bail now — before
      // `doConnect` attaches the transport — so it never opens a session
      // the latest call would only have to tear down. The latest call's
      // own chain step proceeds normally because its `myVersion` matches.
      if (this.connectVersion !== myVersion) {
        throw new TransportClosedError('superseded by a later connect()');
      }
      // Close anything attached during the prior connect's `doConnect`.
      // The sync supersede pass above couldn't see this transport because
      // `prior`'s `doConnect` ran in a microtask after our sync entry.
      const queuedPrior = this.transport;
      if (queuedPrior && queuedPrior !== transport) {
        try {
          queuedPrior.close();
        } catch {
          // Same as the sync close above — onClose drains regardless.
        }
      }
      // Wait for the prior transport's onClose handler to finish draining
      // dispatcher state before the new dispatcher is wired up — without
      // it, a late-firing onClose from the dying socket could trample
      // the new handshake's state. `transportClosed` is constructed with
      // a resolve-only Promise (no reject path), so no try/catch.
      const priorClosed = this.transportClosed;
      if (priorClosed) {
        await priorClosed;
      }
      // Re-check supersession after the drain — a connect that landed
      // while we were awaiting the drain still wins.
      if (this.connectVersion !== myVersion) {
        throw new TransportClosedError('superseded by a later connect()');
      }
      return this.doConnect(transport, options);
    })();
    this.connectChain = next;
    // Drop the chain reference once this attempt settles so a subsequent
    // connect doesn't await a stale, already-resolved promise indefinitely.
    next
      .catch(() => {})
      .finally(() => {
        if (this.connectChain === next) this.connectChain = undefined;
      });
    return next;
  }

  private async doConnect(transport: Transport, options?: ConnectOptions): Promise<WelcomeResult> {
    // The connect() wrapper validates this; the redundant check here keeps
    // TypeScript's narrowing alive for the `app: this.appConfig` reference
    // in the handshake params below.
    if (!this.appConfig) {
      throw new Error('Tesseron: call app({ id, name }) before connect().');
    }
    const appConfig = this.appConfig;
    this.transport = transport;
    let resolveClosed: () => void = () => {};
    this.transportClosed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const dispatcher = new JsonRpcDispatcher((message) => {
      try {
        transport.send(message);
      } catch (err) {
        // The transport rejected the write (closing socket, JSON
        // serialisation failure on a circular result, etc.). If we let the
        // throw propagate up through `handleRequest`'s `void`-discarded
        // promise, the request's response is silently dropped and the peer's
        // pending dispatcher entry waits forever. Close the transport so the
        // peer sees a close, fires `rejectAllPending`, and surfaces the
        // failure as `TransportClosedError` instead of a hang. Outgoing
        // request paths (`dispatcher.request`) catch synchronous send
        // failures themselves; this rethrow preserves that behaviour.
        try {
          transport.close();
        } catch {
          // Already in a bad state; nothing more to do.
        }
        throw err;
      }
    });
    this.dispatcher = dispatcher;

    transport.onMessage((message) => dispatcher.receive(message));
    transport.onClose((reason) => {
      dispatcher.rejectAllPending(new TransportClosedError(reason));
      // Only clear instance state if it still belongs to *this* transport.
      // A stale onClose from a previously-attached transport firing after
      // a reconnect would otherwise trample the new dispatcher and welcome.
      if (this.dispatcher !== dispatcher) {
        // The next connect() — which has already replaced `this.dispatcher`
        // — is no longer waiting on us; signal completion regardless so any
        // straggler awaiter (a third concurrent connect() that latched onto
        // an even older transport's `transportClosed`) doesn't hang.
        resolveClosed();
        return;
      }
      this.dispatcher = undefined;
      this.welcome = undefined;
      for (const ctrl of this.invocations.values()) ctrl.abort();
      this.invocations.clear();
      for (const sub of this.subscriptions.values()) sub.unsubscribe();
      this.subscriptions.clear();
      // Drain complete: any subsequent `connect()` that closed this
      // transport can now safely wire its own dispatcher state without
      // racing this teardown.
      resolveClosed();
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

    // The gateway fires `tesseron/claimed` when an MCP agent calls
    // `tesseron__claim_session` with our pending claim code. After this
    // arrives the code is consumed - merge the agent identity into the
    // welcome and clear `claimCode` so consumers (e.g. `useTesseronConnection`'s
    // `claimCode` field) stop displaying a code that can no longer be redeemed.
    dispatcher.onNotification('tesseron/claimed', (params) => {
      const claimed = params as ClaimedParams;
      if (!this.welcome) return;
      this.welcome = {
        ...this.welcome,
        agent: claimed.agent,
        claimCode: undefined,
        // Merge in authoritative agent capabilities when the gateway
        // sent them (v1.2+). On the v3 host-mint path the welcome the
        // SDK first received was synthesized by the host with
        // conservative defaults; the gateway's real bits arrive here.
        // v1.1 gateways omit the field — keep the previous value.
        ...(claimed.agentCapabilities !== undefined
          ? { capabilities: claimed.agentCapabilities }
          : {}),
      };
      for (const listener of this.welcomeListeners) {
        try {
          listener(this.welcome);
        } catch (err) {
          // Listener errors must not abort the others or leave us in a
          // half-notified state, but a thrown listener is almost always an
          // app bug worth surfacing. Warn-and-continue.
          console.warn('[tesseron] welcome listener threw', err);
        }
      }
    });

    const baseParams = {
      protocolVersion: PROTOCOL_VERSION,
      app: appConfig,
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
   *
   * Also invalidates any pending {@link connect} chain step. Without that,
   * a `disconnect()` called while a handshake is still mid-flight (chain
   * step awaiting `prior`/`priorClosed`, `doConnect` not yet reached, so
   * `this.transport` is still undefined) would silently do nothing — the
   * in-flight `connect()` would proceed to attach a transport and complete
   * the handshake despite the caller's intent to tear down. Bumping
   * `connectVersion` causes the pending step to bail at its supersede
   * check before it ever calls `doConnect`.
   */
  async disconnect(): Promise<void> {
    this.connectVersion += 1;
    this.connectChain = undefined;
    this.transport?.close();
  }

  getWelcome(): WelcomeResult | undefined {
    return this.welcome;
  }

  /**
   * Subscribe to changes in {@link WelcomeResult}. The listener fires on
   * server-driven welcome updates after the initial connect resolves -
   * currently only the `tesseron/claimed` notification, which clears
   * `claimCode` and updates `agent`. Returns an unsubscribe function.
   *
   * Use this to drive UI state that depends on the welcome (e.g. a claim-code
   * banner that should disappear once the session has been claimed). The
   * listener is NOT called for the initial value returned from `connect()` -
   * read that from the resolved welcome directly.
   */
  onWelcomeChange(listener: (welcome: WelcomeResult) => void): () => void {
    this.welcomeListeners.add(listener);
    return () => {
      this.welcomeListeners.delete(listener);
    };
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
      withTimeout: <T>(value: Promise<T> | T, ms: number): Promise<T> =>
        withTimeoutAgainstSignal(value, ms, controller.signal),
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

    // Race the handler against the abort signal so a handler stuck inside a
    // non-AbortSignal-aware Promise (e.g. `modern-screenshot.domToPng`,
    // `<img>.decode`, `document.fonts.ready`, `Audio.play`) doesn't pin the
    // wire indefinitely. When the timeout or an `actions/cancel` aborts the
    // controller, the reaper rejects, we send the error response, and the
    // orphaned handler keeps running on its own — that's the app's problem to
    // clean up, but the agent isn't held hostage.
    const handlerPromise = Promise.resolve().then(() => action.handler(input, ctx));
    // Belt-and-suspenders: even though Promise.race attaches a rejection
    // listener to handlerPromise, attach our own so a late rejection from the
    // orphaned handler can never surface as an unhandledrejection.
    handlerPromise.catch(() => {});
    try {
      const output = await Promise.race([handlerPromise, abortReaper(controller.signal)]);
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

/**
 * Promise that rejects when `signal` aborts. Mirrors the abort-reason mapping
 * used by `handleInvoke`'s catch block: a `TimeoutError` reason propagates as
 * itself, anything else collapses to `CancelledError`.
 */
function abortReaper(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason instanceof TimeoutError ? signal.reason : new CancelledError());
      return;
    }
    signal.addEventListener(
      'abort',
      () => {
        reject(signal.reason instanceof TimeoutError ? signal.reason : new CancelledError());
      },
      { once: true },
    );
  });
}

/**
 * Implementation of `ctx.withTimeout`. Resolves on inner success, rejects with
 * `TimeoutError(ms)` if the local deadline elapses, or with the abort reason
 * if `signal` aborts first.
 */
function withTimeoutAgainstSignal<T>(
  value: Promise<T> | T,
  ms: number,
  signal: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(ms) || ms < 0) {
    return Promise.reject(new Error('ctx.withTimeout: ms must be a non-negative finite number'));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      action();
    };
    const onAbort = (): void => {
      settle(() => {
        const reason = signal.reason;
        reject(reason instanceof TimeoutError ? reason : new CancelledError());
      });
    };
    const timer = setTimeout(() => {
      settle(() => reject(new TimeoutError(ms)));
    }, ms);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(value).then(
      (resolved) => settle(() => resolve(resolved)),
      (err) => settle(() => reject(err)),
    );
  });
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
