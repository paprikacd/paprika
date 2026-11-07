import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

// Loopback by default. WIDGET_LAB_HOST=0.0.0.0 exposes the dev server on the
// network on purpose; Vite's host-header check stays enabled in both cases.
// Relative base: the static build is published under an unknown URL prefix, so
// every emitted script, stylesheet, font and public/ URL resolves from the page.

// The renderer is production's: `@insights/*` points at ui/src/features/insights,
// and nothing is held in a copy. One module graph serves production and the lab,
// so one widget registry holds every registration (src/renderer-extensions/README.md).
// Production files resolve packages from this lab's node_modules through `dedupe`,
// so one React and one TanStack Charts serve both.
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const insightsDir = resolve(repoRoot, 'ui/src/features/insights');

export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@insights\//, replacement: `${insightsDir}/` }],
    // react-grid-layout and react-resizable (its CSS) are imported by production's canvas.tsx, which sits under ui/
    // where this lab's node_modules is not on the resolution path. They resolve from the lab root only through here.
    dedupe: ['react', 'react-dom', '@tanstack/charts', 'd3-hierarchy', 'd3-scale', 'd3-shape', 'lucide-react', 'react-grid-layout', 'react-resizable', 'yaml', 'zod'],
  },
  server: {
    host: process.env.WIDGET_LAB_HOST || '127.0.0.1',
    port: Number(process.env.PORT || 3000),
    // Production sources live outside the lab root; the repository is the allowed root.
    fs: { allow: [repoRoot] },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      onwarn(warning, warn) {
        // Production modules keep their "use client" directives; Rollup ignores them here.
        if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
        warn(warning);
      },
    },
  },
});
