# @tesseron/react

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

### Patch Changes

- Updated dependencies [[`3e8ee2f`](https://github.com/BrainBlend-AI/tesseron/commit/3e8ee2fd431f37c952fff376a3f5bb5202ff870c), [`97248fb`](https://github.com/BrainBlend-AI/tesseron/commit/97248fbce9f5b0f1e2d065390ccbd50fa92b6ea7)]:
  - @tesseron/core@1.1.0
  - @tesseron/web@1.1.0

## 1.0.2

### Patch Changes

- Updated dependencies []:
  - @tesseron/core@1.0.2
  - @tesseron/web@1.0.2

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
  - @tesseron/web@1.0.1

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
  - @tesseron/web@1.0.0
