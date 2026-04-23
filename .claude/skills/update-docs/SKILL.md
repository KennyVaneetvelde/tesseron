---
name: update-docs
description: >-
  Use this skill after any change to `packages/**` source that shifts
  Tesseron's public surface - protocol messages, exported types, action/resource
  builder APIs, ActionContext methods, transports, gateway CLI flags, or React
  hooks - to sync `docs/src/content/docs/` so the Starlight site matches the
  code. Triggers on "update the docs", "sync docs", "docs are stale after this
  change", or when a session ends with public-surface edits unaccompanied by
  doc edits. Do NOT trigger for test-only, tooling-only, or internal refactors
  that leave the public surface identical.
---

# Update Tesseron docs

Keep `docs/src/content/docs/` aligned with whatever just changed in `packages/**`. The docs are the published Starlight site and the contract Tesseron users read, so drift here is user-visible.

## Prerequisites

- A recent edit to `packages/**` (use `git diff` / `git diff --stat HEAD` to see the change set).
- The docs tree at `docs/src/content/docs/`. If it's missing, stop and flag it.

## Doc pages and what they own

| Page | Owns |
|------|------|
| `overview/index.mdx` (the root `index.mdx`) | Elevator pitch, hero copy, top-level links. Rarely changes. |
| `overview/architecture.mdx` | Three-process model diagram, protocol boundary descriptions. |
| `overview/quickstart.mdx` | The 5-minute path: install, declare one action, run the gateway, see Claude call it. |
| `overview/why.md` | Positioning vs browser automation / Playwright / chat widgets. |
| `protocol/index.mdx` | One-page protocol overview. Update when a new top-level concept lands. |
| `protocol/wire-format.mdx` | JSON-RPC envelope, method names, id rules. |
| `protocol/transport.md` | WebSocket URL, framing, origin allowlist, reconnect behavior. |
| `protocol/handshake.mdx` | `tesseron/hello`, `welcome`, claim code, `tools/list_changed`. |
| `protocol/actions.mdx` | Action declaration, namespacing, invoke / validate / return. |
| `protocol/progress-cancellation.mdx` | `actions/progress`, AbortSignal, `actions/cancel`. |
| `protocol/sampling.mdx` | Handler re-entry into the agent's LLM. |
| `protocol/elicitation.mdx` | `ctx.confirm` and `ctx.elicit`. |
| `protocol/resources.mdx` | Readable / subscribable resource projection. |
| `protocol/errors.mdx` | Every defined error code and what raises it. |
| `protocol/lifecycle.mdx` | Session state machine, what happens to pending work. |
| `protocol/security.mdx` | Origin enforcement, claim flow, trust boundaries. |
| `sdk/typescript/index.mdx` | Install, `packages/` landscape, first action snippet. |
| `sdk/typescript/action-builder.md` | `tesseron.action(...)` fluent API. |
| `sdk/typescript/standard-schema.md` | Zod / Valibot / etc. adapter plumbing. |
| `sdk/typescript/context.md` | `ActionContext` methods: progress, sample, confirm, elicit, signal. |
| `sdk/typescript/resources.md` | `tesseron.resource(...)` builder, subscribe contract. |
| `sdk/typescript/core.md` | `@tesseron/core` exports, custom transport extension points. |
| `sdk/typescript/web.md` | `@tesseron/web` browser adapter. |
| `sdk/typescript/server.md` | `@tesseron/server` Node adapter. |
| `sdk/typescript/react.md` | `useTesseronAction`, `useTesseronResource`, `useTesseronConnection`. |
| `sdk/typescript/mcp.md` | `@tesseron/mcp` gateway CLI, config, origin allowlist. |
| `sdk/python/index.md` | Planned Python SDK - only update when roadmap changes. |
| `sdk/porting.md` | How to port Tesseron to another language. |
| `examples/index.mdx` | Table of the example apps. |
| `examples/<name>.md` | Individual example app walk-through. |

## Process

### Step 1 - Inspect the change set

Run these in one go:

```bash
git status --short
git diff --stat HEAD
git diff HEAD -- packages/
```

Focus on exported symbols, public types, protocol method names, CLI flags, and `.md`/`.mdx` snippets inside packages. Ignore changes under `**/*.test.ts`, `**/*.spec.ts`, `**/__tests__/**`, `tsconfig*.json`, `biome*.json`, `.changeset/`, and CI config - those don't require doc updates.

### Step 2 - Map changes to doc pages

For each modified public surface, find the doc pages that own it via the table above. Also `rg` across `docs/src/content/docs/` for the renamed / changed symbol to catch incidental mentions the owner table misses:

```bash
rg --fixed-strings "oldSymbolName" docs/src/content/docs/
```

### Step 3 - Edit the affected pages only

- Prefer `Edit` over `Write`. Targeted edits keep diffs reviewable.
- Preserve frontmatter (`title`, `description`). They feed both the sidebar and the injected docs index.
- Keep Starlight components intact: `Diagram`, `Card`, `CardGrid`, `LinkCard`, `Code`, `Tabs`, etc.
- Don't introduce em-dashes (`-`) in user-facing prose - use `-` or periods. Matches project voice.
- Update version numbers / package exports only when the actual package boundary shifted.

### Step 4 - Update frontmatter `description` if the page focus shifted

The hook at `.claude/hooks/inject-docs-index.py` derives the injected index from `description` fields. If a page's scope changed materially (e.g., a method was promoted or removed), rewrite the `description` so it stays a one-line summary of what the page now covers.

### Step 5 - Verify

```bash
cd docs && npx astro check
```

`astro check` catches broken frontmatter, bad component usage, and broken relative links. If the build is already wired into CI, rely on that instead; otherwise run it locally.

### Step 6 - Report back

End your turn with a bullet list:

- Modified packages: `packages/...`
- Docs updated: `docs/src/content/docs/...`
- Docs reviewed but unchanged (and why)

## What NOT to update

- `.changeset/` files - maintained by the release workflow, not by this skill.
- `README.md` at repo root - stays in sync by hand; mention in your report if it looks stale so the user decides.
- The Starlight `sidebar` in `docs/astro.config.mjs` - only touch when a new page is added or a page is deleted, and even then prefer a note in the report so the user confirms ordering.
- Auto-generated TypeDoc / API reference output (if any).

## Success criteria

- [ ] Every public-surface change is reflected in at least one doc page.
- [ ] No orphaned references to removed / renamed symbols remain in `docs/`.
- [ ] Frontmatter `title` / `description` accurate on every touched page.
- [ ] `astro check` passes (or CI equivalent).
- [ ] Report lists modified packages, updated docs, and reviewed-but-unchanged docs.
