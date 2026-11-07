#!/usr/bin/env node
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = resolve(process.argv[2] || '');
if (!process.argv[2]) {
  throw new Error('Usage: node hack/verify-landing-charts.mjs <built-directory>');
}
const landing = readFileSync(join(dest, 'index.html'), 'utf8');
const gallery = readFileSync(join(dest, 'charts/index.html'), 'utf8');
const lenses = readFileSync(join(project, 'labs/widget-lab/src/lenses/lens-routes.ts'), 'utf8');
const routes = new Set(['charts', 'edge', 'reliability']);
for (const [, route] of lenses.matchAll(/\bid:'([a-z][a-z0-9-]+)'/g)) routes.add(route);

assert.match(landing, /id="charts" class="chart-showcase/);
assert.match(landing, /id="chart-showcase-frame"[^>]+src="\.\/charts\/#charts"/);
const selectors = [...landing.matchAll(/data-chart-route="([^"]+)"/g)].map((match) => match[1]);
assert.ok(selectors.length >= 5, 'Landing should expose the full catalogue and multiple representative lenses');
assert.equal(new Set(selectors).size, selectors.length, 'No duplicate showcase picker routes');
for (const route of selectors) {
  assert.ok(routes.has(route), 'Unknown public lens: ' + route);
  assert.ok(landing.includes('href="./charts/#' + route + '"'), 'Missing non-JavaScript route fallback: ' + route);
}
assert.ok(existsSync(join(dest, 'chart-showcase.js')), 'Missing landing interaction module');
assert.ok(existsSync(join(dest, 'chart-showcase.css')), 'Missing landing styles');
assert.ok(existsSync(join(dest, '.nojekyll')), 'GitHub Pages must serve generated assets without Jekyll filters');
assert.match(gallery, /Paprika.*Chart/i, 'The gallery must describe charts');
assert.match(gallery, /assets\/index-[^"']+\.js/, 'Missing Vite module entry');
assert.match(gallery, /assets\/index-[^"']+\.css/, 'Missing Vite stylesheet entry');
const allAssets = [...gallery.matchAll(/(?:src|href)="(\.\/assets\/[^"']+)"/g)].map((match) => match[1]);
for (const asset of allAssets) {
  assert.ok(existsSync(join(dest, 'charts', asset)), 'Missing gallery dependency ' + asset);
}
assert.ok(existsSync(join(dest, 'charts/fonts/OFL.txt')), 'Retain bundled font attribution');
console.log('Verified landing + full chart gallery (' + selectors.length + ' example shortcuts, ' + routes.size + ' known routes).');

