import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildContent, readAnalyticsConfig, readManifest, validateManifest } from './build-content.mjs';
import { jsonScript } from './structured-data.mjs';

test('embedded JSON-LD cannot terminate its script and preserves editorial text', () => {
  const value = { headline: '</script><script>alert("x")</script> & punctuation\u2028\u2029' };
  const script = jsonScript(value);
  assert.ok(!script.includes('<'));
  assert.ok(!/[\u2028\u2029]/.test(script));
  assert.deepEqual(JSON.parse(script), value);
});

test('publication dates require a real calendar date, time and explicit UTC zone', () => {
  const post = { slug: 'test', title: 'Test', description: 'Test publication date',
    category: 'Delivery', source: 'landing/content/blog/promoting-pinned-revisions.md', image: readManifest().posts[0].image };
  const docs = [{ slug: 'start', title: 'Test guide', description: 'Test guide',
    section: 'Start', source: 'docs/getting-started.md', image: readManifest().docs[0].image }];
  for (const date of ['2026-11-07', '2026-11-07T06:57:52', '2026-02-30T06:57:52Z', '2026-11-07T25:00:00Z']) {
    assert.throws(() => validateManifest({ docs, posts: [{ ...post, date }] }), /publication/);
  }
  assert.equal(validateManifest({ docs, posts: [{ ...post, date: '2026-11-07T06:57:52Z' }] }).posts[0].date,
    '2026-11-07T06:57:52Z');
});

test('article images require real local files, accurate dimensions and editorial descriptions', () => {
  const manifest = readManifest();
  for (const image of [undefined, { ...manifest.docs[0].image, alt: '' },
    { ...manifest.docs[0].image, caption: '' },
    { ...manifest.docs[0].image, src: '../paprika-mark.png' },
    { ...manifest.docs[0].image, src: 'https://example.com/unrelated.png' },
    { ...manifest.docs[0].image, width: 1 },
    { ...manifest.docs[0].image, mobile: { ...manifest.docs[0].image.mobile, height: 1 } }]) {
    const invalid = structuredClone(manifest);
    invalid.docs[0].image = image;
    assert.throws(() => validateManifest(invalid), /image|PNG/);
  }
});

test('every published article ties its schema image to a visible figure and copied asset', () => {
  const destination = mkdtempSync(join(tmpdir(), 'paprika-article-images-'));
  try {
    buildContent(destination);
    const manifest = readManifest();
    for (const item of [...manifest.docs, ...manifest.posts]) {
      const html = readFileSync(join(destination, item.route, 'index.html'), 'utf8');
      const graph = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1])['@graph'];
      const article = graph.find(node => ['TechArticle', 'BlogPosting'].includes(node['@type']));
      const image = graph.find(node => node['@id'] === article.image['@id']);
      assert.equal(image['@type'], 'ImageObject');
      assert.equal(image.url, `https://paprikacd.github.io/paprika/${item.image.src}`);
      assert.equal(image.contentUrl, image.url);
      assert.equal(image.width, item.image.width);
      assert.equal(image.caption, item.image.caption);
      assert.equal(graph.find(node => node['@id'].endsWith('#webpage')).primaryImageOfPage['@id'], image['@id']);
      assert.match(html, /<figure class="article-figure">/);
      assert.ok(html.includes(`src="../../${item.image.src}"`));
      assert.ok(html.includes(`srcset="../../${item.image.mobile.src}"`));
      assert.ok(html.includes(`<meta property="og:image" content="${image.url}"`));
      assert.ok(html.includes(`<meta name="twitter:image" content="${image.url}"`));
      assert.deepEqual(readFileSync(join(destination, item.image.src)), readFileSync(new URL(item.image.src, import.meta.url)));
    }
  } finally { rmSync(destination, { recursive: true, force: true }); }
});

test('a rebuild replaces homepage schema, decodes metadata and retains one analytics loader', () => {
  const destination = mkdtempSync(join(tmpdir(), 'paprika-schema-'));
  try {
    const homepage = join(destination, 'index.html');
    writeFileSync(homepage, '<html><head><title>Paprika &amp; Kubernetes</title><meta name="description" content="Read &quot;the docs&quot; &amp; deploy. Literal $&."/><!-- structured-data:start --><!-- structured-data:end --></head><body></body></html>');
    buildContent(destination);
    const first = readFileSync(homepage, 'utf8');
    buildContent(destination);
    assert.equal(readFileSync(homepage, 'utf8'), first, 'Repeated builds must not duplicate or mutate markup');
    const blocks = [...first.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)];
    assert.equal(blocks.length, 1);
    const page = JSON.parse(blocks[0][1])['@graph'].find((entity) => entity['@type'] === 'WebPage');
    assert.equal(page.name, 'Paprika & Kubernetes');
    assert.equal(page.description, 'Read "the docs" & deploy. Literal $&.');
    assert.equal((first.match(/id="paprika-analytics"/g) || []).length, readAnalyticsConfig().siteId ? 1 : 0);
    writeFileSync(homepage, first.replace('<!-- structured-data:start -->', ''));
    assert.throws(() => buildContent(destination), /one structured-data placeholder/);
  } finally { rmSync(destination, { recursive: true, force: true }); }
});
