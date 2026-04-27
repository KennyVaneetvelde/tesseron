import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
  type ActionAnnotations,
  type ActionContext,
  BrowserWebSocketTransport,
  DEFAULT_GATEWAY_URL,
  type ResumeCredentials,
  TesseronError,
  TesseronErrorCode,
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

/**
 * Persistence backend for resume credentials. Implementations may be sync or
 * async; the hook awaits each call. Returning `null` or `undefined` from
 * `load` means "no stored session, do a fresh hello." Throws from any method
 * are non-fatal: the hook treats them like an empty backend (load) or a
 * silent no-op (save/clear) so storage problems can't fail-close the
 * connection.
 */
export interface ResumeStorage {
  load: () => ResumeCredentials | null | undefined | Promise<ResumeCredentials | null | undefined>;
  save: (credentials: ResumeCredentials) => void | Promise<void>;
  clear: () => void | Promise<void>;
}

/** Options for {@link useTesseronConnection}. */
export interface UseTesseronConnectionOptions {
  /** Gateway URL; defaults to `DEFAULT_GATEWAY_URL` (the local bridge). */
  url?: string;
  /** Set to `false` to skip connecting (useful for gating behind auth). Defaults to `true`. */
  enabled?: boolean;
  /**
   * Persist `{ sessionId, resumeToken }` so the hook can rejoin an existing
   * claimed session via `tesseron/resume` after the transport drops (page
   * refresh, HMR reload, brief network blip) instead of issuing a new claim
   * code. See [protocol/resume](https://tesseron.dev/protocol/resume/).
   *
   * - `false` / omitted (default): no persistence. Every connect is a fresh hello.
   * - `true`: persist in `localStorage` under `'tesseron:resume'`.
   * - `string`: persist in `localStorage` under that exact key. Use a per-app
   *   value when you have multiple `WebTesseronClient` instances per page.
   * - `ResumeStorage`: custom `{ load, save, clear }` callbacks. Useful when
   *   `localStorage` is not available (Electron renderer with strict CSP, an
   *   iframe partition, custom storage).
   *
   * On a `TesseronError(ResumeFailed)` (TTL expired, token rotated by another
   * tab, gateway restarted, session was never claimed), the hook clears the
   * stored credentials, falls back to a fresh `tesseron/hello`, and surfaces
   * `resumeStatus: 'failed'` in {@link TesseronConnectionState} so the UI can
   * react. Resume tokens rotate on every successful handshake (hello or
   * resume), and the hook always overwrites the stored value with the
   * freshest token.
   *
   * Note: resume only re-establishes the session, not its
   * `resources/subscribe` bindings. The {@link useTesseronResource} hook
   * re-registers subscriptions naturally on remount, so apps using the
   * provided hooks see no behavioral difference; if you wire subscriptions
   * by hand against the lower-level client, you must re-subscribe after
   * each connect.
   */
  resume?: boolean | string | ResumeStorage;
}

/**
 * Outcome of the resume attempt that produced the current connection.
 * - `'none'` - no resume was attempted (no stored creds or `resume` disabled).
 * - `'resumed'` - `tesseron/resume` succeeded; the session was reattached.
 * - `'failed'` - resume was attempted but the gateway rejected it; the hook
 *   transparently fell back to a fresh `tesseron/hello`. Useful for telemetry
 *   and for UIs that want to say "your previous session expired" rather than
 *   silently displaying a new claim code.
 */
export type TesseronResumeStatus = 'none' | 'resumed' | 'failed';

/**
 * Sentinel thrown when {@link useTesseronConnection}'s effect detects that
 * cleanup has already fired. The outer `run().catch` checks for this type
 * and skips `setState({ status: 'error' })` — without the sentinel a future
 * refactor that drops the redundant `cancelled` re-check could surface
 * "useTesseronConnection: cancelled" as a UI error string.
 *
 * Internal — not exported from the package.
 */
class CancelledError extends Error {
  constructor() {
    super('useTesseronConnection: effect cancelled before connect resolved');
    this.name = 'CancelledError';
  }
}

/** Reactive connection state returned from {@link useTesseronConnection}. */
export interface TesseronConnectionState {
  status: 'idle' | 'connecting' | 'open' | 'error' | 'closed';
  welcome?: WelcomeResult;
  /**
   * Claim code to display in the UI. Present only on a fresh `tesseron/hello`;
   * absent after a successful resume because the session was already claimed.
   */
  claimCode?: string;
  error?: Error;
  /**
   * Set when `status === 'open'`. Indicates whether the current session is a
   * resumed one, a fresh fallback after a failed resume, or a plain hello.
   * See {@link TesseronResumeStatus}.
   */
  resumeStatus?: TesseronResumeStatus;
}

const DEFAULT_RESUME_STORAGE_KEY = 'tesseron:resume';

function localStorageResumeBackend(key: string): ResumeStorage {
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
        // - treat as no saved session and let the hook do a fresh hello.
        return null;
      }
    },
    save: (creds) => {
      if (typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(key, JSON.stringify(creds));
      } catch {
        // Quota exceeded or storage disabled - non-fatal; the session still
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

function resolveResumeStorage(
  option: UseTesseronConnectionOptions['resume'],
): ResumeStorage | null {
  if (!option) return null;
  if (option === true) return localStorageResumeBackend(DEFAULT_RESUME_STORAGE_KEY);
  if (typeof option === 'string') return localStorageResumeBackend(option);
  return option;
}

/**
 * Connects the shared {@link WebTesseronClient} singleton on mount and exposes
 * the connection status (and claim code) for rendering. Register your actions
 * and resources with {@link useTesseronAction} / {@link useTesseronResource}
 * before this hook runs so they appear in the initial `tesseron/hello` manifest.
 *
 * Pass `options.resume` to survive page refresh / HMR reloads without losing
 * the claimed session - see {@link UseTesseronConnectionOptions.resume}.
 */
export function useTesseronConnection(
  options: UseTesseronConnectionOptions = {},
  client: WebTesseronClient = tesseron,
): TesseronConnectionState {
  const [state, setState] = useState<TesseronConnectionState>({ status: 'idle' });
  const enabled = options.enabled ?? true;
  const url = options.url;
  const resumeRef = useRef(options.resume);
  resumeRef.current = options.resume;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // Own the transport here rather than letting `client.connect(url)`
    // construct one internally. React 18 StrictMode mounts the effect
    // twice (mount → cleanup → re-mount); without an owned transport, the
    // first mount's WebSocket leaks past cleanup and races the second
    // mount's connect over the singleton client's `this.transport`. With
    // the hook holding the ref, cleanup closes the in-flight WS
    // unconditionally — the dispatcher's pending hello/resume rejects
    // cleanly via TransportClosedError and the second mount proceeds with
    // its own fresh transport. See tesseron#68.
    let transport: BrowserWebSocketTransport | null = null;
    setState({ status: 'connecting' });

    const storage = resolveResumeStorage(resumeRef.current);

    const connectOnce = async (
      options?: { resume?: ResumeCredentials },
    ): Promise<WelcomeResult> => {
      const t = new BrowserWebSocketTransport(url ?? DEFAULT_GATEWAY_URL);
      transport = t;
      await t.ready();
      if (cancelled) {
        // Cleanup ran during the await. Two paths converge here:
        //   - Cleanup's `transport?.close()` fired before `t.ready()`
        //     resolved → ready() rejected → we never reach this line.
        //   - The open handshake won the race and ready() resolved
        //     before cleanup closed `t` → close `t` ourselves and bail.
        // The `transport` ref always points at the most recently
        // constructed `t` (each call to connectOnce overwrites it), so
        // cleanup closes whichever connect is in flight.
        t.close();
        throw new CancelledError();
      }
      return client.connect(t, options);
    };

    const run = async (): Promise<void> => {
      let saved: ResumeCredentials | null = null;
      if (storage) {
        try {
          saved = (await storage.load()) ?? null;
        } catch {
          // A throwing custom backend shouldn't break the connection; treat
          // as no saved creds and proceed to a fresh hello.
          saved = null;
        }
      }

      let welcome: WelcomeResult;
      let resumeStatus: TesseronResumeStatus = 'none';
      try {
        welcome = await connectOnce(saved ? { resume: saved } : undefined);
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
              // Cleanup is non-fatal - the next successful save() overwrites
              // the stale entry anyway.
            }
          }
          if (cancelled) return;
          welcome = await connectOnce();
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
          // Persistence failure is non-fatal - the live session still works
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
    // `tesseron/claimed` (which clears `claimCode` and updates `agent`),
    // but the API is generic so future welcome-mutating notifications get
    // surfaced for free. The unsubscribe runs on unmount or dep change.
    const unsubscribe = client.onWelcomeChange((welcome) => {
      if (cancelled) return;
      setState((prev) => {
        // Only patch when we're already 'open'; otherwise the welcome update
        // arrived during connect() and the run() block above will deliver
        // the consistent state.
        if (prev.status !== 'open') return prev;
        return { ...prev, welcome, claimCode: welcome.claimCode };
      });
    });

    return () => {
      cancelled = true;
      unsubscribe();
      // Close any in-flight transport. If it was still in the open
      // handshake, the patched `ready()` rejects on close so `run()`
      // unwinds cleanly. If it was past handshake, the core client's
      // `transport.onClose` handler clears `this.dispatcher` /
      // `this.welcome` and rejects pending dispatcher requests.
      transport?.close();
    };
  }, [enabled, url, client]);

  return state;
}
