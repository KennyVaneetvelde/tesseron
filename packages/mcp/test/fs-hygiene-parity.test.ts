/**
 * Drift detector for the byte-identical `fs-hygiene.ts` copies in
 * `@tesseron/vite`, `@tesseron/server`, and `@tesseron/mcp`.
 *
 * The PR that introduced these helpers explicitly chose three identical
 * copies over a shared package or cross-package dep. The trade-off is fine
 * as long as the three files actually stay identical — but the *only*
 * thing keeping them in sync today is the header comment and reviewer
 * vigilance. A bugfix landed in one and missed in the others would leave
 * the security-claim-violating behavior live in two of the three packages,
 * with no test signal.
 *
 * This test compares the SHA-256 of all three files. A drift produces a
 * one-line failure pointing at the offending pair, and the fix is a
 * trivial `cp` between the three. Lives in `@tesseron/mcp` because mcp
 * already transitively reads the others (it's the gateway, the consumer
 * of all transport kinds), so the assertion runs once per CI rather than
 * three times.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');

const COPIES = {
  vite: resolve(REPO_ROOT, 'packages/vite/src/fs-hygiene.ts'),
  server: resolve(REPO_ROOT, 'packages/server/src/fs-hygiene.ts'),
  mcp: resolve(REPO_ROOT, 'packages/mcp/src/fs-hygiene.ts'),
};

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('fs-hygiene byte-identical-copies invariant', () => {
  it('three copies have the same SHA-256', () => {
    const hashes = Object.fromEntries(
      Object.entries(COPIES).map(([k, p]) => [k, sha256(p)]),
    ) as Record<keyof typeof COPIES, string>;

    // If this fails, copy whichever version you intended into the other
    // two: `cp packages/{vite,server,mcp}/src/fs-hygiene.ts` either
    // direction. The three copies are deliberately identical; see the
    // header comment in any of them.
    expect(hashes.server, 'server vs vite').toBe(hashes.vite);
    expect(hashes.mcp, 'mcp vs vite').toBe(hashes.vite);
  });
});
