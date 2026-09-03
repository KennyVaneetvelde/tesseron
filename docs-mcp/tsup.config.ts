import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'tsup';

const SNAPSHOT_SRC = resolve(__dirname, 'dist/docs-index.json');

export default defineConfig([
  {
    entry: { 'tesseron-docs-mcp': 'src/cli.ts' },
    outDir: 'dist',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    bundle: true,
    noExternal: [/.*/],
    clean: false,
    splitting: false,
    sourcemap: false,
    minify: false,
    async onSuccess() {
      if (!existsSync(SNAPSHOT_SRC)) {
        throw new Error(
          `docs-index.json missing at ${SNAPSHOT_SRC}; run "pnpm build:snapshot" before tsup.`,
        );
      }
      copyFileSync(SNAPSHOT_SRC, resolve(__dirname, 'dist/docs-index.json'));
    },
  },
  {
    entry: { index: 'src/index.ts' },
    outDir: 'dist',
    format: ['esm', 'cjs'],
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
    splitting: false,
    treeshake: true,
    clean: false,
  },
]);
