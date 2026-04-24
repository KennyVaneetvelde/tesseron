/**
 * node-prompts — a headless Node service that exposes a library of reusable
 * LLM prompts to Claude via Tesseron. Sampling is the point of the domain:
 * Claude tests, refines, and generates variants of prompts by calling back
 * into its own LLM through ctx.sample.
 *
 * No HTTP server. No browser. Just a daemon next to your work. The action and
 * resource registrations live in `./prompt-lab.ts` so they can be reused by
 * test harnesses that need to inject their own gateway and MCP client.
 */

import { tesseron } from '@tesseron/server';
import { registerPromptLab } from './prompt-lab.js';

function log(msg: string): void {
  process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);
}

const lab = registerPromptLab(tesseron, { log });

async function main(): Promise<void> {
  log('node-prompts starting up');
  log(`state: ${lab.size()} prompts, no test yet`);
  try {
    const welcome = await tesseron.connect();
    log(`connected to gateway. session=${welcome.sessionId}`);
    log(`claim code: ${welcome.claimCode}`);
    log(`tell Claude: "claim session ${welcome.claimCode}"`);
    log('watching for actions. Ctrl-C to exit.');
  } catch (error) {
    process.stderr.write(
      `[node-prompts] failed to connect to gateway: ${(error as Error).message}\n`,
    );
    process.stderr.write(
      '[node-prompts] is the tesseron MCP plugin running? see https://brainblend-ai.github.io/tesseron/overview/quickstart/\n',
    );
    process.exit(1);
  }
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${signal} received, shutting down`);
  try {
    await tesseron.disconnect();
  } catch {
    // best effort
  }
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

main().catch((err) => {
  process.stderr.write(`[node-prompts] fatal: ${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});
