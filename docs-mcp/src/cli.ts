#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createDocsMcpServer } from './server.js';
import { loadSnapshot } from './snapshot.js';

function parseSnapshotArg(argv: string[]): string | undefined {
  const idx = argv.indexOf('--snapshot');
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  const eqArg = argv.find((a) => a.startsWith('--snapshot='));
  if (eqArg) return eqArg.slice('--snapshot='.length);
  return undefined;
}

async function main(): Promise<void> {
  const override = parseSnapshotArg(process.argv.slice(2));
  const snapshot = loadSnapshot(override);
  const server = createDocsMcpServer({ snapshot });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `[tesseron-docs] serving ${snapshot.count} pages (snapshot ${snapshot.version})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[tesseron-docs] fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
