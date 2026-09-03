# Tesseron codebase map

*Last Updated: 2026-09-03*

Tesseron exposes typed app actions to MCP-compatible AI agents over WebSocket. No browser
automation, no scraping. pnpm + turbo monorepo in a **hub layout** since 2026-09-03: the TypeScript
SDK (seven packages plus 6 example apps) under `sdks/typescript/`, the gateway at `gateway/`, the
docs server at `docs-mcp/`, a Starlight docs site, a language-neutral conformance corpus with an executable runner
(`@tesseron/conformance`), and a version-coupled Claude Code plugin. 9 published packages at 2.10.1 (eight in one changesets `fixed`
group, docs-mcp released separately). A Rust SDK (`tesseron` 0.1.0, unpublished) lives at
`sdks/rust/` and passes the handshake and resume fixtures; Python and C++ follow the same
`sdks/<language>/` path, and each language later gets its own repo.

**The one thing to know:** the app listens and the gateway dials *out* to it. `@tesseron/mcp` has no
port and no `start()`; it watches `~/.tesseron/instances/` for manifests the app wrote.

| Doc | Read it when |
|---|---|
| [architecture.md](architecture.md) | the three moving parts, one invocation end to end, claiming, sessions |
| [protocol.md](protocol.md) | wire format, methods, notifications, error codes, handshake, resume |
| [modules.md](modules.md) | what each package owns; core vs the consumer SDKs; the Rust crate |
| [gateway.md](gateway.md) | `@tesseron/mcp` internals, MCP projection, and the docs-mcp snapshot |
| [entry-points.md](entry-points.md) | binaries, the five core entry points, where execution begins |
| [directory-structure.md](directory-structure.md) | annotated tree, dependency fan, things that aren't where you'd guess |
| [tech-landscape.md](tech-landscape.md) | stack, strictness flags, deps, CI workflows |
| [coding-style.md](coding-style.md) | Biome config and the conventions the code actually follows |
| [patterns.md](patterns.md) | reconnection guards, error propagation, security posture |
| [testing.md](testing.md) | what `pnpm test` covers, the three packages it skips, the conformance corpus |
| [release-and-plugin.md](release-and-plugin.md) | the 8-package fixed group and the 8-surface version contract |
| [onboarding.md](onboarding.md) | setup, the loop, common tasks, traps |

Conventions live in [`AGENTS.md`](../../AGENTS.md) at the repo root. This map describes the code;
AGENTS.md states the rules.

## How to use this map

Read the doc that matches your task before exploring with Glob and Grep. Every claim here carries a
`file:line`, so jump straight to the anchor. If the map and the code disagree, the code wins and the
map is stale.

## How to maintain it

After a change that moves architecture, public surface, or conventions, run
`update-codebase-map` rather than re-running `map-codebase`. Keep this INDEX short: it is injected
into context at the start of every session, so length here is a recurring tax. Detail belongs in the
linked docs.
