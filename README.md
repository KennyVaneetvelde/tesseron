<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./assets/logo/tesseron-smallcaps-dark.png">
  <img src="./assets/logo/tesseron-smallcaps-light.png" alt="Tesseron" width="520">
</picture>

### Typed web-app actions for MCP-compatible AI agents, over WebSocket.

<p>
  <a href="https://github.com/KennyVaneetvelde/tesseron/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/KennyVaneetvelde/tesseron?style=flat-square&color=f59e0b&logo=github&labelColor=0b1220"></a>
  <a href="./LICENSE"><img alt="License: BUSL-1.1" src="https://img.shields.io/badge/License-BUSL--1.1-f59e0b?style=flat-square&labelColor=0b1220"></a>
  <img alt="Protocol 1.0.0" src="https://img.shields.io/badge/Protocol-1.0.0-f59e0b?style=flat-square&labelColor=0b1220">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white&labelColor=0b1220">
  <img alt="Node 20+" src="https://img.shields.io/badge/Node-%E2%89%A5%2020-339933?style=flat-square&logo=node.js&logoColor=white&labelColor=0b1220">
  <img alt="Tests" src="https://img.shields.io/badge/Tests-65%20passing-22c55e?style=flat-square&labelColor=0b1220">
</p>

<p>
  <a href="https://kennyvaneetvelde.github.io/tesseron/"><b>Docs</b></a> &nbsp;·&nbsp;
  <a href="./examples"><b>Examples</b></a> &nbsp;·&nbsp;
  <a href="#quick-install-claude-code"><b>Install</b></a> &nbsp;·&nbsp;
  <a href="#packages"><b>Packages</b></a> &nbsp;·&nbsp;
  <a href="https://github.com/KennyVaneetvelde/tesseron/discussions"><b>Discussions</b></a>
</p>

</div>

---

Web apps declare actions with a Zod-style builder; agents (Claude Code, Claude Desktop, Cursor, Copilot, Codex, Cline, ...) call them as MCP tools. Your real handler runs against your real state. **No browser automation, no scraping, no Playwright.**

<p align="center">
  <img src="./assets/diagrams/pieces-fit-together.png" alt="USER prompts the agent; YOUR APP (browser or Node, using @tesseron/web or /server) connects over WebSocket to the MCP GATEWAY (@tesseron/mcp on :7475); the MCP GATEWAY bridges to the MCP CLIENT (Claude Code, Desktop, Cursor) over MCP stdio." width="900">
</p>

## Why Tesseron

- **Typed actions, not scraped DOMs.** Declare with Zod or any [Standard Schema](https://standardschema.dev) validator; the handler is a plain function against your real state.
- **Framework-agnostic.** Same API for vanilla TS, React, Svelte, Vue, and Node. Pick your stack.
- **MCP-native.** Every action, resource, and capability maps to a standard MCP primitive. Users pick their agent.
- **Click-to-connect.** Six-character claim code handshake. No API keys, no OAuth dance, no per-client configuration.
- **First-class capabilities.** `ctx.confirm` for yes/no, `ctx.elicit` for schema-validated prompts, `ctx.sample` for agent LLM calls, `ctx.progress` for streaming updates, subscribable resources for live reads.
- **Bundled delivery.** The MCP gateway ships inside a [Claude Code plugin](./plugin) — one install command and you're done.

## Quick install (Claude Code)

```text
/plugin marketplace add KennyVaneetvelde/tesseron
/plugin install tesseron@tesseron
```

That installs the [`tesseron`](./plugin) Claude Code plugin, which spawns the MCP gateway automatically and registers it as an MCP server. Then drop [`@tesseron/web`](./packages/web), [`@tesseron/server`](./packages/server), or [`@tesseron/react`](./packages/react) into your app, declare actions, and let Claude drive your real UI.

```ts
import { tesseron } from '@tesseron/web';
import { z } from 'zod';

tesseron.app({ id: 'todo_app', name: 'Todo App' });

tesseron
  .action('addTodo')
  .input(z.object({ text: z.string().min(1) }))
  .handler(({ text }) => {
    state.todos.push({ id: newId(), text, done: false });
    render();
    return { ok: true };
  });

await tesseron.connect();
```

For other MCP clients (Claude Desktop, Cursor, Codex, VS Code Copilot, ...) see the one-time setup in [`examples/README.md`](./examples/README.md#2-wire-the-mcp-gateway-into-your-mcp-client).

See [`examples/`](./examples) for working apps in vanilla TS, React, Svelte, Vue, Express, and plain Node.

## Packages

| Package | Purpose |
|---|---|
| [`@tesseron/core`](./packages/core) | Protocol types, action builder. Zero runtime deps beyond Standard Schema. |
| [`@tesseron/web`](./packages/web) | Browser SDK. |
| [`@tesseron/server`](./packages/server) | Node SDK. |
| [`@tesseron/mcp`](./packages/mcp) | MCP gateway server (CLI; bundled into the plugin). |
| [`@tesseron/react`](./packages/react) | React hooks adapter. |
| [`@tesseron/devtools`](./packages/devtools) | In-browser debug UI served by the MCP gateway *(Phase 4, stub)*. |
| [`create-tesseron`](./packages/create-tesseron) | `npm create tesseron@latest` scaffolder *(Phase 4, stub)*. |

The Claude Code plugin lives at [`plugin/`](./plugin), exposed via the marketplace manifest at [`.claude-plugin/marketplace.json`](./.claude-plugin/marketplace.json).

## Client capability support

Tesseron's action context gives handlers four capabilities beyond plain tool invocation, each backed by an MCP primitive. Whether a given call actually fires depends on what the user's MCP client advertises:

| SDK surface | MCP primitive |
|---|---|
| `tool(...)` (action invocation) | `tools` |
| `resource(...)` (live reads, subscriptions) | `resources` (+ `resources.subscribe`) |
| `ctx.sample(...)` | `sampling` |
| `ctx.confirm(...)` / `ctx.elicit(...)` | `elicitation` |
| `ctx.progress(...)` | `notifications/progress` (client must pass `_meta.progressToken` on `tools/call`) |

For the authoritative, continuously-updated list of which client supports which primitive, see the **[official MCP client compatibility matrix](https://modelcontextprotocol.io/clients)** — filter by `Sampling` or `Elicitation` to see how narrow the field still is. A few points worth knowing before you pick a capability:

- **Tools** are universal — every MCP client can invoke your actions.
- **Sampling** is the rarest. Claude Code, Claude Desktop, and Claude.ai do **not** expose it; today's support is concentrated in VS Code + GitHub Copilot, [goose](https://block.github.io/goose/), and [fast-agent](https://github.com/evalstate/fast-agent).
- **Elicitation** (MCP 2025-06) landed in Claude Code (2.1.76, March 2026), Cursor, Codex, VS Code Copilot, goose, and fast-agent, but **not** Claude Desktop, Claude.ai, ChatGPT, Windsurf, or Zed.
- When a capability is missing, Tesseron raises a typed error (`SamplingNotAvailableError`, `ElicitationNotAvailableError`) or collapses to the safe default (`ctx.confirm` returns `false`), so handlers can branch explicitly rather than silently misbehaving.

## Status

**v0.1** — usable end-to-end. Phase 1–3 of the [PRD](./.planning/requirements.md) shipped: bidirectional JSON-RPC over WebSocket, dynamic MCP tool registration, click-to-connect handshake, streaming progress, cancellation, sampling, elicitation, subscribable resources. Phase 4 (Streamable HTTP transport, devtools UI, scaffolder) pending before **v1.0**.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test                                    # 65 tests across core + mcp
pnpm --filter @tesseron/mcp build:plugin     # rebuild plugin/server/index.cjs after gateway changes
```

## Contributing

Bug reports, protocol refinements, new framework adapters, and improvements to the reference implementation are welcome.

- Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the workflow.
- Every commit must be **`Signed-off-by:`** under the [Developer Certificate of Origin](https://developercertificate.org/) — use `git commit -s`.
- Open an issue first for anything larger than a small fix.

## Star history

<a href="https://star-history.com/#KennyVaneetvelde/tesseron&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KennyVaneetvelde/tesseron&type=Date&theme=dark">
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=KennyVaneetvelde/tesseron&type=Date" width="720">
  </picture>
</a>

## License

**Reference implementation** — [Business Source License 1.1](./LICENSE) (source-available). You may embed Tesseron in your own applications, use it internally, fork it, and redistribute it freely. You may **not** offer Tesseron or a substantial portion of it as a hosted or managed service to third parties. Each release auto-converts to Apache-2.0 four years after publication.

**Protocol specification** — [CC BY 4.0](./docs/src/content/docs/protocol/LICENSE). A compatible implementation in any language, for any purpose including commercial, is explicitly encouraged.

Contributions are welcome under the [Developer Certificate of Origin](./CONTRIBUTING.md) — every commit must be `Signed-off-by`.

© 2026 Kenny Vaneetvelde
