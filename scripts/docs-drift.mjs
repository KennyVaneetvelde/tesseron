#!/usr/bin/env node
// Checks that the hub docs kept up with the four SDK repositories and the
// published hub packages. Version and date drift only: a docs commit that
// lands after a release counts as "kept up" even if its prose says nothing
// about that release.
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const docsRoot = 'docs/src/content/docs';
const userAgent = 'tesseron-docs-drift (kenny@eigenwise.io)';

async function getJson(url) {
  const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

async function npmLatest(packageName) {
  const registry = await getJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
  const version = registry['dist-tags'].latest;
  return { version, publishedAt: new Date(registry.time[version]) };
}

async function cratesLatest(crateName) {
  const body = await getJson(`https://crates.io/api/v1/crates/${crateName}`);
  const latest = body.versions.find((entry) => entry.num === body.crate.max_version);
  return { version: body.crate.max_version, publishedAt: new Date(latest.created_at) };
}

async function pypiLatest(projectName) {
  const body = await getJson(`https://pypi.org/pypi/${projectName}/json`);
  const version = body.info.version;
  return { version, publishedAt: new Date(body.releases[version][0].upload_time_iso_8601) };
}

async function githubLatestTag(repository) {
  const tags = await getJson(`https://api.github.com/repos/${repository}/tags?per_page=1`);
  if (tags.length === 0) return null;
  const commit = await getJson(
    `https://api.github.com/repos/${repository}/commits/${tags[0].commit.sha}`,
  );
  return { version: tags[0].name, publishedAt: new Date(commit.commit.committer.date) };
}

function hubDocsLastTouched(relativeDirectory) {
  const iso = execSync(`git log -1 --format=%cI -- ${docsRoot}/${relativeDirectory}`, {
    encoding: 'utf8',
  }).trim();
  return iso ? new Date(iso) : null;
}

const sdkReleases = [
  { language: 'typescript', docs: 'sdk/typescript', latest: () => npmLatest('@tesseron/core') },
  { language: 'rust', docs: 'sdk/rust', latest: () => cratesLatest('tesseron') },
  { language: 'python', docs: 'sdk/python', latest: () => pypiLatest('tesseron') },
  { language: 'cpp', docs: 'sdk/cpp', latest: () => githubLatestTag('Eigenwise/tesseron-cpp') },
];

function* docsFiles(directory) {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) yield* docsFiles(path);
    else if (/\.mdx?$/.test(entry)) yield path;
  }
}

function pinnedPackages() {
  const pins = [];
  for (const path of docsFiles(docsRoot)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    let insideCodeBlock = false;
    lines.forEach((line, index) => {
      if (line.trimStart().startsWith('```')) insideCodeBlock = !insideCodeBlock;
      if (!insideCodeBlock) return;
      for (const match of line.matchAll(/@tesseron\/([a-z-]+)@(\d+\.\d+\.\d+)/g)) {
        pins.push({
          path: path.replaceAll('\\', '/'),
          line: index + 1,
          packageName: `@tesseron/${match[1]}`,
          version: match[2],
        });
      }
    });
  }
  return pins;
}

let drift = 0;
const rows = [];
for (const sdk of sdkReleases) {
  const release = await sdk.latest();
  const docsAt = hubDocsLastTouched(sdk.docs);
  if (!release) {
    rows.push([sdk.language, 'no release yet', '-', docsAt?.toISOString() ?? '-', 'ok']);
    continue;
  }
  const stale = docsAt === null || release.publishedAt > docsAt;
  if (stale) drift += 1;
  rows.push([
    sdk.language,
    release.version,
    release.publishedAt.toISOString(),
    docsAt?.toISOString() ?? 'never',
    stale ? 'DRIFT: release newer than docs' : 'ok',
  ]);
}

const latestByPackage = new Map();
const pinRows = [];
for (const pin of pinnedPackages()) {
  if (!latestByPackage.has(pin.packageName))
    latestByPackage.set(pin.packageName, npmLatest(pin.packageName));
  const latest = await latestByPackage.get(pin.packageName);
  const stale = latest.version !== pin.version;
  if (stale) drift += 1;
  pinRows.push([
    `${pin.path}:${pin.line}`,
    `${pin.packageName}@${pin.version}`,
    latest.version,
    stale ? 'DRIFT: pin behind registry' : 'ok',
  ]);
}

function printTable(header, table) {
  const widths = header.map((_, column) =>
    Math.max(header[column].length, ...table.map((row) => String(row[column]).length)),
  );
  const format = (row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join('  ');
  console.log(format(header));
  for (const row of table) console.log(format(row));
  console.log();
}

printTable(['sdk', 'released', 'published at', 'hub docs last touched', 'verdict'], rows);
if (pinRows.length > 0) printTable(['docs pin', 'pinned', 'registry latest', 'verdict'], pinRows);
console.log(drift === 0 ? 'docs-drift: no drift found.' : `docs-drift: ${drift} drift finding(s).`);
console.log(
  'Checks version and date drift only; prose that fails to mention a release is not detected.',
);
process.exit(drift === 0 ? 0 : 1);
