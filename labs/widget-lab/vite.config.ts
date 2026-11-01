import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Loopback by default. WIDGET_LAB_HOST=0.0.0.0 exposes the dev server on the
// network on purpose; Vite's host-header check stays enabled in both cases.
// Relative base: the static build is published under an unknown URL prefix, so
// every emitted script, stylesheet, font and public/ URL resolves from the page.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: { host: process.env.WIDGET_LAB_HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) },
  build: { outDir: 'dist', sourcemap: false },
});
