import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DocEntry, Snapshot } from './content/types.js';
import { DocsIndex } from './search.js';

const RESOURCE_SCHEME = 'tesseron-docs';

export type ServerOptions = {
  /** Snapshot produced by `scripts/build-snapshot.ts`. */
  snapshot: Snapshot;
  /** Optional override of the reported server name (for test isolation). */
  name?: string;
  /** Optional override of the reported server version. */
  version?: string;
};

/**
 * Build an `McpServer` wired up with `list_docs`, `search_docs`, `read_doc`
 * tools and `tesseron-docs://<slug>` resources.
 */
export function createDocsMcpServer(options: ServerOptions): McpServer {
  const { snapshot } = options;
  const bySlug = new Map<string, DocEntry>(snapshot.docs.map((d) => [d.slug, d]));
  const index = new DocsIndex(snapshot.docs);

  const server = new McpServer({
    name: options.name ?? 'tesseron-docs',
    version: options.version ?? snapshot.version,
  });

  server.registerTool(
    'list_docs',
    {
      description:
        'List every Tesseron documentation page with title, slug, section, short description, and related slugs. Cheap, call before searching when you want the full catalogue.',
      inputSchema: {},
    },
    () => {
      const docs = snapshot.docs.map((d) => ({
        slug: d.slug,
        title: d.title,
        section: d.section,
        description: d.description,
        related: d.related,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify({ count: docs.length, docs }, null, 2) }],
      };
    },
  );

  server.registerTool(
    'search_docs',
    {
      description:
        'Full-text search across Tesseron docs (BM25, title- and description-weighted). Returns ranked hits with short snippets. Call `read_doc(slug)` on promising hits for full content.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe('Free-form query. Supports multiple terms; fuzzy + prefix matching are on.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Maximum hits to return. Default 8, hard cap 20.'),
      },
    },
    ({ query, limit }) => {
      const hits = index.search(query, limit ?? 8);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ query, count: hits.length, hits }, null, 2),
          },
        ],
      };
    },
  );

  server.registerTool(
    'read_doc',
    {
      description:
        'Return the full markdown body of a Tesseron docs page plus its structured frontmatter (title, description, section, related). Slug format: `<section>/<basename>` without extension (e.g. `protocol/handshake`).',
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe('Page slug. Use `list_docs` or `search_docs` to discover valid slugs.'),
      },
    },
    ({ slug }) => {
      const entry = bySlug.get(slug);
      if (!entry) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `No doc found for slug "${slug}". Call list_docs to see valid slugs.`,
            },
          ],
        };
      }
      const payload = {
        slug: entry.slug,
        title: entry.title,
        description: entry.description,
        section: entry.section,
        related: entry.related,
        body: entry.bodyRaw,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  server.registerResource(
    'tesseron-doc',
    new ResourceTemplate(`${RESOURCE_SCHEME}://{+slug}`, {
      list: () => ({
        resources: snapshot.docs.map((d) => ({
          uri: `${RESOURCE_SCHEME}://${d.slug}`,
          name: d.title,
          description: d.description,
          mimeType: 'text/markdown',
        })),
      }),
    }),
    {
      title: 'Tesseron documentation page',
      description: 'Full markdown body of a single Tesseron docs page, keyed by slug.',
    },
    (uri, variables) => {
      const slug = Array.isArray(variables['slug'])
        ? variables['slug'][0]
        : (variables['slug'] as string | undefined);
      if (!slug) {
        throw new Error(`Missing slug in resource URI ${uri.href}`);
      }
      const entry = bySlug.get(slug);
      if (!entry) {
        throw new Error(`No doc found for slug "${slug}".`);
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: entry.bodyRaw,
          },
        ],
      };
    },
  );

  return server;
}
