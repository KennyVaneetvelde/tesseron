---
description: Eight packages release as one fixed version; docs-mcp releases alone
globs: ["sdks/typescript/*/package.json", "gateway/package.json", ".changeset/**"]
prompt: ["release", "publish", "changeset", "version bump", "ship it"]
priority: 60
---
`.changeset/config.json` puts `@tesseron/core`, `/web`, `/server`, `/react`, `/mcp`, `/svelte`,
`/vue`, and `/vite` in one `fixed` group. They all carry the same version and bump together; you
can't ship one on its own, and dropping a package from the group is a public API decision, not a
cleanup.

`@tesseron/docs-mcp` is deliberately **outside** that group. It ships the build-time docs snapshot
rather than protocol code, and its content changes on a completely different cadence, so a prose
correction releases on its own instead of forcing a bump across all eight SDK packages. Give it its
own changeset. Do not "fix" this by adding it back.

- Any user-visible change under `sdks/typescript/` or `gateway/` needs a fixed-group changeset:
  `pnpm changeset`.
- Never hand-edit a `version` field in `sdks/typescript/*/package.json` or
  `gateway/package.json`. `changeset version` owns it, via `pnpm version-packages`, which also runs
  the plugin version sync and Biome.
- Examples and `@tesseron/docs` are in the changesets `ignore` list. They don't get changesets.
- `.github/workflows/release.yml` publishes through `changesets/action@v1`. Don't publish by hand.
- That workflow pins `npm@^11.5.1` on purpose. npm 12 dropped Node 20, and `npm@latest` silently
  broke every release from 2026-06-10 until it was caught. Raise the pin only with `node-version`.
