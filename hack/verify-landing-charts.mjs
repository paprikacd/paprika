#!/usr/bin/env node
// Usage:
//   node hack/verify-landing-charts.mjs <built-directory>     landing page plus the gallery at <built-directory>/charts
//   node hack/verify-landing-charts.mjs --gallery <dist-dir> the widget lab build alone (static checks and size budget)
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Gallery size budget, measured on the widget lab build on 2026-11-24:
//   JS total 2,468,209 B; largest JS file 852,755 B (assets/index-*.js); fonts 1,176,152 B; directory 4,727,693 B.
// Each limit is the measurement plus 10%. Per-file limits: PNG 300 KiB, any other image 400 KiB.
const BUDGET = {
  jsTotal: 2715030,
  jsLargest: 937031,
  fontsTotal: 1293767,
  directoryTotal: 5200462,
  png: 300 * 1024,
  image: 400 * 1024,
};
const FONT = /\.(ttf|otf|woff2?)$/;
const IMAGE = /\.(png|webp|jpe?g|gif|svg|avif)$/;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function verifyGallerySize(galleryDir) {
  const files = walk(galleryDir).map(path => ({ name: relative(galleryDir, path), bytes: statSync(path).size }));
  const sum = (items) => items.reduce((total, item) => total + item.bytes, 0);
  const js = files.filter(file => file.name.endsWith('.js'));
  const fonts = files.filter(file => FONT.test(file.name));
  const largestJs = js.reduce((largest, file) => (file.bytes > largest.bytes ? file : largest), { name: '', bytes: 0 });
  const measured = `measured ${sum(js)} B JS, largest ${largestJs.bytes} B, fonts ${sum(fonts)} B, directory ${sum(files)} B`;
  assert.ok(sum(js) <= BUDGET.jsTotal, `Gallery JavaScript exceeds ${BUDGET.jsTotal} B (${measured})`);
  assert.ok(largestJs.bytes <= BUDGET.jsLargest, `Largest gallery script ${largestJs.name} exceeds ${BUDGET.jsLargest} B`);
  assert.ok(sum(fonts) <= BUDGET.fontsTotal, `Gallery fonts exceed ${BUDGET.fontsTotal} B (${measured})`);
  assert.ok(sum(files) <= BUDGET.directoryTotal, `Gallery directory exceeds ${BUDGET.directoryTotal} B (${measured})`);
  for (const file of files) {
    if (file.name.endsWith('.png')) assert.ok(file.bytes <= BUDGET.png, `${file.name} is ${file.bytes} B; PNG limit is ${BUDGET.png} B`);
    if (IMAGE.test(file.name)) assert.ok(file.bytes <= BUDGET.image, `${file.name} is ${file.bytes} B; image limit is ${BUDGET.image} B`);
  }
  return files.length;
}

function verifyGallery(chartsDir) {
  const gallery = readFileSync(join(chartsDir, 'index.html'), 'utf8');
  assert.match(gallery, /Paprika.*Chart/i, 'The gallery must describe charts');
  assert.match(gallery, /assets\/index-[^"']+\.js/, 'Missing Vite module entry');
  assert.match(gallery, /assets\/index-[^"']+\.css/, 'Missing Vite stylesheet entry');
  const allAssets = [...gallery.matchAll(/(?:src|href)="(\.\/assets\/[^"']+)"/g)].map((match) => match[1]);
  for (const asset of allAssets) {
    assert.ok(existsSync(join(chartsDir, asset)), 'Missing gallery dependency ' + asset);
  }
  assert.ok(existsSync(join(chartsDir, 'fonts/OFL.txt')), 'Retain bundled font attribution');
  return verifyGallerySize(chartsDir);
}

function verifyLanding(dest) {
  const landing = readFileSync(join(dest, 'index.html'), 'utf8');
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
  verifyGallery(join(dest, 'charts'));
  return { selectors: selectors.length, routes: routes.size };
}

const args = process.argv.slice(2);
if (args[0] === '--gallery') {
  if (!args[1]) throw new Error('Usage: node hack/verify-landing-charts.mjs --gallery <dist-directory>');
  const files = verifyGallery(resolve(args[1]));
  console.log('Verified widget lab gallery and its size budget (' + files + ' files).');
} else {
  if (!args[0]) throw new Error('Usage: node hack/verify-landing-charts.mjs [--gallery] <built-directory>');
  const { selectors: shortcuts, routes } = verifyLanding(resolve(args[0]));
  console.log('Verified landing + full chart gallery (' + shortcuts + ' example shortcuts, ' + routes + ' known routes).');
}
