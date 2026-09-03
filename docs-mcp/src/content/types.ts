export type DocEntry = {
  /** Slug relative to `docs/src/content/docs/`, no extension. E.g. `protocol/handshake`. */
  slug: string;
  /** `title` field from frontmatter, or the filename stem as fallback. */
  title: string;
  /** `description` field from frontmatter; empty string if absent. */
  description: string;
  /** Top-level folder segment of the slug (`protocol`, `sdk`, `examples`, etc.). */
  section: string;
  /** Sibling-page slugs from the `related:` frontmatter list. */
  related: string[];
  /** Raw markdown/MDX body, exactly as authored. Returned by `read_doc`. */
  bodyRaw: string;
  /** Cleaned plain-text body used for full-text indexing. MDX imports and JSX removed. */
  bodyText: string;
};

export type Snapshot = {
  /** Short git SHA of the docs tree at build time, or `dev` when built locally. */
  version: string;
  /** ISO timestamp when the snapshot was generated. */
  generatedAt: string;
  /** Total number of docs pages in the snapshot. */
  count: number;
  docs: DocEntry[];
};
