#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import type { ResumeCredentials, Transport, WelcomeResult } from '@tesseron/server';
import { createFixtureClient, parseHostFixture } from './fixture.js';
import { ConformanceHostEndpoint } from './transport.js';

async function main(): Promise<void> {
  const fixturePath = process.env['TESSERON_CONFORMANCE_FIXTURE'];
  if (!fixturePath) throw new Error('TESSERON_CONFORMANCE_FIXTURE is required');
  const document: unknown = JSON.parse(await readFile(fixturePath, 'utf8'));
  const fixture = parseHostFixture(document);
  const client = createFixtureClient(fixture);
  const endpoint = await ConformanceHostEndpoint.listen(fixture);
  let resumeCredentials: ResumeCredentials | undefined;
  endpoint.onConnection((transport) => {
    void connectClient(client, transport, resumeCredentials)
      .then((welcome) => {
        resumeCredentials = credentialsFromWelcome(welcome);
      })
      .catch((error: unknown) => {
        transport.close(error instanceof Error ? error.message : 'conformance handshake failed');
      });
  });

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void endpoint.close().finally(() => process.exit(0));
  };
  process.stdin.resume();
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.stdout.write(`${endpoint.readinessLine()}\n`);
}

function connectClient(
  client: ReturnType<typeof createFixtureClient>,
  transport: Transport,
  resumeCredentials: ResumeCredentials | undefined,
): Promise<WelcomeResult> {
  return client.connect(
    transport,
    resumeCredentials === undefined ? undefined : { resume: resumeCredentials },
  );
}

function credentialsFromWelcome(welcome: WelcomeResult): ResumeCredentials | undefined {
  if (!welcome.resumeToken) return undefined;
  return { sessionId: welcome.sessionId, resumeToken: welcome.resumeToken };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
