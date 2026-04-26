# @tesseron/mcp

## 2.2.2

### Patch Changes

- [#51](https://github.com/BrainBlend-AI/tesseron/pull/51) [`3dc74b1`](https://github.com/BrainBlend-AI/tesseron/commit/3dc74b174f6f0ed531338e8808bf798a37450777) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Stop swallowing `transport.send` failures inside `WsDialer` and `UdsDialer`. Both dialer transports had a bare `catch {}` around `ws.send` / `socket.write` with the comment "socket likely closed; ignore". That defeated the cascade-on-send-failure fix in 2.2.1: the session-dispatcher wrapper in `gateway.ts` was supposed to close the channel when send threw, but the wrapper never saw a throw because the dialer ate it first. The user-visible symptom was `tesseron__read_resource` (and `tesseron__invoke_action`) hanging indefinitely after a Vite HMR cycle that left the gateway-side socket in a `CLOSING` / `CLOSED` state that silently no-op'd subsequent sends.

  Both dialers now let `ws.send` / `socket.write` throws propagate to the dispatcher wrapper, which closes the channel, fires `transport.onClose`, and `rejectAllPending` rejects every outstanding request with `TransportClosedError`.

- Updated dependencies []:
  - @tesseron/core@2.2.2
  - @tesseron/server@2.2.2

## 2.2.1

### Patch Changes

- [#49](https://github.com/BrainBlend-AI/tesseron/pull/49) [`db6e0c4`](https://github.com/BrainBlend-AI/tesseron/commit/db6e0c4d1a83583c7012634c17d3579bc95060b7) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Fix silent hangs when a transport send fails mid-request. Three places used to swallow `transport.send` failures with no signal: the gateway's session-dispatcher wrapper (bare `catch {}`), the SDK client's session-dispatcher wrapper (no try/catch at all), and the Vite plugin's gateway-to-browser bridge (silently dropped frames when `browserWs.readyState !== OPEN`). When a response failed to send, the peer's pending request would wait forever - the user-visible symptom was `tesseron__read_resource` hanging indefinitely after a Vite HMR cycle that left the browser WebSocket in a non-OPEN state.

  All three paths now close the channel on send failure so the peer's `transport.onClose` handler fires, `rejectAllPending` rejects every outstanding request with `TransportClosedError`, and the bridge / MCP tool surfaces a real error instead of hanging. Also reverts the 30s `DEFAULT_RESOURCE_READ_TIMEOUT_MS` band-aid added in [#47](https://github.com/BrainBlend-AI/tesseron/issues/47) - it would have papered over genuine hangs by silently failing legitimate slow reads, and the cascade-on-send-failure fix is what actually addresses the root cause.

  `JsonRpcDispatcher.receive()` no longer leaves `handleRequest` rejections as unhandled promise rejections - the transport wrappers now handle the recovery, so we attach an empty `.catch` to suppress noise.

- Updated dependencies [[`db6e0c4`](https://github.com/BrainBlend-AI/tesseron/commit/db6e0c4d1a83583c7012634c17d3579bc95060b7)]:
  - @tesseron/core@2.2.1
  - @tesseron/server@2.2.1

## 2.2.0

### Patch Changes

- [#44](https://github.com/BrainBlend-AI/tesseron/pull/44) [`cf604d0`](https://github.com/BrainBlend-AI/tesseron/commit/cf604d0222519f9ed44fab373279e85f60c69062) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Auto-derive JSON Schema from Standard Schema validators that ship a converter.

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

  Closes [#43](https://github.com/BrainBlend-AI/tesseron/issues/43).

- Updated dependencies [[`cf604d0`](https://github.com/BrainBlend-AI/tesseron/commit/cf604d0222519f9ed44fab373279e85f60c69062)]:
  - @tesseron/core@2.2.0
  - @tesseron/server@2.2.0

## 2.1.1

### Patch Changes

- [#41](https://github.com/BrainBlend-AI/tesseron/pull/41) [`fa3bbdc`](https://github.com/BrainBlend-AI/tesseron/commit/fa3bbdc46a327ac800c7c26fc36f763856f18831) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Fix `tesseron__read_resource` (and `__invoke_action`) hanging indefinitely
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

  Closes [#40](https://github.com/BrainBlend-AI/tesseron/issues/40).

- Updated dependencies [[`fa3bbdc`](https://github.com/BrainBlend-AI/tesseron/commit/fa3bbdc46a327ac800c7c26fc36f763856f18831)]:
  - @tesseron/core@2.1.1
  - @tesseron/server@2.1.1

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

- Updated dependencies [[`f49f5bf`](https://github.com/BrainBlend-AI/tesseron/commit/f49f5bfcf11904b1c98a2b17c14ec89acbeb824a)]:
  - @tesseron/core@2.1.0
  - @tesseron/server@2.1.0

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

### Patch Changes

- Updated dependencies [[`21ce314`](https://github.com/BrainBlend-AI/tesseron/commit/21ce31470232bbdfad3843ed0399ce850302e7a4)]:
  - @tesseron/server@2.0.0
  - @tesseron/core@2.0.0

## 1.1.0

### Minor Changes

- [#6](https://github.com/BrainBlend-AI/tesseron/pull/6) [`3e8ee2f`](https://github.com/BrainBlend-AI/tesseron/commit/3e8ee2fd431f37c952fff376a3f5bb5202ff870c) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Surface `TesseronErrorCode` in tool-call error results. The bridge's
  `errorResult` helper now returns an MCP-spec-native `structuredContent`
  object carrying the underlying `TesseronError`'s numeric `code` (and `data`,
  when present), so agents can programmatically branch on `TransportClosed`
  vs `HandlerError` vs `InputValidation` etc. instead of regex-matching the
  text body. The structured shape is exported from `@tesseron/core` as
  `TesseronStructuredError` for typed consumer access.

  Before:

  ```jsonc
  // tools/call response for a failed invocation
  {
    "content": [{ "type": "text", "text": "Invalid input\n[...]" }],
    "isError": true,
  }
  ```

  After:

  ```jsonc
  {
    "content": [{ "type": "text", "text": "Invalid input\n{\n  \"code\": -32004,\n  \"data\": [...]\n}" }],
    "structuredContent": { "code": -32004, "data": [...] },
    "isError": true
  }
  ```

  The text body stays backwards-compatible (it still embeds the same shape
  as `${message}\n${JSON}`), so existing log-scraping / regex assertions
  keep passing. `structuredContent` is an optional field in
  `CallToolResultSchema` from `@modelcontextprotocol/sdk`, so MCP clients
  that ignore it are unaffected.

  Call sites in `mcp-bridge.ts` now pass the full `TesseronError` to
  `errorResult` rather than extracting `error.data` at the caller.

- [#4](https://github.com/BrainBlend-AI/tesseron/pull/4) [`97248fb`](https://github.com/BrainBlend-AI/tesseron/commit/97248fbce9f5b0f1e2d065390ccbd50fa92b6ea7) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Add session resume: SDKs can rejoin a previously-claimed session after a
  transport drop (tab refresh, network blip, HMR) without going through the
  6-character claim-code dance again.

  **Protocol** (`@tesseron/core`)
  - `WelcomeResult.resumeToken` now carries an opaque, cryptographically-random
    token the caller can stash to rejoin this session later.
  - New `tesseron/resume` method with `{ sessionId, resumeToken }` params plus
    the same manifest fields as `tesseron/hello` (a fresh app build may have
    added, removed, or changed actions/resources since last connect).
  - New `TesseronErrorCode.ResumeFailed` (`-32011`) covers unknown session,
    expired zombie, unclaimed zombie, and bad-token failures.

  **Gateway** (`@tesseron/mcp`)
  - New `GatewayOptions.resumeTtlMs` (default 90 s). Closed sessions are
    retained as zombies for this window and can be resumed via
    `tesseron/resume`. Set to `0` to disable resume entirely.
  - Constant-time token compare via `crypto.timingSafeEqual` with a length
    pre-check.
  - Tokens are one-shot: every successful resume rotates the token.

  **SDK** (`@tesseron/core`, `@tesseron/server`, `@tesseron/web`)
  - `TesseronClient.connect(transport, options?)` and the URL-string overloads
    on `ServerTesseronClient` / `WebTesseronClient` accept a new optional
    `{ resume: { sessionId, resumeToken } }` argument. When present, the SDK
    sends `tesseron/resume` instead of `tesseron/hello`.
  - `ConnectOptions` and `ResumeCredentials` exported from `@tesseron/core`.

  **Storage policy**

  Storage of the `{ sessionId, resumeToken }` pair is the implementer's
  responsibility. The SDK exposes the primitive; apps decide where the token
  lives (localStorage, cookie, Electron store, OS keychain, etc). A four-line
  recipe for the browser sits in `docs/protocol/resume`; it is intentionally
  not a shipped feature of `@tesseron/web`.

  Backwards-compatible: older gateways that never populated `resumeToken`
  continue to work, and SDKs that don't pass `{ resume }` send `tesseron/hello`
  exactly as before.

### Patch Changes

- Updated dependencies [[`3e8ee2f`](https://github.com/BrainBlend-AI/tesseron/commit/3e8ee2fd431f37c952fff376a3f5bb5202ff870c), [`97248fb`](https://github.com/BrainBlend-AI/tesseron/commit/97248fbce9f5b0f1e2d065390ccbd50fa92b6ea7)]:
  - @tesseron/core@1.1.0
  - @tesseron/server@1.1.0

## 1.0.2

### Patch Changes

- [#3](https://github.com/BrainBlend-AI/tesseron/pull/3) [`2445125`](https://github.com/BrainBlend-AI/tesseron/commit/2445125df8e7673227bbcdf922a0b7d8b276b7f0) Thanks [@KennyVaneetvelde](https://github.com/KennyVaneetvelde)! - Fix hang on session WebSocket disconnect: the gateway now rejects all pending
  dispatcher requests (`actions/invoke`, `resources/read`, `resources/subscribe`,
  `resources/unsubscribe`) with a `TransportClosedError` when a session's socket
  closes, mirroring the SDK-side behaviour. Previously, in-flight requests
  abandoned by a disappearing SDK would hang until the MCP client's own timeout
  kicked in.
- Updated dependencies []:
  - @tesseron/core@1.0.2
  - @tesseron/server@1.0.2

## 1.0.1

### Patch Changes

- Expanded each package's README to be a proper npm landing page. Each
  now shows the Tesseron logo, a package-specific tagline, install
  command, quick-start code example, what-you-get bullet list, pairing
  guidance, doc links (main repo + SDK reference + protocol spec +
  examples), license summary, and BrainBlend AI attribution. The previous
  two-line descriptions left visitors landing on npm without enough
  context to know what they were looking at or how to use it.

  No code changes, no API changes — this is purely a docs release so the
  npm package pages match the quality of the GitHub README.

- Updated dependencies []:
  - @tesseron/core@1.0.1
  - @tesseron/server@1.0.1

## 1.0.0

### Major Changes

- Initial public release of Tesseron (v1.0.0) under Business Source License 1.1.

  Protocol version bumped to `1.0.0` to align with the SDK release. Packages
  are published with stable API surfaces — future 1.x releases follow
  semantic versioning.

  Highlights:
  - Typed action builder with Zod / Standard Schema input validation.
  - Subscribable resources with tag support.
  - Handler context: `ctx.confirm`, `ctx.elicit` (schema-validated),
    `ctx.sample`, `ctx.progress`, structured errors
    (`SamplingNotAvailableError`, `ElicitationNotAvailableError`).
  - MCP gateway bridges JSON-RPC/WS to MCP/stdio. Three tool-surface
    modes (`dynamic`, `meta`, `both`) for client compatibility.
  - `tesseron__read_resource` meta-tool for MCP clients without native
    resource support.
  - 65 tests across `@tesseron/core` and `@tesseron/mcp`.
  - Reference implementation: BUSL-1.1 (auto-converts to Apache-2.0
    four years post-release). Protocol specification: CC BY 4.0.

### Patch Changes

- Updated dependencies []:
  - @tesseron/core@1.0.0
  - @tesseron/server@1.0.0
