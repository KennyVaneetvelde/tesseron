import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DocEntry, Snapshot } from '../src/content/types';
import { createDocsMcpServer } from '../src/server';

const docs: DocEntry[] = [
  {
    slug: 'protocol/handshake',
    title: 'Handshake and claiming',
    description: 'How a WebSocket becomes a bound session.',
    section: 'protocol',
    related: ['protocol/wire-format', 'protocol/transport'],
    bodyRaw: '# Handshake\n\nFull body of the handshake page.',
    bodyText: 'Full body of the handshake page.',
  },
  {
    slug: 'protocol/resume',
    title: 'Session resume',
    description: 'How a Tesseron app rejoins a previously-claimed session.',
    section: 'protocol',
    related: ['protocol/handshake'],
    bodyRaw: '# Session resume\n\nResume uses a resumeToken.',
    bodyText: 'Resume uses a resumeToken.',
  },
];

const snapshot: Snapshot = {
  version: 'test',
  generatedAt: new Date().toISOString(),
  count: docs.length,
  docs,
};

describe('tesseron-docs MCP server (in-memory)', () => {
  let client: Client;

  beforeAll(async () => {
    const server = createDocsMcpServer({ snapshot });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  it('list_docs returns every entry', async () => {
    const res = await client.callTool({ name: 'list_docs', arguments: {} });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const parsed = JSON.parse(text) as { count: number; docs: Array<{ slug: string }> };
    expect(parsed.count).toBe(2);
    expect(parsed.docs.map((d) => d.slug).sort()).toEqual([
      'protocol/handshake',
      'protocol/resume',
    ]);
  });

  it('search_docs finds the right page for a title match', async () => {
    const res = await client.callTool({
      name: 'search_docs',
      arguments: { query: 'session resume' },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const parsed = JSON.parse(text) as { hits: Array<{ slug: string }> };
    expect(parsed.hits[0]?.slug).toBe('protocol/resume');
  });

  it('read_doc returns the full body plus frontmatter fields', async () => {
    const res = await client.callTool({
      name: 'read_doc',
      arguments: { slug: 'protocol/handshake' },
    });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
    const parsed = JSON.parse(text) as {
      slug: string;
      title: string;
      related: string[];
      body: string;
    };
    expect(parsed.slug).toBe('protocol/handshake');
    expect(parsed.title).toBe('Handshake and claiming');
    expect(parsed.related).toContain('protocol/wire-format');
    expect(parsed.body).toContain('Full body of the handshake page.');
  });

  it('read_doc returns an isError result for unknown slugs', async () => {
    const res = await client.callTool({
      name: 'read_doc',
      arguments: { slug: 'nope/missing' },
    });
    expect(res.isError).toBe(true);
  });

  it('lists resources and reads one by URI', async () => {
    const list = await client.listResources();
    const uris = list.resources.map((r) => r.uri);
    expect(uris).toContain('tesseron-docs://protocol/handshake');

    const read = await client.readResource({ uri: 'tesseron-docs://protocol/handshake' });
    const first = read.contents[0];
    expect(first).toBeDefined();
    expect('text' in first! && first.text).toContain('Full body of the handshake page.');
  });
});
