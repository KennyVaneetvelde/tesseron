import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type ActionAnnotations,
  type ActionContext,
  type WebTesseronClient,
  type WelcomeResult,
  tesseron,
} from '@tesseron/web';
import { useEffect, useRef, useState } from 'react';

export * from '@tesseron/web';

/** Options for {@link useTesseronAction}; mirrors the chained {@link ActionBuilder} methods as a single object. */
export interface UseTesseronActionOptions<I, O> {
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
 * action is removed on unmount. `options.handler` is held in a ref so the
 * registration does not re-run when you close over new state — just pass the
 * latest handler each render.
 *
 * @example
 * ```tsx
 * useTesseronAction('addTodo', {
 *   input: z.object({ text: z.string() }),
 *   handler: ({ text }) => setTodos((t) => [...t, text]),
 * });
 * ```
 */
export function useTesseronAction<I = unknown, O = unknown>(
  name: string,
  options: UseTesseronActionOptions<I, O>,
  client: WebTesseronClient = tesseron,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let builder = client.action<I, O>(name);
    const o = optionsRef.current;
    if (o.description) builder = builder.describe(o.description);
    if (o.input) builder = builder.input(o.input, o.inputJsonSchema);
    if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
    if (o.annotations) builder = builder.annotate(o.annotations);
    if (o.timeoutMs) builder = builder.timeout({ ms: o.timeoutMs });
    if (o.strictOutput) builder = builder.strictOutput();
    builder.handler((input, ctx) => optionsRef.current.handler(input, ctx));
    return () => {
      client.removeAction(name);
    };
  }, [name, client]);
}

/** Options for {@link useTesseronResource}. Pass either `read`, `subscribe`, or both. */
export interface UseTesseronResourceOptions<T> {
  description?: string;
  output?: StandardSchemaV1<T>;
  outputJsonSchema?: unknown;
  read?: () => T | Promise<T>;
  subscribe?: (emit: (value: T) => void) => () => void;
}

/**
 * Registers a Tesseron resource for the lifetime of the calling component.
 * The shorthand form (passing a reader function) is equivalent to `{ read }`.
 * Current-value closures are held in a ref so stale reads are avoided without
 * re-registering the resource each render.
 *
 * @example
 * ```tsx
 * useTesseronResource('todoCount', () => todos.length);
 * ```
 */
export function useTesseronResource<T = unknown>(
  name: string,
  optionsOrReader: UseTesseronResourceOptions<T> | (() => T | Promise<T>),
  client: WebTesseronClient = tesseron,
): void {
  const options: UseTesseronResourceOptions<T> =
    typeof optionsOrReader === 'function' ? { read: optionsOrReader } : optionsOrReader;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    let builder = client.resource<T>(name);
    const o = optionsRef.current;
    if (o.description) builder = builder.describe(o.description);
    if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
    if (o.read) {
      const read = o.read;
      builder = builder.read(() => (optionsRef.current.read ?? read)());
    }
    if (o.subscribe) {
      const subscribe = o.subscribe;
      builder = builder.subscribe((emit) => (optionsRef.current.subscribe ?? subscribe)(emit));
    }
    return () => {
      client.removeResource(name);
    };
  }, [name, client]);
}

/** Options for {@link useTesseronConnection}. */
export interface UseTesseronConnectionOptions {
  /** Gateway URL; defaults to `DEFAULT_GATEWAY_URL` (the local bridge). */
  url?: string;
  /** Set to `false` to skip connecting (useful for gating behind auth). Defaults to `true`. */
  enabled?: boolean;
}

/** Reactive connection state returned from {@link useTesseronConnection}. */
export interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  /** Claim code to display in the UI so the user can paste it into their MCP client. */
  claimCode?: string;
  error?: Error;
}

/**
 * Connects the shared {@link WebTesseronClient} singleton on mount and exposes
 * the connection status (and claim code) for rendering. Register your actions
 * and resources with {@link useTesseronAction} / {@link useTesseronResource}
 * before this hook runs so they appear in the initial `tesseron/hello` manifest.
 */
export function useTesseronConnection(
  options: UseTesseronConnectionOptions = {},
  client: WebTesseronClient = tesseron,
): TesseronConnectionState {
  const [state, setState] = useState<TesseronConnectionState>({ status: 'idle' });
  const enabled = options.enabled ?? true;
  const url = options.url;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState({ status: 'connecting' });
    client
      .connect(url)
      .then((welcome) => {
        if (cancelled) return;
        setState({ status: 'open', welcome, claimCode: welcome.claimCode });
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState({ status: 'error', error });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, url, client]);

  return state;
}
