---
name: tesseron-docs
description: Authoritative Tesseron documentation lookup via the `@tesseron/docs-mcp` MCP server. Calls `search_docs` to find relevant pages and `read_doc` to fetch the full markdown body when the user asks precision questions about Tesseron protocol or SDK behaviour. Triggers on requests that need an exact spec, not an overview — wire format (JSON-RPC envelopes, `tesseron/hello`, `tesseron/welcome`, `tesseron/resume`, `actions/progress`, `actions/cancel`), transport framing, handshake and claim-code flow, session resume and resumeToken, lifecycle transitions, sampling contract, elicitation contract (`ctx.confirm`, `ctx.elicit`), progress + cancellation via `AbortSignal`, error codes (`TesseronErrorCode`, `SamplingNotAvailableError`, `ElicitationNotAvailableError`, `TimeoutError`, `CancelledError`, `ResumeFailedError`), capability negotiation, origin allowlist, multi-app namespacing, MCP gateway config, Standard Schema (Zod, Valibot, Typebox) integration, action-builder steps, resource read/subscribe, React hook semantics. Use phrases like "what error code does X return", "what does tesseron/hello look like", "exact handshake shape", "resumeToken flow", "gateway origin allowlist", "show me the spec for", "what fields does X accept". The `framework` skill handles orientation and the mental model; `tesseron-docs` handles chapter-and-verse questions.
---

# Tesseron docs

This skill is the on-demand, authoritative lookup path for Tesseron documentation. Whenever precision matters (exact wire-format envelope, specific error code, fields a handshake carries, structural contract of resume) prefer calling the MCP tools below over recalling from memory or the `framework` skill's cheat sheet.

## How to use

The plugin bundles `@tesseron/docs-mcp` at install time, so these tools are normally already connected in Claude Code as `mcp__plugin_tesseron_tesseron-docs__*`:

1. **Search first.** Call `search_docs({ query, limit })` with the user's question as-is (or a short paraphrase that keeps the load-bearing nouns). It returns ranked hits with `slug`, `title`, `description`, `score`, and a ~240-char `snippet`. `limit` defaults to 8 and caps at 20; 4-8 is the sweet spot.

2. **Read the top hit.** Call `read_doc({ slug })` on the first promising hit. It returns the full markdown body plus structured frontmatter (`title`, `description`, `section`, `related`). Quote the exact spec text into your answer instead of paraphrasing it.

3. **Walk the graph if the answer is cross-cutting.** The `related` field in `read_doc`'s response is a slug list. Follow those edges with more `read_doc` calls when a single page does not cover the question. Typical example: `protocol/resume` is incomplete without `protocol/handshake` and `protocol/transport`.

4. **Fall back to `list_docs` only** when the user wants the full catalogue ("what are all the protocol pages?") or when `search_docs` keeps missing the page you expect.

## When *not* to use this skill

- For orientation or mental-model questions ("what is Tesseron?", "how does the SDK fit together?", "which consumer package should I use?") — load the `framework` skill. That skill is a cheat sheet; this one is a manual.
- For project-integration tasks ("add Tesseron to this app", "switch to `@tesseron/react`", "upgrade versions") — load the `tesseron-dev` skill.
- For codebase mapping or review — invoke the `tesseron-explorer` or `tesseron-reviewer` subagent. They read the project, not the docs.

## Fallbacks when the MCP server is not configured

If calls to `mcp__plugin_tesseron_tesseron-docs__*` fail (e.g. the user has disabled the MCP server) fall back in order:

1. Read directly from `docs/src/content/docs/**/*.{md,mdx}` if the workspace is the Tesseron monorepo itself.
2. Fetch the deployed site: `https://brainblend-ai.github.io/tesseron/llms-full.txt` has the complete docs as plain text; `https://brainblend-ai.github.io/tesseron/<section>/<slug>/` serves the rendered page.
3. Defer to the `framework` skill's bundled reference files (`plugin/skills/framework/references/*.md`).

Never answer precision questions from training data alone without noting that you could not retrieve the current spec.

## Citing sources

When you read a page via `read_doc`, cite it by slug and link the hosted URL so the user can verify. Example:

> Per `protocol/handshake` (https://brainblend-ai.github.io/tesseron/protocol/handshake/), the welcome frame carries `sessionId`, `claimCode`, `resumeToken`, and the negotiated `capabilities`.

The slug is stable; the published URL tracks the same path.
