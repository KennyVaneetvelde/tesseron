import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDoc, walkDocs } from '../src/content/parse.js';
import type { Snapshot } from '../src/content/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const docsRoot = resolve(repoRoot, 'docs', 'src', 'content', 'docs');
const outPath = resolve(packageRoot, 'dist', 'docs-index.json');

function shortSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return 'dev';
  }
}

function main(): void {
  if (!existsSync(docsRoot)) {
    throw new Error(`Docs root not found at ${docsRoot}. Snapshot build must run in the monorepo.`);
  }

  const files = walkDocs(docsRoot);
  const docs = files.map((file) => parseDoc(file, docsRoot));
  docs.sort((a, b) => a.slug.localeCompare(b.slug));

  const snapshot: Snapshot = {
    version: shortSha(),
    generatedAt: new Date().toISOString(),
    count: docs.length,
    docs,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(snapshot, null, 0), 'utf8');
  process.stdout.write(
    `[build-snapshot] wrote ${docs.length} docs (${(JSON.stringify(snapshot).length / 1024).toFixed(1)} KB) to ${outPath}\n`,
  );
}

main();
