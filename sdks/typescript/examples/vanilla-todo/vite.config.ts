import { defineConfig } from 'vite';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [tesseron({ appName: 'vanilla-todo' })],
  server: { port: 5173 },
  // src/main.ts uses a top-level `await tesseron.connect()`, which requires
  // ES2022+ module output. Vite's default build target (`'modules'`, which
  // resolves to chrome87/firefox78/safari14/es2020) predates top-level await.
  build: { target: 'es2022' },
});
