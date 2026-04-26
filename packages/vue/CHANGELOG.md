# @tesseron/vue

## 2.1.6

### Patch Changes

- Updated dependencies [[`eff7726`](https://github.com/BrainBlend-AI/tesseron/commit/eff77265fac8cb0877eefe06030f462aa8048568), [`94d50ef`](https://github.com/BrainBlend-AI/tesseron/commit/94d50ef5364ce2a240b5033674d59b0cbe4ca486)]:
  - @tesseron/core@2.3.1
  - @tesseron/web@2.3.1

## 2.1.5

### Patch Changes

- Updated dependencies [[`f0e671f`](https://github.com/BrainBlend-AI/tesseron/commit/f0e671f1c26195cc597ce90cb2ad8f8f59dd7e9f)]:
  - @tesseron/core@2.3.0
  - @tesseron/web@2.3.0

## 2.1.4

### Patch Changes

- Updated dependencies []:
  - @tesseron/core@2.2.2
  - @tesseron/web@2.2.2

## 2.1.3

### Patch Changes

- Updated dependencies [[`db6e0c4`](https://github.com/BrainBlend-AI/tesseron/commit/db6e0c4d1a83583c7012634c17d3579bc95060b7)]:
  - @tesseron/core@2.2.1
  - @tesseron/web@2.2.1

## 2.1.2

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
  - @tesseron/web@2.2.0

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
  - @tesseron/web@2.1.1

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
  - @tesseron/web@2.1.0

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
  - @tesseron/web@2.0.0
  - @tesseron/core@2.0.0

## 1.1.0

### Minor Changes

- Initial release: `tesseronAction`, `tesseronResource`, `tesseronConnection`.
