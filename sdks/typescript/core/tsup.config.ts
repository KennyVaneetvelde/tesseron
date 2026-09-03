import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    protocol: 'src/protocol.ts',
    errors: 'src/errors.ts',
    internal: 'src/internal.ts',
    node: 'src/node.ts',
  },
  outDir: 'dist',
  format: ['esm', 'cjs'],
  target: 'es2022',
  platform: 'neutral',
  dts: true,
  sourcemap: true,
  clean: true,
  // splitting=true lets tsup deduplicate code shared between entries
  // (e.g. TesseronError is reachable from both `index` and `internal`).
  // Without it the dispatcher in `internal.cjs` and TesseronError in
  // `index.cjs` end up as separate class definitions, and `instanceof`
  // checks across them silently fail. The duplication is a tsup default
  // for multi-entry CJS — splitting at least handles ESM correctly.
  splitting: true,
  treeshake: true,
});
