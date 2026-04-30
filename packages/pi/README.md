# @tesseron/pi

Pi coding-agent plugin for [Tesseron](https://github.com/BrainBlend-AI/tesseron). Drops the Tesseron MCP gateway into [Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) as a single-command install **and** gives Pi the same skill bundle the Claude Code / Codex plugin ships. Once installed, any web app speaking the Tesseron wire protocol over WebSocket can expose typed actions to Pi's LLM as Pi tools — no browser automation, no scraping.

## What you get

- **Eight Pi tools** that wrap the Tesseron MCP gateway (`@tesseron/mcp`) and docs server (`@tesseron/docs-mcp`):
  - `tesseron_claim_session` — pair a Tesseron-enabled app to Pi via its 6-character claim code.
  - `tesseron_list_actions` — enumerate actions and resources exposed by claimed sessions.
  - `tesseron_list_pending_claims` — recovery path when a claim went stale (browser refresh, dev-server reload).
  - `tesseron_invoke_action` — invoke a typed action on a claimed session.
  - `tesseron_read_resource` — read a resource exposed by a claimed session.
  - `tesseron_docs_list` / `tesseron_docs_search` / `tesseron_docs_read` — chapter-and-verse Tesseron docs lookup, BM25-indexed.
- **The same five skills** the Claude/Codex plugin ships:
  - `framework` — quick-reference mental model for the Tesseron SDK.
  - `tesseron-docs` — authoritative-lookup skill that calls `tesseron_docs_*`.
  - `tesseron-dev` — picks the right consumer package (`@tesseron/web`, `/server`, `/react`, `/svelte`, `/vue`) and wires the canonical API into a project's entry point.
  - `tesseron-explorer` — maps an existing Tesseron codebase.
  - `tesseron-reviewer` — Tesseron-specific code review.
- **A `/tesseron` slash command** that prints the tool surface and the claim-code workflow.

## Install

Requires **Node 20+** with `npx` on `PATH`. On first call the package fetches `@tesseron/mcp` and `@tesseron/docs-mcp` from npm, which adds a one-time cold-start cost; subsequent launches use the npm cache.

### Project-local install (recommended)

Run from the root of the project where you want Tesseron tools available to Pi:

```bash
pi install -l npm:@tesseron/pi@2.6.1
```

`-l` writes the entry to `.pi/settings.json` so the package is restored on every Pi run in this project. Pi automatically installs missing project-local packages on startup, so this also serves as the team-share command.

### Global install

If you want Tesseron tools available in every Pi session regardless of cwd:

```bash
pi install npm:@tesseron/pi@2.6.1
```

This writes to `~/.pi/agent/settings.json`.

### Try without installing

```bash
pi -e npm:@tesseron/pi@2.6.1
```

The `-e` (or `--extension`) flag installs to a temp dir for the current run only. Useful for one-off Tesseron-driven sessions.

### Verify

Start Pi in any project that has the package installed:

```bash
pi
/tesseron
```

The `/tesseron` command prints the tool surface. The eight `tesseron_*` tools should appear in `/tools` (or whatever Pi's tool-list command is in your version).

## How to use the gateway

1. **In your web app**, import `@tesseron/web` (or `/server`, `/react`, `/svelte`, `/vue`), declare actions with the Zod-style builder, and call `tesseron.connect()`. The SDK binds a loopback WebSocket endpoint and writes an instance file to `~/.tesseron/instances/<id>.json`. The Tesseron MCP gateway watches that directory and dials in — no port to configure, no env vars.

2. **The web app displays a 6-character claim code** (returned in the welcome handshake — see [`@tesseron/web`](https://github.com/BrainBlend-AI/tesseron/tree/main/packages/web) for the typical UI placement).

3. **In Pi, say:** `claim session ABCD-XY` (replace with the actual code). Pi calls `tesseron_claim_session`, the gateway pairs the session, and your app's actions become callable via `tesseron_invoke_action`.

4. **Drive your app from chat.** Each `tesseron_invoke_action` call runs the typed handler you declared — mutating whatever state your app owns. The browser (or service) updates in real time.

For complete runnable walkthroughs, see the repo's [examples/](https://github.com/BrainBlend-AI/tesseron/tree/main/examples).

## What ships in this package

```
@tesseron/pi/
├── extensions/
│   └── tesseron.ts        # the Pi extension factory + tool registrations
└── skills/
    ├── framework/         # mental-model skill + 11 reference files
    ├── tesseron-dev/      # SDK integration skill
    ├── tesseron-docs/     # authoritative docs lookup skill
    ├── tesseron-explorer/ # codebase-mapping skill
    └── tesseron-reviewer/ # framework-specific code review skill
```

The extension is a single TypeScript file loaded directly by Pi via [jiti](https://github.com/unjs/jiti) — no compile step.

## How it works under the hood

The extension spawns two MCP servers as child processes via `npx -y @tesseron/mcp@<version>` and `npx -y @tesseron/docs-mcp@<version>` (with `cmd /c` on Windows to navigate around npm's `.cmd` shim quirk). Each Pi `execute()` call translates to a JSON-RPC `tools/call` request over the child's stdio, and the result content is normalized into Pi's `(TextContent | ImageContent)[]` shape. Errors from the gateway (e.g. "no claimed session") arrive as `isError: true` from MCP and get re-thrown so Pi reports them as failed tool calls (Pi sets the `isError` flag by `throw`, never by return value).

The pinned `@tesseron/mcp` version is kept in lockstep with the rest of the Tesseron SDK by [`scripts/sync-plugin-version.mjs`](https://github.com/BrainBlend-AI/tesseron/blob/main/scripts/sync-plugin-version.mjs) — never edit the `TESSERON_MCP_VERSION` constant in `extensions/tesseron.ts` by hand.

## Skill source

The skill bundle is mirrored from `plugin/skills/` (the Claude Code / Codex plugin's skill source). Edits land there; the sync script keeps `packages/pi/skills/` byte-identical and CI fails any drift. See [`AGENTS.md`](https://github.com/BrainBlend-AI/tesseron/blob/main/AGENTS.md) for the contract.

## Compatibility

- **Pi**: `@mariozechner/pi-coding-agent` 0.70.x or newer.
- **Node**: 20.6+ (matches Pi's engine).
- **Tesseron SDK**: matches the `@tesseron/mcp` version pinned in this package's extension. Currently `2.6.x`.

## Links

- Tesseron protocol + SDKs: https://github.com/BrainBlend-AI/tesseron
- Examples: https://github.com/BrainBlend-AI/tesseron/tree/main/examples
- `@tesseron/mcp` (gateway, used by this package): https://www.npmjs.com/package/@tesseron/mcp
- `@tesseron/docs-mcp` (docs server, used by this package): https://www.npmjs.com/package/@tesseron/docs-mcp
- Pi: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent

## License

BUSL-1.1 © Kenny Vaneetvelde — see [`LICENSE`](./LICENSE).
