import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const runnerRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(runnerRoot, '..', 'fixtures');
const destination = resolve(runnerRoot, 'dist', 'fixtures');

await rm(destination, { recursive: true, force: true });
await mkdir(dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true });
