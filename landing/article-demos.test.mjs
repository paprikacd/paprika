import assert from 'node:assert/strict';
import test from 'node:test';
import { demoKeys, galleryRoutes, renderDashboardDemo, renderGalleryPreview } from './article-demos.js';
import { readManifest, renderDocument } from './build-content.mjs';

test('every editorial demo renders explanatory synthetic evidence without network hooks', () => {
  assert.deepEqual(demoKeys, ['release', 'prometheus', 'layout', 'testing', 'mcp']);
  for (const kind of demoKeys) {
    const html = renderDashboardDemo(kind, '../../');
    assert.match(html, /data-editorial-demo="/);
    assert.match(html, /INTERACTIVE \/ SYNTHETIC DATA/);
    assert.match(html, /Local fixture only/);
    assert.match(html, /data-demo-inspect type="range"/);
    assert.match(html, /aria-pressed="true"/);
    assert.match(html, /aria-live="polite"/);
    assert.match(html, /href="\.\.\/\.\.\/charts\/#charts"/);
    assert.doesNotMatch(html, /<script|https:\/\/ingest|data-provider-token/i);
    assert.equal((html.match(/data-demo-choice=/g) || []).length, 3);
  }
  assert.throws(() => renderDashboardDemo('invalid'), /Unknown editorial demo/);
});

test('gallery embeds require explicit interaction and preserve non-JavaScript fallback', () => {
  for (const route of galleryRoutes) {
    const html = renderGalleryPreview(route, '../../');
    assert.match(html, /data-gallery-launch hidden/);
    assert.match(html, /data-gallery-frame/);
    assert.doesNotMatch(html, /<iframe[^>]*\bsrc=/);
    assert.ok(html.includes(`href="../../charts/#${route}"`));
  }
  assert.throws(() => renderGalleryPreview('https://evil.invalid/'), /Unknown chart-gallery route/);
});

test('blog Markdown supports only whitelisted, empty editorial directives', () => {
  const item = readManifest().posts.find((post) => post.slug === 'kubernetes-release-dashboard');
  const routes = new Map();
  const valid = renderDocument(item, routes, new Map(), [
    '# Test heading',
    '',
    '```paprika-dashboard release',
    '```',
    '',
    '```paprika-gallery kubernetes-fleet',
    '```',
    '',
    '## Inspect the evidence',
    '',
    'A readable explanation alongside the interactive fixture.',
  ].join('\n'));
  assert.match(valid.html, /data-editorial-demo="release"/);
  assert.match(valid.html, /data-editorial-gallery/);
  assert.match(valid.html, /<h2 id="inspect-the-evidence"/);
  assert.throws(() => renderDocument(item, routes, new Map(),
    '# Example\n\n```paprika-dashboard injected\n```\n'), /Unknown editorial directive/);
  assert.throws(() => renderDocument(item, routes, new Map(),
    '# Example\n\n```paprika-dashboard release\n<img src=x>\n```\n'), /must not contain arbitrary/);
  const doc = readManifest().docs[0];
  assert.throws(() => renderDocument(doc, routes, new Map(),
    '# Example\n\n```paprika-dashboard release\n```\n'), /only allowed in blog/);
});
