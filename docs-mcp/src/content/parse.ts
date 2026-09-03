import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import matter from 'gray-matter';
import type { DocEntry } from './types.js';

const DOC_EXTENSIONS = new Set(['.md', '.mdx']);

/**
 * Recursively collect absolute paths of every Markdown/MDX file under `root`.
 * Order is stable (sorted at each directory level) so snapshots are deterministic.
 */
export function walkDocs(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir).sort();
    for (const name of entries) {
      const full = join(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      const ext = name.slice(name.lastIndexOf('.'));
      if (DOC_EXTENSIONS.has(ext)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/** Derive a stable slug from a doc file path relative to the docs root. */
export function slugFromPath(absPath: string, docsRoot: string): string {
  const rel = relative(docsRoot, absPath).split(sep).join('/');
  const dot = rel.lastIndexOf('.');
  return dot === -1 ? rel : rel.slice(0, dot);
}

/** Return the top-level folder of a slug, or `''` for root pages. */
export function sectionFromSlug(slug: string): string {
  const first = slug.indexOf('/');
  return first === -1 ? '' : slug.slice(0, first);
}

/** Derive a human-friendly fallback title when frontmatter lacks one. */
export function titleFromSlug(slug: string): string {
  const last = slug.slice(slug.lastIndexOf('/') + 1);
  return last.replace(/[-_]/g, ' ');
}

/**
 * Strip MDX imports and JSX-style component blocks from a raw body so the
 * remainder is suitable for text search. Regular Markdown (code fences, tables,
 * headings, lists) is preserved verbatim.
 */
export function toSearchText(raw: string): string {
  let out = raw;
  out = out.replace(/^import\s+[\s\S]*?;?\s*$/gm, '');
  out = out.replace(/<([A-Z][\w.]*)([^>]*)\/>/g, '');
  out = out.replace(/<([A-Z][\w.]*)([^>]*?)>[\s\S]*?<\/\1>/g, '');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return out;
}

type Frontmatter = {
  title?: unknown;
  description?: unknown;
  related?: unknown;
};

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === 'string' && item.trim()) out.push(item.trim());
  }
  return out;
}

/** Parse a single doc file into a `DocEntry`. */
export function parseDoc(absPath: string, docsRoot: string): DocEntry {
  const raw = readFileSync(absPath, 'utf8');
  const parsed = matter(raw);
  const fm = parsed.data as Frontmatter;

  const slug = slugFromPath(absPath, docsRoot);
  const title = asString(fm.title) || titleFromSlug(slug);
  const description = asString(fm.description);
  const related = asStringList(fm.related);
  const section = sectionFromSlug(slug);
  const bodyRaw = parsed.content;
  const bodyText = toSearchText(bodyRaw);

  return { slug, title, description, section, related, bodyRaw, bodyText };
}
