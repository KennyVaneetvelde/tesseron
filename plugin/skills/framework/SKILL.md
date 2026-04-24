---
name: framework
description: Quick-reference mental model for the Tesseron TypeScript SDK — core abstractions (app, action, resource, handler, ActionContext, transport, session, gateway), canonical imports per consumer package (`@tesseron/web`, `/server`, `/react`, `/core`, `/mcp`), and the minimum-viable-app template. Load when the user is starting Tesseron work, wiring a first action or resource, deciding which consumer package to import, writing a handler for the first time, or orienting on how the pieces fit together. Triggers on code that imports from `@tesseron/*`, on calls to `tesseron.action(...)`, `tesseron.resource(...)`, `tesseron.connect(...)`, `useTesseronAction`, `useTesseronResource`, or `useTesseronConnection`, and on broad questions like "what is Tesseron", "how do actions work", "where do I start". For authoritative specs — exact wire format, error code tables, handshake and resume shapes, full protocol behaviour — prefer the `tesseron-docs` skill, which queries the live `@tesseron/docs-mcp` server. This skill is the cheat sheet; `tesseron-docs` is the manual.
---

# Tesseron Framework

Tesseron is a TypeScript protocol + SDK that lets a live web app expose typed, prefixed actions and resources to MCP-compatible AI agents (Claude Code, Claude Desktop, Cursor, and others) over WebSocket. Instead of the agent automating a browser to drive the UI, the app directly tells the agent *what it can do*. Each tool invocation runs a real handler against real state — no DOM scraping, no screenshot analysis.

This skill orients Claude on the framework and routes to focused reference files as the task requires.

## Core abstractions

| Concept | Class / symbol | Role |
|---|---|---|
| App | `tesseron.app({...})` | Stable identity (`id`, `name`, `description`) announced in the welcome handshake |
| Action | `ActionDefinition` via `tesseron.action(name)...handler(fn)` | A named operation the agent can invoke as an MCP tool |
| Resource | `ResourceDefinition` via `tesseron.resource(name)...read(fn)`/`.subscribe(fn)` | Readable and/or subscribable state exposed to the agent |
| Handler | `ActionHandler<I, O>` | `(input, ctx) => Promise<O> | O` — runs inside the app, with validated input |
| Context | `ActionContext` | Per-invocation runtime: `signal`, `agent`, `agentCapabilities`, `client`, `progress`, `sample`, `confirm`, `elicit`, `log` |
| Transport | `Transport` interface | JSON-RPC 2.0 bidirectional channel; `BrowserWebSocketTransport`, `NodeWebSocketTransport`, or custom |
| Session | `WelcomeResult` from `tesseron.connect(...)` | `sessionId`, `claimCode`, `resumeToken`, `capabilities`, invoking `agent` |
| Gateway | `@tesseron/mcp` | Bridges `tesseron/*` JSON-RPC ↔ MCP; launched automatically by the Claude Code plugin |

Every action/resource uses a Standard-Schema-compatible validator (Zod, Valibot, Typebox) for input/output.

## Canonical imports

```ts
// Browser
import { tesseron, BrowserWebSocketTransport, DEFAULT_GATEWAY_URL } from '@tesseron/web';

// Node (headless server, CLI, daemon)
import { tesseron, NodeWebSocketTransport, DEFAULT_GATEWAY_URL } from '@tesseron/server';

// React (co-located inside components)
import { useTesseronAction, useTesseronResource, useTesseronConnection } from '@tesseron/react';

// Core (protocol types, errors, transport interface — useful for custom transports/tests)
import type { ActionContext, Transport, WelcomeResult, ResumeCredentials } from '@tesseron/core';
import {
  TesseronError,
  TesseronErrorCode,
  SamplingNotAvailableError,
  ElicitationNotAvailableError,
  TimeoutError,
  CancelledError,
  ResumeFailedError,
} from '@tesseron/core';
```

Do not import from package internals (`@tesseron/core/dist/...` or relative paths across packages). Only the top-level exports are part of the public API.

## Minimum viable app

```ts
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

tesseron.app({
  id: 'my_todo',
  name: 'My Todo App',
  description: 'A todo app driven by Claude through Tesseron.',
});

const todos: Array<{ id: string; text: string; done: boolean }> = [];

tesseron
  .action('addTodo')
  .describe('Add a new todo item to the list. Returns the created todo.')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    const todo = { id: crypto.randomUUID(), text, done: false };
    todos.push(todo);
    return todo;
  });

tesseron
  .resource('todos')
  .describe('All current todos.')
  .output(z.array(z.object({ id: z.string(), text: z.string(), done: z.boolean() })))
  .read(() => todos);

const welcome = await tesseron.connect();
console.log(`Claim code: ${welcome.claimCode}`);
```

In Claude, the user then says `claim session <code>` and the app's `addTodo` action appears as a typed MCP tool. Full runnable versions live in `examples/` (vanilla, React, Svelte, Vue, Express, Node).

## Decision routing

Pick the reference file that matches the task. Each is loaded only when read.

| Task | Reference |
|---|---|
| Design an action — input/output/annotations/timeout/handler shape | [references/actions.md](references/actions.md) |
| Expose readable / subscribable state to the agent | [references/resources.md](references/resources.md) |
| Use `ctx.sample`, `ctx.confirm`, `ctx.elicit`, `ctx.progress`, `ctx.log`, or `ctx.signal` inside a handler | [references/context.md](references/context.md) |
| Connect, pick a transport, write a custom one, reconnect with resume | [references/transports.md](references/transports.md) |
| Wire actions/resources into a React app, manage connection UI | [references/react.md](references/react.md) |
| Understand the JSON-RPC wire protocol: methods, payloads, errors, resume | [references/protocol.md](references/protocol.md) |
| Pick an input/output validator (Zod / Valibot / Typebox), pass the right `jsonSchema` | [references/schemas.md](references/schemas.md) |
| Handle errors — codes, subclasses, `instanceof` patterns, resume failures | [references/errors.md](references/errors.md) |
| Configure the gateway — env vars, origin allowlist, tool surface modes, multi-app | [references/gateway.md](references/gateway.md) |
| Write unit/integration tests with mock transports and context | [references/testing.md](references/testing.md) |
| Tesseron-specific structural rules — which `@tesseron/*` package per stack, where `tesseron.app(...)` goes, `app.id` rules, version lockstep, multi-app layout | [references/project-structure.md](references/project-structure.md) |

When a concept is unclear, start from the user's verb: *add an action* → actions, *push a live value* → resources, *ask the LLM to pick something* → context (`ctx.sample`), *let the user confirm* → context (`ctx.confirm` / `ctx.elicit`), *my session died on reload* → transports (resume).

## Working style

Follow these defaults unless the project says otherwise. The reference files go deeper on each.

**Describe every action for the LLM, not the developer.** The `.describe(...)` string and field descriptions in the input schema are the only hints the agent has to decide when to call the action and what arguments to pass. A missing or vague description is effectively an unused tool.

**Schemas are the runtime contract.** `.input(schema)` validates before the handler runs; invalid input is rejected with an `InputValidation` error without invoking the handler. Use a Standard-Schema validator (Zod is most common, Valibot and Typebox also work). Plain TypeScript types are not runtime validators.

**Annotate destructive actions.** `.annotate({ destructive: true })` and `requiresConfirmation: true` let the agent surface a confirmation to the user before invoking. `readOnly: true` on pure getters helps the agent reason about side effects.

**Forward `ctx.signal` to every cancellable async op.** `fetch`, child-process, database calls, long timers — all should accept `signal: ctx.signal` so gateway-initiated cancellation propagates through the call stack.

**Call `ctx.progress(...)` on operations longer than ~1–2 seconds.** The agent surfaces progress to the user; handlers that don't emit look frozen.

**Capability-check before `sample` and `elicit`.** Calling them on an agent that doesn't support the capability throws `SamplingNotAvailableError` / `ElicitationNotAvailableError`. `ctx.confirm(...)` is the exception — it collapses to `false` on any non-accept, which is the safe default for destructive ops.

**Persist `{sessionId, resumeToken}` after each successful connect.** The resume token rotates on every successful resume, so always write back the freshest token from the latest `WelcomeResult`. On reconnect failure (`ResumeFailedError`), fall back to a fresh `connect()` without resume options.

**Resources that push updates emit an initial value then a cleanup.** The `subscribe((emit) => { emit(current); registry.add(emit); return () => registry.delete(emit); })` shape is canonical. Missing the initial emit leaves the first read hanging; missing the return leaks the subscription.

**In React, hooks register once at mount and cleanup on unmount.** Pass a fresh handler closure on every render — the hook stores it in a ref. `useCallback` / `useMemo` around the handler is unnecessary. Put `useTesseronConnection(...)` at the app root, not per-component.

## When the user wants to add Tesseron to a project

Delegate to the sibling `tesseron-dev` skill. It handles picking the right `@tesseron/*` consumer package, installing it with the project's existing package manager, and inserting the canonical Tesseron API (`tesseron.app(...)` + one action + one resource + `tesseron.connect()`) at module scope of the entry point.

Project creation itself (scaffolding `package.json`, `tsconfig.json`, bundler config, picking framework versions) is outside Tesseron's scope — the user uses whichever upstream scaffolder or framework-specific skill they prefer. `tesseron-dev` works the same way whether the project was created five seconds ago or five years ago.

## When the user wants to understand an existing codebase

Delegate to the `tesseron-explorer` subagent when the project has more than a handful of Tesseron files and the user asks to "explore", "map", "understand how X works", or similar. The subagent reads the relevant files in isolated context and returns a compact architecture map (apps, actions, resources, context-method use, transports, React hooks, session lifecycle, essential-reading list). Invoke via the `Task` tool with the scope (project root, package, or feature) in the prompt.

For a small project (a single `main.ts` + one or two actions), reading the files directly in the main thread is fine — the isolation upside is thin.

## When the user wants a review

Delegate to the `tesseron-reviewer` subagent — do not review in the main thread. The subagent runs in isolated context with read-only tools, keeping the review's file exploration out of the parent conversation. Invoke it via the `Task` tool with the scope (diff, paths, or module) in the prompt. Review findings return as a single structured report the parent thread can act on.

## Versioning and compatibility

- TypeScript 5.7+ (strict mode, `noUncheckedIndexedAccess` recommended).
- Node 20+ for server / gateway processes (Node 18 *may* work for consumers but 20+ is what the monorepo tests against).
- Protocol version `1.0.0`. Session resume (`tesseron/resume`) added in SDK v1.1.
- Package versions travel together: `@tesseron/core`, `/web`, `/server`, `/react`, `/mcp` are released in lockstep. Match them within a minor version.
- `@standard-schema/spec ^1.0.0` is the only runtime dependency of `@tesseron/core`.

## Anti-patterns (surface these in review)

- Calling `tesseron.connect()` before `tesseron.app(...)` — connect throws.
- Chaining anything after `.handler(...)` on an action builder — `.handler(...)` returns the finalized `ActionDefinition`, not the builder. Silent bug.
- Skipping `.describe(...)` on an action or resource — the LLM has no signal to pick the tool.
- Plain TypeScript `interface` / `type` passed to `.input(...)` — not a validator. Use Zod / Valibot / Typebox.
- `.subscribe(...)` that does not return a cleanup function — leaks the subscription.
- `.subscribe(...)` that does not emit an initial value — the first read blocks waiting for a push.
- Calling `ctx.sample(...)` / `ctx.elicit(...)` without a `ctx.agentCapabilities.*` check — throws on clients that don't support the capability.
- Not forwarding `ctx.signal` to `fetch` or other cancellable ops — gateway cancellation cannot propagate.
- Persisting a stale `resumeToken` — the token rotates on every successful resume; stale tokens fail with `ResumeFailedError`.
- Storing `claimCode` — it's one-shot pairing, not authentication. Throw it away after the user pastes it.
- Hardcoding `ws://localhost:7475` throughout the codebase instead of using `DEFAULT_GATEWAY_URL`.
- `TESSERON_HOST=0.0.0.0` without `TESSERON_ORIGIN_ALLOWLIST` — exposes the gateway to arbitrary origins.
- Multiple `useTesseronConnection(...)` hooks in the same app — each creates its own session.
- `useCallback` / `useMemo` wrapping a `useTesseronAction` handler — unnecessary; the hook refs the handler itself.
- `error.code === -32006` magic-number checks instead of `instanceof SamplingNotAvailableError`.

For deeper guidance load the relevant reference file above. For code-review runs, delegate to the `tesseron-reviewer` subagent.
