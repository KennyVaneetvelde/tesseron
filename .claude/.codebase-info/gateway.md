# The gateway and the docs server

*Last Updated: 2026-09-03*

## `@tesseron/mcp` — binary `tesseron-mcp`

`bin` is `./src/cli.ts` in the repo, swapped to `./dist/tesseron-mcp.cjs` on publish
(`gateway/package.json:40` vs `:76`). Fully bundled CJS, `noExternal: [/.*/]`.

### There are no CLI flags

`src/cli.ts` never reads `process.argv`. Configuration is environment only:

| Env var | Read at | Values |
|---|---|---|
| `TESSERON_TOOL_SURFACE` | `cli.ts:6` | `dynamic` \| `meta` \| `both`; anything else → `both` |
| `TESSERON_RESUME_TTL_MS` | `cli.ts:19` | non-negative ms; `0` disables resume; invalid → warn + 4 h default |

**`gateway/README.md:98` still documents `TESSERON_PORT`, `TESSERON_HOST`, and
`TESSERON_ORIGIN_ALLOWLIST`. Those are stale.** No such string exists in `src/`; they were removed
in v2.0 (`gateway/CHANGELOG.md:537`). Fix the README rather than trusting it.

Startup: construct gateway (`cli.ts:39`) → `watchAppsJson()` (`:40`, a **deprecated alias** for
`watchInstances()`, kept for 1.1.x embedders, `gateway.ts:648`) → bridge over `StdioServerTransport`
(`:47`) → SIGINT/SIGTERM → `gateway.stop()`.

### Gateway core (`src/gateway.ts`, 1753 lines)

`TesseronGateway extends EventEmitter` (`:237`). No port, no listener, no `start()`. Owns live
sessions `:238`, pending claims `:239`, in-flight invocations `:240`, zombies `:245`, dialers `:256`,
watchers `:257`, host-mint cache `:273`.

- **Start** = `watchInstances()` `:471` — watches `~/.tesseron/instances/` for v2 manifests `:477`
  and `~/.tesseron/tabs/` for v1 compat `:562`, with `fs.watch` `:597` plus an unref'd 2 s polling
  fallback `:630`.
- **Stop** = `stop()` `:325` — sweeps unclaimed claim breadcrumbs, closes session transports, clears
  zombie timers, closes watchers and dialed connections.
- Emits `sessions-changed` and `gateway-log`.

Constants: `DEFAULT_RESUME_TTL_MS = 4h` `:115`, `DEFAULT_MAX_ZOMBIES = 100` `:122`.

### Dialers (`src/dialer.ts`)

Gateway → app, always. `WsDialer` `:67` uses subprotocol `tesseron-gateway` `:12` plus optional
`tesseron-bind.<code>` `:77`. `UdsDialer` `:162` uses NDJSON line framing `:190` with a
`tesseron/bind` first frame `:247`. Both expose `isClosed()` `:133`, `:299`.

`dial()` is **synchronous by contract** (`:33`) so the gateway can register `onMessage` before an
in-process peer fires `tesseron/hello`. Enforced at `gateway.ts:430`.

### MCP projection (`src/mcp-bridge.ts`)

Five meta tools, all prefixed `tesseron__` (`:31-35`):

| Tool | Defined | Handled |
|---|---|---|
| `tesseron__claim_session` | `:48` | `:752` |
| `tesseron__list_actions` | `:68` | `:582` |
| `tesseron__invoke_action` | `:78` | `:376` |
| `tesseron__read_resource` | `:106` | `:719` |
| `tesseron__list_pending_claims` | `:128` | `:640` |

Actions project to per-app tools `<app_id>__<action>` (`:852`, separator `__` at `:36`). Resources
project to `tesseron://<app_id>/<name>`, mimeType `application/json` (`:870`). What gets listed
depends on `TESSERON_TOOL_SURFACE`: the claim tool always, meta tools when `meta|both`, per-app
tools when `dynamic|both` (`:340`).

Progress forwards to `notifications/progress` **only when the caller supplies
`_meta.progressToken`** (`:404`), with a monotonic cursor per token (`:419`). Errors carry
`TesseronError.code` and `data` as MCP `structuredContent` (`:911`).

## `@tesseron/docs-mcp` — binary `tesseron-docs-mcp`

Three tools, built with the higher-level `McpServer` (contrast with `gateway/`, which uses raw
`Server` + request schemas): `list_docs` (`src/server.ts:31`), `search_docs` (`:52`, default limit 8),
`read_doc` (`:84`, unknown slug → `isError`). Plus a resource template `tesseron-docs://{+slug}`
(`:121`). Only CLI flag: `--snapshot <path>` (`src/cli.ts:6`).

### The build-time snapshot, and its coupling

Docs are baked into a JSON artifact at build time. The published package contains no markdown and
never reads `docs/` at runtime.

- Script: `docs-mcp/scripts/build-snapshot.ts`.
- Source path is **hardcoded relative to the package**:
  `resolve(packageRoot, '..', '..', 'docs', 'src', 'content', 'docs')` (`:9`), and it **hard-throws**
  if that directory is missing (`:27`). So `@tesseron/docs-mcp` cannot be built outside the
  monorepo, and renaming `docs/src/content/docs/` breaks the build.
- Output: `docs-mcp/dist/docs-index.json` (`:12`), minified, ~476 KB for 43 pages.
  `version` is `git rev-parse --short HEAD`, falling back to `'dev'` (`:14`).
- Runs on every build: `"build": "pnpm build:snapshot && tsup"` and `prepublishOnly` (`package.json:41`).

**The trap:** turbo's `build` task declares only `dependsOn: ["^build"]` and `outputs: ["dist/**"]`
(`turbo.json:4`). Nothing in the graph re-runs the snapshot when `docs/` changes, so **a docs edit
does not invalidate this package's turbo cache.** That is the mechanism by which stale docs ship to
end users, and it is why the docs-sync hook exists.

`dist/` is gitignored, so a fresh clone must build before the docs server works.

Search is MiniSearch 7 (`src/search.ts:1`), indexed **in memory at process start** (`:20`) — the
on-disk artifact is the corpus, not a serialized index. Fields `title`/`description`/`bodyText`,
boost `title: 3, description: 2`, `fuzzy: 0.15`, `prefix: true` (`:22`).
