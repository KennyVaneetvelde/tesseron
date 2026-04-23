---
name: new-app
description: Scaffold a new Tesseron project from scratch — create the directory, `package.json`, `tsconfig.json`, vite config (if browser), entry point, and a first working action + resource. Use when the user asks to start a new Tesseron project from scratch, says "scaffold" / "new project" / "start from zero", or runs `/tesseron:new-app`.
disable-model-invocation: true
argument-hint: [project-name]
---

# New Tesseron Project

Scaffold a fresh Tesseron project. The result is a single-package TypeScript project with one working action, one resource, a Standard-Schema-validated input, and a runnable entry point that connects to the gateway and surfaces its claim code.

This skill is opinionated. Produce a complete, tested skeleton the user can run immediately.

## Phase 1 — Interrogate

Ask these questions in one message, not one-at-a-time. Skip any the user already answered (including via `$ARGUMENTS`).

1. **Project name** — used as both directory name and the `app.id`. Default from `$ARGUMENTS` if provided. Normalize to `kebab-case` for the directory, `snake_case` for the `app.id`, and a human-readable title for `app.name`.
2. **Stack** — `vanilla-ts` (vanilla TypeScript + Vite, browser) / `react` (React + Vite, browser) / `node` (headless Node service) / `express` (Express HTTP + Tesseron hybrid). Default: `vanilla-ts`.
3. **App domain** — a one-liner describing what the app does (e.g. "todo list", "shopping cart", "document editor"). Shapes the first action, the first resource, and the initial README. Default: a small counter app (`increment` / `reset` / resource `counter`).
4. **Validator** — `zod` (default, most common) / `valibot` / `typebox`.

Do not ask about tsconfig, Vite config, port numbers, or which package manager to use. Pick them (`pnpm` preferred, fall back to `npm` if `pnpm` is not on `PATH`).

## Phase 2 — Confirm the plan

State the plan in one short block and wait for a yes. Include:

- Directory: `<project-name>/`
- `app.id`: `<snake_case>`, `app.name`: `<Title Case>`
- Stack: `<vanilla-ts | react | node | express>`
- Dependencies:
  - vanilla-ts: `@tesseron/web`, `<validator>`
  - react: `@tesseron/react`, `react`, `react-dom`, `<validator>`
  - node: `@tesseron/server`, `<validator>`
  - express: `@tesseron/server`, `express`, `<validator>`
- Dev dependencies:
  - browser: `typescript`, `vite` (+ `@vitejs/plugin-react` + `@types/react*` for react)
  - node/express: `typescript`, `@types/node` (+ `@types/express` for express)
- First action and first resource, reflecting the chosen domain.
- Entry point:
  - browser: `src/main.ts` (or `src/main.tsx`) + `index.html` + `vite.config.ts`.
  - node/express: `src/index.ts`.
- How to run.

## Phase 3 — Scaffold

Create files in this order. Verify each step before proceeding.

### Directory and package layout

**Browser (vanilla or react):**

```
<project-name>/
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
├── README.md
├── .gitignore
└── src/
    └── main.ts    # or main.tsx + App.tsx for react
```

**Node / Express:**

```
<project-name>/
├── package.json
├── tsconfig.json
├── README.md
├── .gitignore
└── src/
    └── index.ts
```

### `package.json`

Use the templates from `framework/references/project-structure.md`, substituting project name, stack, and validator. Always `"type": "module"`. Always `"private": true`.

Pin:

- `@tesseron/*` packages — same minor version across all of them (`^1.0.x` or latest available).
- `typescript ^5.7.0`.
- `zod ^3.24.0` (default), `valibot ^0.42.0`, or `@sinclair/typebox ^0.34.0` as chosen.
- Browser: `vite ^5.4.0`, React `^18.3.0`.
- Node: `@types/node ^22.0.0`.

### `tsconfig.json`

Use the template from `framework/references/project-structure.md` matching the stack (browser vs node). Always `strict: true`, `noUncheckedIndexedAccess: true`, `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`, `esModuleInterop: true`, `skipLibCheck: true`.

### `vite.config.ts` (browser only)

```ts
import { defineConfig } from 'vite';
// React: import react from '@vitejs/plugin-react';

export default defineConfig({
  server: { port: 5173 },
  // React: plugins: [react()],
});
```

### `index.html` (browser only)

Minimal shell with a `<div id="app"></div>` and `<script type="module" src="/src/main.ts">`.

### Entry point

Follow the stack-specific template in `framework/references/project-structure.md`. The entry point must:

1. `tesseron.app({ id, name, description })` with the chosen id/name/description.
2. Register at least one action (domain-appropriate) with `.describe(...)`, `.input(schema)`, and `.handler(...)`.
3. Register at least one resource (domain-appropriate) with `.describe(...)`, `.output(schema)`, and `.read(...)` — ideally a live counter or list that the action mutates, so the user sees the resource move.
4. Call `await tesseron.connect()` — and, for non-React stacks, `console.log(welcome.claimCode)` so the user can paste it.
5. For React: use `useTesseronConnection()` at the app root and render the `claimCode` in the UI.

Use `crypto.randomUUID()` for identifiers. No uuid packages.

### `.gitignore`

```
node_modules/
dist/
.cache/
.env
.DS_Store
```

### `README.md`

Short. Include: what the project is, how to install (`pnpm install` or `npm install`), how to run (`pnpm dev` / `npm run dev`), the claim-code step (where it prints / appears), and a pointer back to `https://github.com/BrainBlend-AI/tesseron`.

## Phase 4 — Install and smoke-test

Run install:

- If `pnpm` is on `PATH`: `pnpm install`.
- Else: `npm install`.

Then verify the project type-checks:

```bash
pnpm typecheck  # or: npm run typecheck
```

If typecheck passes, the scaffold is sound. Don't start the dev server from the scaffold skill — the user may want to configure env vars first.

## Phase 5 — Hand off

After scaffolding, tell the user:

1. **Run the app:** `pnpm dev` (browser) or `pnpm dev` / `node src/index.ts` (server). For browser apps, visit `http://localhost:5173`.
2. **Install the Tesseron Claude Code plugin** if not already installed:
   ```
   /plugin marketplace add BrainBlend-AI/tesseron
   /plugin install tesseron@tesseron
   ```
3. **Claim the session:** the app surfaces a 6-character code (`ABCD-XY`). In Claude, say: `claim session ABCD-XY`. The app's action appears as a typed MCP tool.
4. **Next steps**, picked from:
   - Add more actions — see `framework/references/actions.md`.
   - Add subscribable resources that push live updates — see `framework/references/resources.md`.
   - Wire `ctx.sample` / `ctx.confirm` / `ctx.elicit` into a handler — see `framework/references/context.md`.
   - Persist session resume (survive page reloads) — see `framework/references/transports.md`.
   - Write tests — see `framework/references/testing.md`.
5. A pointer to `framework` (auto-triggered) and `tesseron-reviewer` (auto-triggered before commit).

## Constraints

- Never commit `.env`. Only ship `.env.example` if env vars are needed (the default scaffold doesn't need any).
- Never install anything globally. Use the project's `node_modules`.
- Never pick an old version. Default to current: `@tesseron/* ^1.0.x`, TypeScript `^5.7.0`, Zod `^3.24.0`, Vite `^5.4.0`, React `^18.3.0`, Node types `^22.0.0`.
- Never hand-roll what `framework/references/project-structure.md` already templates.
- Use the canonical imports:
  - Browser: `import { tesseron } from '@tesseron/web';`
  - React: `import { useTesseronAction, useTesseronResource, useTesseronConnection } from '@tesseron/react';`
  - Node: `import { tesseron } from '@tesseron/server';`
- Use `crypto.randomUUID()` for ids — it's available in all supported runtimes.
- `app.id` is snake_case and stable. Do not use spaces, dashes, or slashes.
- Always include a `.describe(...)` on every action and resource. The LLM reads it.
- Always use a Standard-Schema-compatible validator for `.input(...)` — never a plain TypeScript interface.
