import { describe, expect, it } from 'vitest';
import type { DocEntry } from '../src/content/types';
import { DocsIndex, makeSnippet } from '../src/search';

function docEntry(partial: Partial<DocEntry> & { slug: string }): DocEntry {
  return {
    slug: partial.slug,
    title: partial.title ?? partial.slug,
    description: partial.description ?? '',
    section: partial.section ?? partial.slug.split('/')[0] ?? '',
    related: partial.related ?? [],
    bodyRaw: partial.bodyRaw ?? '',
    bodyText: partial.bodyText ?? '',
  };
}

describe('DocsIndex', () => {
  const docs: DocEntry[] = [
    docEntry({
      slug: 'protocol/handshake',
      title: 'Handshake and claiming',
      description: 'How a WebSocket becomes a bound session.',
      bodyText: 'The handshake begins with tesseron/hello and ends with welcome.',
    }),
    docEntry({
      slug: 'protocol/resume',
      title: 'Session resume',
      description: 'How a Tesseron app rejoins a previously-claimed session.',
      bodyText: 'Resume requires a resumeToken issued during the original handshake.',
    }),
    docEntry({
      slug: 'sdk/typescript/core',
      title: '@tesseron/core',
      description: 'The protocol types, builder, JSON-RPC dispatcher.',
      bodyText: 'Exports ActionContext, Transport, and the JSON-RPC dispatcher.',
    }),
  ];

  const index = new DocsIndex(docs);

  it('ranks title matches highest', () => {
    const hits = index.search('handshake');
    expect(hits[0]?.slug).toBe('protocol/handshake');
  });

  it('finds body-only matches', () => {
    const hits = index.search('resumeToken');
    expect(hits.map((h) => h.slug)).toContain('protocol/resume');
  });

  it('returns snippets with ellipses when the body is longer than the window', () => {
    const hits = index.search('tesseron/hello');
    expect(hits[0]?.snippet).toContain('tesseron/hello');
  });

  it('respects the limit cap', () => {
    const hits = index.search('the', 1);
    expect(hits.length).toBeLessThanOrEqual(1);
  });
});

describe('makeSnippet', () => {
  const entry = {
    slug: 'x',
    title: 't',
    description: 'a fallback description',
    section: '',
    related: [],
    bodyRaw: '',
    bodyText:
      'The quick brown fox jumps over the lazy dog. Then a handshake sequence occurs between the client and server, followed by a welcome frame and eventually a claim code.',
  } satisfies DocEntry;

  it('centres on the best match and truncates', () => {
    const s = makeSnippet(entry, 'handshake');
    expect(s).toContain('handshake');
    expect(s.length).toBeLessThanOrEqual(260);
  });

  it('falls back to description when no body match exists', () => {
    const s = makeSnippet(entry, 'nonexistentterm');
    expect(s).toBe('a fallback description');
  });
});
