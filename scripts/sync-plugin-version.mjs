#!/usr/bin/env node
/**
 * Sync the Claude Code plugin manifest versions to `@tesseron/mcp`'s version.
 *
 * The plugin's bundled gateway IS `@tesseron/mcp`; the two should never
 * disagree. This script is the contract that keeps them in lockstep, run as
 * part of `pnpm version-packages` so changesets-driven bumps automatically
 * carry through to the manifest.
 *
 * Ten surfaces and one mirror tree move together:
 *   - plugin/.claude-plugin/plugin.json#version  (the plugin's own manifest)
 *   - .claude-plugin/marketplace.json#metadata.version  (Claude marketplace version)
 *   - .claude-plugin/marketplace.json#plugins[0].version  (Claude marketplace listing)
 *   - .agents/plugins/marketplace.json#plugins[0].version  (Codex marketplace listing)
 *   - plugin/.mcp.json#mcpServers.tesseron.args  (npx -y @tesseron/mcp@<version>)
 *   - plugin/.mcp.json#mcpServers.tesseron-docs.args  (npx -y @tesseron/docs-mcp@<version>)
 *   - packages/pi/package.json#version  (Pi extension package version)
 *   - packages/pi/extensions/tesseron.ts#TESSERON_MCP_VERSION  (Pi extension's pinned npx target)
 *   - README.md  (every literal `@tesseron/{mcp,docs-mcp}@<semver>` in install snippets)
 *   - plugin/README.md  (same)
 *   - packages/pi/skills/**  (byte-identical mirror of plugin/skills/**)
 *
 * Bumping only one leaves the other surfaces stale and users running an older
 * gateway under a fresh manifest. That's issue #38.
 *
 * Exit codes:
 *   0  no drift (or rewrote drift, in default mode)
 *   1  --check mode and drift detected (CI guard)
 *   2  unrecoverable: a manifest is missing, malformed, or structurally wrong
 */
import { createHash } from 'node:crypto';
import { cpSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MCP_PKG = resolve(repoRoot, 'packages/mcp/package.json');
const PLUGIN_MANIFEST = resolve(repoRoot, 'plugin/.claude-plugin/plugin.json');
const MARKETPLACE_MANIFEST = resolve(repoRoot, '.claude-plugin/marketplace.json');
const CODEX_MARKETPLACE_MANIFEST = resolve(repoRoot, '.agents/plugins/marketplace.json');
const PLUGIN_MCP_JSON = resolve(repoRoot, 'plugin/.mcp.json');
const PI_PKG = resolve(repoRoot, 'packages/pi/package.json');
const PI_EXTENSION = resolve(repoRoot, 'packages/pi/extensions/tesseron.ts');
const PLUGIN_SKILLS_DIR = resolve(repoRoot, 'plugin/skills');
const PI_SKILLS_DIR = resolve(repoRoot, 'packages/pi/skills');
// READMEs whose install snippets pin literal `@tesseron/{mcp,docs-mcp}@<semver>`
// strings. These are not JSON, so the script rewrites them as text via regex.
const README_TARGETS = [resolve(repoRoot, 'README.md'), resolve(repoRoot, 'plugin/README.md')];

// `<bin-package>@<version>` arg slots in plugin/.mcp.json. The script pins both
// MCP servers to the same version as @tesseron/mcp so users always run a
// gateway that matches the plugin manifest they installed.
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

/**
 * Walk a skill tree, returning a map of POSIX-relative path -> sha256(content).
 * Returns an empty map if the root doesn't exist (the directory is created on
 * first sync). The traversal is sorted at each level so the resulting map has
 * deterministic key ordering, which keeps `--check` output stable across runs.
 */
function walkSkillTree(root) {
  const files = new Map();
  function walk(absDir) {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = resolve(absDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      // POSIX-style relative path so Win/Linux produce identical map keys.
      const rel = relative(root, abs).split('\\').join('/');
      // readFileSync returns a Buffer, so byte-level CRLF differences are
      // visible to the hash (a text-mode read on Windows would normalise them
      // away and false-negative on real drift).
      const buf = readFileSync(abs);
      const hash = createHash('sha256').update(buf).digest('hex');
      files.set(rel, hash);
    }
  }
  walk(root);
  return files;
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
    const wanted = `${pkg}@${target}`;
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
      to: target,
      next: serialize(next),
      currentRaw: raw,
    });
  }
}

// 7. packages/pi/package.json — `@tesseron/pi` ships in lockstep with the rest
//    of the SDK fixed group (changesets handles the bump). Catch drift here in
//    case anyone hand-edits one without the other.
{
  const { data, raw } = await readJson(PI_PKG);
  if (data.version !== target) {
    drift.push({
      file: PI_PKG,
      from: data.version,
      to: target,
      next: serialize({ ...data, version: target }),
      currentRaw: raw,
    });
  }
}

// 8. packages/pi/extensions/tesseron.ts — pinned `npx -y @tesseron/mcp@<v>`
//    target lives in a single `TESSERON_MCP_VERSION` constant. Rewrite as
//    text (not JSON) so we don't have to parse TypeScript.
{
  let raw;
  try {
    raw = await readFile(PI_EXTENSION, 'utf8');
  } catch (err) {
    console.error(`[sync-plugin-version] failed to read ${PI_EXTENSION}: ${err.message}`);
    process.exit(2);
  }
  const pinPattern = /(const TESSERON_MCP_VERSION = ')([^']+)(';)/;
  const match = raw.match(pinPattern);
  if (!match) {
    console.error(
      `[sync-plugin-version] ${PI_EXTENSION}: could not find \`const TESSERON_MCP_VERSION = '<version>';\` pin`,
    );
    process.exit(2);
  }
  const current = match[2];
  if (current !== target) {
    const next = raw.replace(pinPattern, `$1${target}$3`);
    drift.push({
      file: PI_EXTENSION,
      from: `TESSERON_MCP_VERSION (${current} → ${target})`,
      to: target,
      next,
      currentRaw: raw,
    });
  }
}

// 9 + 10. README install snippets — match every literal
// `@tesseron/{mcp,docs-mcp}@<semver>` and rewrite. The placeholder
// `@tesseron/mcp@<version>` (with literal `<version>` text) is intentionally
// not matched because the regex requires digits.
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
    const wanted = `@tesseron/${pkg}@${target}`;
    if (current !== target) driftedPins.push(`${match} → ${wanted}`);
    return wanted;
  });
  if (driftedPins.length > 0) {
    drift.push({
      file,
      from: driftedPins.length === 1 ? driftedPins[0] : `${driftedPins.length} pin(s) drifted`,
      to: target,
      next,
      currentRaw: raw,
    });
  }
}

// 11. Skill tree mirror: plugin/skills/ → packages/pi/skills/
//
// The five Tesseron skills are edited under plugin/skills/ and ship from
// packages/pi/ as well. Pi has no idiomatic primitive that lets two consumer
// packages reference one on-disk source (bundledDependencies works for nested
// pi packages but not for a sibling Claude plugin; pnpm doesn't bundle
// `workspace:*` deps; Pi's pi.skills paths can't escape the package root).
// So we mirror the tree, hash-compare every file, and fail --check on drift.
{
  const sourceFiles = walkSkillTree(PLUGIN_SKILLS_DIR);
  const targetFiles = walkSkillTree(PI_SKILLS_DIR);
  const driftedPaths = [];

  for (const [relPath, hash] of sourceFiles) {
    const targetHash = targetFiles.get(relPath);
    if (targetHash === undefined) driftedPaths.push(`+ ${relPath}`);
    else if (targetHash !== hash) driftedPaths.push(`~ ${relPath}`);
  }
  for (const relPath of targetFiles.keys()) {
    if (!sourceFiles.has(relPath)) driftedPaths.push(`- ${relPath}`);
  }

  if (driftedPaths.length > 0) {
    drift.push({
      file: PI_SKILLS_DIR,
      from: `${driftedPaths.length} skill file(s) drifted: ${driftedPaths.slice(0, 5).join(', ')}${driftedPaths.length > 5 ? `, +${driftedPaths.length - 5} more` : ''}`,
      to: 'mirror of plugin/skills/',
      // Marker handled by the writer at the bottom of the script.
      mirror: true,
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
  if (d.mirror) {
    // Full directory mirror: blow away the target and re-copy from source.
    // This is the simplest way to make deletions propagate (file removed from
    // plugin/skills/ should also disappear from packages/pi/skills/).
    rmSync(d.file, { recursive: true, force: true });
    cpSync(PLUGIN_SKILLS_DIR, d.file, { recursive: true });
  } else {
    await writeFile(d.file, d.next);
  }
  console.log(`[sync-plugin-version] ${d.file}: ${d.from} → ${d.to}`);
}
