#!/usr/bin/env node
/**
 * Sync the Claude Code plugin manifest versions to `@tesseron/mcp`'s version.
 *
 * The plugin's bundled gateway IS `@tesseron/mcp`; the two should never
 * disagree. This script is the contract that keeps them in lockstep, run as
 * part of `pnpm version-packages` so changesets-driven bumps automatically
 * carry through to the manifest.
 *
 * Three fields move together:
 *   - plugin/.claude-plugin/plugin.json#version  (the plugin's own manifest)
 *   - .claude-plugin/marketplace.json#metadata.version  (the marketplace's version)
 *   - .claude-plugin/marketplace.json#plugins[0].version  (the marketplace's listing for this plugin)
 *
 * Bumping only one leaves the other surfaces stale and users on a cached older
 * bundle even after npm has shipped the new gateway. That's issue #38.
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
const MCP_PKG = resolve(repoRoot, 'packages/mcp/package.json');
const PLUGIN_MANIFEST = resolve(repoRoot, 'plugin/.claude-plugin/plugin.json');
const MARKETPLACE_MANIFEST = resolve(repoRoot, '.claude-plugin/marketplace.json');

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

const { data: mcpPkg } = await readJson(MCP_PKG);
const target = mcpPkg.version;
if (typeof target !== 'string' || target.length === 0) {
  console.error(`[sync-plugin-version] could not read version from ${MCP_PKG}`);
  process.exit(2);
}

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

if (drift.length === 0) {
  // Log on both paths: in check mode the green check is the only signal CI
  // emits, and a positive confirmation makes the guard's success auditable.
  console.log(`[sync-plugin-version] all manifests already at ${target}, nothing to do.`);
  process.exit(0);
}

if (checkMode) {
  console.error(`[sync-plugin-version] drift detected (target: @tesseron/mcp = ${target}):`);
  for (const d of drift) {
    console.error(`  - ${d.file}: ${d.from} → ${d.to}`);
  }
  console.error('Run `pnpm sync-plugin-version` to fix, then commit the changes.');
  process.exit(1);
}

for (const d of drift) {
  await writeFile(d.file, d.next);
  console.log(`[sync-plugin-version] ${d.file}: ${d.from} → ${d.to}`);
}
