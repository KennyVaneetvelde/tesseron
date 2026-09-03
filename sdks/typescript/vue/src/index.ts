import {
  type ConnectionController,
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
import { type Ref, onMounted, onUnmounted, ref } from 'vue';

export * from '@tesseron/web';

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
  onUnmounted(registerAction<I, O>(client, name, () => options));
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
 * tesseronResource('todoCount', () => todos.value.length);
 * </script>
 * ```
 */
export function tesseronResource<T = unknown>(
  name: string,
  optionsOrReader: TesseronResourceOptions<T> | (() => T | Promise<T>),
  client: WebTesseronClient = tesseron,
): void {
  const options = normalizeResourceOptions(optionsOrReader);
  onUnmounted(registerResource<T>(client, name, () => options));
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
 * Resume is on by default: a page refresh inside the host's idle TTL window
 * keeps the same Tesseron session paired with the agent — no re-claim needed.
 * Pass `resume: false` to opt out (incognito-style flows).
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
 *   <p v-if="connection.claimCode">
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
  let controller: ConnectionController | undefined;
  let unsubscribe: (() => void) | undefined;

  onMounted(() => {
    const c = createConnectionController(options, client);
    controller = c;
    unsubscribe = c.subscribe(() => {
      state.value = c.getState();
    });
    c.start();
  });

  onUnmounted(() => {
    controller?.stop();
    unsubscribe?.();
  });

  return state;
}
