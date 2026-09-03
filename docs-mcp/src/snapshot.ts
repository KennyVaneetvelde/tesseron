import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DocEntry, Snapshot } from './content/types.js';

const SNAPSHOT_FILENAME = 'docs-index.json';
const ENV_SNAPSHOT_PATH = 'TESSERON_DOCS_SNAPSHOT';

function thisModuleDir(): string {
  if (typeof __dirname !== 'undefined') return __dirname;
  return dirname(fileURLToPath(import.meta.url));
}

/**
 * Locate the bundled snapshot JSON. Lookup order:
 *   1. `TESSERON_DOCS_SNAPSHOT` environment variable, if set.
 *   2. Explicit `override` argument.
 *   3. Alongside the compiled bin (production / `npx` use).
 *   4. `../dist/docs-index.json` (when running via `tsx src/cli.ts` in dev).
 */
export function resolveSnapshotPath(override?: string): string {
  const envPath = process.env[ENV_SNAPSHOT_PATH];
  if (envPath) return envPath;
  if (override) return override;

  const here = thisModuleDir();
  const bundled = resolve(here, SNAPSHOT_FILENAME);
  if (existsSync(bundled)) return bundled;

  const devFallback = resolve(here, '..', 'dist', SNAPSHOT_FILENAME);
  return devFallback;
}

export function loadSnapshot(override?: string): Snapshot {
  const path = resolveSnapshotPath(override);
  if (!existsSync(path)) {
    throw new Error(
      `[tesseron-docs-mcp] snapshot not found at ${path}. Run "pnpm --filter @tesseron/docs-mcp build" to generate it, or set ${ENV_SNAPSHOT_PATH}=/abs/path/to/docs-index.json.`,
    );
  }
  const raw = readFileSync(path, 'utf8');
  const parsed = JSON.parse(raw) as Snapshot;
  if (!Array.isArray(parsed.docs)) {
    throw new Error(`[tesseron-docs-mcp] invalid snapshot at ${path}: missing "docs" array.`);
  }
  return parsed;
}

/** Index docs by slug for O(1) lookup in `read_doc`. */
export function indexBySlug(docs: DocEntry[]): Map<string, DocEntry> {
  const map = new Map<string, DocEntry>();
  for (const d of docs) map.set(d.slug, d);
  return map;
}
