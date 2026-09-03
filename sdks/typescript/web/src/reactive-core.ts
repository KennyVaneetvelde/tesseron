/**
 * Framework-neutral reactive core shared by `@tesseron/react`,
 * `@tesseron/svelte`, and `@tesseron/vue`.
 *
 * Before this module existed, each framework adapter carried its own
 * byte-for-byte copy of: the localStorage resume backend, the resume-option
 * resolver, the action/resource builder-chain application, and the entire
 * connect → load → resume → ResumeFailed-fallback → save → `onWelcomeChange`
 * state machine. Parity across the three was kept only by convention and
 * JSDoc cross-references, which is exactly how the Svelte/Vue copies drifted
 * from React's.
 *
 * Everything reusable now lives here once. The per-framework packages are thin
 * bindings that map this core onto their reactivity primitive (React hooks,
 * Svelte stores, Vue refs) and lifecycle (`useEffect` cleanup, `onDestroy`,
 * `onUnmounted`). The public option/state shapes are defined here and
 * re-exported by each adapter, so there is a single source of truth for both
 * behaviour and types.
 */

import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type ActionAnnotations,
  type ActionContext,
  type ResumeCredentials,
  TesseronError,
  TesseronErrorCode,
  type WelcomeResult,
} from '@tesseron/core';
// Type-only import: erased at build time, so there is no runtime import cycle
// even though `./index.ts` imports values from this module. The reactive core
// never reaches for the `tesseron` singleton — every helper takes an explicit
// client, and the adapters supply the default.
import type { WebTesseronClient } from './index.js';

// ─── Resume storage ───────────────────────────────────────────────────────────

/**
 * Persistence backend for resume credentials. Implementations may be sync or
 * async; callers await each call. Returning `null` / `undefined` from `load`
 * means "no stored session, do a fresh hello." Throws from any method are
 * non-fatal: callers treat them like an empty backend (load) or a silent
 * no-op (save/clear) so storage problems can't fail-close the connection.
 */
export interface ResumeStorage {
  load: () => ResumeCredentials | null | undefined | Promise<ResumeCredentials | null | undefined>;
  save: (credentials: ResumeCredentials) => void | Promise<void>;
  clear: () => void | Promise<void>;
}

/** Default `localStorage` key used when a `resume` option is omitted or `true`. */
export const DEFAULT_RESUME_STORAGE_KEY = 'tesseron:resume';

/**
 * `localStorage`-backed {@link ResumeStorage}. SSR-safe (guards `window`) and
 * tolerant of corrupted entries / denied access (private mode, disabled
 * storage) — every failure degrades to "no saved session" rather than throwing.
 */
export function localStorageResumeBackend(key: string): ResumeStorage {
  return {
    load: () => {
      // SSR: no window, nothing to load.
      if (typeof window === 'undefined') return null;
      try {
        const raw = window.localStorage.getItem(key);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          if (typeof obj['sessionId'] === 'string' && typeof obj['resumeToken'] === 'string') {
            return { sessionId: obj['sessionId'], resumeToken: obj['resumeToken'] };
          }
        }
        return null;
      } catch {
        // Corrupted entry or localStorage access denied (private mode, etc.)
        // — treat as no saved session and let the caller do a fresh hello.
        return null;
      }
    },
    save: (creds) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(key, JSON.stringify(creds));
      } catch {
        // Quota exceeded or storage disabled — non-fatal; the session still
        // works for this page load, it just won't survive the next refresh.
      }
    },
    clear: () => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Same as save: best-effort cleanup.
      }
    },
  };
}

/** The `resume` option accepted by the framework connection bindings. */
export type ResumeOption = boolean | string | ResumeStorage;

/**
 * Resolve a {@link ResumeOption} to a concrete {@link ResumeStorage} backend
 * (or `null` for "no persistence").
 *
 * - `undefined` / `true` → `localStorage` under {@link DEFAULT_RESUME_STORAGE_KEY}
 * - `false` → `null` (no persistence; every connect is a fresh hello)
 * - `string` → `localStorage` under that key
 * - {@link ResumeStorage} → used as-is
 */
export function resolveResumeStorage(option: ResumeOption | undefined): ResumeStorage | null {
  if (option === undefined || option === true) {
    return localStorageResumeBackend(DEFAULT_RESUME_STORAGE_KEY);
  }
  if (option === false) return null;
  if (typeof option === 'string') return localStorageResumeBackend(option);
  return option;
}

// ─── Action / resource registration ───────────────────────────────────────────

/** Options for registering an action; mirrors the chained `ActionBuilder` methods as a single object. */
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

/** Options for registering a resource. Pass either `read`, `subscribe`, or both. */
export interface TesseronResourceOptions<T> {
  description?: string;
  output?: StandardSchemaV1<T>;
  outputJsonSchema?: unknown;
  read?: () => T | Promise<T>;
  subscribe?: (emit: (value: T) => void) => () => void;
}

/** Normalize the `resource(name, reader)` shorthand into a full options object. */
export function normalizeResourceOptions<T>(
  optionsOrReader: TesseronResourceOptions<T> | (() => T | Promise<T>),
): TesseronResourceOptions<T> {
  return typeof optionsOrReader === 'function' ? { read: optionsOrReader } : optionsOrReader;
}

/**
 * Apply an action's builder chain on `client` and return a teardown that
 * removes it. The builder configuration (describe/input/output/annotate/
 * timeout/strictOutput) is read once from `getOptions()`; the registered
 * handler delegates through `getOptions()` on every invocation so callers that
 * hold the latest options behind a ref (React) get the freshest closure
 * without re-registering, while callers that capture once (Svelte/Vue) get
 * stable behaviour. Identical to the three previous per-framework copies.
 */
export function registerAction<I, O>(
  client: WebTesseronClient,
  name: string,
  getOptions: () => TesseronActionOptions<I, O>,
): () => void {
  let builder = client.action<I, O>(name);
  const o = getOptions();
  if (o.description) builder = builder.describe(o.description);
  if (o.input) builder = builder.input(o.input, o.inputJsonSchema);
  if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
  if (o.annotations) builder = builder.annotate(o.annotations);
  if (o.timeoutMs) builder = builder.timeout({ ms: o.timeoutMs });
  if (o.strictOutput) builder = builder.strictOutput();
  builder.handler((input, ctx) => getOptions().handler(input, ctx));
  return () => {
    client.removeAction(name);
  };
}

/**
 * Apply a resource's builder chain on `client` and return a teardown that
 * removes it. Like {@link registerAction}, the static configuration is read
 * once while `read` / `subscribe` delegate through `getOptions()` (falling back
 * to the initial closure) so the freshest reader is always used without
 * re-registering.
 */
export function registerResource<T>(
  client: WebTesseronClient,
  name: string,
  getOptions: () => TesseronResourceOptions<T>,
): () => void {
  let builder = client.resource<T>(name);
  const o = getOptions();
  if (o.description) builder = builder.describe(o.description);
  if (o.output) builder = builder.output(o.output, o.outputJsonSchema);
  if (o.read) {
    const initial = o.read;
    builder = builder.read(() => (getOptions().read ?? initial)());
  }
  if (o.subscribe) {
    const initial = o.subscribe;
    builder = builder.subscribe((emit) => (getOptions().subscribe ?? initial)(emit));
  }
  return () => {
    client.removeResource(name);
  };
}

// ─── Connection ────────────────────────────────────────────────────────────────

/** Options for {@link createConnectionController} and the framework connection bindings. */
export interface TesseronConnectionOptions {
  /** Gateway URL; defaults to `DEFAULT_GATEWAY_URL` (the local bridge). */
  url?: string;
  /** Set to `false` to skip connecting (useful for gating behind auth). Defaults to `true`. */
  enabled?: boolean;
  /**
   * Persist `{ sessionId, resumeToken }` so the connection can rejoin an
   * existing claimed session via `tesseron/resume` after the transport drops
   * (page refresh, HMR reload, brief network blip) instead of issuing a new
   * claim code. See [protocol/resume](https://tesseron.dev/protocol/resume/).
   *
   * - `true` / omitted *(default)*: persist in `localStorage` under
   *   `'tesseron:resume'`. The right answer for almost every app.
   * - `false`: no persistence. Every connect is a fresh hello.
   * - `string`: persist in `localStorage` under that exact key. Use a per-app
   *   value when you mount multiple Tesseron clients on one page.
   * - {@link ResumeStorage}: custom `{ load, save, clear }` callbacks (sync or
   *   async). Use when `localStorage` is unavailable (Electron with strict
   *   CSP, an iframe partition, an OS keychain bridge).
   *
   * On `TesseronError(ResumeFailed)` (TTL expired, token rotated by another
   * tab, gateway restarted, session never claimed), the stored credentials are
   * cleared, a fresh `tesseron/hello` is attempted, and `resumeStatus: 'failed'`
   * is surfaced in {@link TesseronConnectionState}. Resume tokens rotate on
   * every successful handshake, and the freshest token is always persisted.
   *
   * Note: resume re-establishes the session, not its `resources/subscribe`
   * bindings. The resource registration bindings re-register subscriptions
   * naturally on remount; hand-wired subscriptions against the lower-level
   * client must be re-subscribed after each connect.
   */
  resume?: ResumeOption;
}

/**
 * Outcome of the resume attempt that produced the current connection.
 * - `'none'` — no resume was attempted (no stored creds or `resume` disabled).
 * - `'resumed'` — `tesseron/resume` succeeded; the session was reattached.
 * - `'failed'` — resume was attempted but the gateway rejected it; fell back to
 *   a fresh `tesseron/hello`. Useful for telemetry and for UIs that want to say
 *   "your previous session expired" rather than silently showing a new claim code.
 */
export type TesseronResumeStatus = 'none' | 'resumed' | 'failed';

/** Reactive connection state surfaced by the framework connection bindings. */
export interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  /**
   * Claim code to display in the UI. Present only on a fresh `tesseron/hello`;
   * absent after a successful resume. Cleared in-place when the gateway sends
   * `tesseron/claimed`, so UIs that show this field disappear once an agent
   * attaches.
   */
  claimCode?: string;
  error?: Error;
  /** Set when `status === 'open'`. See {@link TesseronResumeStatus}. */
  resumeStatus?: TesseronResumeStatus;
}

/**
 * Imperative, framework-neutral connection state machine. Each framework
 * binding constructs one of these, mirrors {@link getState} into its reactive
 * primitive via {@link subscribe}, and drives lifecycle with {@link start} /
 * {@link stop}.
 */
export interface ConnectionController {
  /** Current state snapshot. */
  getState: () => TesseronConnectionState;
  /** Subscribe to state changes; returns an unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /**
   * Begin connecting (idempotent; a no-op if already started or if
   * `options.enabled === false`). Transitions to `connecting`, performs the
   * resume/hello handshake, and subscribes to server-driven welcome updates.
   */
  start: () => void;
  /** Cancel any in-flight connect and unsubscribe from welcome updates. */
  stop: () => void;
}

/**
 * Sentinel used to distinguish "the controller was stopped mid-connect" from a
 * genuine connection error. The `run().catch` checks for this type (alongside
 * the `cancelled` flag) and skips the error state — without it a future
 * refactor that drops the redundant `cancelled` re-check could surface a
 * spurious error string in the UI. Internal — not exported.
 */
class CancelledError extends Error {
  constructor() {
    super('tesseron connection: controller stopped before connect resolved');
    this.name = 'CancelledError';
  }
}

/**
 * Create a {@link ConnectionController} bound to `client`. This is the single
 * implementation of Tesseron's browser connection lifecycle — resume credential
 * load/save/clear, the `tesseron/resume` → fresh-`hello` fallback on
 * `ResumeFailed`, resume-token rotation, claim-code surfacing, and the
 * `onWelcomeChange` patch that clears the claim code on `tesseron/claimed`.
 *
 * `resume: false` is passed explicitly to `client.connect` when there are no
 * saved credentials (or after a failed resume) so the web SDK's own
 * auto-persist layer stays out of the controller's storage: the controller owns
 * load/save/clear here and surfaces `resumeStatus` reactively, which the web
 * SDK's storage layer cannot.
 */
export function createConnectionController(
  options: TesseronConnectionOptions,
  client: WebTesseronClient,
): ConnectionController {
  let state: TesseronConnectionState = { status: 'idle' };
  const listeners = new Set<() => void>();
  let started = false;
  let cancelled = false;
  let unsubscribeWelcome: (() => void) | undefined;

  const emit = (): void => {
    for (const listener of listeners) listener();
  };
  const setState = (next: TesseronConnectionState): void => {
    state = next;
    emit();
  };

  const start = (): void => {
    if (started) return;
    if (options.enabled === false) return;
    started = true;
    cancelled = false;
    setState({ status: 'connecting' });

    const storage = resolveResumeStorage(options.resume);

    const run = async (): Promise<void> => {
      let saved: ResumeCredentials | null = null;
      if (storage) {
        try {
          saved = (await storage.load()) ?? null;
        } catch {
          // A throwing backend shouldn't break the connection; treat as no
          // saved creds and proceed to a fresh hello.
          saved = null;
        }
      }

      // URL-form `client.connect` is the de-dup path on the singleton: same URL
      // + same resume creds + concurrent calls → shared promise, single socket.
      // That's what fixes the StrictMode / HMR resume race (tesseron#88).
      let welcome: WelcomeResult;
      let resumeStatus: TesseronResumeStatus = 'none';
      try {
        welcome = await client.connect(options.url, { resume: saved ?? false });
        if (saved) resumeStatus = 'resumed';
      } catch (err) {
        if (saved && err instanceof TesseronError && err.code === TesseronErrorCode.ResumeFailed) {
          // Stored creds are stale (TTL elapsed, gateway restarted, session
          // never claimed, token already rotated by another tab). Best-effort
          // clear and start fresh; clear failures must not block the fallback.
          if (storage) {
            try {
              await storage.clear();
            } catch {
              // Cleanup is non-fatal — the next successful save() overwrites
              // the stale entry anyway.
            }
          }
          if (cancelled) return;
          welcome = await client.connect(options.url, { resume: false });
          resumeStatus = 'failed';
        } else {
          throw err;
        }
      }

      if (cancelled) return;
      if (storage && welcome.resumeToken) {
        try {
          await storage.save({
            sessionId: welcome.sessionId,
            resumeToken: welcome.resumeToken,
          });
        } catch {
          // Persistence failure is non-fatal — the live session still works
          // for this page load; it just won't survive the next refresh.
        }
      }
      if (cancelled) return;
      setState({
        status: 'open',
        welcome,
        claimCode: welcome.claimCode,
        resumeStatus,
      });
    };

    run().catch((error: unknown) => {
      if (cancelled || error instanceof CancelledError) return;
      setState({
        status: 'error',
        error: error instanceof Error ? error : new Error(String(error)),
      });
    });

    // Subscribe to server-driven welcome updates. Currently only fires on
    // `tesseron/claimed` (which clears `claimCode` and updates `agent`), but the
    // API is generic so future welcome-mutating notifications surface for free.
    unsubscribeWelcome = client.onWelcomeChange((welcome) => {
      if (cancelled) return;
      // Only patch when we're already 'open'; otherwise the welcome update
      // arrived during connect() and the run() block delivers consistent state.
      if (state.status !== 'open') return;
      setState({ ...state, welcome, claimCode: welcome.claimCode });
    });
  };

  const stop = (): void => {
    cancelled = true;
    if (unsubscribeWelcome) {
      unsubscribeWelcome();
      unsubscribeWelcome = undefined;
    }
    // Intentionally NOT closing the transport: the singleton's URL-form
    // `connect()` dedups concurrent calls so a remount (including StrictMode's
    // synchronous mount → cleanup → remount) shares the in-flight promise.
    // Closing the socket here would reproduce the tesseron#88 resume race.
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    stop,
  };
}
