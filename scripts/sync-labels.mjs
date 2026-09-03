#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const labelsPath = resolve(repoRoot, '.github/labels.json');
const checkMode = process.argv.includes('--check');

function readLabels() {
  try {
    const labels = JSON.parse(readFileSync(labelsPath, 'utf8'));
    if (!Array.isArray(labels)) {
      throw new Error('expected an array');
    }
    return labels;
  } catch (error) {
    console.error(`[sync-labels] failed to read ${labelsPath}: ${error.message}`);
    process.exit(2);
  }
}

function readRemoteLabels() {
  try {
    return JSON.parse(
      execFileSync('gh', ['label', 'list', '--json', 'name,color,description', '--limit', '100'], {
        encoding: 'utf8',
      }),
    );
  } catch (error) {
    console.error(`[sync-labels] failed to read labels from GitHub: ${error.message}`);
    process.exit(2);
  }
}

const labels = readLabels();

if (checkMode) {
  const remoteLabels = readRemoteLabels();
  const remoteByName = new Map(remoteLabels.map((label) => [label.name, label]));
  const drift = [];

  for (const label of labels) {
    const remoteLabel = remoteByName.get(label.name);
    if (!remoteLabel) {
      drift.push(`  - ${label.name}: missing`);
      continue;
    }
    for (const field of ['color', 'description']) {
      if (remoteLabel[field] !== label[field]) {
        drift.push(
          `  - ${label.name}: ${field} ${JSON.stringify(remoteLabel[field])} → ${JSON.stringify(label[field])}`,
        );
      }
    }
  }

  if (drift.length > 0) {
    console.error('[sync-labels] drift detected:');
    console.error(drift.join('\n'));
    console.error('Run `pnpm sync-labels` to fix, then commit the changes.');
    process.exit(1);
  }

  console.log(`[sync-labels] all ${labels.length} area labels are in sync.`);
  process.exit(0);
}

for (const label of labels) {
  execFileSync(
    'gh',
    [
      'label',
      'create',
      label.name,
      '--color',
      label.color,
      '--description',
      label.description,
      '--force',
    ],
    { stdio: 'inherit' },
  );
}
