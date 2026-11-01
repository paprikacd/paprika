import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Loopback by default. WIDGET_LAB_HOST=0.0.0.0 exposes the dev server on the
// network on purpose; Vite's host-header check stays enabled in both cases.
export default defineConfig({
  plugins: [react()],
  server: { host: process.env.WIDGET_LAB_HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) },
  build: { outDir: 'dist', sourcemap: true },
});
