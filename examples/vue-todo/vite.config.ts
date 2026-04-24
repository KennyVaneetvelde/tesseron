import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [vue(), tesseron({ appName: 'vue-todo' })],
  server: { port: 5176 },
});
