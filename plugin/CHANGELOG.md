# Changelog

All notable changes to the Tesseron Claude Code plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-04-24

Bumps the bundled gateway (`server/index.cjs`) to `@tesseron/mcp@2.0.0` — the reverse-connection architecture. The gateway is now a pure WebSocket client; apps host their own loopback endpoints and announce themselves via `~/.tesseron/tabs/<tabId>.json`. One discovery mechanism for every runtime, no fixed ports.

### Breaking

- **Gateway no longer binds a port.** `TESSERON_PORT`, `TESSERON_HOST`, and `TESSERON_ORIGIN_ALLOWLIST` env vars are removed (silently ignored if set). The `.mcp.json` that ships with the plugin no longer declares them.
- **`NodeWebSocketTransport` replaced with `NodeWebSocketServerTransport`** on the Node SDK side. `tesseron.connect()` no longer accepts a gateway URL string.
- **Browser apps require `@tesseron/vite`** (new package) to expose `/@tesseron/ws` on the dev server. Without it, `tesseron.connect()` has nothing to dial.

### Added

- **New adapter packages**: `@tesseron/svelte` (Svelte 5 runes), `@tesseron/vue` (Composition API), `@tesseron/vite` (dev-server bridge). The `tesseron-dev` skill now routes to them when appropriate.

### Changed

- `plugin/skills/framework/references/gateway.md` rewritten for the reverse-connection model: describes tab-file discovery, drops the env-vars section down to just `TESSERON_TOOL_SURFACE`, removes the `0.0.0.0` / origin-allowlist guidance that no longer applies.
- `plugin/README.md` updated: gateway is now "dials apps via `~/.tesseron/tabs/`", compatibility section notes `/svelte`, `/vue`, `/vite` as part of the lockstep release.
- `plugin/agents/tesseron-explorer.md` and `plugin/agents/tesseron-reviewer.md` updated to look for `NodeWebSocketServerTransport` + `@tesseron/vite` wiring and to flag stale `TESSERON_PORT` / `ws://localhost:7475` references as v2 regressions.

## [1.0.2] - 2026-04-23

This release brings the plugin into version lockstep with the Tesseron SDK packages (`@tesseron/core`, `@tesseron/web`, `@tesseron/server`, `@tesseron/react`, `@tesseron/mcp`). Going forward, the plugin version matches the SDK version so users have one number to remember across all Tesseron surfaces. This is honest about what ships inside: the bundled gateway (`plugin/server/index.cjs`) is built from `@tesseron/mcp`, so sharing the version number reflects what users actually run.

Because the plugin had only been released at 0.1.0 before, the bump is 0.1.0 → 1.0.2 (skipping the unreleased in-progress 0.2.0 version that lived only on a feature branch).

This release also expands the plugin from a gateway-only install to a full developer toolkit mirroring the atomic-agents hybrid pattern: reference skills for knowledge that should inform the main thread, specialist subagents for discrete read-heavy tasks whose output is a summary.

### Added

- **`framework` skill** (`skills/framework/SKILL.md`) — auto-triggered when Claude sees imports from `@tesseron/core`, `@tesseron/web`, `@tesseron/server`, `@tesseron/react`, or `@tesseron/mcp`. Orients Claude on core abstractions, canonical imports, and minimum-viable-app shape, then routes to eleven focused reference files via progressive disclosure.

- **Eleven `framework/references/` files**:
  - `actions.md` — `ActionBuilder` chain, `ActionDefinition` shape, annotations, timeouts, `.strictOutput()`.
  - `resources.md` — `ResourceBuilder` chain, read vs subscribe, emit/cleanup contract, combining both.
  - `context.md` — `ActionContext` shape, `signal` forwarding, `agentCapabilities` checks, `progress` / `log` / `sample` / `confirm` / `elicit`.
  - `transports.md` — `Transport` interface, `BrowserWebSocketTransport` / `NodeWebSocketTransport`, custom transports (postMessage, stdio), in-memory transport for tests.
  - `react.md` — `useTesseronConnection` / `useTesseronAction` / `useTesseronResource`, the ref pattern for stable handler registration, where to mount each hook.
  - `protocol.md` — JSON-RPC 2.0 wire format, `tesseron/hello`, `tesseron/resume`, `actions/*`, `resources/*`, `sampling/request`, `elicitation/request`, `actions/list_changed`, error envelopes.
  - `schemas.md` — Standard Schema spec, Zod / Valibot / Typebox integration, the optional `jsonSchema` argument, `.strictOutput()`.
  - `errors.md` — `TesseronErrorCode` table, subclass hierarchy, `instanceof` patterns, never-swallow rules.
  - `gateway.md` — `@tesseron/mcp` env vars (`TESSERON_PORT`, `TESSERON_HOST`, `TESSERON_ORIGIN_ALLOWLIST`, `TESSERON_TOOL_SURFACE`), tool naming (`<app_id>__<action>`), tool surface modes, meta tools, multi-app sessions.
  - `testing.md` — Vitest patterns, mocking `ActionContext`, capturing-registry pattern, in-memory transport round-trips, session-resume tests.
  - `project-structure.md` — **Tesseron-specific** structural rules only: the three consumer packages (`@tesseron/react` for React, `@tesseron/server` for Node, `@tesseron/web` for any other browser context), where `tesseron.app(...)` goes, `app.id` rules, `@tesseron/*` version lockstep, multi-app tool-name collisions, and the monorepo layout for shared schemas. Explicitly scoped away from project scaffolding (`package.json`, `tsconfig.json`, bundler config, framework version pins, framework-specific idioms) — none of that is Tesseron's responsibility.

- **`tesseron-dev` skill** (`skills/tesseron-dev/SKILL.md`) — auto-triggered when the user asks to add Tesseron to a project (existing, or one just scaffolded by another tool). Strictly Tesseron-scoped: picks one of the three consumer packages (`@tesseron/react` for React, `@tesseron/server` for Node, `@tesseron/web` for any other browser context), installs it with the project's existing package manager (pnpm / npm / yarn / bun), ensures a Standard-Schema validator is present (defaults to `zod` if none), and inserts the canonical Tesseron API — `tesseron.app(...)` + at least one action + at least one resource + `tesseron.connect(...)` — at module scope of the entry point. Does not create projects, scaffold build tooling, pick framework versions, or template framework-specific idioms. Creating projects is outside Tesseron's scope.

- **`tesseron-explorer` subagent** (`agents/tesseron-explorer.md`) — isolated-context read-only subagent that maps an existing Tesseron codebase: apps, actions, resources, context-method usage, transports, React hooks, session lifecycle. Returns a compact architecture summary with `file:line` references.

- **`tesseron-reviewer` subagent** (`agents/tesseron-reviewer.md`) — isolated-context read-only subagent that reviews Tesseron code for framework- and protocol-specific correctness. Eleven-category checklist (app manifest, actions, resources, `ActionContext`, React hooks, session resume, transports, gateway, errors, security, testing) with confidence-based filtering (≥75% default, ≥50% for security). Emits ready-to-apply fixes with `file:line` citations.

### Changed

- Plugin version scheme changed from independent pre-1.0 to SDK lockstep. The plugin is now `1.0.2`, matching `@tesseron/core`, `/web`, `/server`, `/react`, `/mcp`.
- `marketplace.json` and `plugin.json`: version `0.1.0` → `1.0.2`; descriptions expanded to cover the new surface alongside the gateway.
- `README.md` rewritten to lead with "what you get" (gateway + `framework` skill + `tesseron-dev` skill + explorer/reviewer subagents), with separate sections for gateway usage and skill-driven workflows.

### Unchanged

- `plugin/.mcp.json`, `plugin/server/index.cjs`, `plugin/LICENSE` are untouched. The gateway install path is identical to 0.1.0; existing users upgrading via the marketplace keep the same gateway behavior.

## [0.1.0] - 2026-04-21

Initial release. Drops the Tesseron MCP gateway into Claude Code as a single-command install.

### Added

- `@tesseron/mcp` gateway bundled as `server/index.cjs`, launched via `.mcp.json` on Claude Code startup.
- `tesseron__claim_session({code})` meta-tool for the click-to-connect pairing handshake.
- Dynamic and meta tool-surface modes; multi-app tool-name prefixing (`<app_id>__<action>`).
- Origin allowlist with localhost default and `TESSERON_ORIGIN_ALLOWLIST` override.
- `TESSERON_PORT` / `TESSERON_HOST` env-var configuration.
