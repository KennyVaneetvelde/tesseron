import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [svelte(), tesseron({ appName: 'svelte-todo' })],
  server: { port: 5175 },
});
