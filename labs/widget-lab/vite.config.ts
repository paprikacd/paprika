import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';

// Loopback by default. WIDGET_LAB_HOST=0.0.0.0 exposes the dev server on the
// network on purpose; Vite's host-header check stays enabled in both cases.
// Relative base: the static build is published under an unknown URL prefix, so
// every emitted script, stylesheet, font and public/ URL resolves from the page.

// The renderer is production's: `@insights/*` points at ui/src/features/insights.
// Files that the lab patch changes are held in src/renderer-extensions/ instead
// (see its README). Production files resolve packages from this lab's
// node_modules through `dedupe`, so one React and one TanStack Charts serve both.
const labRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const insightsDir = resolve(repoRoot, 'ui/src/features/insights');
const holdingDir = resolve(labRoot, 'src/renderer-extensions');

// One registry instance. Production plugin modules register through
// `./widget-registry`; the lab renderer reads the patched registry. Resolving
// those production imports to the holding copy keeps a single store, so every
// registration lands where the lab renderer looks.
const holdingOverlays = new Map([[`${insightsDir}/widget-registry.tsx`, `${holdingDir}/widget-registry.tsx`]]);

function holdingOverlay(): Plugin {
  return {
    name: 'paprika-holding-overlay',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !importer.startsWith(`${insightsDir}/`)) return null;
      const resolved = await this.resolve(source, importer, { skipSelf: true, custom: options.custom });
      if (!resolved || resolved.external) return null;
      return holdingOverlays.get(resolved.id) ?? null;
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [holdingOverlay(), react()],
  resolve: {
    alias: [{ find: /^@insights\//, replacement: `${insightsDir}/` }],
    dedupe: ['react', 'react-dom', '@tanstack/charts', 'd3-hierarchy', 'd3-scale', 'd3-shape', 'lucide-react', 'yaml', 'zod'],
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
