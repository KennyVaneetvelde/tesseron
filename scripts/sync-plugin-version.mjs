#!/usr/bin/env node
/**
 * Sync the Claude Code plugin manifest versions to the packages they pin.
 *
 * The plugin's gateway IS `@tesseron/mcp`; the two should never disagree. This
 * script is the contract that keeps them in lockstep, run as part of
 * `pnpm version-packages` so changesets-driven bumps automatically carry
 * through to the manifest.
 *
 * Two versions, not one. `@tesseron/mcp` is in the changesets `fixed` group and
 * defines the *plugin* version. `@tesseron/docs-mcp` left that group because it
 * ships prose rather than protocol code, so a docs correction no longer forces
 * a bump across every SDK package. It therefore carries its own version, and
 * only the surfaces that literally name it follow it.
 *
 * Eight surfaces move together:
 *   - plugin/.claude-plugin/plugin.json#version           → @tesseron/mcp
 *   - .claude-plugin/marketplace.json#metadata.version    → @tesseron/mcp
 *   - .claude-plugin/marketplace.json#plugins[0].version  → @tesseron/mcp
 *   - .agents/plugins/marketplace.json#plugins[0].version → @tesseron/mcp
 *   - plugin/.mcp.json#mcpServers.tesseron.args           → @tesseron/mcp
 *   - plugin/.mcp.json#mcpServers.tesseron-docs.args      → @tesseron/docs-mcp
 *   - README.md  (every literal `@tesseron/{mcp,docs-mcp}@<semver>`, each to its own package)
 *   - plugin/README.md  (same)
 *
 * Bumping only one leaves the other surfaces stale and users running an older
 * gateway under a fresh manifest. That's issue #38.
 *
 * Exit codes:
 *   0  no drift (or rewrote drift, in default mode)
 *   1  --check mode and drift detected (CI guard)
 *   2  unrecoverable: a manifest is missing, malformed, or structurally wrong
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_PKG = resolve(repoRoot, 'gateway/package.json');
const DOCS_MCP_PKG = resolve(repoRoot, 'docs-mcp/package.json');
const PLUGIN_MANIFEST = resolve(repoRoot, 'plugin/.claude-plugin/plugin.json');
const MARKETPLACE_MANIFEST = resolve(repoRoot, '.claude-plugin/marketplace.json');
const CODEX_MARKETPLACE_MANIFEST = resolve(repoRoot, '.agents/plugins/marketplace.json');
const PLUGIN_MCP_JSON = resolve(repoRoot, 'plugin/.mcp.json');
// READMEs whose install snippets pin literal `@tesseron/{mcp,docs-mcp}@<semver>`
// strings. These are not JSON, so the script rewrites them as text via regex.
const README_TARGETS = [resolve(repoRoot, 'README.md'), resolve(repoRoot, 'plugin/README.md')];

// `<bin-package>@<version>` arg slots in plugin/.mcp.json. Each server pins the
// package it actually runs, so the gateway follows the plugin version while the
// docs server follows its own.
const MCP_NPX_TARGETS = [
  { server: 'tesseron', pkg: '@tesseron/mcp' },
  { server: 'tesseron-docs', pkg: '@tesseron/docs-mcp' },
];

const checkMode = process.argv.includes('--check');

/**
 * Read JSON; exit 2 with a clear message on missing-file or parse failure so
 * CI can distinguish "broken setup" (2) from "drift" (1) from "clean" (0).
 * Without this, an unreadable file surfaces as Node's default unhandled-
 * rejection exit code 1 — colliding with the drift signal.
 */
async function readJson(path) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    console.error(`[sync-plugin-version] failed to read ${path}: ${err.message}`);
    process.exit(2);
  }
  try {
    return { data: JSON.parse(raw), raw };
  } catch (err) {
    console.error(`[sync-plugin-version] ${path} is not valid JSON: ${err.message}`);
    process.exit(2);
  }
}

/** Stringify with 2-space indent + trailing newline (matches the repo's Biome formatter). */
function serialize(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

async function readPackageVersion(path) {
  const { data } = await readJson(path);
  if (typeof data.version !== 'string' || data.version.length === 0) {
    console.error(`[sync-plugin-version] could not read version from ${path}`);
    process.exit(2);
  }
  return data.version;
}

/** The plugin's own version: the gateway and the plugin manifest are one artifact. */
const target = await readPackageVersion(MCP_PKG);

/**
 * Version each pinned package resolves to. `@tesseron/docs-mcp` releases on its
 * own cadence, so surfaces that name it must not inherit the plugin version.
 */
const versionByPackage = {
  '@tesseron/mcp': target,
  '@tesseron/docs-mcp': await readPackageVersion(DOCS_MCP_PKG),
};

const drift = [];

// 1. plugin/.claude-plugin/plugin.json
{
  const { data, raw } = await readJson(PLUGIN_MANIFEST);
  if (data.version !== target) {
    drift.push({
      file: PLUGIN_MANIFEST,
      from: data.version,
      to: target,
      next: serialize({ ...data, version: target }),
      currentRaw: raw,
    });
  }
}

// 2 + 3. .claude-plugin/marketplace.json — metadata.version AND plugins[0].version
{
  const { data, raw } = await readJson(MARKETPLACE_MANIFEST);
  // Validate shape up front — optional chaining alone would let a missing
  // `plugins` array fall through to the rewrite path and produce a manifest
  // with no plugins listing. That'd be silent corruption, not drift.
  if (typeof data.metadata !== 'object' || data.metadata === null) {
    console.error(`[sync-plugin-version] ${MARKETPLACE_MANIFEST}: \`metadata\` must be an object`);
    process.exit(2);
  }
  if (!Array.isArray(data.plugins) || data.plugins.length === 0) {
    console.error(
      `[sync-plugin-version] ${MARKETPLACE_MANIFEST}: \`plugins\` must be a non-empty array`,
    );
    process.exit(2);
  }
  const metadataNeeds = data.metadata.version !== target;
  const pluginsNeeds = data.plugins[0].version !== target;
  if (metadataNeeds || pluginsNeeds) {
    const next = {
      ...data,
      metadata: { ...data.metadata, version: target },
      plugins: data.plugins.map((p, i) => (i === 0 ? { ...p, version: target } : p)),
    };
    const fields = [
      metadataNeeds && `metadata.version (${data.metadata.version ?? '<missing>'} → ${target})`,
      pluginsNeeds && `plugins[0].version (${data.plugins[0].version ?? '<missing>'} → ${target})`,
    ].filter(Boolean);
    drift.push({
      file: MARKETPLACE_MANIFEST,
      from: fields.join(', '),
      to: target,
      next: serialize(next),
      currentRaw: raw,
    });
  }
}

// 4. .agents/plugins/marketplace.json — Codex marketplace listing. Schema is
//    flatter than the Claude one: only plugins[0].version moves with releases.
{
  const { data, raw } = await readJson(CODEX_MARKETPLACE_MANIFEST);
  if (!Array.isArray(data.plugins) || data.plugins.length === 0) {
    console.error(
      `[sync-plugin-version] ${CODEX_MARKETPLACE_MANIFEST}: \`plugins\` must be a non-empty array`,
    );
    process.exit(2);
  }
  if (data.plugins[0].version !== target) {
    const next = {
      ...data,
      plugins: data.plugins.map((p, i) => (i === 0 ? { ...p, version: target } : p)),
    };
    drift.push({
      file: CODEX_MARKETPLACE_MANIFEST,
      from: `plugins[0].version (${data.plugins[0].version ?? '<missing>'} → ${target})`,
      to: target,
      next: serialize(next),
      currentRaw: raw,
    });
  }
}

// 5 + 6. plugin/.mcp.json — pin each `npx -y <pkg>@<version>` arg.
{
  const { data, raw } = await readJson(PLUGIN_MCP_JSON);
  if (typeof data.mcpServers !== 'object' || data.mcpServers === null) {
    console.error(`[sync-plugin-version] ${PLUGIN_MCP_JSON}: \`mcpServers\` must be an object`);
    process.exit(2);
  }
  let mutated = false;
  const next = { ...data, mcpServers: { ...data.mcpServers } };
  const driftedTargets = [];
  for (const { server, pkg } of MCP_NPX_TARGETS) {
    const entry = data.mcpServers[server];
    if (typeof entry !== 'object' || entry === null || !Array.isArray(entry.args)) {
      console.error(
        `[sync-plugin-version] ${PLUGIN_MCP_JSON}: mcpServers.${server} must declare an args array`,
      );
      process.exit(2);
    }
    const idx = entry.args.findIndex((arg) => typeof arg === 'string' && arg.startsWith(`${pkg}@`));
    if (idx === -1) {
      console.error(
        `[sync-plugin-version] ${PLUGIN_MCP_JSON}: mcpServers.${server}.args must contain a pinned ${pkg}@<version> entry`,
      );
      process.exit(2);
    }
    const current = entry.args[idx];
    const wanted = `${pkg}@${versionByPackage[pkg]}`;
    if (current !== wanted) {
      mutated = true;
      driftedTargets.push(`mcpServers.${server} (${current} → ${wanted})`);
      const nextArgs = [...entry.args];
      nextArgs[idx] = wanted;
      next.mcpServers[server] = { ...entry, args: nextArgs };
    }
  }
  if (mutated) {
    drift.push({
      file: PLUGIN_MCP_JSON,
      from: driftedTargets.join(', '),
      next: serialize(next),
      currentRaw: raw,
    });
  }
}

// 7 + 8. README install snippets — match every literal
// `@tesseron/{mcp,docs-mcp}@<semver>` and rewrite each to *its own* package's
// version. The placeholder `@tesseron/mcp@<version>` (with literal `<version>`
// text) is intentionally not matched because the regex requires digits.
const README_PIN_PATTERN = /@tesseron\/(mcp|docs-mcp)@(\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)/g;
for (const file of README_TARGETS) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    console.error(`[sync-plugin-version] failed to read ${file}: ${err.message}`);
    process.exit(2);
  }
  const driftedPins = [];
  const next = raw.replace(README_PIN_PATTERN, (match, pkg, current) => {
    const wanted = `@tesseron/${pkg}@${versionByPackage[`@tesseron/${pkg}`]}`;
    if (match !== wanted) driftedPins.push(`${match} → ${wanted}`);
    return wanted;
  });
  if (driftedPins.length > 0) {
    drift.push({
      file,
      from: driftedPins.length === 1 ? driftedPins[0] : `${driftedPins.length} pin(s) drifted`,
      next,
      currentRaw: raw,
    });
  }
}

/** `from` already spells out "old → new" for the per-package surfaces. */
const describe = (d) => (d.to === undefined ? d.from : `${d.from} → ${d.to}`);

const versionSummary = Object.entries(versionByPackage)
  .map(([pkg, version]) => `${pkg} = ${version}`)
  .join(', ');

if (drift.length === 0) {
  // Log on both paths: in check mode the green check is the only signal CI
  // emits, and a positive confirmation makes the guard's success auditable.
  console.log(`[sync-plugin-version] all manifests already in sync (${versionSummary}).`);
  process.exit(0);
}

if (checkMode) {
  console.error(`[sync-plugin-version] drift detected (${versionSummary}):`);
  for (const d of drift) {
    console.error(`  - ${d.file}: ${describe(d)}`);
  }
  console.error('Run `pnpm sync-plugin-version` to fix, then commit the changes.');
  process.exit(1);
}

for (const d of drift) {
  await writeFile(d.file, d.next);
  console.log(`[sync-plugin-version] ${d.file}: ${describe(d)}`);
}
