# @tesseron/mcp

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
