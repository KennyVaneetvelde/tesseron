# @tesseron/vite

## 2.3.2

### Patch Changes

- Updated dependencies []:
  - @tesseron/core@2.6.0

## 2.3.1

### Patch Changes

- [`4f59055`](https://github.com/BrainBlend-AI/tesseron/commit/4f5905509120783a03413f1d7ea2cb63699a02d7) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Fix `tesseron/resume` hang on the `@tesseron/vite` host-mint path (closes [#68](https://github.com/BrainBlend-AI/tesseron/issues/68)). On a fresh page load with stored resume credentials, the SDK sent `tesseron/resume` to the plugin but no handler existed for that method on the host-mint path — the frame just sat in `entry.queue` waiting for a gateway dial that never arrives for an unclaimed instance, and `useTesseronConnection` hung at `status: 'connecting'` forever.

  **`@tesseron/vite`.** The host-mint message handler now answers `tesseron/resume` directly with `ResumeFailed` (-32011). Each fresh WS opens a brand-new `PendingInstance` with a brand-new `sessionId` / `resumeToken`, so any incoming resume's tokens are by definition stale. The rejection lets the SDK clear its stored creds and fall back to a fresh `tesseron/hello` on the same socket. The branch is gated on `!entry.helloAnswered` so a (theoretical) mid-session resume post-hello still forwards to the gateway, which has its own `InvalidRequest` handling for that case.

  **`@tesseron/web`.** `BrowserWebSocketTransport.ready()` now rejects on `close` in addition to `error`. Without this, closing a CONNECTING socket (which can happen when React 18 StrictMode unmounts mid-handshake) left the `opened` promise unresolved and the hook hung. A no-op `.catch(() => {})` is attached to suppress unhandled-rejection warnings on the orphan reference — vitest with `unhandledRejection: 'strict'` would otherwise crash the test process. The class also now exposes a public `readonly url` field for diagnostics.

  **`@tesseron/react`.** `useTesseronConnection` now constructs and owns its `BrowserWebSocketTransport` instead of letting `client.connect(url)` create one internally, and unconditionally closes it on cleanup. This eliminates the StrictMode double-mount race over the singleton client's `this.transport`: each mount has its own transport ref; cleanup closes whichever connect is in flight; the first mount's `connectOnce` throws a `CancelledError` (private sentinel) when it sees `cancelled = true` after `await ready()`, and `run().catch` short-circuits without flipping state to `'error'`.

  **Tests.** `packages/vite/test/resume-rejection.test.ts` boots the plugin against a real HTTP server and verifies (a) `tesseron/resume` returns `ResumeFailed` and (b) a follow-up `tesseron/hello` on the same socket still synthesizes a welcome. `packages/react/test/use-tesseron-connection.test.tsx` adds direct coverage for `BrowserWebSocketTransport.ready()` rejecting on close, the `.catch(() => {})` not crashing under strict unhandled-rejection settings, an unmount-during-handshake regression test, and a real `<StrictMode>` double-mount test that asserts `client.connect` is called exactly once and the surviving mount drives final state.

  **End-to-end validation.** Verified against the `examples/react-todo` Vite dev server in a real browser: page refresh with stored resume creds reaches `Status: open` with a fresh claim code in <1s (was hanging forever). Multiple consecutive refreshes each yield a fresh claim. Claimed the new session via `tesseron__claim_session`, invoked `todos__addTodo` via MCP, and read `todoStats` — bidirectional flow works. Refresh-while-claimed cleanly invalidates the previous session and shows a fresh claim code; the agent's stale tools drop from the MCP tool list.

- Updated dependencies []:
  - @tesseron/core@2.5.1

## 2.3.0

### Minor Changes

- [#66](https://github.com/BrainBlend-AI/tesseron/pull/66) [`f93b7f6`](https://github.com/BrainBlend-AI/tesseron/commit/f93b7f6a3f607a9d6a36f309b64379ce4fb82d0c) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Complete the tesseron#60 claim-mediated transport binding by extending the host-mint flow to every host shape and tightening the security model:

  **`@tesseron/server` host-mint mirror.** `NodeWebSocketServerTransport` and `UnixSocketServerTransport` now mint `claimCode` / `sessionId` / `resumeToken` at construction, write them into the manifest's `hostMintedClaim`, and intercept the SDK's `tesseron/hello` to synthesize the welcome locally so the SDK can show the host-minted code as soon as `connect()` resolves — no waiting for a gateway dial.

  **UDS bind handshake.** UDS doesn't have WebSocket subprotocols, so the equivalent of `tesseron-bind.<code>` is the new `tesseron/bind` JSON-RPC request. A v1.2 gateway sends it as the very first NDJSON frame after connect; the host validates the code in constant time and either accepts (bind succeeds, hello replay flows) or returns `Unauthorized` and closes. Same two-gate model as WS: file-mode-based UID enforcement on the socket inode + bind validation.

  **Sliding TTL with heartbeat.** Every host-minted claim now carries `expiresAt = mintedAt + 10 minutes`. The host rewrites the manifest every 5 minutes while the SDK is alive and the claim is unbound; the gateway skips manifests whose `expiresAt < now` during scan. A tab forgotten overnight expires its code before someone else can paste it; a live tab's code stays valid forever.

  **Bind failure rate-limit.** Hosts track bind-mismatch failures in a 60-second rolling window. After 5 mismatches, the entry is locked out for 60 seconds — every bind upgrade gets HTTP 429 (WS) or `Unauthorized` (UDS) — long enough to make sustained brute force expensive without breaking a legitimate retry loop. Counters reset on a successful bind.

  **Legacy auto-dial rejected.** Host transports now require a v1.2-aware gateway. Legacy auto-dials (no bind subprotocol on WS, no `tesseron/bind` on UDS) are rejected with HTTP 426 Upgrade Required and a clear message: upgrade `@tesseron/mcp` to >= 2.4.0. The plugin bundle ships in `plugin/server/index.cjs`, so a Claude Code plugin update brings the user along automatically.

  **Workspace package layout.** `@tesseron/{core,web,server,react,vite,svelte,vue,mcp}` packages now point `main` / `module` at `dist/` (built output) instead of `src/index.ts` directly. Without this change, Node ESM's `.js` ↔ `.ts` resolution fails when a Vite plugin loads the workspace package as a transitive dep — fixes the Vite dev-server demo's previously-broken plugin-load. The `types` field still points at `src/index.ts` so editor go-to-definition keeps working.

  **Validation parity.** `validateAppId` moved to `@tesseron/core/internal` so the host transports re-apply the same rejection logic the gateway has on its hello handler. The SDK's `connect()` now rejects with `"Invalid app id"` / `"... is reserved"` at hello synthesis time rather than after a successful welcome that the gateway would have refused.

  **`tesseron/claimed.agentCapabilities`.** The notification carries the gateway's authoritative sampling/elicitation bits so the SDK can overwrite the host's conservative pre-claim defaults. Action handlers gating on `ctx.agentCapabilities.sampling` see real values rather than the synthesized `false`s.

  **Tests:** new `packages/mcp/test/server-host-mint.test.ts` exercises the full ServerTesseronClient ↔ gateway round-trip with a real bind. Existing tests updated to use `dialSdk`'s v3 path. Three legacy-only breadcrumb tests skipped pending a hand-rolled legacy SDK fixture; the breadcrumb code stays in the gateway for v1.1 SDK back-compat.

  **End-to-end validation:** ran the `examples/vanilla-todo` demo in a real browser, scraped the host-minted claim code, drove an MCP gateway (in-process) to `tesseron__claim_session(code)`. The gateway dialed with the bind subprotocol, the v3 hello replay flowed, the session was registered as claimed with the host-minted ids, the MCP tool list refreshed to show all 9 vanilla_todo actions, and an MCP-invoked `addTodo` round-tripped back to the browser DOM. All 6 demo apps (vanilla-todo, react-todo, svelte-todo, vue-todo, node-prompts, express-prompts) typecheck and build clean.

### Patch Changes

- Updated dependencies [[`f93b7f6`](https://github.com/BrainBlend-AI/tesseron/commit/f93b7f6a3f607a9d6a36f309b64379ce4fb82d0c)]:
  - @tesseron/core@2.5.0

## 2.2.0

### Minor Changes

- [#64](https://github.com/BrainBlend-AI/tesseron/pull/64) [`abe0cac`](https://github.com/BrainBlend-AI/tesseron/commit/abe0cacad930f748d9bd69a0025be38c6d4d852b) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Claim-mediated transport binding (tesseron#60). The MCP gateway no longer races other gateways to dial a freshly-opened browser tab and mint the user-pasteable claim code in whichever it wins. Instead the SDK host (Vite plugin / `@tesseron/server`) mints the code itself and writes it into the instance manifest; the gateway only dials when the user's `tesseron__claim_session(code)` call matches a host-minted manifest, and authenticates the dial via a `tesseron-bind.<code>` WebSocket subprotocol element.

  **Why.** With one Claude Code session per gateway process, several gateways often watch `~/.tesseron/instances/` simultaneously. The first to dial a new manifest won the bridge, but on multi-session boxes the OS scheduler picked which gateway saw the welcome — and the user-typed code was usable only in that one Claude window. The single-owner-binding fix from [#54](https://github.com/BrainBlend-AI/tesseron/issues/54) made the race deterministic; this PR makes it irrelevant. The user pastes the code into whichever Claude session they're working in; that gateway scans manifests for a match and dials only the right one. No race, no "switch to the Claude that minted this" detour.

  **Wire shape.**
  - `InstanceManifest` (still `version: 2`) gains two optional fields: `helloHandledByHost: true` and `hostMintedClaim: { code, sessionId, mintedAt, boundAgent }`. v1.1 gateways ignore the new fields and still auto-dial — no regression for old gateways paired with new hosts.
  - New WebSocket subprotocol element `tesseron-bind.<code>` carries the host-minted claim code on the gateway's outbound dial, alongside the existing `tesseron-gateway` element. Subprotocol headers don't appear in URL logs, browser history, or crash dumps the way `?claim=CODE` query strings would.
  - Constant-time compare (PR [#62](https://github.com/BrainBlend-AI/tesseron/issues/62)'s `constantTimeEqual`) gates the bind validation in the host's upgrade handler.
  - The gateway's welcome to a v3-mode dial omits `claimCode` — the host's synthesized welcome already showed it; repeating would race the SDK's UI.

  **`gateway.claimSession()` is now async.** Returns `Promise<Session | null>` rather than `Session | null`. The legacy `pendingClaims` lookup happens first (synchronous in practice), then the host-minted scan dials and waits for the session to register. The `@tesseron/mcp` bridge is the only public caller; embedders calling the method directly need to add `await`.

  **Migration matrix.**
  - old plugin / old gateway → unchanged
  - new plugin / old gateway → old gateway ignores host-mint fields, auto-dials, mints its own code, host's hello goes through unmodified
  - old plugin / new gateway → no host-mint fields in manifest, gateway auto-dials as legacy
  - new plugin / new gateway → host mints, gateway scans on claim, dials with bind subprotocol, session is born claimed

  **Out of scope (follow-up issues).**
  - TTL refresh on heartbeat (the host's mint lives until manifest unlink today; a stale code can be claimed if the browser tab outlives the user's intent).
  - Rate-limit on bind failures (the constant-time grammar guard plus the 6-char alphabet make brute force expensive but unbounded).
  - `@tesseron/server` host-mint mirror — server transports still use the legacy auto-dial path. Tracked separately.
  - UDS bind subprotocol equivalent. Tracked separately.

  New `@tesseron/core` exports under `/internal`: `formatBindSubprotocol`, `parseBindSubprotocol`, `BIND_SUBPROTOCOL_PREFIX`. `InstanceManifest` and `HostMintedClaim` types extended.

### Patch Changes

- Updated dependencies [[`abe0cac`](https://github.com/BrainBlend-AI/tesseron/commit/abe0cacad930f748d9bd69a0025be38c6d4d852b)]:
  - @tesseron/core@2.4.0

## 2.1.3

### Patch Changes

- [#58](https://github.com/BrainBlend-AI/tesseron/pull/58) [`eff7726`](https://github.com/BrainBlend-AI/tesseron/commit/eff77265fac8cb0877eefe06030f462aa8048568) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Cross-gateway claim-code disambiguation + stale-manifest tombstoning. Two layers, both addressing concerns left open in tesseron#53 after the single-owner binding fix landed in [#54](https://github.com/BrainBlend-AI/tesseron/issues/54):

  **Stale instance manifests are now skipped and tombstoned.** The SDK side (`@tesseron/server`'s WS and UDS transports, `@tesseron/vite`) now stamps `pid: process.pid` on every `~/.tesseron/instances/<id>.json` it writes. The MCP gateway probes `process.kill(pid, 0)` on each manifest before dialing. Manifests whose owning process is gone get unlinked instead of dialed, so a long-running gateway no longer pays a connection-refused round-trip every poll tick for browser tabs whose Vite server died without a clean shutdown. Older SDKs without `pid` are still trusted (no regression for in-flight upgrades). The `InstanceManifest` type in `@tesseron/core` gains an optional `pid?: number` field.

  **Claim codes now carry a cross-gateway ownership breadcrumb.** When the gateway mints a claim code, it writes `~/.tesseron/claims/<CODE>.json` with `{ sessionId, appId, appName, gatewayPid, mintedAt }`. The breadcrumb is removed atomically when the owning gateway claims the session, when an unclaimed session closes, and when the gateway shuts down. When `tesseron__claim_session` is called on a gateway that doesn't own the code locally, it now reads the breadcrumb and surfaces a useful error: `"Claim code XYZ-12 belongs to a different Tesseron gateway (pid 12345, app \"My App\", minted 2026-04-26T15:16:09Z). Switch to the Claude session that opened this connection..."` instead of the previous opaque "No pending session found". If the breadcrumb's gatewayPid is dead, the error reports a stale claim and tombstones the file. This solves the "guess which Claude window owns this code" problem on multi-session developer machines without introducing a cross-process rendezvous protocol.

  `TesseronGateway` exposes a new `describeForeignClaim(code)` method returning `{ kind: 'foreign' | 'stale' | 'unknown', ... }` for embedders that build their own claim UIs, and a new `isPidAlive(pid)` helper export.

- [#62](https://github.com/BrainBlend-AI/tesseron/pull/62) [`94d50ef`](https://github.com/BrainBlend-AI/tesseron/commit/94d50ef5364ce2a240b5033674d59b0cbe4ca486) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Harden every `~/.tesseron/*` write and switch all token generation to the platform CSPRNG. Foundations for tesseron#60 (claim-mediated transport binding); shipped on its own so the security improvements land without waiting for the larger architectural change.

  **Filesystem hygiene.** Instance manifests (`~/.tesseron/instances/<id>.json`) and claim breadcrumbs (`~/.tesseron/claims/<CODE>.json`) are now written via a shared private-file helper that:
  - creates the parent directory with mode `0o700` (and tightens an existing world-readable directory left over from a pre-hardening release);
  - creates the file with mode `0o600` (owner-only read/write);
  - writes atomically via a sibling temp file plus `rename`, so a concurrent reader never observes a partial write.

  A sibling local process running as the same user can no longer enumerate or read the contents of `~/.tesseron/instances/` or `~/.tesseron/claims/` simply by walking the directory. (POSIX modes are advisory on Windows; the parent-dir-as-access-gate model documented for the UDS transport applies there too.)

  **CSPRNG-sourced tokens.** Claim codes (`generateClaimCode`), session IDs (`generateSessionId`), and invocation IDs (`generateInvocationId`) now draw from `crypto.getRandomValues()` with rejection sampling instead of `Math.random()`. The claim code in particular is the user-typed gate between an unclaimed session and the MCP agent — a predictable PRNG meaningfully shrank the ~1.5-billion-combination space against an attacker measuring outputs. The wire format is unchanged (still `XXXX-XX` from a 31-char alphabet); only the entropy source differs.

  **Constant-time compare.** A pure-JavaScript `constantTimeEqual` lands in `@tesseron/core/internal` and replaces the existing `node:crypto` `timingSafeEqual` used to validate `tesseron/resume` tokens. Same security property, but the helper is now reusable from browser-side code paths in upcoming PRs without pulling `node:crypto` into the web bundle.

  No wire-protocol or public-API changes; the new symbols ship under `@tesseron/core/internal` (explicitly not part of the public contract). Existing tests cover unchanged; a new `fs-hygiene.test.ts` exercises mode bits and atomic-write semantics on POSIX, and a new `timing-safe.test.ts` includes a coarse statistical check that catches a regression to a short-circuiting comparison.

## 2.1.2

### Patch Changes

- [#54](https://github.com/BrainBlend-AI/tesseron/pull/54) [`d58dffd`](https://github.com/BrainBlend-AI/tesseron/commit/d58dffdb1c7471a449267f8462470a7f04473f62) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - The Vite plugin's gateway-to-instance bridge now rejects a second gateway upgrade with `HTTP 409 Conflict` instead of silently overwriting `entry.gatewayWs`. When more than one Tesseron MCP gateway process was alive on the same machine (e.g. multiple Claude Code sessions), all of them poll `~/.tesseron/instances/` and race to upgrade the bridge for each instance. The previous last-writer-wins behaviour split the welcome+claim code from the live message routing across two processes, so the user-visible claim code became silently unclaimable. First-gateway-wins is now deterministic per process; race-losers see a 409 and their poll loop moves on. See tesseron#53 for the full diagnosis.

  Also adds a `[tesseron-vite]` stderr log when a second-gateway upgrade is rejected, so the multi-gateway scenario is visible during dev.

## 2.1.1

### Patch Changes

- [#49](https://github.com/BrainBlend-AI/tesseron/pull/49) [`db6e0c4`](https://github.com/BrainBlend-AI/tesseron/commit/db6e0c4d1a83583c7012634c17d3579bc95060b7) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Fix silent hangs when a transport send fails mid-request. Three places used to swallow `transport.send` failures with no signal: the gateway's session-dispatcher wrapper (bare `catch {}`), the SDK client's session-dispatcher wrapper (no try/catch at all), and the Vite plugin's gateway-to-browser bridge (silently dropped frames when `browserWs.readyState !== OPEN`). When a response failed to send, the peer's pending request would wait forever - the user-visible symptom was `tesseron__read_resource` hanging indefinitely after a Vite HMR cycle that left the browser WebSocket in a non-OPEN state.

  All three paths now close the channel on send failure so the peer's `transport.onClose` handler fires, `rejectAllPending` rejects every outstanding request with `TransportClosedError`, and the bridge / MCP tool surfaces a real error instead of hanging. Also reverts the 30s `DEFAULT_RESOURCE_READ_TIMEOUT_MS` band-aid added in [#47](https://github.com/BrainBlend-AI/tesseron/issues/47) - it would have papered over genuine hangs by silently failing legitimate slow reads, and the cascade-on-send-failure fix is what actually addresses the root cause.

  `JsonRpcDispatcher.receive()` no longer leaves `handleRequest` rejections as unhandled promise rejections - the transport wrappers now handle the recovery, so we attach an empty `.catch` to suppress noise.

## 2.1.0

### Minor Changes

- [#37](https://github.com/BrainBlend-AI/tesseron/pull/37) [`f49f5bf`](https://github.com/BrainBlend-AI/tesseron/commit/f49f5bfcf11904b1c98a2b17c14ec89acbeb824a) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Multi-binding transport layer (PROTOCOL_VERSION → 1.1.0). Decouples the
  protocol from WebSocket so apps that can host other duplex channels — Unix
  domain sockets, future named pipes / stdio — speak Tesseron without bridging
  through a WS server.

  Closes [#28](https://github.com/BrainBlend-AI/tesseron/issues/28), [#29](https://github.com/BrainBlend-AI/tesseron/issues/29), [#30](https://github.com/BrainBlend-AI/tesseron/issues/30), [#31](https://github.com/BrainBlend-AI/tesseron/issues/31), [#32](https://github.com/BrainBlend-AI/tesseron/issues/32), [#33](https://github.com/BrainBlend-AI/tesseron/issues/33), [#34](https://github.com/BrainBlend-AI/tesseron/issues/34).

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

- [#35](https://github.com/BrainBlend-AI/tesseron/pull/35) [`7223ecc`](https://github.com/BrainBlend-AI/tesseron/commit/7223ecc2fa14ee92679847a9fd7649e6de444c3e) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Fix `@tesseron/vite` forwarding text frames as binary frames so the browser
  SDK silently dropped every gateway message and the connection hung at
  `status: 'connecting'`.

  The `ws` library hands handlers a `Buffer` for both text and binary frames
  and `Buffer` arguments to `send()` are forwarded as binary, which the
  browser receives as a `Blob`. `BrowserWebSocketTransport` in `@tesseron/web`
  only handles `string` frames, so the `tesseron/welcome`, action results,
  progress, and every other gateway message were discarded.

  The bridge now reads the `isBinary` flag both directions, decodes text
  frames back to UTF-8 strings before re-emitting them, and queues frames in
  their original form so re-`send()` after the gateway connects produces the
  correct frame type.

  Fixes [#27](https://github.com/BrainBlend-AI/tesseron/issues/27).

## 2.0.0

### Major Changes

- [#21](https://github.com/BrainBlend-AI/tesseron/pull/21) [`21ce314`](https://github.com/BrainBlend-AI/tesseron/commit/21ce31470232bbdfad3843ed0399ce850302e7a4) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Reversed connection architecture. The gateway is now a pure WebSocket client; apps host their own endpoints and announce themselves via `~/.tesseron/tabs/<tabId>.json`. One discovery mechanism for every runtime, no fixed ports.

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
