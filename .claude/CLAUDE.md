# Plugin & Skill Strategy Guide

Strategies for the plugins enabled on this machine, at both user-level (`~/.claude/settings.json`) and project-level (`.claude/settings.json`). Written to keep future sessions from re-deriving what each plugin does and how to compose them. All claims are grounded in each plugin's own files; verify anything that looks stale before acting on it.

## Active plugins

| Scope | Plugin | Marketplace |
|-------|--------|-------------|
| user | secrets-vault | claude-ai-workshop |
| user | reddit-researcher | claude-ai-workshop |
| project | codebase-mapper | claude-ai-workshop |
| project | typescript-lsp | claude-plugins-official |
| project | mcp-server-dev | claude-plugins-official |
| project | skill-creator | claude-plugins-official |
| project | plugin-dev | claude-plugins-official |
| project | superpowers-developing-for-claude-code | superpowers-marketplace |
| project | developer-kit-typescript | developer-kit |

Claude Desktop also bundles two always-on plugins from `~/AppData/Roaming/Claude/local-agent-mode-sessions/…`: `anthropic-skills` (docx, xlsx, pptx, pdf, canvas-design, algorithmic-art, skill-creator, plus Desktop-only extras like calculator, research, youtube, music21, consolidate-memory, setup-cowork, schedule) and `design` (design-critique, accessibility-review, design-system, design-handoff, research-synthesis, ux-copy, user-research). They're not managed by `~/.claude/settings.json`; treat them as first-class defaults.

## Quick decision tree

- **Building a plugin** → `/plugin-dev:create-plugin` for the guided 8-phase flow; drop into `plugin-dev:*` skills (skill-development, hook-development, command-development, agent-development, mcp-integration, plugin-settings, plugin-structure) only for the specific component you're writing. Lean on the `plugin-validator` and `skill-reviewer` agents before shipping.
- **Need official Claude Code docs or the full release workflow** → `superpowers-developing-for-claude-code:working-with-claude-code` (42 reference docs) or `developing-claude-code-plugins` (6-phase workflow with working examples). Prefer superpowers when you want comprehensive context; prefer `plugin-dev` when you want focused progressive disclosure on one component.
- **Building an MCP server** → always start with `mcp-server-dev:build-mcp-server` (entry point that routes by deployment model); hand off to `build-mcp-app` (UI widgets) or `build-mcpb` (bundled stdio distribution) only if that deployment fits.
- **Creating / editing / benchmarking a skill** → `skill-creator@claude-plugins-official`. Expect a draft → test → eval → iterate loop; honor "vibe mode" if the user declines evals.
- **Mapping or documenting a codebase** → `codebase-mapper:map-codebase` on first touch, `update-codebase-map` after changes. A `UserPromptSubmit` hook auto-injects `.claude/.codebase-info/INDEX.md` once it exists — don't re-paste it manually.
- **TypeScript / NestJS / React / Next.js / Nx / Drizzle / Zod / Tailwind / shadcn work** → the `developer-kit-typescript` skills auto-trigger on keywords; hooks auto-run on writes. Use `/devkit.typescript.code-review`, `/devkit.react.code-review`, or `/devkit.ts.security-review` for explicit audits.
- **Reddit research** → invoke the `reddit-researcher:orchestration` skill; YOU coordinate the five specialized sub-agents (post-researcher, sentiment-analyzer, subreddit-analyzer, user-profiler, trend-detector) in parallel. Do not call Reddit MCP tools directly.
- **User mentions an API key / token / credential, or asks to recall one** → `secrets-vault:secrets-management` handles detection and retrieval; secrets land in `~/.claude/secrets.local.md` (Base64, not encrypted).
- **Docx / xlsx / pptx / pdf / poster / generative art / design critique / accessibility audit / UX copy** → the `anthropic-skills:*` or `design:*` bundle (Claude Desktop) auto-triggers on the file type or keyword. No plugin setup needed.

## How skills load

Skills auto-activate from the keywords in their descriptions — describing the task usually triggers them, no explicit invocation needed. The prefix in the available-skills list tells you which source provided a skill; when two plugins ship the same skill name, the fully-qualified `plugin:skill` form disambiguates. `anthropic-skills:*` and `design:*` live outside `~/.claude/settings.json` because Claude Desktop bundles them directly.

## Per-plugin playbooks

### codebase-mapper @ claude-ai-workshop
- **Skills:** `map-codebase` (first-time full documentation into `.claude/.codebase-info/`), `update-codebase-map` (incremental refresh, requires existing INDEX.md).
- **Auto-hook:** `UserPromptSubmit` runs `inject-index.py` on every prompt once the index exists. The project context is in your context without action; don't re-derive it.
- **Strategy:** Run `map-codebase` once per repo, then `update-codebase-map` after significant refactors. Trust the injected INDEX — skim before diving into `Glob`/`Grep`.
- **Pitfall:** `update-codebase-map` errors out if `.claude/.codebase-info/` is missing; run `map-codebase` first.

### typescript-lsp @ claude-plugins-official
- **What it adds:** the `LSP` tool for `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, call-hierarchy queries on `.ts/.tsx/.js/.jsx/.mts/.cts/.mjs/.cjs`.
- **Setup (Windows, this machine):** install via **bun**, NOT npm — `bun add -g typescript-language-server typescript`. The Claude Code `LSP` tool spawns the language server via libuv's raw `uv_spawn`, which on Windows:
  1. Finds npm's bare unix-style shell-script shim (e.g. `C:\nvm4w\nodejs\typescript-language-server` with `#!/bin/sh`) first in PATH and fails because Windows can't exec a shell script.
  2. Even with that bare shim removed, Node's CVE-2024-27980 security fix blocks resolution of `.cmd` shims without `shell: true`, so libuv still returns `ENOENT`.
  - bun creates real `typescript-language-server.exe` binaries that libuv resolves cleanly. If both are installed, npm's dir is earlier in PATH and wins — `npm uninstall -g typescript-language-server typescript` so libuv falls through to the bun `.exe`.
  - **Diagnostic**: if `LSP` returns `ENOENT: no such file or directory, uv_spawn 'typescript-language-server'`, run `node -e "require('child_process').spawn('typescript-language-server', ['--version'], {shell:false}).on('error', console.log)"`. If it logs ENOENT, the shim chain is broken — reinstall via bun and uninstall the npm copy.
- **Setup (Linux/macOS):** `npm install -g typescript-language-server typescript` works fine — the libuv/`.cmd` issue is Windows-only.
- **Strategy:** prefer `LSP` over grep for "where is X defined / used / implemented" in TS code — it's precise and scoped; grep for string/regex patterns.
- **No skills or commands**, so nothing to invoke by name.

### mcp-server-dev @ claude-plugins-official
- **Skills:** `build-mcp-server` (discovery entry point; asks about connection target, users, action surface, auth), `build-mcp-app` (UI widgets inline in chat), `build-mcpb` (local stdio bundled with its runtime as a `.mcpb`).
- **Strategy:** always `build-mcp-server` first. It decides between remote HTTP, MCPB, local stdio, or MCP-app — getting this wrong early means rework. Only pivot to `build-mcp-app` or `build-mcpb` after the entry skill recommends them.
- **Pitfall:** don't bundle (`build-mcpb`) a purely-cloud API — remote HTTP is the preferred distribution path.

### skill-creator @ claude-plugins-official
- **Skill:** `skill-creator` — iterative draft → test → eval → iterate, with a final description-triggering optimizer.
- **Strategy:** extract the workflow from conversation history before drafting; run evals in parallel with writing the quantitative analysis; close with the description optimizer so the skill actually auto-triggers later.
- **Pitfall:** scope upfront — if the user says "just draft it, no evals", skip the eval phase; don't force the full loop.

### plugin-dev @ claude-plugins-official
- **Command:** `/plugin-dev:create-plugin` — guided 8-phase flow (discovery → plan → design → scaffold → implement → validate → test → docs). Auto-loads the relevant `plugin-dev:*` skill at each phase.
- **Skills (focused reference, load by topic):** `plugin-structure`, `skill-development`, `command-development`, `hook-development`, `agent-development`, `mcp-integration`, `plugin-settings`.
- **Agents:** `agent-creator` (generates agent YAML from a description), `plugin-validator` (runs proactively after plugin changes), `skill-reviewer` (runs proactively after skill changes).
- **Strategy:** `/plugin-dev:create-plugin` for greenfield plugins. For targeted work ("add a hook", "fix my skill description"), load the single topic skill — don't spin up the whole command. Let `plugin-validator` and `skill-reviewer` run before publishing; they're designed to self-trigger, so avoid redundant manual review.
- **Pitfall:** loading plugin-dev's topic skills at the same time as the superpowers plugin's comprehensive skill for the same sub-task doubles the context with overlap.

### superpowers-developing-for-claude-code @ superpowers-marketplace
- **Skills:** `working-with-claude-code` (42 official Claude Code reference docs + a quick-reference table + self-update script), `developing-claude-code-plugins` (6-phase workflow, polyglot hook wrapper, example plugins, versioning/distribution guidance).
- **Positioning vs plugin-dev:** use `developing-claude-code-plugins` when you want the whole arc (plan → create → test → release) with working examples; use `plugin-dev:*` when you want progressive disclosure on one component. Use `working-with-claude-code` when you need the authoritative official docs on any Claude Code feature (hooks, settings, CLI, IDE, GitHub Actions, security, networking, troubleshooting).
- **Strategy:** for a new plugin, start with `developing-claude-code-plugins`, then drop into `plugin-dev:*` skills for any component you want deeper coverage on.
- **Pitfall:** loading both this plugin and plugin-dev for the same task produces overlapping docs — pick one lane.

### developer-kit-typescript @ developer-kit
The opinionated one. Hooks auto-enforce conventions, so **work with them, not around them**.

- **Auto-run hooks (Python 3 required on PATH — otherwise these fail silently):**
  - `ts-session-context` (SessionStart) — injects git status, Nx affected projects, TS config.
  - `ts-dev-server-guard` (PreToolUse/Bash) — blocks `npm start`, `ng serve`, etc. during edit sessions.
  - `ts-file-validator` (PostToolUse/Write) — enforces kebab-case filenames, `.spec.ts` for tests.
  - `ts-pattern-validator` (PostToolUse/Write|Edit) — enforces NestJS module / DDD / React patterns.
  - `ts-rules-tracker` (PostToolUse/Write|Edit) — indexes which rules apply to modified files.
  - `ts-prettier-format` (PostToolUse/Write|Edit, async) — auto-formats after edits.
  - `ts-rules-verifier` (UserPromptSubmit) — validates pending rule violations before the next prompt.
  - `ts-quality-gate` (Stop) — runs `tsc` and ESLint on session exit; can block exit on violations.

- **Commands:** `/devkit.typescript.code-review` (full Nx/NestJS/React audit), `/devkit.react.code-review` (React 19 + Tailwind), `/devkit.ts.security-review` (npm audit + ESLint + Semgrep + deps).

- **Agents (natural-language trigger or command fallback):**
  - NestJS: `nestjs-backend-development-expert`, `-code-review-expert`, `-database-expert`, `-security-expert`, `-testing-expert`, `-unit-testing-expert`.
  - React / mobile: `react-frontend-development-expert`, `react-software-architect-review`, `expo-react-native-development-expert`.
  - TypeScript core: `typescript-refactor-expert`, `typescript-security-expert`, `typescript-software-architect-review`, `typescript-documentation-expert`.

- **Skills (auto-trigger by keyword):**
  - Framework: `nestjs`, `nestjs-best-practices`, `nestjs-drizzle-crud-generator`, `react-patterns`, `nextjs-app-router`, `nextjs-authentication`, `nextjs-data-fetching`, `nextjs-performance`, `nextjs-deployment`.
  - Infra / cloud: `aws-lambda-typescript-integration`, `aws-cdk`, `nx-monorepo`, `turborepo-monorepo`.
  - Patterns / validation: `clean-architecture`, `drizzle-orm-patterns`, `dynamodb-toolbox-patterns`, `zod-validation-utilities`.
  - UI: `shadcn-ui`, `tailwind-css-patterns`, `tailwind-design-system`.
  - Auth / tooling / review: `better-auth`, `typescript-docs`, `react-code-review`, `nestjs-code-review`, `nextjs-code-review`, `typescript-security-review`.

- **Rules:** live in the plugin's `rules/` directory and are **not** auto-copied into your project. To enforce them in a repo, copy the relevant files into `.claude/rules/` (or run the plugin's `make copy-rules PLUGIN=developer-kit-typescript`). Hooks verify rule compliance only if the rules are present.

- **Strategy:**
  1. Confirm Python 3 is on PATH before relying on hooks.
  2. Let the session-context hook inject project metadata — don't re-run `git status` manually at the start.
  3. Skills auto-trigger when you mention their domain keywords (e.g., "NestJS CRUD with Drizzle", "React 19 Server Action", "Nx monorepo boundary"). Don't force-invoke them.
  4. Use `/devkit.*` commands for explicit review gates; they delegate to the domain agents.
  5. Treat hook failures as signals, not obstacles — fix the violation rather than bypassing.

- **Pitfalls:** `ts-quality-gate` at Stop can block session exit on `tsc` / ESLint errors. Rules must be manually copied into `.claude/rules/` to take effect. Without Python 3 on PATH, the whole enforcement layer is inert.

### secrets-vault @ claude-ai-workshop (user-level)
- **Skill:** `secrets-management` auto-triggers on secret patterns (`sk-…`, `ghp_…`, `AKIA…`, `xoxb-…`, `AIza…`, 32+-char strings) and retrieval phrases ("what was my OpenAI key", "find my GitHub token").
- **Storage:** global `~/.claude/secrets.local.md`, Base64-obfuscated (not encrypted).
- **Strategy:** when a user shares a secret, proactively offer to store it with description / purpose / tags so later retrieval by fuzzy search works.
- **Pitfalls:** Base64 is obfuscation, not encryption — treat the file as sensitive. Secrets are shared across all projects; there is no per-project isolation.

### reddit-researcher @ claude-ai-workshop (user-level)
- **Skill:** `reddit-researcher:orchestration` is the only skill YOU load; the others (`content-analysis`, `research-workflows`, `reddit-api-fundamentals`) are internal to the specialized sub-agents.
- **Sub-agents (you coordinate in parallel, never invoke from user-facing turns directly):** `post-researcher`, `sentiment-analyzer`, `subreddit-analyzer`, `user-profiler`, `trend-detector`.
- **Strategy:** on any Reddit question, the orchestration skill teaches you to decompose into atomic <10k-token tasks and launch 2–5 sub-agents in a single parallel Agent batch. Infer relevant subreddits from the topic (no separate discovery phase). Synthesize the returned text into the final answer.
- **Pitfalls:**
  - **Do not call the Reddit MCP tools directly** from the main thread — always go through sub-agents.
  - Sub-agents must return findings as text; writing files risks 256KB context-overflow errors.
  - There is no `search_subreddits` tool — infer subreddit names.
  - Don't spawn a separate "research-orchestrator" agent; the main thread IS the orchestrator.

## Composition patterns

- **New repo onboarding:** `map-codebase` first → use the injected INDEX for planning → `developer-kit-typescript` hooks + skills carry day-to-day work → `/devkit.typescript.code-review` before merging.
- **New plugin from scratch:** `superpowers-developing-for-claude-code:developing-claude-code-plugins` for the workflow overview → `/plugin-dev:create-plugin` for the hands-on scaffold → `plugin-dev:*` skills for deep-dives → `plugin-validator` / `skill-reviewer` agents before publishing.
- **New MCP server:** `mcp-server-dev:build-mcp-server` for deployment choice → `build-mcp-app` or `build-mcpb` as that decision dictates. If wrapping the result in a plugin, follow the plugin flow above.
- **New skill:** `skill-creator@claude-plugins-official` for the draft+eval loop.
- **Reddit research report:** `reddit-researcher:orchestration` loads → you plan a parallel fan-out of 2–5 sub-agents → synthesize returned text.
- **Secrets flow:** user shares secret → secrets-vault stores with metadata → later retrieval is keyword-based across description / purpose / tags.

## Guardrails

- Keep `.claude/settings.local.json` in gitignore if this repo is pushed publicly — it is user-local permission state.
- Don't commit `~/.claude/secrets.local.md` anywhere, ever; it's global and Base64-obfuscated only.
- Don't bypass `developer-kit-typescript` hooks; fix the underlying violation.
- Don't call Reddit MCP tools from the main thread.
- Don't re-run `map-codebase` when `update-codebase-map` is sufficient.
