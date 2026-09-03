import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ActionContext } from './context.js';
import type { ActionAnnotations } from './protocol.js';

/**
 * Function that executes an action. Receives the validated input and an
 * {@link ActionContext} for progress, sampling, elicitation, logging, and cancellation.
 */
export type ActionHandler<I, O> = (input: I, ctx: ActionContext) => Promise<O> | O;

/** Per-action invocation timeout. */
export interface TimeoutOptions {
  /** Maximum wall-clock time in milliseconds before the invocation is aborted with {@link TimeoutError}. */
  ms: number;
}

/**
 * Fluent builder returned by {@link TesseronClient.action}. All methods except
 * {@link ActionBuilder.handler} return `this` for chaining; `handler` commits
 * the action and returns its {@link ActionDefinition}.
 *
 * @example
 * ```ts
 * tesseron.action('addTodo')
 *   .describe('Add a todo item')
 *   .input(z.object({ text: z.string() }))
 *   .output(z.object({ id: z.string() }))
 *   .handler(async ({ text }) => ({ id: todos.add(text) }));
 * ```
 */
export interface ActionBuilder<I = unknown, O = unknown> {
  /** Sets the human-readable description sent to the agent in the tool manifest. */
  describe(description: string): ActionBuilder<I, O>;
  /**
   * Sets the input validator. The runtime `schema` gates handler execution; the
   * optional `jsonSchema` is the manifest copy the MCP client uses to render
   * arguments. Prefer deriving the JSON Schema from your validator (e.g.
   * `z.toJSONSchema(schema)`).
   *
   * @example
   * ```ts
   * .input(z.object({ text: z.string() }), z.toJSONSchema(Input))
   * ```
   */
  input<NewI>(schema: StandardSchemaV1<NewI>, jsonSchema?: unknown): ActionBuilder<NewI, O>;
  /**
   * Sets the output validator. Validation is informational unless
   * {@link ActionBuilder.strictOutput} is also set. The optional `jsonSchema`
   * is surfaced in the manifest so agents can reason about results.
   *
   * @example
   * ```ts
   * .output(z.object({ id: z.string() }))
   * ```
   */
  output<NewO>(schema: StandardSchemaV1<NewO>, jsonSchema?: unknown): ActionBuilder<I, NewO>;
  /** Attaches MCP tool annotations (`readOnly`, `destructive`, `requiresConfirmation`). */
  annotate(annotations: ActionAnnotations): ActionBuilder<I, O>;
  /** Overrides the default invocation timeout. */
  timeout(options: TimeoutOptions): ActionBuilder<I, O>;
  /** Makes the output schema a hard gate — handler results that fail validation throw. */
  strictOutput(): ActionBuilder<I, O>;
  /**
   * Commits the action and registers it with the owning client. Returns the
   * resolved {@link ActionDefinition} in case callers want to introspect it.
   */
  handler(fn: ActionHandler<I, O>): ActionDefinition<I, O>;
}

/** Immutable result of {@link ActionBuilder.handler}. */
export interface ActionDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema?: StandardSchemaV1<I>;
  outputSchema?: StandardSchemaV1<O>;
  annotations: ActionAnnotations;
  timeoutMs: number;
  strictOutput: boolean;
  handler: ActionHandler<I, O>;
}

/** Function that produces the current value of a resource. Can be sync or async. */
export type ResourceReader<T> = () => T | Promise<T>;
/**
 * Subscription factory. Call `emit(value)` on every change; return a cleanup
 * function the SDK calls when the last subscriber unsubscribes or the session ends.
 */
export type ResourceSubscriber<T> = (emit: (value: T) => void) => () => void;

/**
 * Fluent builder returned by {@link TesseronClient.resource}. Unlike
 * {@link ActionBuilder}, each call to {@link ResourceBuilder.read} or
 * {@link ResourceBuilder.subscribe} commits the resource to the client — you
 * can chain both on the same builder to expose read + subscribe in one
 * definition, but each call re-registers the resource.
 */
export interface ResourceBuilder<T = unknown> {
  /** Sets the human-readable description sent to the agent in the resource manifest. */
  describe(description: string): ResourceBuilder<T>;
  /** Sets the output validator and optional JSON Schema for manifest consumers. */
  output<NewT>(schema: StandardSchemaV1<NewT>, jsonSchema?: unknown): ResourceBuilder<NewT>;
  /** Registers a one-shot reader and commits the resource. */
  read(reader: ResourceReader<T>): ResourceBuilder<T>;
  /**
   * Registers a change-notification source and commits the resource as
   * subscribable. The factory receives an `emit` callback and must return a
   * cleanup function.
   */
  subscribe(subscriber: ResourceSubscriber<T>): ResourceBuilder<T>;
}

/** Immutable result of {@link ResourceBuilder.read} or {@link ResourceBuilder.subscribe}. */
export interface ResourceDefinition<T = unknown> {
  name: string;
  description: string;
  outputSchema?: StandardSchemaV1<T>;
  reader?: ResourceReader<T>;
  subscriber?: ResourceSubscriber<T>;
}
