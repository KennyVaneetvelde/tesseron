import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parseDoc,
  sectionFromSlug,
  slugFromPath,
  titleFromSlug,
  toSearchText,
  walkDocs,
} from '../src/content/parse';

function makeTmpDoc(body: string, name = 'page.mdx'): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'docs-mcp-'));
  const file = join(root, name);
  writeFileSync(file, body, 'utf8');
  return { root, file };
}

describe('slugFromPath', () => {
  it('strips extension and normalizes separators', () => {
    const root = '/docs';
    expect(slugFromPath('/docs/protocol/handshake.mdx', root)).toBe('protocol/handshake');
    expect(slugFromPath('/docs/index.mdx', root)).toBe('index');
  });
});

describe('sectionFromSlug', () => {
  it('returns the first path segment or empty for root', () => {
    expect(sectionFromSlug('protocol/handshake')).toBe('protocol');
    expect(sectionFromSlug('sdk/typescript/core')).toBe('sdk');
    expect(sectionFromSlug('index')).toBe('');
  });
});

describe('titleFromSlug', () => {
  it('humanises the last segment', () => {
    expect(titleFromSlug('protocol/handshake-and-claiming')).toBe('handshake and claiming');
    expect(titleFromSlug('index')).toBe('index');
  });
});

describe('toSearchText', () => {
  it('strips MDX imports', () => {
    const out = toSearchText(
      `import Foo from './Foo.astro';\nimport { Bar } from './Bar';\n\nReal content here.`,
    );
    expect(out).toBe('Real content here.');
  });

  it('strips self-closing and paired JSX components', () => {
    const out = toSearchText(
      `<Diagram foo="bar" />\n\nParagraph.\n\n<Card>\ninner\n</Card>\n\nTrailing.`,
    );
    expect(out).toContain('Paragraph.');
    expect(out).toContain('Trailing.');
    expect(out).not.toContain('Diagram');
    expect(out).not.toContain('inner');
  });

  it('keeps code fences and markdown', () => {
    const out = toSearchText('```ts\nconst x = 1;\n```\n\nProse.');
    expect(out).toContain('const x = 1');
    expect(out).toContain('Prose.');
  });
});

describe('parseDoc', () => {
  it('parses title, description, related list, and strips frontmatter from body', () => {
    const { root, file } = makeTmpDoc(
      '---\ntitle: Session resume\ndescription: Short description.\nrelated:\n  - protocol/handshake\n  - protocol/transport\n---\n\nBody text.',
      'resume.mdx',
    );
    const entry = parseDoc(file, root);
    expect(entry.slug).toBe('resume');
    expect(entry.title).toBe('Session resume');
    expect(entry.description).toBe('Short description.');
    expect(entry.related).toEqual(['protocol/handshake', 'protocol/transport']);
    expect(entry.bodyRaw).toContain('Body text.');
    expect(entry.bodyText).toBe('Body text.');
  });

  it('falls back to the filename stem when title is missing', () => {
    const { root, file } = makeTmpDoc(
      '---\ndescription: Only description.\n---\n\nBody.',
      'plain.md',
    );
    const entry = parseDoc(file, root);
    expect(entry.title).toBe('plain');
  });

  it('returns an empty related array when the field is absent', () => {
    const { root, file } = makeTmpDoc('---\ntitle: T\n---\nBody.', 'x.md');
    expect(parseDoc(file, root).related).toEqual([]);
  });
});

describe('walkDocs', () => {
  it('finds only .md/.mdx files recursively, in sorted order', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-mcp-walk-'));
    writeFileSync(join(root, 'z.md'), '---\ntitle: z\n---\n');
    writeFileSync(join(root, 'a.mdx'), '---\ntitle: a\n---\n');
    writeFileSync(join(root, 'ignore.txt'), 'nope');
    const files = walkDocs(root).map((f) => f.replace(root, ''));
    expect(files).toHaveLength(2);
    expect(files[0]).toMatch(/a\.mdx$/);
    expect(files[1]).toMatch(/z\.md$/);
  });
});
