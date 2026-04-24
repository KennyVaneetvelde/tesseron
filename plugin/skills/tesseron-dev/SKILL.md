---
name: tesseron-dev
description: Set up and maintain Tesseron integration in a JS/TS project. Picks the right consumer package (`@tesseron/react` for React, `@tesseron/server` for Node, `@tesseron/web` for any other browser context), installs it with the project's existing package manager, ensures a Standard-Schema validator is present, and inserts the canonical Tesseron API — `tesseron.app(...)`, at least one action, at least one resource, `tesseron.connect(...)` — at module scope of the entry point. Also handles integration maintenance: switching consumer packages, upgrading `@tesseron/*` versions in lockstep, splitting a multi-surface app into multiple `app.id` values, or removing Tesseron. Strictly scoped to Tesseron concerns — does not create projects, scaffold build tooling, pick framework versions, or template framework-specific integration code (reactive primitives, component patterns, lifecycle hooks). Use when the user says "add tesseron", "integrate tesseron", "wire up @tesseron/web" / "/react" / "/server", "upgrade tesseron", "switch to @tesseron/react", "split this into two tesseron apps", or opens a project without `@tesseron/*` yet and wants to start using it.
---

# Tesseron dev

The go-to skill for getting Tesseron into a project and keeping it cleanly wired as the project evolves. It is the *integration* skill — not the *API tutorial* skill (that is the sibling `framework` skill, which covers how to design actions, resources, handlers, and so on). If the question is "how do I use Tesseron's API?", load `framework`. If the question is "how do I wire Tesseron into this project, switch to a different consumer package, or adjust the integration shape?", you are in the right place.

This skill does not create projects, pick build tooling, or template framework-specific code. Project creation is someone else's job (upstream scaffolders, framework-specific skills, or the user's own hand). Once the project exists, this skill gets Tesseron correctly integrated with it.

## What Tesseron officially supports

Tesseron ships five consumer packages plus one build-tool plugin. Everything else — package managers, TypeScript configs, framework-specific idioms — is outside Tesseron's responsibility.

| Package | Scope |
|---|---|
| `@tesseron/react` | React projects — exports `useTesseronAction`, `useTesseronResource`, `useTesseronConnection`. |
| `@tesseron/svelte` | Svelte 5 projects — exports `tesseronAction`, `tesseronResource`, `tesseronConnection` runes-style helpers with lifecycle-scoped registration. |
| `@tesseron/vue` | Vue 3 projects — Composition API equivalents of the Svelte helpers with the same lifecycle-scoped semantics. |
| `@tesseron/server` | Node processes — headless services, CLIs, backend adapters. |
| `@tesseron/web` | **Any other browser context.** A framework-neutral singleton — the same singleton API serves vanilla JS and any browser framework Tesseron does not officially ship a dedicated adapter for. |
| `@tesseron/vite` | Vite dev-server plugin. **Required for every browser app in v2** — exposes the `/@tesseron/ws` bridge the gateway dials into. Add it to `vite.config.ts` alongside the consumer package. |

`@tesseron/core` (protocol types) and `@tesseron/mcp` (the gateway binary) are not consumer packages; ignore them here.

## Phase 1 — Pick the package

Detect from the project's `package.json` + file layout:

- `svelte` in dependencies → `@tesseron/svelte`.
- `vue` in dependencies → `@tesseron/vue`.
- `react` and `react-dom` in dependencies → `@tesseron/react`.
- Node process without a browser bundle (no `index.html`, no Vite/webpack/etc., `@types/node` present) → `@tesseron/server`.
- Anything else that runs in a browser → `@tesseron/web`.

For browser apps, ALSO install `@tesseron/vite` as a dev dependency and register it in `vite.config.ts` — v2 relies on the plugin to bridge the browser WebSocket to the gateway.

If the signals conflict (e.g. a React app embedded in a Node workspace — which package applies is usually about where the `tesseron.connect()` will run), ask the user which process needs the agent surface. Only one consumer `@tesseron/*` package per process.

If the project is on a non-JS/TS stack (Rails, Django, Go, raw PHP, etc.), stop. Tesseron consumes the SDK from JS/TS only.

## Phase 2 — Ensure a validator is available

Every action needs a Standard-Schema-compatible validator for its `.input(...)`. Check `dependencies` + `devDependencies` for one of (preference order): `zod`, `valibot`, `@sinclair/typebox`. If none is present, install `zod`. Do not install a second validator if the project already has one.

## Phase 3 — Install

Detect the package manager from the lockfile (`pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, `bun.lockb` → bun, `package-lock.json` or none → npm) and use it. Never swap managers.

Install the chosen `@tesseron/*` package (+ the validator if missing, + `@tesseron/vite` as a devDependency for browser apps) pinned as `^2.0.0`. All `@tesseron/*` packages release in lockstep, so this range resolves them compatibly as new minors land. If an older project is still on `^1.0.0`, upgrade it to `^2.0.0` — v2 is a breaking reverse-connection migration and mixing majors will fail at connect time.

## Phase 4 — Insert the canonical Tesseron API

The Tesseron API is framework-neutral. Every integration has the same four calls:

### 1. App manifest — exactly once, at module scope, before any action/resource

```ts
tesseron.app({
  id: '<snake_case>',
  name: '<Human Readable Name>',
  description: '<one-line purpose>',
});
```

`app.id` is snake_case and stable — it's the prefix the MCP gateway applies to every tool name (`<app_id>__<action_name>`). Derive a default from `package.json` `name` normalized to snake_case; ask the user only if that clashes.

### 2. At least one action

```ts
tesseron
  .action('<name>')
  .describe('<what it does, written for the LLM>')
  .input(<validator schema>)
  .handler((input, ctx) => { /* mutate state, return a result */ });
```

Always include `.describe(...)` — it is the LLM's only signal for when to call this action.

### 3. At least one resource

```ts
tesseron
  .resource('<name>')
  .describe('<what it exposes>')
  .output(<validator schema>)
  .read(() => <current value>);
```

A resource exposes state to the agent. The minimal scaffold should include one so the user sees the full shape; they can remove it later if they only need actions.

### 4. Connect

```ts
const welcome = await tesseron.connect();
// welcome.claimCode is the 6-character code the user pastes into Claude.
```

### Where these calls live

The canonical calls are framework-neutral. *Where* they go in the project is the framework's convention, not Tesseron's:

- **React** (`@tesseron/react`): `tesseron.app(...)` at module scope in the main entry file (`src/main.tsx` or equivalent). Actions and resources can be registered either at module scope via `tesseron.action(...)` / `tesseron.resource(...)` or — when they need to close over component state — inside components via `useTesseronAction(...)` / `useTesseronResource(...)`. `useTesseronConnection()` surfaces the connection object (including `claimCode`) to whichever component renders the pairing UI.
- **Server** (`@tesseron/server`): all four calls at module scope of the Node entry file. For Express/Fastify/Koa hybrids, put the Tesseron block in the same file as `app.listen(...)` so they share process state.
- **Browser-non-React** (`@tesseron/web`): all four calls at module scope of the framework's entry file (whichever file the framework bootstraps from). The singleton does not care about framework lifecycle — `tesseron.app(...)` runs at import time; `tesseron.connect()` can be awaited at module scope or scheduled inside a framework-provided startup hook.

**Do not template framework-specific code.** Reactive primitives, component patterns, and lifecycle idioms of any non-React framework belong to the framework — not to Tesseron. If the user is working in such a framework, they already know how to wire a module-scope import; if another skill is active that specializes in that framework, let it handle idiomatic placement.

If you don't know the project's framework well enough to place calls idiomatically, put them at module scope of the main entry file. That is the lowest-common-denominator placement and will work. Tell the user it's a safe default, not an idiomatic one, and invite them to relocate if their framework prefers a different hook.

## Phase 5 — Surface the claim code

`tesseron.connect()` returns a `WelcomeResult` whose `claimCode` is a 6-character string the user pastes into Claude to pair the session. Make it visible:

- **Headless**: `console.log(\`Claim code: ${welcome.claimCode}\`)`.
- **React** (`@tesseron/react`): `useTesseronConnection()` exposes `claimCode` — render it in whichever component owns the pairing UI.
- **Browser-non-React** (`@tesseron/web`): feed the resolved `claimCode` into the framework's own reactivity primitive (state, ref, signal, observable) and render it. Do not template this — it is the framework's UI concern, not Tesseron's.

## Phase 6 — Hand off

1. Start the app with whatever dev command the project already has — do not invent new scripts.
2. When the claim code appears, the user says `claim session <code>` in Claude and the app's actions become typed MCP tools.
3. The `framework` skill is auto-triggered for further Tesseron work (more actions, subscribable resources, `ActionContext` methods, session resume, tests). The `tesseron-reviewer` subagent runs before commit.

## Other integration changes

Beyond first-time setup, this skill also covers:

- **Switching consumer packages.** A project originally using `@tesseron/web` that now wants React's hook ergonomics: uninstall `@tesseron/web`, install `@tesseron/react`, rewrite the module-scope registrations into hook calls where component-scoped state requires it. Only one consumer package per process at the end.
- **Upgrading `@tesseron/*` versions.** All `@tesseron/*` packages ship in lockstep. Upgrade them together. Bump every `@tesseron/*` dep in `package.json` to the same new version, run the project's install, re-run typecheck. A matching `@tesseron/mcp` gateway version lives in the plugin — users who installed the plugin at the same version are already aligned; users on older plugin installs may need to reinstall the plugin after a major bump.
- **Splitting one Tesseron app into two `app.id` values.** When a single process is exposing two logically distinct surfaces to the agent, they should be two separate processes with two `app.id` values. See `framework/references/project-structure.md` for the multi-app section and tool-name collision rules.
- **Removing Tesseron.** Uninstall the `@tesseron/*` package and the validator if it was installed by this skill (check whether the project uses it elsewhere first). Delete the `tesseron.app(...)` / action / resource / `tesseron.connect()` block. Leave bundler config, tsconfig, and framework code untouched.

For each of these, apply the same rules as the install flow: use the project's existing package manager, do not touch framework config, do not template framework-specific code. The `framework` skill's references are the source of truth for what the Tesseron API is — consult them if you need to verify current shapes before editing.

## Constraints

- Never create `package.json`, `tsconfig.json`, or any framework config file.
- Never swap the package manager or touch framework version pins.
- Never register more than one `@tesseron/*` package per process.
- Never template framework-specific integration code. The canonical Tesseron API is framework-neutral; framework-specific idioms are outside this skill's scope.
- Never import from package internals (`@tesseron/core/dist/...` or cross-package relative paths). Only the top-level exports are public API.
- Always include `.describe(...)` on every action and resource.
- Always use a Standard-Schema validator on `.input(...)` — never a plain TypeScript type.
- Use `crypto.randomUUID()` for ids. It's available in all supported runtimes.

## When to stop and ask

- Detection is ambiguous (multiple processes could reasonably host the Tesseron surface).
- The entry point already contains a `tesseron.app(...)` call (inserting a second one throws).
- The project uses a layout where module scope isn't obvious (Electron main+renderer split, Webview host, custom bundler with an unusual entry).
- The project's framework is non-JS/TS (Tesseron does not apply).
