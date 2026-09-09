# Tesseron codebase map

*Last Updated: 2026-09-09*

Tesseron exposes typed app actions to MCP-compatible AI agents over WebSocket. No browser
automation, no scraping. This repo is the **hub** (pnpm + turbo): the gateway at `gateway/`
(`@tesseron/mcp` 2.10.2), the docs server at `docs-mcp/` (`@tesseron/docs-mcp` 2.10.2), the
language-neutral conformance corpus with its executable runner at `conformance/`
(`@tesseron/conformance` 1.2.1), the Starlight docs site, and the version-coupled Claude Code plugin.
Three published packages, each released on its own; `.changeset/config.json` has `fixed: []`.

The SDKs left the hub on 2026-09-08 (SQ-52). Each lives in its own repo under the Eigenwise org:
`tesseron-typescript` (the seven `@tesseron/*` packages at 2.10.2, one changesets fixed group
there), `tesseron-rust` (crate `tesseron` 0.2.0), `tesseron-python` (PyPI `tesseron` 0.1.0), and
`tesseron-cpp` (CMake `FetchContent`, target `tesseron::tesseron`). The gateway depends on
`@tesseron/core` from the registry (`gateway/package.json:51`), not on a workspace link.

**Path convention in this map:** a path that starts with `tesseron-<language>/` is inside that
language repo (the split kept each tree's layout, so `tesseron-typescript/core/src/client.ts` is
`core/src/client.ts` there). Every other path is in this hub.

**The one thing to know:** the app listens and the gateway dials *out* to it. `@tesseron/mcp` has no
port and no `start()`; it watches `~/.tesseron/instances/` for manifests the app wrote.

| Doc | Read it when |
|---|---|
| [architecture.md](architecture.md) | the three moving parts, one invocation end to end, claiming, sessions |
| [protocol.md](protocol.md) | wire format, methods, notifications, error codes, handshake, resume |
| [modules.md](modules.md) | what each package owns; the gateway's view of core; where each SDK repo picks up |
| [gateway.md](gateway.md) | `@tesseron/mcp` internals, MCP projection, and the docs-mcp snapshot |
| [entry-points.md](entry-points.md) | binaries, the five core entry points, where execution begins |
| [directory-structure.md](directory-structure.md) | annotated tree, dependency fan, things that aren't where you'd guess |
| [tech-landscape.md](tech-landscape.md) | stack, strictness flags, deps, CI workflows |
| [coding-style.md](coding-style.md) | Biome config and the conventions the code actually follows |
| [patterns.md](patterns.md) | reconnection guards, error propagation, security posture |
| [testing.md](testing.md) | what `pnpm test` covers, the conformance corpus and how the SDK repos run it |
| [release-and-plugin.md](release-and-plugin.md) | three independent hub releases and the 8-surface plugin version contract |
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
