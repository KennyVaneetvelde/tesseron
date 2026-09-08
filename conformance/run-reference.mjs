#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const runnerPath = fileURLToPath(
  new URL('./runner/dist/tesseron-conformance.cjs', import.meta.url),
);
// The runner ships a copy of the corpus in its dist for npx consumers, and turbo
// does not know that copy depends on ../fixtures, so a hub run reads the live
// corpus instead of whatever the cached build captured.
const fixturesPath = fileURLToPath(new URL('./fixtures', import.meta.url));

const options = parseArguments(process.argv.slice(2));
const unsupported =
  options.unsupported ?? splitTags(process.env['TESSERON_CONFORMANCE_UNSUPPORTED'] ?? '');
// Conformance hosts do not use Unix domain sockets on Windows, so the tag is added
// rather than left to every caller to remember.
if (process.platform === 'win32' && !unsupported.includes('uds')) unsupported.push('uds');

if (!options.host?.trim()) {
  process.stderr.write(
    '--host is required; conformance hosts live in the language SDK repositories.\n',
  );
  process.exit(2);
}
const child = spawn(
  process.execPath,
  [runnerPath, '--host', options.host, '--fixtures', fixturesPath, ...options.forwarded],
  {
    cwd: workspaceRoot,
    env: { ...process.env, TESSERON_CONFORMANCE_UNSUPPORTED: unsupported.join(',') },
    stdio: 'inherit',
    windowsHide: true,
  },
);

child.once('error', (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 2;
});
child.once('exit', (code, signal) => {
  if (signal) {
    process.stderr.write(`Conformance runner exited from signal ${signal}\n`);
    process.exitCode = 1;
  } else {
    process.exitCode = code ?? 1;
  }
});

/**
 * Reads the two flags this helper owns. `--host` takes a command line, which
 * may be a bare path: the runner resolves that against the workspace root and
 * adds `.exe` on Windows. `--unsupported` takes comma-separated capability
 * tags and replaces TESSERON_CONFORMANCE_UNSUPPORTED rather than adding to it,
 * because the list has to shrink as an SDK grows capabilities. Everything else
 * goes through to the runner untouched.
 */
function parseArguments(argv) {
  const forwarded = [];
  let host;
  let unsupported;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--host' || argument === '--unsupported') {
      const value = argv[index + 1];
      if (value === undefined) {
        process.stderr.write(`${argument} needs a value\n`);
        process.exit(2);
      }
      if (argument === '--host') host = value;
      else unsupported = splitTags(value);
      index += 1;
      continue;
    }
    forwarded.push(argument);
  }
  return { host, unsupported, forwarded };
}

function splitTags(value) {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}
