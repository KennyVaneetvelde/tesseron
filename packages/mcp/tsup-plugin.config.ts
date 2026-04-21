import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/cli.ts' },
  outDir: '../../plugin/server',
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
