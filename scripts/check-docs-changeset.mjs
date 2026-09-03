#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
const configuredBase = process.env.GITHUB_BASE_REF?.trim() || 'origin/main';

function runGit(gitArguments) {
  try {
    return execFileSync('git', gitArguments, {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[check-docs-changeset] failed to inspect git history: ${message}`);
    process.exit(1);
  }
}

function referenceExists(reference) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${reference}^{commit}`], {
      cwd: repositoryRoot,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function readFileAtHead(filePath) {
  try {
    return execFileSync('git', ['show', `HEAD:${filePath}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
  } catch {
    return '';
  }
}

const baseCandidates = [configuredBase];
if (process.env.GITHUB_BASE_REF?.trim() && !configuredBase.startsWith('origin/')) {
  baseCandidates.push(`origin/${configuredBase}`);
}

const baseReference = baseCandidates.find(referenceExists);
if (!baseReference) {
  console.error(`[check-docs-changeset] could not resolve base ref ${configuredBase}`);
  process.exit(1);
}

const changedFiles = runGit(['diff', '--name-only', `${baseReference}...HEAD`])
  .split(/\r?\n/)
  .map((filePath) => filePath.trim())
  .filter(Boolean);
const documentationFiles = changedFiles.filter((filePath) =>
  /^docs\/src\/content\/docs(?:\/|$)/.test(filePath),
);

if (documentationFiles.length === 0) {
  process.exit(0);
}

const changesetFiles = changedFiles.filter(
  (filePath) => /^\.changeset\/[^/]+\.md$/.test(filePath) && filePath !== '.changeset/README.md',
);
const hasDocsMcpChangeset = changesetFiles.some((filePath) =>
  readFileAtHead(filePath).includes('@tesseron/docs-mcp'),
);

if (hasDocsMcpChangeset) {
  process.exit(0);
}

console.error(
  '[check-docs-changeset] Docs content changed without a @tesseron/docs-mcp changeset.',
);
console.error('Changed docs files:');
for (const documentationFile of documentationFiles) {
  console.error(`- ${documentationFile}`);
}
console.error('Add a changeset with this frontmatter:');
console.error('---');
console.error("'@tesseron/docs-mcp': patch");
console.error('---');
process.exit(1);
