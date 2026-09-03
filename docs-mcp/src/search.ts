import MiniSearch from 'minisearch';
import type { DocEntry } from './content/types.js';

export type SearchHit = {
  slug: string;
  title: string;
  description: string;
  section: string;
  score: number;
  snippet: string;
};

const SNIPPET_RADIUS = 120;
const SNIPPET_MAX = SNIPPET_RADIUS * 2;

export class DocsIndex {
  private readonly mini: MiniSearch<DocEntry>;
  private readonly bySlug: Map<string, DocEntry>;

  constructor(docs: DocEntry[]) {
    this.bySlug = new Map(docs.map((d) => [d.slug, d]));
    this.mini = new MiniSearch<DocEntry>({
      idField: 'slug',
      fields: ['title', 'description', 'bodyText'],
      storeFields: ['slug', 'title', 'description', 'section'],
      searchOptions: {
        boost: { title: 3, description: 2 },
        fuzzy: 0.15,
        prefix: true,
      },
    });
    this.mini.addAll(docs);
  }

  search(query: string, limit = 8): SearchHit[] {
    const raw = this.mini.search(query);
    const out: SearchHit[] = [];
    for (const r of raw.slice(0, Math.max(1, Math.min(limit, 20)))) {
      const slug = String(r['slug']);
      const entry = this.bySlug.get(slug);
      if (!entry) continue;
      out.push({
        slug,
        title: String(r['title']),
        description: String(r['description'] ?? ''),
        section: String(r['section'] ?? ''),
        score: typeof r['score'] === 'number' ? r['score'] : 0,
        snippet: makeSnippet(entry, query),
      });
    }
    return out;
  }
}

/**
 * Extract a ~240-char snippet centred on the best match for `query` within
 * `entry.bodyText`. Falls back to `description` when no body match is found.
 */
export function makeSnippet(entry: DocEntry, query: string): string {
  const text = entry.bodyText;
  if (!text) return entry.description;

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
  if (terms.length === 0) return truncate(text, SNIPPET_MAX);

  const lower = text.toLowerCase();
  let bestIdx = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) bestIdx = idx;
  }
  if (bestIdx === -1) return entry.description || truncate(text, SNIPPET_MAX);

  const start = Math.max(0, bestIdx - SNIPPET_RADIUS);
  const end = Math.min(text.length, bestIdx + SNIPPET_RADIUS);
  let slice = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) slice = `…${slice}`;
  if (end < text.length) slice = `${slice}…`;
  return slice;
}

function truncate(s: string, n: number): string {
  const single = s.replace(/\s+/g, ' ').trim();
  return single.length <= n ? single : `${single.slice(0, n - 1)}…`;
}
