import {
  type TesseronActionOptions,
  type TesseronConnectionOptions,
  type TesseronConnectionState,
  type TesseronResourceOptions,
  type WebTesseronClient,
  createConnectionController,
  normalizeResourceOptions,
  registerAction,
  registerResource,
  tesseron,
} from '@tesseron/web';
import { useEffect, useRef, useState } from 'react';

export * from '@tesseron/web';

/**
 * React naming alias for {@link TesseronActionOptions}. The option shape is
 * shared verbatim with `@tesseron/svelte` and `@tesseron/vue` (defined once in
 * `@tesseron/web`); this `Use…`-prefixed name is kept for hook-idiomatic call
 * sites and backward compatibility.
 */
export type UseTesseronActionOptions<I, O> = TesseronActionOptions<I, O>;
/** React naming alias for {@link TesseronResourceOptions}. */
export type UseTesseronResourceOptions<T> = TesseronResourceOptions<T>;
/** React naming alias for {@link TesseronConnectionOptions}. */
export type UseTesseronConnectionOptions = TesseronConnectionOptions;

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
  // Re-register only when the identity (name/client) changes; the handler is
  // read through the ref so new closures each render are picked up for free.
  useEffect(() => registerAction<I, O>(client, name, () => optionsRef.current), [name, client]);
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
  const optionsRef = useRef<TesseronResourceOptions<T>>(normalizeResourceOptions(optionsOrReader));
  optionsRef.current = normalizeResourceOptions(optionsOrReader);
  useEffect(() => registerResource<T>(client, name, () => optionsRef.current), [name, client]);
}

/**
 * Connects the shared {@link WebTesseronClient} singleton on mount and exposes
 * the connection status (and claim code) for rendering. Register your actions
 * and resources with {@link useTesseronAction} / {@link useTesseronResource}
 * before this hook runs so they appear in the initial `tesseron/hello` manifest.
 *
 * The connect effect re-runs when `enabled`, `url`, or `client` change, so
 * toggling an auth gate or switching gateways at runtime reconnects. Pass
 * `options.resume` to survive page refresh / HMR reloads without losing the
 * claimed session — see {@link UseTesseronConnectionOptions.resume}.
 */
export function useTesseronConnection(
  options: UseTesseronConnectionOptions = {},
  client: WebTesseronClient = tesseron,
): TesseronConnectionState {
  const [state, setState] = useState<TesseronConnectionState>({ status: 'idle' });
  const enabled = options.enabled ?? true;
  const url = options.url;
  // `resume` is intentionally read through a ref rather than an effect dep:
  // changing it should not force a reconnect, but it must be picked up on the
  // next reconnect triggered by enabled/url/client.
  const resumeRef = useRef(options.resume);
  resumeRef.current = options.resume;

  useEffect(() => {
    if (!enabled) return;
    const controller = createConnectionController(
      { url, enabled, resume: resumeRef.current },
      client,
    );
    const unsubscribe = controller.subscribe(() => setState(controller.getState()));
    controller.start();
    return () => {
      controller.stop();
      unsubscribe();
    };
  }, [enabled, url, client]);

  return state;
}
