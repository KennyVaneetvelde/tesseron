import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { tesseron } from '@tesseron/vite';

export default defineConfig({
  plugins: [react(), tesseron({ appName: 'react-todo' })],
  server: { port: 5174 },
});
