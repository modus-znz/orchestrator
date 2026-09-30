import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwind()],
  build: {
    // The daemon serves this directory; `serveStatic` caches anything under
    // /assets/ forever, which is only safe because Vite fingerprints it.
    outDir: 'dist',
    sourcemap: true,
  },
  server: {
    // `npm run dev` talks to the real daemon rather than a mock, so the UI is
    // developed against the same auth and the same event stream it ships with.
    proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: false } },
  },
});
