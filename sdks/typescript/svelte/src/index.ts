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
import { onDestroy, onMount } from 'svelte';
import { type Readable, writable } from 'svelte/store';

export * from '@tesseron/web';

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
  onDestroy(registerAction<I, O>(client, name, () => options));
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
 *   tesseronResource('todoCount', () => todos.length);
 * </script>
 * ```
 */
export function tesseronResource<T = unknown>(
  name: string,
  optionsOrReader: TesseronResourceOptions<T> | (() => T | Promise<T>),
  client: WebTesseronClient = tesseron,
): void {
  const options = normalizeResourceOptions(optionsOrReader);
  onDestroy(registerResource<T>(client, name, () => options));
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
 * Resume is on by default: a page refresh inside the host's idle TTL window
 * keeps the same Tesseron session paired with the agent — no re-claim
 * needed. Pass `resume: false` to opt out.
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
 * {#if $connection.claimCode}
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
    const controller = createConnectionController(options, client);
    const unsubscribe = controller.subscribe(() => set(controller.getState()));
    controller.start();
    return () => {
      controller.stop();
      unsubscribe();
    };
  });

  return { subscribe };
}
