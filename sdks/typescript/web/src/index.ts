import {
  type ConnectOptions,
  type ResumeCredentials,
  TesseronClient,
  TesseronError,
  TesseronErrorCode,
  type Transport,
  type WelcomeResult,
} from '@tesseron/core';
import {
  DEFAULT_RESUME_STORAGE_KEY,
  type ResumeStorage,
  localStorageResumeBackend,
} from './reactive-core.js';
import { BrowserWebSocketTransport } from './transport.js';

export * from '@tesseron/core';
// The framework-neutral reactive core (connection controller, registration
// helpers, resume storage, shared option/state types) is part of the public
// `@tesseron/web` surface and is re-exported wholesale by the React/Svelte/Vue
// adapters via their own `export * from '@tesseron/web'`.
export * from './reactive-core.js';
export { BrowserWebSocketTransport } from './transport.js';

/**
 * Default gateway endpoint: the Tesseron Vite plugin exposes `/@tesseron/ws`
 * on the same origin as the page, so no separate port is needed.
 * Falls back to a non-browser safe string — in practice the browser always
 * has `location` defined, this branch is only hit during SSR/bundler analysis.
 */
export const DEFAULT_GATEWAY_URL =
  typeof location !== 'undefined'
    ? `${location.origin.replace(/^http/, 'ws')}/@tesseron/ws`
    : 'ws://localhost:5173/@tesseron/ws';

/**
 * Options to {@link WebTesseronClient.connect}. Extends the protocol-level
 * {@link ConnectOptions} with a richer `resume` shape that bundles persistence
 * into the connect call so raw `@tesseron/web` users don't have to hand-wire
 * the four-line localStorage recipe from the docs.
 */
export interface WebConnectOptions extends Omit<ConnectOptions, 'resume'> {
  /**
   * Controls session-resume behaviour on this connect.
   *
   * - `undefined` or `true` (default): persist `{ sessionId, resumeToken }`
   *   in `localStorage` under {@link DEFAULT_RESUME_STORAGE_KEY}. The SDK
   *   auto-loads on connect, sends `tesseron/resume` if credentials exist,
   *   saves the rotated token on success, and transparently falls back to a
   *   fresh `tesseron/hello` if the gateway rejects the resume (TTL elapsed,
   *   token rotated by another tab, gateway restarted).
   * - `false`: no persistence. Every connect is a fresh hello with a new
   *   claim code. Use for incognito-style flows that must not carry session
   *   state across page reloads.
   * - `string`: same as `true`, but with this `localStorage` key. Pass a
   *   per-app value when you run multiple Tesseron clients on one page.
   * - {@link ResumeStorage}: custom persistence backend (an Electron store,
   *   an OS keychain bridge, an IPC channel — anything implementing the
   *   interface).
   * - {@link ResumeCredentials}: explicit credentials the caller already
   *   loaded from elsewhere. The SDK uses them as-is and does **not**
   *   auto-persist; the caller is expected to handle storage itself. This
   *   is the legacy form; new code should prefer one of the storage-aware
   *   shapes above.
   *
   * `@tesseron/react`'s `useTesseronConnection` hook manages its own
   * storage and passes results through explicitly — when using the hook,
   * configure resume there, not here.
   */
  resume?: ResumeCredentials | boolean | string | ResumeStorage;
}

/**
 * Browser-side {@link TesseronClient} with a WebSocket-aware `connect` overload.
 * Pass nothing to use {@link DEFAULT_GATEWAY_URL}, a URL string to connect to
 * another gateway, or a custom {@link Transport} to bypass WebSocket entirely.
 * The optional second argument is {@link WebConnectOptions} — see its `resume`
 * field for how persistence is wired in by default.
 *
 * **Re-entry safety.** Two URL-form `connect()` calls with the same URL and
 * the same resume credentials (StrictMode mount → cleanup → remount, HMR
 * re-running module-scope `connect()`, an `enabled` flag flapping under an
 * auth gate) share a single in-flight promise and a single underlying
 * WebSocket. Without this, both calls would build their own socket, the
 * gateway would see two `tesseron/resume` requests sharing one (single-shot)
 * resume token, and the second one would invariably fail with `ResumeFailed`.
 * See tesseron#88. The transport-form (`connect(transport, options)`)
 * bypasses URL-form de-dup and falls through to {@link TesseronClient.connect}'s
 * serialization on top.
 */
export class WebTesseronClient extends TesseronClient {
  /**
   * Tracks the most recent URL-form connect attempt so concurrent calls with
   * matching dedup keys share its promise instead of opening a parallel
   * WebSocket. Cleared once the promise settles.
   */
  private inFlightUrlConnect?: {
    url: string;
    dedupKey: string;
    promise: Promise<WelcomeResult>;
  };

  override connect(
    target?: Transport | string,
    options?: WebConnectOptions,
  ): Promise<WelcomeResult> {
    if (target && typeof target !== 'string') {
      // Transport-form: the caller supplied their own transport. Auto-persist
      // would have to round-trip through the SDK at connect time, which the
      // caller hasn't asked for, so refuse the storage-aware shapes upfront
      // rather than silently dropping them. ResumeCredentials and `false`
      // remain valid here. Reject (don't throw) so the API stays
      // promise-uniform — callers don't have to know which mistakes are
      // synchronous vs asynchronous.
      if (
        options?.resume !== undefined &&
        options.resume !== false &&
        !isResumeCredentials(options.resume)
      ) {
        return Promise.reject(
          new Error(
            'tesseron.connect(transport, { resume }): persistence shapes (true/string/ResumeStorage) require the URL form. Pass ResumeCredentials directly or omit the option.',
          ),
        );
      }
      return super.connect(target, options as ConnectOptions);
    }
    const url = target ?? DEFAULT_GATEWAY_URL;
    const { storage, explicitCreds } = normalizeResume(options?.resume);
    // Dedup key fingerprints the resume intent: explicit creds dedup on their
    // literal value (preserves the pre-storage tesseron#88 contract), storage-
    // backed connects dedup on a stable id of the storage option (two
    // StrictMode mounts asking for `resume: true` share one connect), and
    // `resume: false` dedups against itself but not against storage-backed
    // calls.
    const dedupKey = dedupKeyOf(options?.resume, storage, explicitCreds);
    const inFlight = this.inFlightUrlConnect;
    if (inFlight && inFlight.url === url && inFlight.dedupKey === dedupKey) {
      return inFlight.promise;
    }
    const promise = this.runUrlConnect(url, storage, explicitCreds);
    const entry = { url, dedupKey, promise };
    this.inFlightUrlConnect = entry;
    promise
      .catch(() => {})
      .finally(() => {
        if (this.inFlightUrlConnect === entry) this.inFlightUrlConnect = undefined;
      });
    return promise;
  }

  private async runUrlConnect(
    url: string,
    storage: ResumeStorage | null,
    explicitCreds: ResumeCredentials | null,
  ): Promise<WelcomeResult> {
    let creds: ResumeCredentials | null = explicitCreds;
    if (!creds && storage) {
      try {
        creds = (await storage.load()) ?? null;
      } catch {
        // A throwing backend shouldn't break the connection; treat as no
        // saved creds and proceed to a fresh hello.
        creds = null;
      }
    }
    const welcome = await this.openSocketAndHandshake(url, creds, storage, explicitCreds);
    if (storage && !explicitCreds && welcome.resumeToken) {
      try {
        await storage.save({
          sessionId: welcome.sessionId,
          resumeToken: welcome.resumeToken,
        });
      } catch {
        // Persistence failure is non-fatal — the live session still works
        // for this page load, it just won't survive the next refresh.
      }
    }
    return welcome;
  }

  private async openSocketAndHandshake(
    url: string,
    creds: ResumeCredentials | null,
    storage: ResumeStorage | null,
    explicitCreds: ResumeCredentials | null,
  ): Promise<WelcomeResult> {
    const transport = new BrowserWebSocketTransport(url);
    try {
      await transport.ready();
    } catch (err) {
      // ready() rejected — gateway unreachable, TLS handshake failed, or the
      // socket closed before opening. Best-effort close so the underlying
      // WebSocket is GC'able and we don't leak a half-open socket past the
      // rejected connect promise. close() is a no-op if the WS already
      // closed itself, which is the common case.
      try {
        transport.close();
      } catch {
        // Already in a bad state; nothing more to do.
      }
      throw err;
    }
    try {
      return await super.connect(transport, creds ? { resume: creds } : {});
    } catch (err) {
      // Auto-fallback only kicks in for SDK-managed storage. If the caller
      // passed explicit creds they own the storage layer and the failure
      // contract — let it through unchanged.
      if (
        storage &&
        !explicitCreds &&
        creds &&
        err instanceof TesseronError &&
        err.code === TesseronErrorCode.ResumeFailed
      ) {
        try {
          await storage.clear();
        } catch {
          // Cleanup is non-fatal — the next successful save() overwrites
          // the stale entry anyway.
        }
        // Open a fresh socket: the failed resume already closed the previous
        // one, and re-using a dead transport would double-fault.
        const retry = new BrowserWebSocketTransport(url);
        try {
          await retry.ready();
        } catch (e) {
          try {
            retry.close();
          } catch {
            // see above
          }
          throw e;
        }
        return super.connect(retry, {});
      }
      throw err;
    }
  }
}

function isResumeCredentials(x: unknown): x is ResumeCredentials {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as Record<string, unknown>)['sessionId'] === 'string' &&
    typeof (x as Record<string, unknown>)['resumeToken'] === 'string'
  );
}

function normalizeResume(option: WebConnectOptions['resume']): {
  storage: ResumeStorage | null;
  explicitCreds: ResumeCredentials | null;
} {
  if (option === false) return { storage: null, explicitCreds: null };
  if (option === undefined || option === true) {
    return {
      storage: localStorageResumeBackend(DEFAULT_RESUME_STORAGE_KEY),
      explicitCreds: null,
    };
  }
  if (typeof option === 'string') {
    return { storage: localStorageResumeBackend(option), explicitCreds: null };
  }
  if (isResumeCredentials(option)) {
    return { storage: null, explicitCreds: option };
  }
  return { storage: option, explicitCreds: null };
}

const customStorageIds = new WeakMap<ResumeStorage, string>();
let customStorageCounter = 0;
function identityOf(storage: ResumeStorage): string {
  let id = customStorageIds.get(storage);
  if (!id) {
    id = `custom-${++customStorageCounter}`;
    customStorageIds.set(storage, id);
  }
  return id;
}

function dedupKeyOf(
  option: WebConnectOptions['resume'],
  storage: ResumeStorage | null,
  explicitCreds: ResumeCredentials | null,
): string {
  if (explicitCreds) {
    return `creds:${explicitCreds.sessionId}\x00${explicitCreds.resumeToken}`;
  }
  if (!storage) return 'fresh';
  if (option === undefined || option === true) return `storage:${DEFAULT_RESUME_STORAGE_KEY}`;
  if (typeof option === 'string') return `storage:${option}`;
  return `storage:${identityOf(storage)}`;
}

/**
 * Singleton {@link WebTesseronClient} shared across a browser app. Most apps
 * import and use this directly rather than constructing their own.
 */
export const tesseron = new WebTesseronClient();
