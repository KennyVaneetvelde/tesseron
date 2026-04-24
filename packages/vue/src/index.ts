import type { StandardSchemaV1 } from '@standard-schema/spec';
import { onMounted, onUnmounted, ref, type Ref } from 'vue';
import {
  type ActionAnnotations,
  type ActionContext,
  type WebTesseronClient,
  type WelcomeResult,
  tesseron,
} from '@tesseron/web';

export * from '@tesseron/web';

// ─── Action ─────────────────────────────────────────────────────────────────

/** Options for {@link tesseronAction}; mirrors the chained {@link ActionBuilder} methods as a single object. */
export interface TesseronActionOptions<I, O> {
  description?: string;
  input?: StandardSchemaV1<I>;
  inputJsonSchema?: unknown;
  output?: StandardSchemaV1<O>;
  outputJsonSchema?: unknown;
  annotations?: ActionAnnotations;
  timeoutMs?: number;
  strictOutput?: boolean;
  handler: (input: I, ctx: ActionContext) => Promise<O> | O;
}

/**
 * Registers a Tesseron action for the lifetime of the calling component. The
 * action is removed on unmount. Call inside `<script setup>` or `setup()`.
 *
 * Handlers that close over Vue `ref`/`reactive` values always read the current
 * `.value` at invocation time — no extra indirection required.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { tesseronAction } from '@tesseron/vue';
 * import { ref } from 'vue';
 * import { z } from 'zod';
 *
 * const todos = ref([]);
 *
 * tesseronAction('addTodo', {
 *   input: z.object({ text: z.string() }),
 *   handler: ({ text }) => { todos.value = [...todos.value, text]; },
 * });
 * </script>
 * ```
 */
export function tesseronAction<I = unknown, O = unknown>(
  name: string,
  options: TesseronActionOptions<I, O>,
  client: WebTesseronClient = tesseron,
): void {
  // Box holds the latest options so the registered handler always delegates
  // to whatever was most recently passed, matching React's useRef pattern.
  const box = { options };

  let builder = client.action<I, O>(name);
  const o = options;
  if (o.description) builder = builder.describe(o.description);
  if (o.input) builder = builder.input(o.input, o.inputJsonSchema);
  if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
  if (o.annotations) builder = builder.annotate(o.annotations);
  if (o.timeoutMs) builder = builder.timeout({ ms: o.timeoutMs });
  if (o.strictOutput) builder = builder.strictOutput();
  builder.handler((input, ctx) => box.options.handler(input, ctx));

  onUnmounted(() => client.removeAction(name));
}

// ─── Resource ────────────────────────────────────────────────────────────────

/** Options for {@link tesseronResource}. Pass `read`, `subscribe`, or both. */
export interface TesseronResourceOptions<T> {
  description?: string;
  output?: StandardSchemaV1<T>;
  outputJsonSchema?: unknown;
  read?: () => T | Promise<T>;
  subscribe?: (emit: (value: T) => void) => () => void;
}

/**
 * Registers a Tesseron resource for the lifetime of the calling component.
 * The shorthand form (passing a reader function directly) is equivalent to
 * `{ read }`. The resource is removed on unmount.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { tesseronResource } from '@tesseron/vue';
 * import { ref } from 'vue';
 *
 * const todos = ref([]);
 *
 * // Shorthand: read-only resource
 * tesseronResource('todoCount', () => todos.value.length);
 *
 * // With subscribe: pushed to the agent on every change
 * const countSubs = new Set();
 * watch(() => todos.value.length, (n) => countSubs.forEach(fn => fn(n)));
 * tesseronResource('todoCount', {
 *   read: () => todos.value.length,
 *   subscribe: (emit) => { countSubs.add(emit); return () => countSubs.delete(emit); },
 * });
 * </script>
 * ```
 */
export function tesseronResource<T = unknown>(
  name: string,
  optionsOrReader: TesseronResourceOptions<T> | (() => T | Promise<T>),
  client: WebTesseronClient = tesseron,
): void {
  const options: TesseronResourceOptions<T> =
    typeof optionsOrReader === 'function' ? { read: optionsOrReader } : optionsOrReader;
  const box = { options };

  let builder = client.resource<T>(name);
  const o = options;
  if (o.description) builder = builder.describe(o.description);
  if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
  if (o.read) {
    const initial = o.read;
    builder = builder.read(() => (box.options.read ?? initial)());
  }
  if (o.subscribe) {
    const initial = o.subscribe;
    builder = builder.subscribe((emit) => (box.options.subscribe ?? initial)(emit));
  }

  onUnmounted(() => client.removeResource(name));
}

// ─── Connection ──────────────────────────────────────────────────────────────

/** Options for {@link tesseronConnection}. */
export interface TesseronConnectionOptions {
  /** Gateway URL; defaults to `DEFAULT_GATEWAY_URL` (the local bridge). */
  url?: string;
  /** Set to `false` to skip connecting (useful for gating behind auth). Defaults to `true`. */
  enabled?: boolean;
}

/** Reactive connection state held in the ref returned by {@link tesseronConnection}. */
export interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  /** Claim code to display so the user can paste it into their MCP client. */
  claimCode?: string;
  error?: Error;
}

/**
 * Connects the shared {@link WebTesseronClient} singleton on mount and returns
 * a `Ref` holding the current connection state. In templates the ref is
 * auto-unwrapped — access `connection.status` directly. In `<script setup>`
 * use `connection.value.status`.
 *
 * Register your actions and resources with {@link tesseronAction} /
 * {@link tesseronResource} before calling this so they appear in the initial
 * `tesseron/hello` manifest.
 *
 * @example
 * ```vue
 * <script setup lang="ts">
 * import { tesseronConnection } from '@tesseron/vue';
 *
 * tesseron.app({ id: 'my_app', name: 'My App' });
 * // ...register actions and resources first...
 * const connection = tesseronConnection();
 * </script>
 *
 * <template>
 *   <p v-if="connection.status === 'open'">
 *     Claim code: <code>{{ connection.claimCode }}</code>
 *   </p>
 * </template>
 * ```
 */
export function tesseronConnection(
  options: TesseronConnectionOptions = {},
  client: WebTesseronClient = tesseron,
): Ref<TesseronConnectionState> {
  const state = ref<TesseronConnectionState>({ status: 'idle' });
  let cancelled = false;

  onMounted(() => {
    if (options.enabled === false) return;
    cancelled = false;
    state.value = { status: 'connecting' };

    client
      .connect(options.url)
      .then((welcome) => {
        if (!cancelled) {
          state.value = { status: 'open', welcome, claimCode: welcome.claimCode };
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          state.value = { status: 'error', error };
        }
      });
  });

  onUnmounted(() => {
    cancelled = true;
  });

  return state;
}
