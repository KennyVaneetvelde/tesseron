import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { 'tesseron-mcp': 'src/cli.ts' },
    outDir: 'dist',
    format: ['cjs'],
    target: 'node20',
    platform: 'node',
    bundle: true,
    noExternal: [/.*/],
    clean: true,
    splitting: false,
    sourcemap: false,
    minify: false,
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
  },
]);
