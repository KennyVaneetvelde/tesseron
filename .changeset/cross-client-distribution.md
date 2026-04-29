---
"@tesseron/mcp": patch
---

Cross-client plugin distribution. The Claude Code plugin no longer ships a pre-bundled gateway under `plugin/server/`; instead `plugin/.mcp.json` invokes `@tesseron/mcp` and `@tesseron/docs-mcp` via `npx -y <pkg>@<version>` with the version pinned to the plugin's own. This adds a one-time cold-start cost on first launch but matches the canonical distribution form every other major MCP server uses (filesystem, sequential-thinking, Playwright, Chrome DevTools, Sentry, Supabase) and unblocks the same plugin for Codex (`.agents/plugins/marketplace.json` + `.claude-plugin/plugin.json` fallback) and OpenCode (`opencode.json` snippet documented in the plugin README).

The two former subagents (`tesseron-explorer`, `tesseron-reviewer`) are now skills under `plugin/skills/`, since SKILL.md is the only customization primitive that auto-triggers identically across Claude Code, Codex, and OpenCode. Subagent runtime semantics differ across clients; skills do not.

`AGENTS.md` is added at the repo root for cross-client agent instructions; `CLAUDE.md` reduces to a single `@AGENTS.md` include.

No published-package source changed. The lockstep group bumps so the version pin in `plugin/.mcp.json` resolves to a real npm release.
