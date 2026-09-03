#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspaceRoot = fileURLToPath(new URL('../', import.meta.url));
const runnerPath = fileURLToPath(
  new URL('./runner/dist/tesseron-conformance.cjs', import.meta.url),
);
const hostPath = fileURLToPath(
  new URL('../sdks/typescript/conformance-host/dist/bin.js', import.meta.url),
);
const unsupported = (process.env['TESSERON_CONFORMANCE_UNSUPPORTED'] ?? '')
  .split(',')
  .map((tag) => tag.trim())
  .filter(Boolean);
if (process.platform === 'win32' && !unsupported.includes('uds')) unsupported.push('uds');
const environment = {
  ...process.env,
  TESSERON_CONFORMANCE_UNSUPPORTED: unsupported.join(','),
};
const hostCommand = `${quoteForShell(process.execPath)} ${quoteForShell(hostPath)}`;
const child = spawn(process.execPath, [runnerPath, '--host', hostCommand], {
  cwd: workspaceRoot,
  env: environment,
  stdio: 'inherit',
  windowsHide: true,
});

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

function quoteForShell(value) {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '""')}"`;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
