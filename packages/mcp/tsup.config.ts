import { defineConfig } from 'tsup';

export default defineConfig({
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
});
