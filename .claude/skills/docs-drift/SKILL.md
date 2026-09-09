---
name: docs-drift
description: Check whether the hub docs kept up with the four SDK repositories (tesseron-typescript, tesseron-rust, tesseron-python, tesseron-cpp) and the published hub packages. Use before or after an SDK release, when asked "are the docs stale", "did the docs keep up with the release", "which docs pin an old version", or as the release gate that backs the AGENTS.md rule that an SDK release PR is complete only after its hub docs PR merged.
---

# docs-drift

Run from the hub root:

```sh
pnpm docs:drift
```

`scripts/docs-drift.mjs` prints two tables and exits 1 on any finding.

**SDK table.** One row per language. "released" is the latest version on the registry that owns the SDK
(npm `@tesseron/core` for TypeScript, crates.io `tesseron` for Rust, PyPI `tesseron` for Python, the latest
GitHub tag for C++). "hub docs last touched" is the last commit under `docs/src/content/docs/sdk/<lang>/`.
A release published after that commit is `DRIFT: release newer than docs`, meaning the AGENTS.md rule was
broken: the SDK shipped and the hub docs never followed.

**Pin table.** Every literal `@tesseron/<pkg>@<semver>` inside a fenced code block under
`docs/src/content/docs/`, compared with the package's npm latest. Code blocks are what readers copy;
prose pins ("default since `@tesseron/mcp@2.4.0`") are history and are skipped on purpose.
`scripts/sync-plugin-version.mjs` owns the pin on `sdk/typescript/mcp.md`; every other docs pin drifts on its own.

**Blind spot.** It measures dates and version strings only. A docs commit that lands after a release but
says nothing about it counts as ok. Prose drift still needs `update-docs`.

Fixing a finding is a docs content change, so it needs a `@tesseron/docs-mcp` changeset.
