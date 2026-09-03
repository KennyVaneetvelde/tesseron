# @tesseron/svelte

## 2.10.1

### Patch Changes

- Updated dependencies [[`1fc880b`](https://github.com/Eigenwise/tesseron/commit/1fc880b60308d58e21b0bb2e9288a375da1f2fe4)]:
  - @tesseron/core@2.10.1
  - @tesseron/web@2.10.1

## 2.10.0

### Minor Changes

- [#95](https://github.com/eigenwise/tesseron/pull/95) [`119cb2e`](https://github.com/eigenwise/tesseron/commit/119cb2efd250447553c1986e3c1b2f868c519202) by Kenny - refactor(web, react, svelte, vue, core, server, mcp, vite): single shared implementation behind every SDK — zero duplicated logic across packages

  Two families of copy-pasted code are collapsed to one source each. Every
  public API — React hooks, Svelte stores, Vue composables, the gateway, the
  server transports — is byte-for-byte behaviour-compatible; the duplication just
  moves out of sight.

  **Browser adapters.** `@tesseron/react`, `/svelte`, and `/vue` previously each
  carried their own copy of the connection state machine (connect → resume →
  `ResumeFailed` fallback → token rotation → save → `onWelcomeChange`), the
  action/resource builder-chain application, the `localStorage` resume backend,
  and the option/state types — with parity kept only by convention. That drift
  surface is gone. A new framework-neutral reactive core in `@tesseron/web`
  (`createConnectionController`, `registerAction`, `registerResource`,
  `resolveResumeStorage`, `localStorageResumeBackend`, and the shared
  `TesseronConnectionState` / `TesseronConnectionOptions` / `TesseronActionOptions`
  / `TesseronResourceOptions` / `TesseronResumeStatus` types) holds the logic
  once; each adapter is now a thin (~10-line-per-primitive) binding onto its
  framework's reactivity and lifecycle. The per-framework public names are
  unchanged (React keeps its `Use…Options` aliases; Svelte/Vue surface the shared
  types through their existing `export *`).

  **Node utilities.** The byte-identical `fs-hygiene.ts` (three copies across
  `/server`, `/vite`, `/mcp`), the duplicated claim/session/token mint helpers
  (`/server`, `/vite`, plus inline in `/mcp`), and the host-bind helpers — the
  rolling-window bind rate limiter, the `tesseron/hello` detector, the synthesized
  pre-claim welcome, and the bind-failure lockout constants (byte-identical across
  the two `/server` host transports and re-implemented again in `/vite`) — now
  live once behind the new node-only `@tesseron/core/node` subpath
  (`ensurePrivateDir`, `writePrivateFile`, `mintClaimCode`, `mintSessionId`,
  `mintInvocationId`, `mintResumeToken`, `BindRateLimiter`, `isHelloFrame`,
  `buildSynthesizedWelcomeResponse`, `BIND_FAILURE_*`). The main `@tesseron/core`
  entry stays browser-safe. The drift-detection parity test that guarded the three
  `fs-hygiene` copies is removed — there is nothing left to drift. `@tesseron/mcp`
  keeps its historical `generate*` names as re-export aliases.

### Patch Changes

- Updated dependencies [[`119cb2e`](https://github.com/eigenwise/tesseron/commit/119cb2efd250447553c1986e3c1b2f868c519202)]:
  - @tesseron/core@2.10.0
  - @tesseron/web@2.10.0

## 2.2.1

### Patch Changes

- Updated dependencies [[`7b9236a`](https://github.com/eigenwise/tesseron/commit/7b9236a9c4dd2f6a0d493d8b9e96c59a58be96a8)]:
  - @tesseron/core@2.9.1
  - @tesseron/web@2.9.1

## 2.2.0

### Minor Changes

- [`af19ac3`](https://github.com/eigenwise/tesseron/commit/af19ac3a0013fccbd05d6dec5cc0c0eb6b7e057e) by Kenny - feat(vite, web, react, vue, svelte, mcp): session resume is now the default — no more claim-code dance on refresh

  A casual page refresh keeps the same Tesseron session paired with the agent.
  The work coordinates four layers; each is independently correct, and together
  they make refresh-without-re-claim work end-to-end for every host.
  - **@tesseron/vite** — replaces the per-WS instance model with a
    **SessionManager**. The unit of identity is now a `Session` keyed by
    `sessionId`, not the browser WebSocket. Browser WSes attach via `tesseron/hello`
    (create) or `tesseron/resume` (re-attach to an existing Session); browser
    detach starts an idle TTL (default 4 h, configurable via the new
    `sessionIdleTtlMs` option), and a reattaching browser within that window
    cancels it. The gateway-side bridge stays open across detach/reattach so
    the agent never sees a disconnect. The previous "host-mint sessions don't
    honour resume" rejection ([#68](https://github.com/eigenwise/tesseron/issues/68)) is replaced by proper resume validation:
    constant-time compare against the stored resume token, rotate on success,
    fall through to `ResumeFailed` on any miss.
  - **@tesseron/mcp** — bumps `DEFAULT_RESUME_TTL_MS` from 90 seconds to
    **4 hours** for the gateway-mint path (Node-side hosts via `@tesseron/server`).
    A `TESSERON_RESUME_TTL_MS` env var (non-negative integer milliseconds; `0`
    disables resume) lets operators tune it without a fork.
  - **@tesseron/web** — `tesseron.connect()` auto-persists the
    `{ sessionId, resumeToken }` pair to `localStorage` (`'tesseron:resume'`)
    and replays it on the next connect. New `WebConnectOptions.resume` accepts:
    `true`/omitted (default), `false`, a string key, a `ResumeStorage` backend,
    or an explicit `ResumeCredentials` literal.
  - **@tesseron/react** — `useTesseronConnection`'s `resume` default flips from
    off to `true`. The hook always passes an explicit `resume` to the web SDK
    so the SDK's own auto-persist layer doesn't double-write under the hook's
    storage.
  - **@tesseron/vue** and **@tesseron/svelte** — full parity with React:
    `resume` option (defaults to `true`), `resumeStatus` on the reactive state,
    `onWelcomeChange` subscription so `claimCode` clears automatically when an
    agent claims (previously stayed stale until refresh).

  Behavioural envelope:
  - Same session survives refresh, HMR reload, brief network blip, and even a
    short laptop sleep, for both browser tabs (`@tesseron/vite`) and Node
    processes (`@tesseron/server`).
  - Invalid resume tokens (TTL expired, gateway/host restarted, corrupted
    storage) fail gracefully: `ResumeFailed` → SDK clears storage → fresh
    `tesseron/hello` → new claim code.
  - Opt out everywhere with `{ resume: false }` for incognito-style flows.

  No protocol bump — the wire shape is unchanged. See the [session resume
  docs](https://tesseron.dev/protocol/resume/) and the
  [vite plugin's Session model](https://tesseron.dev/sdk/typescript/vite/#sessions-span-browser-refreshes)
  for the implementation details and the [security model](https://tesseron.dev/protocol/security/)
  for the threat-model notes (unchanged: same-UID local process can read
  `localStorage` and `~/.tesseron/instances/`, so the host-mint resume window
  is the same trust surface as the existing claim-code flow).

### Patch Changes

- Updated dependencies [[`af19ac3`](https://github.com/eigenwise/tesseron/commit/af19ac3a0013fccbd05d6dec5cc0c0eb6b7e057e)]:
  - @tesseron/core@2.9.0
  - @tesseron/web@2.9.0

## 2.1.14

### Patch Changes

- [#89](https://github.com/eigenwise/tesseron/pull/89) [`77f8a64`](https://github.com/eigenwise/tesseron/commit/77f8a641c8fb514baefe7e4b24a605772711a2ae) by Kenny - fix(core, web, react): make `connect()` re-entrant so claimed-session resume survives StrictMode and HMR (closes [#88](https://github.com/eigenwise/tesseron/issues/88))

  Two `connect()` calls used to race on `this.transport`: the second closed the
  first's socket mid-handshake, frames in flight on either socket — including
  the gateway's `tesseron/resume` response — could be lost, and a claimed
  session ended up displaying a fresh claim code instead of resuming. The
  predecessor fix in [#68](https://github.com/eigenwise/tesseron/issues/68) papered this over for unclaimed sessions, but
  claimed-session resume across full page reloads (e.g. Vite hot-reloading a
  module-scope side effect) still failed.

  Now:
  - `TesseronClient.connect()` (core) eagerly closes the prior transport on
    re-entry, then queues the new handshake behind the prior connect's
    settlement and the prior transport's `onClose` drain. New dispatcher
    state is only installed once the old socket has stopped touching it,
    so a late-firing `onClose` can never trample the new welcome.
  - `WebTesseronClient.connect()` (web, URL form) deduplicates concurrent
    calls with the same URL and the same resume credentials: the second
    caller shares the in-flight promise (and the in-flight WebSocket)
    instead of opening a parallel one. Without de-dup, the gateway would
    receive two `tesseron/resume` requests carrying the same single-shot
    token, the first would consume the zombie, and the second would
    invariably fail with `ResumeFailed`.
  - `useTesseronConnection` (react) now defers transport ownership to the
    singleton's URL-form `connect()` and no longer closes the WebSocket on
    cleanup. Under React 18 StrictMode the second mount dedupes onto the
    first mount's still-in-flight promise, so only one socket is opened
    and only one `tesseron/resume` reaches the gateway.

  Consumer apps can now drop the `beforeunload`-clears-`tesseron:resume`
  workaround that was needed to mask the race; the SDK manages the
  lifecycle by itself.

- Updated dependencies [[`77f8a64`](https://github.com/eigenwise/tesseron/commit/77f8a641c8fb514baefe7e4b24a605772711a2ae)]:
  - @tesseron/core@2.8.1
  - @tesseron/web@2.8.1

## 2.1.13

### Patch Changes

- Updated dependencies [[`bcf950d`](https://github.com/eigenwise/tesseron/commit/bcf950d5ba9f567a1d7a0b080b094544d30bfd86)]:
  - @tesseron/core@2.8.0
  - @tesseron/web@2.8.0

## 2.1.12

### Patch Changes

- Updated dependencies [[`cba7894`](https://github.com/eigenwise/tesseron/commit/cba7894a3a90fb6b2de7f2a1955ca842a514100b)]:
  - @tesseron/core@2.7.0
  - @tesseron/web@2.7.0

## 2.1.11

### Patch Changes

- Updated dependencies []:
  - @tesseron/core@2.6.1
  - @tesseron/web@2.6.1

## 2.1.10

### Patch Changes

- Updated dependencies []:
  - @tesseron/core@2.6.0
  - @tesseron/web@2.6.0

## 2.1.9

### Patch Changes

- Updated dependencies [[`4f59055`](https://github.com/eigenwise/tesseron/commit/4f5905509120783a03413f1d7ea2cb63699a02d7)]:
  - @tesseron/web@2.5.1
  - @tesseron/core@2.5.1

## 2.1.8

### Patch Changes

- Updated dependencies [[`f93b7f6`](https://github.com/eigenwise/tesseron/commit/f93b7f6a3f607a9d6a36f309b64379ce4fb82d0c)]:
  - @tesseron/core@2.5.0
  - @tesseron/web@2.5.0

## 2.1.7

### Patch Changes

- Updated dependencies [[`abe0cac`](https://github.com/eigenwise/tesseron/commit/abe0cacad930f748d9bd69a0025be38c6d4d852b)]:
  - @tesseron/core@2.4.0
  - @tesseron/web@2.4.0

## 2.1.6

### Patch Changes

- Updated dependencies [[`eff7726`](https://github.com/eigenwise/tesseron/commit/eff77265fac8cb0877eefe06030f462aa8048568), [`94d50ef`](https://github.com/eigenwise/tesseron/commit/94d50ef5364ce2a240b5033674d59b0cbe4ca486)]:
  - @tesseron/core@2.3.1
  - @tesseron/web@2.3.1

## 2.1.5

### Patch Changes

- Updated dependencies [[`f0e671f`](https://github.com/eigenwise/tesseron/commit/f0e671f1c26195cc597ce90cb2ad8f8f59dd7e9f)]:
  - @tesseron/core@2.3.0
  - @tesseron/web@2.3.0

## 2.1.4

### Patch Changes

- Updated dependencies []:
  - @tesseron/core@2.2.2
  - @tesseron/web@2.2.2

## 2.1.3

### Patch Changes

- Updated dependencies [[`db6e0c4`](https://github.com/eigenwise/tesseron/commit/db6e0c4d1a83583c7012634c17d3579bc95060b7)]:
  - @tesseron/core@2.2.1
  - @tesseron/web@2.2.1

## 2.1.2

### Patch Changes

- [#44](https://github.com/eigenwise/tesseron/pull/44) [`cf604d0`](https://github.com/eigenwise/tesseron/commit/cf604d0222519f9ed44fab373279e85f60c69062) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Auto-derive JSON Schema from Standard Schema validators that ship a converter.

  The documented `.input(z.object({...}))` idiom previously shipped every action
  with a permissive `{type: 'object', additionalProperties: true}` because no
  auto-derivation existed in `@tesseron/core` — only the explicit-second-arg
  path was wired up. Agents got no field-type signal, which meant Claude
  sometimes JSON-encoded numeric arguments as strings; Zod's runtime then
  correctly rejected the call with `-32004 InputValidation`.

  `ActionBuilder.input` / `.output` and `ResourceBuilder.output` now look for a
  JSON Schema exporter on the validator and use it when the caller didn't pass
  one explicitly. Detection is duck-typed and never throws — failures fall
  through to the existing permissive default:
  - **Zod 4+** — `schema.toJSONSchema()` instance method.
  - **TypeBox** — schema object IS the JSON Schema; `~standard` is stripped.
  - **ArkType** — `schema.toJsonSchema()` instance method.
  - **Valibot / Effect Schema / Zod 3** — no native instance exporter; pass
    JSON Schema as the second argument (use `@valibot/to-json-schema`,
    `@effect/schema/JSONSchema`, or `zod-to-json-schema` respectively).

  Closes [#43](https://github.com/eigenwise/tesseron/issues/43).

- Updated dependencies [[`cf604d0`](https://github.com/eigenwise/tesseron/commit/cf604d0222519f9ed44fab373279e85f60c69062)]:
  - @tesseron/core@2.2.0
  - @tesseron/web@2.2.0

## 2.1.1

### Patch Changes

- [#41](https://github.com/eigenwise/tesseron/pull/41) [`fa3bbdc`](https://github.com/eigenwise/tesseron/commit/fa3bbdc46a327ac800c7c26fc36f763856f18831) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Fix `tesseron__read_resource` (and `__invoke_action`) hanging indefinitely
  after an HMR-driven reconnect.

  Two interlocking bugs:
  1. `TesseronClient.connect()` swapped in a new transport without closing the
     previous one, so the old `WebSocket` lingered as a phantom claimed
     session on the gateway side. `connect()` now closes any previously-
     attached transport before swapping, and the per-transport `onClose`
     handler guards against a late close from the prior transport trampling
     the new dispatcher / welcome.
  2. `McpAgentBridge` resolved sessions by `Map`-iteration order, so when the
     user reclaimed via a fresh socket the bridge still routed reads and
     action invocations to the older — and now dead — session. The lookup
     now picks the most-recently-claimed session matching the `app.id`.

  Closes [#40](https://github.com/eigenwise/tesseron/issues/40).

- Updated dependencies [[`fa3bbdc`](https://github.com/eigenwise/tesseron/commit/fa3bbdc46a327ac800c7c26fc36f763856f18831)]:
  - @tesseron/core@2.1.1
  - @tesseron/web@2.1.1

## 2.1.0

### Minor Changes

- [#37](https://github.com/eigenwise/tesseron/pull/37) [`f49f5bf`](https://github.com/eigenwise/tesseron/commit/f49f5bfcf11904b1c98a2b17c14ec89acbeb824a) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Multi-binding transport layer (PROTOCOL_VERSION → 1.1.0). Decouples the
  protocol from WebSocket so apps that can host other duplex channels — Unix
  domain sockets, future named pipes / stdio — speak Tesseron without bridging
  through a WS server.

  Closes [#28](https://github.com/eigenwise/tesseron/issues/28), [#29](https://github.com/eigenwise/tesseron/issues/29), [#30](https://github.com/eigenwise/tesseron/issues/30), [#31](https://github.com/eigenwise/tesseron/issues/31), [#32](https://github.com/eigenwise/tesseron/issues/32), [#33](https://github.com/eigenwise/tesseron/issues/33), [#34](https://github.com/eigenwise/tesseron/issues/34).

  ### Protocol
  - New on-disk discovery format: `~/.tesseron/instances/<instanceId>.json`,
    v2 manifest with a discriminated `transport: { kind, ... }` field.
  - New types in `@tesseron/core`: `TransportSpec`, `InstanceManifest`.
  - `PROTOCOL_VERSION` bumped 1.0.0 → 1.1.0. Hard reject on major mismatch,
    warn on minor (covered by `protocol-version.test.ts`).
  - Compat: gateway reads both `instances/` (v2) and `tabs/` (v1) for one
    minor version. v1 manifests are coerced to `{ kind: 'ws', url }`. The
    legacy directory drops in 2.0.

  ### Bindings
  - **WebSocket** (default, unchanged on the wire) — formal binding spec at
    `/protocol/transport-bindings/ws/`.
  - **Unix domain socket** (new) — NDJSON framing on AF_UNIX sockets; SDK-side
    `UnixSocketServerTransport` in `@tesseron/server` (Linux + macOS).
    Same-UID enforcement via 0700 parent dir + 0600 socket file. Select with
    `tesseron.connect({ transport: 'uds' })`. Windows tracked separately —
    Node's `net.listen({ path })` binds named pipes there, which need a
    different binding.

  ### Gateway
  - `TesseronGateway.connectToApp(instanceId, spec: TransportSpec)` —
    signature change from `(tabId, wsUrl)`. Picks a dialer (`WsDialer`,
    `UdsDialer`) by `spec.kind`. Custom dialers can be registered via
    `new TesseronGateway({ dialers: [...] })`.
  - `TesseronGateway.watchInstances()` — replaces `watchAppsJson()`, which
    stays as a deprecated alias for one minor.
  - Internal `Session.ws: WebSocket` → `Session.transport: Transport`. Session
    shutdown now goes through the binding-neutral `transport.close(reason)`
    instead of a raw `ws.close(1001)` — UDS sessions don't have close codes.

  ### Vite plugin
  - `@tesseron/vite` writes v2 instance manifests (`{ kind: 'ws', url }`)
    instead of v1 tab files.
  - Internal `tabId` → `instanceId` (manifests are still per-tab; the rename
    drops the WS-only bias).

  ### Docs
  - `protocol/transport.md` rewritten as a binding-neutral overview.
  - New per-binding pages: `protocol/transport-bindings/ws.md`,
    `protocol/transport-bindings/uds.md`.
  - `sdk/porting.md` updated to describe how to write a new binding.
  - Cross-references in `handshake.mdx`, `wire-format.mdx`, `security.mdx`,
    `mcp.md`, `server.md`, `vite.md`, `quickstart.mdx`, `architecture.mdx`,
    `core.md`, `index.mdx` synced.

### Patch Changes

- Updated dependencies [[`f49f5bf`](https://github.com/eigenwise/tesseron/commit/f49f5bfcf11904b1c98a2b17c14ec89acbeb824a)]:
  - @tesseron/core@2.1.0
  - @tesseron/web@2.1.0

## 2.0.0

### Major Changes

- [#21](https://github.com/eigenwise/tesseron/pull/21) [`21ce314`](https://github.com/eigenwise/tesseron/commit/21ce31470232bbdfad3843ed0399ce850302e7a4) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Reversed connection architecture. The gateway is now a pure WebSocket client; apps host their own endpoints and announce themselves via `~/.tesseron/tabs/<tabId>.json`. One discovery mechanism for every runtime, no fixed ports.

  Breaking changes:
  - **`@tesseron/mcp`**: removed `gateway.start()`, `GatewayOptions.port` / `host` / `originAllowlist`, `DEFAULT_GATEWAY_PORT`, `DEFAULT_GATEWAY_HOST`, and the `TESSERON_PORT` / `TESSERON_HOST` / `TESSERON_ORIGIN_ALLOWLIST` environment variables. The CLI now watches `~/.tesseron/tabs/` exclusively.
  - **`@tesseron/server`**: `NodeWebSocketTransport` (a WS client) replaced with `NodeWebSocketServerTransport` (a WS server that binds loopback and writes a tab file). `DEFAULT_GATEWAY_URL` removed. `tesseron.connect()` no longer accepts a gateway URL string; pass `NodeWebSocketServerTransportOptions` (`appName`, `host`, `port`) or a custom `Transport`.
  - **`@tesseron/web`**: `DEFAULT_GATEWAY_URL` now derives from `location.origin` and points at `/@tesseron/ws` (served by the new `@tesseron/vite` plugin). Production-browser SPAs that previously dialed `ws://localhost:7475` must provide their own bridge.

  New packages:
  - **`@tesseron/vite`**: Vite plugin that exposes `/@tesseron/ws` on the dev server and bridges browser tabs to the gateway.
  - **`@tesseron/svelte`** and **`@tesseron/vue`**: framework adapters with lifecycle-scoped `tesseronAction` / `tesseronResource` / `tesseronConnection`.

  Required migration:
  - Browser apps: add `@tesseron/vite` to `devDependencies` and register `tesseron()` in `vite.config.ts`.
  - Node apps: no env vars or URLs to configure; `tesseron.connect()` handles bind-and-announce automatically.

### Patch Changes

- Updated dependencies [[`21ce314`](https://github.com/eigenwise/tesseron/commit/21ce31470232bbdfad3843ed0399ce850302e7a4)]:
  - @tesseron/web@2.0.0
  - @tesseron/core@2.0.0

## 1.1.0

### Minor Changes

- Initial release: `tesseronAction`, `tesseronResource`, `tesseronConnection`.
