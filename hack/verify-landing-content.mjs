#!/usr/bin/env node
/** Verify the assembled public site, including Markdown links and SEO output. */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAnalyticsConfig, readManifest, siteURL } from '../landing/build-content.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(process.argv[2], 'Usage: node hack/verify-landing-content.mjs <assembled-site-directory>');
const destination = resolve(process.argv[2]);
const manifest = readManifest();
const analytics = readAnalyticsConfig();
const items = [...manifest.docs, ...manifest.posts];
const routes = ['', 'tour.html', 'charts/', 'docs/', 'blog/', ...items.map((item) => item.route)];
const htmlRoutes = routes.filter((route) => route !== 'charts/').concat('404.html');
const canonicalBase = new URL(siteURL);
const contentRoutes = new Set(['docs/', 'blog/', ...items.map((item) => item.route)]);
const titles = new Set();
const descriptions = new Set();
const cache = new Map();
let localLinks = 0;
let fragmentLinks = 0;
let sourceLinks = 0;
const failures = [];

function decode(value) {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#39|#\d+|#x[a-f\d]+);/gi, (entity) => {
    const named = { '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&#39;': "'" };
    if (named[entity]) return named[entity];
    return String.fromCodePoint(entity[2].toLowerCase() === 'x' ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10));
  });
}

function attributes(tag) {
  const values = {};
  for (const match of tag.matchAll(/\s([a-zA-Z_:][a-zA-Z\d_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    values[match[1].toLowerCase()] = decode(match[2] ?? match[3]);
  }
  return values;
}

function filename(route) {
  return join(destination, route.endsWith('.html') ? route : `${route}index.html`);
}

function readHTML(route) {
  if (!cache.has(route)) {
    const path = filename(route);
    assert.ok(existsSync(path), `Missing published page: ${route || '/'}`);
    const html = readFileSync(path, 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => decode(match[1]));
    assert.equal(new Set(ids).size, ids.length, `Duplicate IDs in ${route || '/'}`);
    cache.set(route, { html, ids: new Set(ids) });
  }
  return cache.get(route);
}

function verifyURL(value, currentRoute, { asset = false, fragment = true } = {}) {
  assert.ok(value && !value.includes('undefined'), `Empty or invalid URL in ${currentRoute}`);
  const url = new URL(value, new URL(currentRoute, siteURL));
  assert.ok(['http:', 'https:', 'mailto:'].includes(url.protocol), `Unsafe URL in ${currentRoute}: ${value}`);
  if (url.origin === 'https://github.com' && /^\/paprikacd\/paprika\/(?:blob|tree)\/master\//.test(url.pathname) && contentRoutes.has(currentRoute)) {
    const source = decodeURIComponent(url.pathname.replace(/^\/paprikacd\/paprika\/(?:blob|tree)\/master\//, ''));
    const path = resolve(repository, source);
    const relativeSource = relative(repository, path);
    assert.ok(!relativeSource.startsWith(`..${sep}`) && !isAbsolute(relativeSource), `Repository link escaped source: ${value}`);
    assert.ok(existsSync(path), `Missing repository target from ${currentRoute}: ${source}`);
    sourceLinks += 1;
    return;
  }
  if (url.origin !== canonicalBase.origin) return;
  assert.ok(url.pathname.startsWith(canonicalBase.pathname), `Link escapes the GitHub Pages project in ${currentRoute}: ${value}`);
  const publicPath = decodeURIComponent(url.pathname.slice(canonicalBase.pathname.length));
  const path = resolve(destination, publicPath);
  const relativeTarget = relative(destination, path);
  assert.ok(!relativeTarget.startsWith(`..${sep}`) && !isAbsolute(relativeTarget), `Local URL escaped output: ${value}`);
  assert.ok(existsSync(path), `Missing local target from ${currentRoute}: ${publicPath || '/'}`);
  const target = statSync(path).isDirectory() ? join(path, 'index.html') : path;
  assert.ok(existsSync(target), `Missing index at ${publicPath}`);
  localLinks += 1;
  if (!asset && fragment && url.hash && publicPath !== 'charts/' && target.endsWith('.html')) {
    const route = publicPath.endsWith('.html') ? publicPath : publicPath.endsWith('/') ? publicPath : `${publicPath}/`;
    const id = decodeURIComponent(url.hash.slice(1));
    assert.ok(readHTML(route).ids.has(id), `Missing fragment ${id} in ${route || '/'} (linked from ${currentRoute})`);
    fragmentLinks += 1;
  }
}

for (const route of htmlRoutes) {
  try {
  const { html } = readHTML(route);
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] || '';
  const title = decode(head.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
  assert.ok(title, `Missing title: ${route}`);
  assert.ok(!titles.has(title), `Duplicate title: ${title}`);
  titles.add(title);
  const meta = [...head.matchAll(/<meta\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const description = meta.find((tag) => tag.name === 'description')?.content;
  assert.ok(description?.trim(), `Missing description: ${route}`);
  assert.ok(!descriptions.has(description), `Duplicate description: ${route}`);
  descriptions.add(description);
  const links = [...head.matchAll(/<link\b[^>]*>/gi)].map((match) => attributes(match[0]));
  const canonical = links.filter((tag) => tag.rel === 'canonical');
  assert.equal(canonical.length, 1, `Expected one canonical: ${route}`);
  assert.equal(canonical[0].href, new URL(route, siteURL).href, `Incorrect canonical: ${route}`);
  assert.equal(meta.find((tag) => tag.property === 'og:url')?.content, canonical[0].href, `Open Graph URL mismatch: ${route}`);
  assert.ok(meta.some((tag) => tag.name === 'twitter:card' && tag.content === 'summary_large_image'), `Missing social card: ${route}`);
  assert.equal((html.match(/<h1(?:\s|>)/g) || []).length, 1, `Expected one h1: ${route}`);
  if (route === '404.html') assert.ok(meta.some((tag) => tag.name === 'robots' && tag.content === 'noindex'), '404 must be noindex');
  else assert.ok(!meta.some((tag) => tag.name === 'robots' && /noindex/i.test(tag.content)), `Public page marked noindex: ${route}`);
  const structured = [...head.matchAll(/<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => JSON.parse(match[1]));
  assert.ok(structured.length, `Missing structured data: ${route}`);
  if (contentRoutes.has(route)) {
    assert.ok(links.some((tag) => tag.type === 'application/rss+xml'), `Missing RSS autodiscovery: ${route}`);
    const graph = structured.flatMap((schema) => schema['@graph'] || [schema]);
    assert.ok(graph.some((schema) => schema['@type'] === 'BreadcrumbList'), `Missing breadcrumb schema: ${route}`);
    const item = items.find((entry) => entry.route === route);
    if (item) {
      const article = graph.find((schema) => schema['@type'] === (item.kind === 'blog' ? 'BlogPosting' : 'TechArticle'));
      assert.ok(article, `Missing article schema: ${route}`);
      assert.equal(article.headline, item.title);
      assert.equal(article.url, canonical[0].href);
      assert.equal(article.author.name, 'Paprika maintainers');
      assert.ok(html.includes('View source on GitHub'), `Missing source link: ${route}`);
      if (item.kind === 'blog') {
        assert.equal(article.datePublished, item.date);
        assert.ok(html.includes(`<time datetime="${item.date}">`), `Visible publication date missing: ${route}`);
      }
    }
  }
  // Keep script bodies out of the tag scan; example HTML is escaped by the Markdown renderer.
  const markup = html.replace(/(<script\b[^>]*>)[\s\S]*?<\/script>/gi, '$1</script>').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  for (const match of markup.matchAll(/<(a|link|script|img|source|iframe)\b[^>]*>/gi)) {
    const tag = match[1].toLowerCase();
    const attrs = attributes(match[0]);
    if (attrs.href) verifyURL(attrs.href, route, { fragment: tag === 'a' });
    if (attrs.src) verifyURL(attrs.src, route, { asset: true });
    if (attrs.srcset) for (const candidate of attrs.srcset.split(',')) verifyURL(candidate.trim().split(/\s+/)[0], route, { asset: true });
  }
  } catch (error) {
    failures.push(`${route || '/'}: ${error.message}`);
  }
}

const sitemap = readFileSync(join(destination, 'sitemap.xml'), 'utf8');
const locations = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) => decode(match[1]));
assert.equal(new Set(locations).size, locations.length, 'Sitemap has duplicate URLs');
assert.deepEqual(new Set(locations), new Set(routes.map((route) => new URL(route, siteURL).href)), 'Sitemap routes must match the content manifest');
assert.ok(!sitemap.includes('<lastmod>'), 'Do not invent content modification times at build time');
assert.ok(!locations.some((url) => url.endsWith('/404.html')), '404 must not be in the sitemap');
const feed = readFileSync(join(destination, 'feed.xml'), 'utf8');
assert.equal((feed.match(/<item>/g) || []).length, manifest.posts.length, 'RSS must contain each article');
for (const post of manifest.posts) assert.ok(feed.includes(`<link>${new URL(post.route, siteURL).href}</link>`), `RSS missing ${post.slug}`);
const search = JSON.parse(readFileSync(join(destination, 'search-index.json'), 'utf8'));
assert.equal(search.length, manifest.docs.length, 'Search index must contain every public guide');
for (const entry of search) {
  assert.ok(entry.text.length > 80, `Search index has no body content: ${entry.href}`);
  assert.ok(manifest.docs.some((doc) => doc.route === entry.href && doc.title === entry.title), `Search entry has unknown route: ${entry.href}`);
}
for (const route of [...routes, '404.html']) {
  const { html } = readHTML(route);
  const loaders = [...html.matchAll(/<script\b[^>]*\bid="paprika-analytics"[^>]*>/g)];
  assert.equal(loaders.length, analytics.siteId ? 1 : 0, `Unexpected Flaggr loader count on ${route || '/'}`);
  if (analytics.siteId) {
    const attrs = attributes(loaders[0][0]);
    assert.equal(attrs['data-site-id'], analytics.siteId, `Wrong public Flaggr site ID on ${route || '/'}`);
    verifyURL(attrs.src, route, { asset: true });
  }
}
for (const privatePath of ['node_modules', 'content', 'package.json', 'package-lock.json', 'build-content.mjs', 'analytics.test.mjs', 'verify-browser.mjs']) {
  assert.ok(!existsSync(join(destination, privatePath)), `Build source should not be published: ${privatePath}`);
}
assert.equal(failures.length, 0, `Public content verification failed:\n${failures.join('\n')}`);
console.log(`Verified ${htmlRoutes.length} HTML pages, ${locations.length} canonical sitemap URLs, ${localLinks} local links/assets, ${fragmentLinks} section links, ${sourceLinks} repository targets, RSS and full-text search.`);
