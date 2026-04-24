import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type ActionAnnotations,
  type ActionContext,
  type WebTesseronClient,
  type WelcomeResult,
  tesseron,
} from '@tesseron/web';
import { onDestroy, onMount } from 'svelte';
import { type Readable, writable } from 'svelte/store';

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
 * action is removed on component destroy. Call during component initialisation
 * (top-level `<script>` block).
 *
 * Handlers that close over Svelte `$state` variables always read the current
 * value at invocation time — no extra indirection required.
 *
 * @example
 * ```svelte
 * <script>
 *   import { tesseronAction } from '@tesseron/svelte';
 *   import { z } from 'zod';
 *
 *   let todos = $state([]);
 *
 *   tesseronAction('addTodo', {
 *     input: z.object({ text: z.string() }),
 *     handler: ({ text }) => { todos = [...todos, text]; },
 *   });
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

  onDestroy(() => client.removeAction(name));
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
 * `{ read }`. The resource is removed on component destroy.
 *
 * @example
 * ```svelte
 * <script>
 *   import { tesseronResource } from '@tesseron/svelte';
 *
 *   let todos = $state([]);
 *
 *   // Shorthand: read-only resource
 *   tesseronResource('todoCount', () => todos.length);
 *
 *   // With subscribe: pushed to the agent on every change
 *   const countSubs = new Set();
 *   $effect(() => { const n = todos.length; countSubs.forEach(fn => fn(n)); });
 *   tesseronResource('todoCount', {
 *     read: () => todos.length,
 *     subscribe: (emit) => { countSubs.add(emit); return () => countSubs.delete(emit); },
 *   });
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

  onDestroy(() => client.removeResource(name));
}

// ─── Connection ──────────────────────────────────────────────────────────────

/** Options for {@link tesseronConnection}. */
export interface TesseronConnectionOptions {
  /** Gateway URL; defaults to `DEFAULT_GATEWAY_URL` (the local bridge). */
  url?: string;
  /** Set to `false` to skip connecting (useful for gating behind auth). Defaults to `true`. */
  enabled?: boolean;
}

/** Reactive connection state held in the store returned by {@link tesseronConnection}. */
export interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  /** Claim code to display so the user can paste it into their MCP client. */
  claimCode?: string;
  error?: Error;
}

/**
 * Connects the shared {@link WebTesseronClient} singleton on mount and returns
 * a Svelte `Readable` store holding the current connection state. Subscribe
 * with the `$` prefix in templates.
 *
 * Register your actions and resources with {@link tesseronAction} /
 * {@link tesseronResource} before calling this so they appear in the initial
 * `tesseron/hello` manifest.
 *
 * @example
 * ```svelte
 * <script>
 *   import { tesseronConnection } from '@tesseron/svelte';
 *
 *   tesseron.app({ id: 'my_app', name: 'My App' });
 *   // ...register actions and resources first...
 *   const connection = tesseronConnection();
 * </script>
 *
 * {#if $connection.status === 'open'}
 *   <p>Claim code: <code>{$connection.claimCode}</code></p>
 * {/if}
 * ```
 */
export function tesseronConnection(
  options: TesseronConnectionOptions = {},
  client: WebTesseronClient = tesseron,
): Readable<TesseronConnectionState> {
  const { subscribe, set } = writable<TesseronConnectionState>({ status: 'idle' });

  onMount(() => {
    if (options.enabled === false) return;
    let cancelled = false;
    set({ status: 'connecting' });

    client
      .connect(options.url)
      .then((welcome) => {
        if (!cancelled) {
          set({ status: 'open', welcome, claimCode: welcome.claimCode });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          set({ status: 'error', error });
        }
      });

    return () => {
      cancelled = true;
    };
  });

  return { subscribe };
}
