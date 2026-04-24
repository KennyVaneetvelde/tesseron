# tesseron (Claude Code plugin)

Drops the [Tesseron](https://github.com/BrainBlend-AI/tesseron) MCP gateway into Claude Code as a single-command install **and** gives Claude deep, just-in-time knowledge of the Tesseron protocol and SDK. When you work in a Tesseron codebase, Claude picks up the right patterns for actions, resources, `ActionContext`, transports, React hooks, protocol wire format, errors, gateway config, testing, and project layout — without you pasting docs or repeating conventions.

## What you get

- **MCP gateway** — a bundled `@tesseron/mcp` gateway that Claude Code launches automatically. Any web app speaking the Tesseron wire protocol over WebSocket — via [`@tesseron/web`](https://github.com/BrainBlend-AI/tesseron/tree/main/packages/web), [`@tesseron/server`](https://github.com/BrainBlend-AI/tesseron/tree/main/packages/server), or [`@tesseron/react`](https://github.com/BrainBlend-AI/tesseron/tree/main/packages/react) — can expose typed, prefixed actions as MCP tools that Claude can call.
- **`framework` skill** — auto-triggered when Claude sees Tesseron code. The *cheat sheet*: core abstractions, canonical imports, and the minimum-viable-app template, plus eleven focused reference files (actions, resources, context, transports, react, protocol, schemas, errors, gateway, testing, project-structure). Progressive disclosure keeps the parent context lean. Load this for orientation and mental model questions.
- **`tesseron-docs` skill** — auto-triggered when a Tesseron question needs a precise answer (exact wire format, error codes, handshake shape, resume flow). The *manual*: it calls the bundled [`@tesseron/docs-mcp`](https://www.npmjs.com/package/@tesseron/docs-mcp) MCP server's `search_docs` and `read_doc` tools so the answer comes from the live docs, not training data.
- **`tesseron-dev` skill** — auto-triggered when you ask to add Tesseron to a project (existing, or one you're creating). Picks the right `@tesseron/*` consumer package — `@tesseron/react` for React (hooks API), `@tesseron/server` for Node, `@tesseron/web` for any other browser context — installs it with the project's existing package manager, and inserts the canonical Tesseron API (`tesseron.app(...)` + one action + one resource + `tesseron.connect(...)`) at module scope of the entry point. Strictly Tesseron-scoped: does not create projects, scaffold build tooling, pick framework versions, or template framework-specific idioms. Creating projects is someone else's job.
- **`tesseron-explorer` subagent** — auto-triggered (or `Task`-invoked) when you ask to explore, map, or understand an existing Tesseron codebase. Reads the project in isolated context and returns a compact architecture map (apps, actions, resources, context-method usage, transports, React hooks, session lifecycle, essential-reading list) without polluting the parent thread with every file it had to open.
- **`tesseron-reviewer` subagent** — auto-triggered (or `Task`-invoked) when you ask for a review, audit, or check of Tesseron code. Runs in isolated context with read-only tools so the file-exploration load never pollutes the parent thread. Focuses only on Tesseron-specific concerns (app manifest hygiene, builder invariants, `ActionContext` capability checks, handler async/signal forwarding, subscriber cleanup, session resume flow, React hook registration, gateway origin-allowlist sanity). Returns a single confidence-filtered structured report. Complements generic code review; does not replace it.

This follows the hybrid pattern Anthropic themselves ship: reference skills for knowledge that should inform the main thread, specialist subagents for discrete read-heavy tasks whose output is a summary.

**Why this exists.** Browser automation (Playwright, chrome-devtools-mcp) is fragile, slow, and forces the agent to reverse-engineer your UI on every run. Your app already knows what it can do — let it tell Claude directly with typed action manifests.

## Install

Requires **Node 18+** on `PATH` for the gateway (Claude Code's runtime already qualifies; this is only a concern for unusual setups).

```text
/plugin marketplace add BrainBlend-AI/tesseron
/plugin install tesseron@tesseron
```

Restart Claude Code. The plugin's MCP server (`tesseron`) starts automatically. You'll see a single tool, `mcp__plugin_tesseron_tesseron__tesseron__claim_session`, until a web app speaking the protocol connects.

## How to use the gateway

1. **In your web app**, import `@tesseron/web` (or `/server`, `/svelte`, `/vue`, `/react`), declare actions with the Zod-style builder, and call `tesseron.connect()`. The SDK binds a loopback WebSocket endpoint and writes a tab file to `~/.tesseron/tabs/<tabId>.json`. The plugin's gateway is watching that directory and dials in — no port to configure, no env vars to set.

2. **The web app displays a 6-character claim code** (returned in the welcome handshake).

3. **In Claude, say:** `claim session ABCD-XY` (replace with the actual code). Claude calls the meta-tool, the MCP gateway pairs the session, and your app's actions appear as MCP tools named `mcp__plugin_tesseron_tesseron__<your-app-id>__<action-name>`.

4. **Drive your app from chat.** Each tool call runs the handler you declared — mutating whatever state your app owns. The browser (or service) updates in real time.

For complete runnable walkthroughs, see the repo's [examples/](https://github.com/BrainBlend-AI/tesseron/tree/main/examples).

## Typical flows

**Writing new Tesseron code.** Open your project. Claude notices imports from `@tesseron/*`, loads the `framework` skill for the mental model, and pulls in `references/actions.md`, `references/resources.md`, etc. as the conversation progresses. When you ask a precision question ("what fields does the welcome frame carry?", "what error code does a failed resume return?"), the `tesseron-docs` skill fires and calls `search_docs` / `read_doc` against the live docs MCP server to quote the spec verbatim.

**Adding Tesseron to a project.** Say "add Tesseron to this app" — it works the same whether the project was scaffolded five seconds ago by an upstream tool or has existed for years. The `tesseron-dev` skill picks the right `@tesseron/*` consumer package (`/react` for React, `/server` for Node, `/web` for any other browser context), installs it with the project's existing package manager, and inserts `tesseron.app(...)` + one action + one resource + `tesseron.connect(...)` at module scope of the entry point. It never touches `tsconfig.json`, build config, framework versions, or framework-specific idioms.

**Starting a new project.** Create the project however you normally would — `npm create vite@latest`, `npx create-next-app@latest`, `npx sv create`, `npm init -y`, a framework-specific skill if you have one, or a hand-rolled layout — then invoke `tesseron-dev`. Project scaffolding is not Tesseron's job, so the plugin has no opinion on which tool you use.

**Understanding a codebase you inherited.** Ask "help me understand how the actions in this project work" or "map this codebase." The `tesseron-explorer` subagent fires, reads the relevant files in its own context, and returns a compact architecture map with file:line references — the parent thread skips the file-by-file slog.

**Before committing.** Ask "review my changes for Tesseron issues." The `tesseron-reviewer` subagent fires (or Claude invokes it via the `Task` tool), reads the diff in its own context, and returns a confidence-filtered list of framework-specific issues with ready-to-apply fixes.

## What the MCP gateway does

- **No fixed port.** The gateway is a WebSocket *client*: it watches `~/.tesseron/tabs/` and dials each app it finds. Apps bind their own loopback endpoint and announce themselves by writing `<tabId>.json`.
- Exposes a meta-tool `tesseron__claim_session({code})` for the click-to-connect handshake.
- Forwards SDK→agent: action invocations, streaming progress, structured logs, sampling, elicitation, resource read/subscribe.
- Forwards agent→SDK: tool calls, cancellations, MCP-side `notifications/progress`.
- Multi-app aware: tools from each connected app are prefixed with the app's id, so `shop__refundOrder` and `crm__refundOrder` don't collide.

## Configuration (env vars)

| Variable | Default | Purpose |
|---|---|---|
| `TESSERON_TOOL_SURFACE` | `both` | `dynamic` \| `meta` \| `both` — see `skills/framework/references/gateway.md` |

v2.0 removed `TESSERON_PORT`, `TESSERON_HOST`, and `TESSERON_ORIGIN_ALLOWLIST`: the gateway no longer binds a port or accepts inbound connections.

## How the skills work

This plugin follows Anthropic's 2026 skill-authoring conventions:

- Each skill is a folder with a `SKILL.md` file (≤500 lines) plus an optional `references/` directory.
- YAML frontmatter has two fields: `name` and `description`. The description is what Claude reads to decide when the skill applies.
- Reference files are one level deep from `SKILL.md`, each ≤ a few pages. Claude loads only the ones relevant to the current task.

Read the `framework` skill's `SKILL.md` if you want to see the routing table and minimum-viable-app template up front.

## Compatibility

- TypeScript 5.7+ (strict mode, `noUncheckedIndexedAccess` recommended).
- Node 20+ for server / gateway processes.
- Protocol version `1.0.0`. Session resume added in SDK v1.1.
- `@tesseron/core`, `/web`, `/server`, `/react`, `/svelte`, `/vue`, `/vite`, `/mcp` released in lockstep — match them within a major version (currently `2.x`).

## Building the gateway from source

The bundled gateway at [`server/index.cjs`](./server/index.cjs) is generated by tsup from the [@tesseron/mcp](https://github.com/BrainBlend-AI/tesseron/tree/main/packages/mcp) source. To rebuild after changes:

```bash
pnpm --filter @tesseron/mcp build:plugin
```

Output lands directly in this directory's `server/`.

## Development

Edit files in place and re-run `/reload-plugins` in Claude Code to pick up changes without restarting. `--plugin-dir` loads take precedence over installed marketplace copies for the current session.

```bash
claude --plugin-dir /path/to/tesseron/plugin
```

## License

MIT © Kenny Vaneetvelde — see [`LICENSE`](./LICENSE).

## Links

- Protocol + SDKs: https://github.com/BrainBlend-AI/tesseron
- Examples: https://github.com/BrainBlend-AI/tesseron/tree/main/examples
- Changelog: [`CHANGELOG.md`](./CHANGELOG.md)
