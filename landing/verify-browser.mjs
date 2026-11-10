#!/usr/bin/env node
// Run against a fully assembled static site, never a production URL.
// Usage: node landing/verify-browser.mjs <staging-directory> <artifact-directory>
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { readManifest } from './build-content.mjs';

const BASE = '/paprika/';
const CANONICAL = 'https://paprikacd.github.io/paprika/';
const EXPECTED_GUIDES = readManifest().docs.length;
const [stagingArgument, artifactArgument, ...extra] = process.argv.slice(2);
if (!stagingArgument || !artifactArgument || extra.length) {
  console.error('Usage: node landing/verify-browser.mjs <staging-directory> <artifact-directory>');
  process.exit(1);
}
const root = await realpath(resolve(stagingArgument));
const artifacts = resolve(artifactArgument);
function within(parent, child) {
  const path = relative(parent, child);
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`);
}
assert(!within(root, artifacts), 'Screenshot output must be outside the served staging directory.');
await mkdir(artifacts, { recursive: true });
for (const file of ['index.html', 'docs/index.html', 'blog/index.html', '404.html', 'search-index.json']) {
  assert((await stat(resolve(root, file))).isFile(), `Assemble the public site first: missing ${file}`);
}

const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const errors = [];
const server = createServer((req, res) => {
  const send = (status, body, contentType = 'text/plain; charset=utf-8') => {
    res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  };
  const missing = async () => send(404, await readFile(resolve(root, '404.html')), types['.html']);
  (async () => {
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'Method not allowed');
    // Inspect the raw path before URL normalization can erase dot segments.
    const rawPath = (req.url || '/').split(/[?#]/, 1)[0];
    let pathname;
    try { pathname = decodeURIComponent(rawPath); } catch { return send(400, 'Invalid URL'); }
    if (/[\u0000-\u001f\u007f\\]/.test(pathname) || pathname.split('/').some((part) => part === '.' || part === '..')) {
      return send(403, 'Forbidden path');
    }
    if (pathname === BASE.slice(0, -1)) {
      res.writeHead(308, { Location: `${BASE}${new URL(req.url, 'http://localhost').search}` });
      return res.end();
    }
    if (!pathname.startsWith(BASE)) return missing();
    let file = resolve(root, pathname.slice(BASE.length));
    if (!within(root, file)) return send(403, 'Forbidden path');
    try {
      file = await realpath(file);
      if (!within(root, file)) return send(403, 'Forbidden path');
      if ((await stat(file)).isDirectory()) {
        if (!pathname.endsWith('/')) {
          res.writeHead(308, { Location: `${rawPath}/${new URL(req.url, 'http://localhost').search}` });
          return res.end();
        }
        file = await realpath(resolve(file, 'index.html'));
      }
      if (!within(root, file)) return send(403, 'Forbidden path');
      if (!(await stat(file)).isFile()) return missing();
      return send(200, await readFile(file), types[extname(file)] || 'application/octet-stream');
    } catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return missing();
      throw error;
    }
  })().catch((error) => {
    errors.push(`Preview server: ${error.message}`);
    if (!res.headersSent) send(500, 'Preview server error');
    else res.destroy();
  });
});
await new Promise((accept, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', accept);
});
const origin = `http://127.0.0.1:${server.address().port}`;
const url = (path = '') => `${origin}${BASE}${path}`;
let browser;
let deadline;
let assertions = 0;

function rawStatus(path) {
  return new Promise((accept, reject) => {
    const req = request(`${origin}${path}`, (res) => { res.resume(); res.on('end', () => accept(res.statusCode)); });
    req.setTimeout(5000, () => req.destroy(new Error('Preview server check timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function newPage(options = {}, allowedFailures = []) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1, serviceWorkers: 'block', ...options });
  context.setDefaultTimeout(7000);
  context.setDefaultNavigationTimeout(15000);
  // External fonts/APIs are not part of this local-site regression gate.
  // Fulfill them locally so this check never makes requests to production services.
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    const kind = route.request().resourceType();
    const contentType = kind === 'stylesheet' ? 'text/css' : kind === 'script' ? 'text/javascript' : 'application/json';
    return route.fulfill({ status: 200, contentType, body: ['fetch', 'xhr'].includes(kind) ? '{}' : '' });
  });
  const page = await context.newPage();
  const expected = new Set(allowedFailures);
  const localFailure = (address) => {
    try {
      const parsed = new URL(address);
      return parsed.origin === origin && parsed.pathname.startsWith(BASE) && !expected.has(parsed.pathname);
    } catch { return false; }
  };
  page.on('pageerror', (error) => errors.push(`${page.url()}: ${error.message}`));
  page.on('console', (message) => {
    // Failed-resource errors are checked below, where intentional failures can be scoped by URL.
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
      errors.push(`${page.url()} console: ${message.text()}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400 && localFailure(response.url())) errors.push(`HTTP ${response.status()}: ${response.url()}`);
  });
  page.on('requestfailed', (req) => {
    if (localFailure(req.url()) && req.failure()?.errorText !== 'net::ERR_ABORTED') {
      errors.push(`${req.failure()?.errorText}: ${req.url()}`);
    }
  });
  return { context, page };
}

async function identity(page, path) {
  await page.locator('main').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('h1:visible').count(), 1, `${path}: one visible H1`);
  assert((await page.locator('h1:visible').textContent()).trim(), `${path}: nonempty H1`);
  assert.match(await page.title(), /Paprika/i, `${path}: page title identifies Paprika`);
  if (path.startsWith('docs/')) assert.match(await page.title(), /docs|documentation/i);
  if (path.startsWith('blog/')) assert.match(await page.title(), /blog|engineering/i);
  assert.equal(await page.locator('link[rel="canonical"]').count(), 1);
  assert.equal(await page.locator('link[rel="canonical"]').getAttribute('href'), `${CANONICAL}${path}`);
  // Indexable pages deliberately omit this optional tag; do not wait for it to appear.
  const robots = await page.evaluate(() => document.querySelector('meta[name="robots"]')?.content || '');
  assert(!/noindex/i.test(robots));
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    root: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  assert(dimensions.root <= dimensions.viewport + 1 && dimensions.body <= dimensions.viewport + 1,
    `${path}: horizontal page overflow ${JSON.stringify(dimensions)}`);
  assertions += 1;
}

async function visit(page, path) {
  const response = await page.goto(url(path), { waitUntil: 'load' });
  assert.equal(response.status(), 200, `${path}: HTTP 200`);
  await identity(page, path);
}

async function deploymentImage(page, filename) {
  const image = page.locator('.deployment-diagram img');
  await image.scrollIntoViewIfNeeded();
  await page.waitForFunction((filename) => {
    const image = document.querySelector('.deployment-diagram img');
    return image?.complete && image.naturalWidth > 0 && new URL(image.currentSrc).pathname.endsWith(`/${filename}`);
  }, filename);
  await image.evaluate((element) => element.decode());
  await page.waitForFunction(() => {
    const workbench = document.querySelector('#deployment [data-gamma-tabs]');
    return getComputedStyle(workbench).opacity === '1';
  });
}

async function deploymentTabs(page, device) {
  const suffix = device === 'mobile' ? '-mobile' : '';
  for (const phase of ['source', 'build', 'apply', 'observe']) {
    await page.locator(`#deploy-${phase}-tab`).click();
    await deploymentImage(page, `deployment-${phase}${suffix}.svg`);
    assert(await page.locator(`#deploy-${phase}`).isVisible());
  }
  await page.locator('.deployment-diagram').screenshot({ path: resolve(artifacts, `${device}-deployment.png`) });
}

async function structuredDataMatchesPage(page, path) {
  const rendered = await page.evaluate(() => {
    const canonical = document.querySelector('link[rel="canonical"]').href;
    const publicURL = (href) => {
      const target = new URL(href, location.href);
      return target.origin === location.origin ? new URL(target.pathname, canonical).href : target.href;
    };
    const figure = document.querySelector('.article-figure');
    const image = figure?.querySelector('img');
    const mobile = figure?.querySelector('source');
    return {
      canonical,
      schemas: [...document.querySelectorAll('script[type="application/ld+json"]')].map((script) => JSON.parse(script.textContent)),
      title: document.title,
      description: document.querySelector('meta[name="description"]').content,
      heading: document.querySelector('h1').textContent.trim(),
      breadcrumbs: [...document.querySelectorAll('.breadcrumbs li')].map((item) => ({
        name: item.querySelector('a, [aria-current="page"]').textContent.trim(),
        item: item.querySelector('a') ? publicURL(item.querySelector('a').href) : canonical,
      })),
      author: document.querySelector('[rel="author"]')?.textContent.trim(),
      authorURL: document.querySelector('[rel="author"]')?.href,
      date: document.querySelector('.article-header time')?.getAttribute('datetime'),
      section: document.querySelector('.article-section')?.textContent,
      image: image ? { url: publicURL(image.src), alt: image.alt,
        width: Number(image.getAttribute('width')), height: Number(image.getAttribute('height')),
        caption: figure.querySelector('figcaption span').textContent,
        mobile: { url: publicURL(mobile.srcset), width: Number(mobile.getAttribute('width')), height: Number(mobile.getAttribute('height')) },
        openURL: publicURL(figure.querySelector('a').href),
        socialURL: document.querySelector('meta[property="og:image"]').content,
        twitterURL: document.querySelector('meta[name="twitter:image"]').content } : null,
      entries: [...document.querySelectorAll('.docs-directory .doc-link, .post-copy h2 a')].map((link) => ({
        name: (link.querySelector('h3') || link).textContent.trim(), url: publicURL(link.href),
      })),
    };
  });
  assert.equal(rendered.schemas.length, 1, `${path}: one crawlable JSON-LD block`);
  const graph = rendered.schemas[0]['@graph'];
  const byID = new Map(graph.map((entity) => [entity['@id'], entity]));
  const webpage = byID.get(`${rendered.canonical}#webpage`);
  assert.equal(webpage.name, rendered.title);
  assert.equal(webpage.description, rendered.description);
  if (rendered.breadcrumbs.length) {
    assert.deepEqual(byID.get(webpage.breadcrumb['@id']).itemListElement.map(({ name, item }) => ({ name, item })), rendered.breadcrumbs);
    assert(await page.locator('.breadcrumbs [aria-current="page"]').isVisible());
  }
  const article = graph.find((entity) => ['TechArticle', 'BlogPosting'].includes(entity['@type']));
  if (article) {
    assert.equal(article.headline, rendered.heading, `${path}: schema headline matches rendered H1`);
    assert.equal(byID.get(article.author['@id']).name, rendered.author);
    assert.equal(byID.get(article.author['@id']).url, rendered.authorURL);
    assert(await page.locator('[rel="author"]').isVisible());
    assert.equal(article.datePublished, rendered.date);
    assert.equal(article.articleSection, rendered.section);
    const image = byID.get(article.image?.['@id']);
    assert.equal(image?.['@type'], 'ImageObject', `${path}: article image schema`);
    assert.equal(webpage.primaryImageOfPage['@id'], image['@id']);
    assert.equal(image.contentUrl, rendered.image.url);
    assert.equal(image.width, rendered.image.width);
    assert.equal(image.height, rendered.image.height);
    assert.equal(image.caption, rendered.image.caption);
    assert.equal(image.description, rendered.image.alt);
    for (const key of ['socialURL', 'twitterURL', 'openURL']) assert.equal(rendered.image[key], image.url);
    const illustration = page.locator('.article-figure img');
    assert(await illustration.isVisible());
    await illustration.evaluate(element => element.decode());
    const selected = await illustration.evaluate(element => ({ src: new URL(element.currentSrc).pathname, width: element.naturalWidth, height: element.naturalHeight }));
    const expected = page.viewportSize().width <= 600 ? rendered.image.mobile : rendered.image;
    assert.equal(selected.src, new URL(expected.url).pathname, `${path}: responsive image source`);
    assert.equal(selected.width, expected.width);
    assert.equal(selected.height, expected.height);
  }
  if (rendered.entries.length) {
    assert.deepEqual(byID.get(webpage.mainEntity['@id']).itemListElement.map(({ name, url }) => ({ name, url })), rendered.entries);
  }
}

async function editorialArtwork(page, post) {
  const cover = page.locator('.editorial-cover img');
  assert.equal(await cover.count(), 1, `${post.route}: one editorial cover`);
  assert.equal(await cover.getAttribute('alt'), post.cover.alt, `${post.route}: informative cover alt text`);
  assert.equal(await cover.getAttribute('width'), '1200');
  assert.equal(await cover.getAttribute('height'), '675');
  await cover.scrollIntoViewIfNeeded();
  await cover.evaluate((img) => img.decode());
  const actual = await cover.evaluate((img) => ({
    src: new URL(img.currentSrc).pathname,
    width: img.naturalWidth,
    height: img.naturalHeight,
  }));
  assert(actual.src.endsWith('/' + post.cover.src), `${post.route}: correct cover asset`);
  assert.equal(actual.width, 1200);
  assert.equal(actual.height, 675);
  assert.equal(await page.locator('.footer-brand img').count(), 1, `${post.route}: footer identity`);
}

async function directory(page) {
  await page.locator('.docs-directory').waitFor({ state: 'visible' });
  assert.equal(await page.locator('.docs-directory .doc-link').count(), EXPECTED_GUIDES);
}

async function resultsFor(page, query, { empty = false } = {}) {
  await page.waitForFunction(({ query, empty }) => {
    const status = document.querySelector('.search-status')?.textContent || '';
    return status.includes(`found for “${query}”.`) && (empty ? status.startsWith('0 ') : /^[1-9]\d* /.test(status));
  }, { query, empty });
  assert.equal(await page.locator('#docs-query').inputValue(), query);
  assert.equal(await page.locator('.docs-directory').isVisible(), false);
}

async function tocAnchor(page) {
  const contents = page.locator('.article-toc details');
  if (!(await contents.getAttribute('open') !== null)) await contents.locator('summary').click();
  const link = contents.locator('a[href^="#"]').first();
  const hash = await link.getAttribute('href');
  await link.click();
  await page.waitForFunction((hash) => {
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    const rect = target?.getBoundingClientRect();
    return location.hash === hash && rect && rect.top >= 0 && rect.top < innerHeight - 20;
  }, hash);
}

async function run() {
  assert.equal(await rawStatus(`${BASE}missing-browser-smoke-page/`), 404, 'Missing pages must return HTTP 404');
  // An options.path request preserves traversal segments (URL strings normalize literal dot segments).
  const traversalStatus = await new Promise((accept, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port,
      path: `${BASE}%2e%2e/package.json` }, (res) => { res.resume(); res.on('end', () => accept(res.statusCode)); });
    req.setTimeout(5000, () => req.destroy(new Error('Traversal check timed out')));
    req.on('error', reject); req.end();
  });
  assert.equal(traversalStatus, 403, 'Preview must reject path traversal');
  browser = await chromium.launch({ headless: true, timeout: 20000 });
  const routes = ['', 'docs/', 'blog/', 'docs/getting-started/', 'blog/kubernetes-health-vs-drift/'];
  for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const { page, context } = await newPage({ viewport });
    try {
      for (const path of routes) {
        await visit(page, path);
        const screenshot = path === '' ? `${device}-home.png`
          : device === 'desktop' && path === 'docs/getting-started/' ? 'desktop-docs.png'
          : device === 'desktop' && path.startsWith('blog/kubernetes-') ? 'desktop-article.png'
          : device === 'mobile' && path === 'docs/' ? 'mobile-docs-index.png'
          : device === 'mobile' && path.startsWith('blog/kubernetes-') ? 'mobile-article.png' : null;
        if (screenshot) await page.screenshot({ path: resolve(artifacts, screenshot), fullPage: false, animations: 'disabled' });
        if (path === '') await deploymentTabs(page, device);
      }
      if (device === 'mobile') {
        await visit(page, 'docs/');
        const menu = page.locator('.mobile-menu');
        const summary = menu.locator('summary');
        await summary.click();
        await menu.locator('.mobile-menu-links').getByRole('link', { name: 'Blog', exact: true }).focus();
        await page.keyboard.press('Escape');
        assert.equal(await menu.getAttribute('open'), null, 'Escape closes mobile menu');
        assert(await summary.evaluate((element) => element === document.activeElement), 'Escape returns focus to Menu');
        await summary.click();
        await menu.locator('.mobile-menu-links').getByRole('link', { name: 'Blog', exact: true }).click();
        await page.waitForURL(url('blog/'));
        await identity(page, 'blog/');
        assert.equal(await page.locator('.mobile-menu').getAttribute('open'), null);
        await visit(page, 'docs/getting-started/');
        await tocAnchor(page);
      }
    } finally { await context.close(); }
    console.log(`PASS ${device}: five page types, metadata, layout, all four decoded lifecycle diagrams${device === 'mobile' ? ', menu and contents navigation' : ''}`);
  }

  for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const { page: demoPage, context: demoContext } = await newPage({ viewport });
    try {
      const demoRoutes = [
        ['kubernetes-release-dashboard', 'release', 'staging'],
        ['prometheus-dashboard-query-patterns', 'prometheus', 'histogram'],
        ['observability-dashboard-layout', 'layout', 'diagnose'],
        ['visual-testing-observability-dashboards', 'testing', 'mobile'],
        ['building-dashboards-with-mcp', 'mcp', 'verify'],
      ];
      for (const [slug, kind, alternate] of demoRoutes) {
        await visit(demoPage, 'blog/' + slug + '/');
        const demo = demoPage.locator('[data-editorial-demo="' + kind + '"]');
        assert.equal(await demo.count(), 1, slug + ': interactive demo');
        assert.equal(await demo.locator('.demo-kicker').textContent().then((text) => text.includes('SYNTHETIC')), true);
        const starting = await demo.locator('[data-demo-value]').textContent();
        await demo.locator('button[data-demo-choice="' + alternate + '"]').click();
        assert.equal(await demo.locator('button[data-demo-choice="' + alternate + '"]').getAttribute('aria-pressed'), 'true');
        assert.notEqual(await demo.locator('[data-demo-value]').textContent(), starting);
        await demo.locator('[data-demo-theme-toggle]').click();
        assert.equal(await demo.getAttribute('data-demo-theme'), 'light');
        await demo.locator('[data-demo-theme-toggle]').click();
        assert.equal(await demo.getAttribute('data-demo-theme'), 'dark');
        const figure = demoPage.locator('.prose > p > img[src*="content-assets/landing/editorial/"]');
        assert.equal(await figure.count(), 1, slug + ': one inline explanatory dashboard image');
        await figure.evaluate((img) => img.decode());
        if (slug === 'prometheus-dashboard-query-patterns') {
          assert.equal(await demo.locator('[data-demo-bars] rect').count(), 12, 'Histogram uses bars');
        }
        if (slug === 'observability-dashboard-layout') {
          await demo.locator('button[data-demo-choice="empty"]').click();
          assert(await demo.locator('[data-demo-empty]').isVisible());
          assert(await demo.locator('[data-demo-inspect]').isDisabled());
        }
        await demo.scrollIntoViewIfNeeded();
        if (slug === 'observability-dashboard-layout') {
          await demo.screenshot({ path: resolve(artifacts, device + '-editorial-demo.png'), animations: 'disabled' });
        }
      }
      await visit(demoPage, 'blog/kubernetes-release-dashboard/');
      const preview = demoPage.locator('[data-editorial-gallery]');
      assert.equal(await preview.count(), 1, 'Public chart gallery embeds are available');
      assert.equal(await preview.locator('iframe').getAttribute('src'), null, 'Heavy chart gallery is not fetched before intent');
      await preview.locator('[data-gallery-launch]').click();
      assert(await preview.locator('iframe').isVisible(), 'Gallery frame shown on request');
      assert.match(await preview.locator('iframe').getAttribute('src'), /\/charts\/#kubernetes-fleet$/);
      console.log('PASS ' + device + ': five synthetic dashboard demos, themed controls, accessible data states, decoded illustrations and on-demand gallery');
    } finally { await demoContext.close(); }
  }

  for (const [device, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    const suffix = device === 'mobile' ? '-mobile' : '';
    const unavailable = ['source', 'build'].map((phase) => `${BASE}diagrams/deployment-${phase}${suffix}.svg`);
    const { page, context } = await newPage({ viewport }, unavailable);
    try {
      const failureStatus = device === 'desktop' ? 503 : 200;
      for (const path of unavailable) {
        await page.route(`**${path}`, (route) => route.fulfill({ status: failureStatus,
          contentType: 'image/svg+xml', body: 'Diagram temporarily unavailable' }));
      }
      const initialFailure = page.waitForResponse((response) => new URL(response.url()).pathname === unavailable[0]);
      await visit(page, '');
      await page.locator('.deployment-diagram').scrollIntoViewIfNeeded();
      assert.equal((await initialFailure).status(), failureStatus);
      await deploymentImage(page, `deployment${suffix}.svg`);

      // A failed later phase must show the neutral overview, not the preceding phase's highlight.
      await page.locator('#deploy-apply-tab').click();
      await deploymentImage(page, `deployment-apply${suffix}.svg`);
      const nextFailure = page.waitForResponse((response) => new URL(response.url()).pathname === unavailable[1]);
      await page.locator('#deploy-build-tab').click();
      assert.equal((await nextFailure).status(), failureStatus);
      await deploymentImage(page, `deployment${suffix}.svg`);
      assert(await page.locator('#deploy-build').isVisible());
      await page.locator('.deployment-diagram').screenshot({ path: resolve(artifacts, `${device}-deployment-fallback.png`) });

      // Both responsive sources must remain usable after a failed enhancement.
      await page.setViewportSize(device === 'mobile' ? { width: 1440, height: 1000 } : { width: 390, height: 844 });
      await deploymentImage(page, `deployment${device === 'mobile' ? '' : '-mobile'}.svg`);
      await page.locator('#deploy-observe-tab').click();
      await deploymentImage(page, `deployment-observe${device === 'mobile' ? '' : '-mobile'}.svg`);
      console.log(`PASS ${device}: failed initial/later phase images retain the overview; resize and subsequent phases recover`);
    } finally { await context.close(); }
  }

  const delayed = await newPage();
  let releaseImages;
  const pendingImages = new Promise((accept) => { releaseImages = accept; });
  try {
    const paths = ['deployment-build.svg', 'deployment-build-mobile.svg'];
    for (const path of paths) {
      await delayed.page.route(`**/diagrams/${path}`, async (route) => {
        await pendingImages;
        await route.continue();
      });
    }
    await visit(delayed.page, '');
    await deploymentImage(delayed.page, 'deployment-source.svg');
    const requested = delayed.page.waitForRequest(`**/diagrams/deployment-build.svg`);
    await delayed.page.locator('#deploy-build-tab').click();
    await requested;
    await deploymentImage(delayed.page, 'deployment.svg');
    await delayed.page.locator('#deploy-observe-tab').click();
    await deploymentImage(delayed.page, 'deployment-observe.svg');
    releaseImages();
    // Let the delayed SVGs finish decoding before checking that they did not win the race.
    await delayed.page.evaluate(async (paths) => {
      await Promise.all(paths.map(async (path) => {
        const image = new Image();
        image.src = `./diagrams/${path}`;
        await image.decode();
      }));
      await new Promise((accept) => requestAnimationFrame(() => requestAnimationFrame(accept)));
    }, paths);
    await deploymentImage(delayed.page, 'deployment-observe.svg');
    assert(await delayed.page.locator('#deploy-observe').isVisible());
    console.log('PASS delayed phase images: overview remains visible while loading; the latest selected phase wins');
  } finally {
    releaseImages();
    await delayed.context.close();
  }

  const { page, context } = await newPage();
  try {
    await visit(page, 'docs/');
    await directory(page);
    const input = page.locator('#docs-query');
    await input.fill('promotion');
    await input.press('Enter');
    await resultsFor(page, 'promotion');
    assert(await page.locator('.search-results a[href$="/docs/environment-promotion/"]').count());
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await directory(page);
    assert.equal(await input.inputValue(), '');
    assert.equal(new URL(page.url()).searchParams.get('q'), null);
    await input.fill('no-guide-zzzz-67291');
    await input.press('Enter');
    await resultsFor(page, 'no-guide-zzzz-67291', { empty: true });
    await page.getByRole('button', { name: 'Show all guides', exact: true }).click();
    await directory(page);

    // Typing updates results; only submission creates a navigable search entry.
    await input.fill('prometheus');
    await resultsFor(page, 'prometheus');
    assert.equal(new URL(page.url()).searchParams.get('q'), null);
    await input.press('Enter');
    await page.waitForURL((address) => address.searchParams.get('q') === 'prometheus');
    await input.fill('canary');
    await resultsFor(page, 'canary');
    assert.equal(new URL(page.url()).searchParams.get('q'), 'prometheus');
    await input.press('Enter');
    await page.waitForURL((address) => address.searchParams.get('q') === 'canary');
    await page.goBack();
    await resultsFor(page, 'prometheus');
    assert.equal(new URL(page.url()).searchParams.get('q'), 'prometheus');
    await page.goForward();
    await resultsFor(page, 'canary');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await directory(page);
    assert.equal(new URL(page.url()).searchParams.get('q'), null);
    await page.goBack();
    await resultsFor(page, 'canary');
    console.log('PASS search: results, clear, empty state, draft queries and Back/Forward history');

    await visit(page, 'docs/getting-started/');
    await tocAnchor(page);
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const block = page.locator('[data-code-block]').first();
    const exactCode = await block.locator('pre code').textContent();
    assert(exactCode.length > 0);
    await block.getByRole('button', { name: 'Copy code example 1', exact: true }).click();
    await block.locator('.code-copy-status').filter({ hasText: 'Code example 1 copied.' }).waitFor();
    // Paste through the browser clipboard rather than accepting a visual success message alone.
    await page.evaluate(() => {
      const textarea = document.createElement('textarea');
      textarea.id = 'smoke-clipboard-target';
      textarea.setAttribute('aria-label', 'Clipboard verification');
      textarea.style.cssText = 'position:fixed;left:10px;top:100px;width:250px;height:100px;z-index:9999';
      document.body.append(textarea);
      textarea.focus();
    });
    await page.keyboard.press('ControlOrMeta+V');
    await page.waitForFunction((expected) => document.querySelector('#smoke-clipboard-target')?.value === expected, exactCode);
    assert.equal(await page.locator('#smoke-clipboard-target').inputValue(), exactCode);
    await page.locator('#smoke-clipboard-target').evaluate((element) => element.remove());
    await context.clearPermissions();
    console.log('PASS contents anchors and exact code clipboard paste');
  } finally { await context.close(); }

  const failedSearch = await newPage({}, [`${BASE}search-index.json`]);
  try {
    let unavailable = true;
    await failedSearch.page.route(`**${BASE}search-index.json`, (route) => unavailable
      ? route.fulfill({ status: 503, body: 'Unavailable for smoke test' })
      : route.continue());
    await visit(failedSearch.page, 'docs/');
    await failedSearch.page.locator('#docs-query').fill('promotion');
    await failedSearch.page.locator('#docs-query').press('Enter');
    await failedSearch.page.locator('.search-status').filter({ hasText: 'Search could not load.' }).waitFor();
    await directory(failedSearch.page);
    unavailable = false;
    await failedSearch.page.getByRole('button', { name: 'Try search again', exact: true }).click();
    await resultsFor(failedSearch.page, 'promotion');
    await failedSearch.page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await directory(failedSearch.page);
    await failedSearch.page.locator('.docs-directory a[href="./getting-started/"]').click();
    await failedSearch.page.waitForURL(url('docs/getting-started/'));
    await identity(failedSearch.page, 'docs/getting-started/');
    console.log('PASS unavailable search index: error feedback, retry recovery and full directory navigation');
  } finally { await failedSearch.context.close(); }

  const noJS = await newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  try {
    await visit(noJS.page, '');
    await deploymentImage(noJS.page, 'deployment-mobile.svg');
    await visit(noJS.page, 'docs/');
    await directory(noJS.page);
    assert.equal(await noJS.page.locator('[data-docs-search]').isVisible(), false);
    assert.equal(await noJS.page.locator('.copy-code').count(), 0);
    await noJS.page.locator('.docs-directory a[href="./getting-started/"]').click();
    await noJS.page.waitForURL(url('docs/getting-started/'));
    await identity(noJS.page, 'docs/getting-started/');
    assert((await noJS.page.locator('.prose').innerText()).length > 500);
    assert(await noJS.page.locator('pre code').count());
    assert.equal(await noJS.page.locator('.copy-code').count(), 0);
    await visit(noJS.page, 'blog/kubernetes-health-vs-drift/');
    assert((await noJS.page.locator('.prose').innerText()).length > 500);
    assert.equal(await noJS.page.locator('.copy-code').count(), 0);
    console.log('PASS JavaScript disabled: complete directory, readable guides/articles, no dead enhancement controls');
    const manifest = readManifest();
    const schemaRoutes = ['', 'docs/', 'blog/', ...manifest.docs.map((item) => item.route), ...manifest.posts.map((item) => item.route)];
    for (const path of schemaRoutes) {
      await visit(noJS.page, path);
      await structuredDataMatchesPage(noJS.page, path);
      const editorial = manifest.posts.find((post) => post.route === path);
      if (editorial) {
        await editorialArtwork(noJS.page, editorial);
        if (editorial.slug === 'building-dashboards-with-mcp') {
          await noJS.page.locator('.editorial-cover').screenshot({ path: resolve(artifacts, 'mobile-editorial-cover.png'), animations: 'disabled' });
        }
      }
      const featuredDemo = manifest.posts.find((post) => post.route === path);
      if (featuredDemo && ['kubernetes-release-dashboard', 'prometheus-dashboard-query-patterns',
        'observability-dashboard-layout', 'visual-testing-observability-dashboards',
        'building-dashboards-with-mcp'].includes(featuredDemo.slug)) {
        assert.equal(await noJS.page.locator('[data-editorial-demo]').count(), 1);
        assert(await noJS.page.locator('[data-demo-value]').isVisible(), 'Static demo evidence remains visible without JavaScript');
        assert.equal(await noJS.page.locator('[data-gallery-launch]:visible').count(), 0, 'No nonfunctional launch buttons without JavaScript');
      }
      if (path === 'blog/') {
        assert.equal(await noJS.page.locator('.post-cover img').count(), manifest.posts.length);
        assert.equal(await noJS.page.locator('.topic-article img').count(),
          Math.min(3, manifest.posts.filter((post) => post.category === 'Dashboarding').length));
      }
      if (path === '') {
        assert.equal(await noJS.page.locator('.reading-thumb img').count(), Math.min(3, manifest.posts.length));
        assert.equal(await noJS.page.locator('.chart-reading-card img').count(),
          Math.min(3, manifest.posts.filter((post) => post.category === 'Dashboarding').length));
      }
      if (['docs/canary/', 'blog/building-dashboards-with-mcp/'].includes(path)) {
        await noJS.page.locator('.article-figure').scrollIntoViewIfNeeded();
        await noJS.page.screenshot({ path: resolve(artifacts, path.startsWith('docs/') ? 'mobile-canary-figure.png' : 'mobile-dashboard-figure.png'), animations: 'disabled' });
      }
    }
    console.log(`PASS structured data: ${schemaRoutes.length} pages, rendered breadcrumbs, authors, dates, directory entries and mobile layout with JavaScript disabled`);
    await noJS.page.setViewportSize({ width: 1440, height: 1000 });
    for (const item of [...manifest.docs, ...manifest.posts]) {
      await visit(noJS.page, item.route);
      await structuredDataMatchesPage(noJS.page, item.route);
      if (item.kind === 'blog') {
        await editorialArtwork(noJS.page, item);
        if (item.slug === 'building-dashboards-with-mcp') {
          await noJS.page.locator('.editorial-cover').screenshot({ path: resolve(artifacts, 'desktop-editorial-cover.png'), animations: 'disabled' });
        }
      }
      if (['getting-started', 'building-dashboards-with-mcp'].includes(item.slug)) {
        await noJS.page.locator('.article-figure').scrollIntoViewIfNeeded();
        await noJS.page.screenshot({ path: resolve(artifacts, `${item.kind === 'docs' ? 'desktop-guide' : 'desktop-dashboard'}-figure.png`), animations: 'disabled' });
      }
    }
    const imageResponse = await Promise.all([
      noJS.page.waitForResponse(response => response.url().endsWith(manifest.posts.at(-1).image.src)),
      noJS.page.getByRole('link', { name: 'Open full-size diagram' }).click(),
    ]);
    assert.equal(imageResponse[0].status(), 200);
    assert.equal(imageResponse[0].headers()['content-type'], 'image/png');
    console.log('PASS article images: all 19 desktop and mobile images decode, match schema/social previews, and open at full size without JavaScript');
  } finally { await noJS.context.close(); }

  const reduced = await newPage({ reducedMotion: 'reduce', viewport: { width: 390, height: 844 } });
  try {
    await visit(reduced.page, 'docs/getting-started/');
    assert(await reduced.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches));
    assert.equal(await reduced.page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
    await tocAnchor(reduced.page);
    console.log('PASS reduced motion: readable content and immediate contents navigation');
  } finally { await reduced.context.close(); }

  assert.deepEqual(errors, [], 'Unexpected browser or local resource errors');
  console.log(`Passed public-site browser smoke check (${assertions} page checks). Screenshots: ${artifacts}`);
}

try {
  await Promise.race([run(), new Promise((_, reject) => {
    deadline = setTimeout(() => reject(new Error('Public-site browser smoke exceeded 180 seconds')), 180000);
  })]);
} catch (error) {
  console.error(error.stack || error);
  if (errors.length) console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((accept) => server.close(accept));
}
