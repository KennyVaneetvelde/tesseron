import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'tesseron-conformance': 'src/bin.ts' },
  outDir: 'dist',
  format: ['cjs'],
  outExtension: () => ({ js: '.cjs' }),
  target: 'node20',
  platform: 'node',
  bundle: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  minify: false,
});
