#!/usr/bin/env node
/** Build readable public pages from the maintained repository Markdown. */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';
import { jsonScript, pageStructuredData, repositoryURL, siteURL } from './structured-data.mjs';
import { renderDashboardDemo, renderGalleryPreview } from './article-demos.js';

export { siteURL } from './structured-data.mjs';

const landingRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(landingRoot, '..');
const socialImage = `${siteURL}demo-applications.webp`;
const sectionDescriptions = {
  Start: 'Install the operator, learn the resource model, and find your way around the CLI.',
  Deliver: 'Run pipelines, promote revisions, and inspect your Kubernetes deployments.',
  Observe: 'Connect telemetry, build dashboards, and verify what your data is telling you.',
  Integrate: 'Connect your tools and agents through the CLI, API, and authenticated MCP surfaces.',
};

export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
const escapeXML = escapeHTML;
const encodePath = (value) => value.split('/').map(encodeURIComponent).join('/');
const publicURL = (route) => new URL(route, siteURL).href;
const assetPrefix = (route) => '../'.repeat(route.split('/').filter(Boolean).length) || './';
const sourceURL = (source) => `${repositoryURL}/blob/master/${encodePath(source)}`;
const dateLabel = (date) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(date));

function insideRepository(path) {
  const absolute = resolve(repoRoot, path);
  const fromRoot = relative(repoRoot, absolute);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw new Error(`Source escapes the repository: ${path}`);
  }
  if (existsSync(absolute)) {
    const actual = relative(repoRoot, realpathSync(absolute));
    if (actual.startsWith(`..${sep}`) || actual === '..' || isAbsolute(actual)) {
      throw new Error(`Source symlink escapes the repository: ${path}`);
    }
  }
  return absolute;
}

export function readManifest(path = join(landingRoot, 'content/site.json')) {
  return validateManifest(JSON.parse(readFileSync(path, 'utf8')));
}

export function readAnalyticsConfig(path = join(landingRoot, 'content/analytics.json')) {
  return validateAnalyticsConfig(JSON.parse(readFileSync(path, 'utf8')));
}

export function validateAnalyticsConfig(config) {
  assert.equal(config.provider, 'flaggr', 'The public site uses Flaggr analytics');
  assert.ok(config.siteId === null || (typeof config.siteId === 'string' && /^site_[A-Za-z0-9_-]{1,123}$/.test(config.siteId)),
    'Use the public site_ identifier issued by Flaggr, never an API or MCP credential');
  for (const key of ['projectId', 'serviceId']) {
    assert.ok(config[key] === null || (typeof config[key] === 'string' && config[key].length > 0 && config[key].length <= 128), `Invalid Flaggr ${key}`);
  }
  return config;
}

/** Stable intent labels only; never derive conversion names from visible text. */
export function annotateAnalyticsLinks(html, route) {
  return html.replace(/<a\b[^>]*>/gi, (tag) => {
    if (/\bdata-analytics-event=/.test(tag)) return tag;
    const href = tag.match(/\bhref="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&');
    if (!href || (href.startsWith('#') && href !== '#get-started')) return tag;
    let target;
    try { target = new URL(href, publicURL(route)); } catch { return tag; }
    let event;
    if (target.origin === 'https://github.com' && /^\/paprikacd\/paprika\/releases\/download\/[^/]+\/paprika_[^/]+\.(?:tar\.gz|zip)$/.test(target.pathname)) event = 'cli_download';
    if (target.origin === new URL(siteURL).origin) {
      if (target.pathname === '/paprika/docs/getting-started/' || (target.pathname === '/paprika/' && target.hash === '#get-started')) event = 'get_started';
      else if (target.pathname === '/paprika/tour.html') event = 'demo_open';
      else if (target.pathname.startsWith('/paprika/docs/')) event = 'docs_open';
      else if (target.pathname.startsWith('/paprika/blog/')) event = 'blog_open';
    }
    return event ? tag.replace(/^<a\b/i, `<a data-analytics-event="${event}"`) : tag;
  });
}

export function instrumentPage(html, route, config) {
  const clean = annotateAnalyticsLinks(html.replace(/<!-- paprika-analytics:start -->[\s\S]*?<!-- paprika-analytics:end -->\n?/g, ''), route);
  if (!config.siteId) return clean;
  const prefix = route === '404.html' ? '/paprika/' : route.endsWith('.html') ? './' : assetPrefix(route);
  const script = `<!-- paprika-analytics:start -->\n<script id="paprika-analytics" defer src="${prefix}analytics.js?v=flaggr-1" data-site-id="${config.siteId}"></script>\n<!-- paprika-analytics:end -->\n`;
  assert.ok(clean.includes('</head>'), `Missing head in ${route || '/'}`);
  return clean.replace('</head>', `${script}</head>`);
}

export function validateManifest(manifest) {
  const routes = new Set();
  const sources = new Set();
  for (const kind of ['docs', 'posts']) {
    assert.ok(Array.isArray(manifest[kind]) && manifest[kind].length, `${kind} must be a non-empty list`);
    for (const item of manifest[kind]) {
      assert.match(item.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `Invalid slug: ${item.slug}`);
      for (const key of ['title', 'description', 'source', kind === 'docs' ? 'section' : 'category']) {
        assert.ok(typeof item[key] === 'string' && item[key].trim(), `${item.slug} needs ${key}`);
      }
      assert.ok(!isAbsolute(item.source), 'Source paths must be repository-relative');
      const absoluteSource = insideRepository(item.source);
      assert.equal(relative(repoRoot, absoluteSource).split(sep).join('/'), item.source, 'Source paths must be normalized');
      assert.match(item.source, /\.md$/, 'Public content sources must be Markdown');
      item.kind = kind === 'docs' ? 'docs' : 'blog';
      item.route = `${item.kind}/${item.slug}/`;
      assert.ok(!routes.has(item.route), `Duplicate route: ${item.route}`);
      assert.ok(!sources.has(item.source), `Duplicate source: ${item.source}`);
      routes.add(item.route);
      sources.add(item.source);
      if (kind === 'posts') {
        assert.match(item.date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, `${item.slug} needs a UTC publication timestamp`);
        const date = new Date(item.date);
        assert.ok(!Number.isNaN(date.valueOf()) && date.toISOString() === item.date.replace('Z', '.000Z'), `Invalid publication date: ${item.date}`);
      }
      if (kind === 'posts') {
        assert.ok(item.cover && typeof item.cover === 'object', `${item.slug} needs an editorial cover`);
        assert.match(item.cover.src, /^editorial\/[a-z0-9-]+\.svg$/, 'Editorial covers must be local SVG assets');
        for (const key of ['alt', 'caption']) {
          assert.ok(typeof item.cover[key] === 'string' && item.cover[key].trim(), `${item.slug} cover needs ${key}`);
        }
        const artwork = readFileSync(insideRepository(`landing/${item.cover.src}`), 'utf8');
        assert.ok(artwork.length >= 500 && artwork.length < 200_000, `Invalid cover size: ${item.cover.src}`);
        assert.match(artwork, /^<svg\b[^>]*\bviewBox="0 0 1200 675"/, `Cover needs a 1200×675 viewBox: ${item.cover.src}`);
        assert.doesNotMatch(artwork, /<(?:script|foreignObject|image)\b/i, `Cover must be self-contained and inert: ${item.cover.src}`);
      }
      assert.ok(item.image && typeof item.image === 'object', `${item.slug} needs an article image`);
      for (const key of ['alt', 'caption']) {
        assert.ok(typeof item.image[key] === 'string' && item.image[key].trim(), `${item.slug} image needs ${key}`);
      }
      for (const image of [item.image, item.image.mobile]) {
        assert.ok(image && typeof image.src === 'string', `${item.slug} needs desktop and mobile images`);
        assert.match(image.src, /^article-images\/[a-z0-9-]+\.png$/, 'Article image paths must be local PNG assets');
        const bytes = readFileSync(insideRepository(`landing/${image.src}`));
        assert.ok(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.length >= 24, `Invalid PNG: ${image.src}`);
        assert.equal(image.width, bytes.readUInt32BE(16), `Wrong image width: ${image.src}`);
        assert.equal(image.height, bytes.readUInt32BE(20), `Wrong image height: ${image.src}`);
        assert.ok(image.width * image.height >= 50_000, `Article image is too small: ${image.src}`);
      }
    }
  }
  return manifest;
}

export function stagingDestination(output) {
  assert.ok(typeof output === 'string' && output.trim(), 'A staging output directory is required');
  const requested = resolve(output);
  let existing = requested;
  while (!existsSync(existing)) existing = dirname(existing);
  const destination = resolve(realpathSync(existing), relative(existing, requested));
  const realRepository = realpathSync(repoRoot);
  const realLanding = realpathSync(landingRoot);
  const relativeRepository = relative(destination, realRepository);
  const containsRepository = relativeRepository === '' || (!relativeRepository.startsWith(`..${sep}`) && relativeRepository !== '..' && !isAbsolute(relativeRepository));
  assert.ok(!containsRepository, 'Staging output must not be the repository or one of its ancestors');
  assert.ok(destination !== realLanding && !destination.startsWith(`${realLanding}${sep}`), 'Build into a staging directory outside landing sources');
  if (existsSync(destination)) assert.ok(statSync(destination).isDirectory(), 'Staging output must be a directory');
  return destination;
}

/** Resolve source links once, rather than letting Markdown-relative paths leak into public routes. */
export function rewriteURL(href, source, route, sourceRoutes, assets = new Map(), image = false) {
  if (!href || href.startsWith('#')) return href;
  const prefix = assetPrefix(route);
  let target;
  let suffix = '';
  let parsed;
  try { parsed = new URL(href); } catch { /* A repository-relative path is expected. */ }
  if (parsed) {
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return '';
    if (image && !['http:', 'https:'].includes(parsed.protocol)) return '';
    if (parsed.origin === 'https://github.com' && parsed.pathname.startsWith('/paprikacd/paprika/blob/master/')) {
      target = decodeURIComponent(parsed.pathname.slice('/paprikacd/paprika/blob/master/'.length));
      suffix = parsed.search + parsed.hash;
    } else if (parsed.origin === 'https://raw.githubusercontent.com' && parsed.pathname.startsWith('/paprikacd/paprika/master/')) {
      target = decodeURIComponent(parsed.pathname.slice('/paprikacd/paprika/master/'.length));
      suffix = parsed.search + parsed.hash;
    } else if (parsed.origin === new URL(siteURL).origin && parsed.pathname.startsWith('/paprika/')) {
      return `${prefix}${parsed.pathname.slice('/paprika/'.length)}${parsed.search}${parsed.hash}`;
    } else {
      return href;
    }
  } else {
    if (href.startsWith('//') || /[\u0000-\u001f\u007f\\]/.test(href)) return '';
    if (href.startsWith('/paprika/')) return `${prefix}${href.slice('/paprika/'.length)}`;
    // The renderer explains these as routes on the reader's configured server.
    if (href.startsWith('/')) return '';
    const fragmentIndex = href.search(/[?#]/);
    const pathname = fragmentIndex < 0 ? href : href.slice(0, fragmentIndex);
    suffix = fragmentIndex < 0 ? '' : href.slice(fragmentIndex);
    target = relative(repoRoot, resolve(repoRoot, dirname(source), decodeURIComponent(pathname))).split(sep).join('/');
  }
  const absolute = insideRepository(target);
  if (sourceRoutes.has(target) && !image && !/^\?/.test(suffix)) {
    // Line anchors refer to source, not to a rendered section.
    if (/^#L\d+(?:-L\d+)?$/.test(suffix)) return sourceURL(target) + suffix;
    return `${prefix}${sourceRoutes.get(target)}${suffix}`;
  }
  if (image && existsSync(absolute) && statSync(absolute).isFile()) {
    assert.match(target, /\.(?:png|jpe?g|gif|webp|avif|svg)$/i, `Unsupported documentation image: ${target}`);
    assets.set(target, absolute);
    return `${prefix}content-assets/${encodePath(target)}${suffix}`;
  }
  const kind = existsSync(absolute) && statSync(absolute).isDirectory() ? 'tree' : 'blob';
  return `${repositoryURL}/${kind}/master/${encodePath(target)}${suffix}`;
}

function inlineText(tokens = []) {
  return tokens.map((token) => token.type === 'image' ? inlineText(token.children) : token.children ? inlineText(token.children) : token.content || '').join('');
}

export function renderDocument(item, sourceRoutes, assets = new Map(), markdown = readFileSync(insideRepository(item.source), 'utf8')) {
  const parser = new MarkdownIt({ html: false, linkify: false, typographer: false });
  const slugger = new GithubSlugger();
  const toc = [];
  let headingID = item.slug;
  let firstHeading = true;
  let codeCount = 0;
  let tableCount = 0;
  const tokens = parser.parse(markdown, {});
  const contentTokens = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === 'heading_open') {
      const inline = tokens[index + 1];
      const label = inlineText(inline.children);
      const id = slugger.slug(label);
      token.attrSet('id', id);
      if (token.tag === 'h1' && firstHeading) {
        headingID = id;
        firstHeading = false;
        index += 2;
        continue;
      }
      if (token.tag === 'h1') {
        token.tag = 'h2';
        tokens[index + 2].tag = 'h2';
      }
      if (['h2', 'h3'].includes(token.tag)) toc.push({ id, title: label, level: Number(token.tag.slice(1)) });
    }
    contentTokens.push(token);
  }
  const defaultLink = parser.renderer.rules.link_open || ((renderTokens, index, options, _env, renderer) => renderer.renderToken(renderTokens, index, options));
  parser.renderer.rules.link_open = (renderTokens, index, options, env, renderer) => {
    const token = renderTokens[index];
    const href = token.attrGet('href');
    if (href.startsWith('/') && !href.startsWith('/paprika/') && !href.startsWith('//')) {
      const closing = renderTokens.slice(index + 1).find((candidate) => candidate.type === 'link_close');
      closing.meta = { productRoute: href };
      return '<span class="product-route-reference">';
    }
    token.attrSet('href', rewriteURL(href, item.source, item.route, sourceRoutes, assets));
    return defaultLink(renderTokens, index, options, env, renderer);
  };
  parser.renderer.rules.link_close = (renderTokens, index, options, _env, renderer) => {
    const route = renderTokens[index].meta?.productRoute;
    return route ? ` <span class="product-route-hint">(on your Paprika server: <code>${escapeHTML(route)}</code>)</span></span>` : renderer.renderToken(renderTokens, index, options);
  };
  const defaultImage = parser.renderer.rules.image;
  parser.renderer.rules.image = (renderTokens, index, options, env, renderer) => {
    const token = renderTokens[index];
    const originalImage = token.attrGet('src');
    token.attrSet('src', rewriteURL(originalImage, item.source, item.route, sourceRoutes, assets, true));
    // Reserve intrinsic dimensions for local editorial SVGs so lazy images
    // have a real layout box, can enter the viewport and avoid content shifts.
    if (/^\.\.\/\.\.\/editorial\/[a-z0-9-]+\.svg$/.test(originalImage)) {
      const imageSource = insideRepository('landing/' + originalImage.replace('../../', ''));
      const markup = readFileSync(imageSource, 'utf8');
      const dimensions = markup.match(/<svg\b[^>]*\bwidth="(\d+)"\s+height="(\d+)"/);
      assert.ok(dimensions, 'Editorial SVG needs explicit dimensions: ' + originalImage);
      token.attrSet('width', dimensions[1]);
      token.attrSet('height', dimensions[2]);
    }
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');
    return defaultImage(renderTokens, index, options, env, renderer);
  };
  parser.renderer.rules.fence = (renderTokens, index) => {
    const token = renderTokens[index];
    const directive = token.info.trim();
    if (directive.startsWith('paprika-')) {
      assert.equal(item.kind, 'blog', 'Interactive editorial directives are only allowed in blog articles');
      assert.equal(token.content.trim(), '', 'Editorial directives must not contain arbitrary HTML or content');
      if (/^paprika-dashboard (release|prometheus|layout|testing|mcp)$/.test(directive)) {
        return renderDashboardDemo(directive.split(' ')[1], assetPrefix(item.route)) + '\n';
      }
      if (/^paprika-gallery (charts|kubernetes-fleet|performance-workbench|distributed-systems)$/.test(directive)) {
        return renderGalleryPreview(directive.split(' ')[1], assetPrefix(item.route)) + '\n';
      }
      throw new Error('Unknown editorial directive in ' + item.slug + ': ' + directive);
    }
    const language = directive.split(/\s+/)[0].replace(/[^a-zA-Z0-9_+-]/g, '');
    const label = language === 'mermaid' ? 'Diagram source' : language || 'Text';
    codeCount += 1;
    return `<div class="code-block" data-code-block><div class="code-toolbar"><span class="code-language">${escapeHTML(label)}</span></div><pre tabindex="0" aria-label="${escapeHTML(label)} code example ${codeCount}"><code${language ? ` class="language-${escapeHTML(language)}"` : ''}>${escapeHTML(token.content)}</code></pre></div>\n`;
  };
  parser.renderer.rules.table_open = () => {
    tableCount += 1;
    return `<div class="table-scroll" role="region" aria-label="Table ${tableCount}, scroll horizontally if needed" tabindex="0"><table>\n`;
  };
  parser.renderer.rules.table_close = () => '</table></div>\n';
  const html = parser.renderer.render(contentTokens, parser.options, {});
  const text = tokens.filter((token) => ['inline', 'fence', 'code_block'].includes(token.type))
    .map((token) => token.children ? inlineText(token.children) : token.content).join(' ').replace(/\s+/g, ' ').trim();
  return { html, toc, headingID, text, readingMinutes: Math.max(1, Math.ceil(text.split(/\s+/).length / 220)) };
}

function breadcrumbHTML(items, prefix) {
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${items.map((item, index) => `<li>${index < items.length - 1 ? `<a href="${escapeHTML(`${prefix}${item.route}`)}">${escapeHTML(item.name)}</a>` : `<span aria-current="page">${escapeHTML(item.name)}</span>`}${index < items.length - 1 ? '<span aria-hidden="true">/</span>' : ''}</li>`).join('')}</ol></nav>`;
}

function header(prefix, active) {
  const navItems = [
    ['Product', `${prefix}#deployment`, 'product'],
    ['Docs', `${prefix}docs/`, 'docs'],
    ['Charts', `${prefix}charts/#charts`, 'charts'],
    ['Blog', `${prefix}blog/`, 'blog'],
    ['Get started', `${prefix}docs/getting-started/`, 'start'],
  ];
  const links = navItems.map(([label, href, section]) => `<a href="${href}"${active === section ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<a href="#main-content" class="skip-link">Skip to main content</a>
<header class="masthead nav"><div class="masthead-inner shell"><a href="${prefix}" class="wordmark" aria-label="Paprika home"><img src="${prefix}paprika-mark.png" width="35" height="35" alt=""/><span>Paprika</span></a><nav class="nav-links" aria-label="Main navigation">${links}<details class="mobile-menu"><summary>Menu</summary><div class="mobile-menu-links">${links}</div></details><a href="${repositoryURL}" class="nav-action">GitHub <span aria-hidden="true">↗</span></a></nav></div></header>`;
}

function editorialEyebrow(prefix, label) {
  return `<div class="editorial-eyebrow"><img src="${prefix}paprika-mark.png" alt="" width="24" height="24"/><span>${escapeHTML(label)}</span></div>`;
}

function footer(prefix) {
  return `<footer class="content-footer"><div class="shell"><a href="${prefix}" class="footer-brand"><img src="${prefix}paprika-mark.png" alt="" width="34" height="34"/><span>Paprika</span></a><p>Open source Kubernetes delivery and observability.</p><nav aria-label="Footer"><a href="${prefix}docs/">Documentation</a><a href="${prefix}blog/">Engineering blog</a><a href="${prefix}feed.xml">RSS feed</a><a href="${repositoryURL}">GitHub</a><a href="${repositoryURL}/blob/master/LICENSE">Apache 2.0</a></nav></div></footer>`;
}

function page({ route, title, description, active, body, article, listing, breadcrumbs, noindex = false, fileRoute = false }) {
  const prefix = fileRoute ? './' : assetPrefix(route);
  const canonical = publicURL(route);
  const structured = pageStructuredData({ route, title, description, article, listing, breadcrumbs });
  const preview = article?.image ? publicURL(article.image.src) : socialImage;
  const previewAlt = article?.image?.alt || 'Paprika console showing synthetic application data';
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHTML(title)}</title>
<meta name="description" content="${escapeHTML(description)}"/>
${noindex ? '<meta name="robots" content="noindex"/>' : ''}
<link rel="canonical" href="${canonical}"/>
<link rel="icon" type="image/png" href="${prefix}paprika-mark.png"/>
<meta name="theme-color" content="#1d2d3d"/>
<meta property="og:site_name" content="Paprika"/>
<meta property="og:type" content="${active === 'blog' && route !== 'blog/' ? 'article' : 'website'}"/>
<meta property="og:title" content="${escapeHTML(title)}"/>
<meta property="og:description" content="${escapeHTML(description)}"/>
<meta property="og:url" content="${canonical}"/>
<meta property="og:image" content="${preview}"/>
<meta property="og:image:alt" content="${escapeHTML(previewAlt)}"/>
${article?.image ? `<meta property="og:image:width" content="${article.image.width}"/><meta property="og:image:height" content="${article.image.height}"/><meta property="og:image:type" content="image/png"/>` : ''}
${article?.date ? `<meta property="article:published_time" content="${article.date}"/>` : ''}
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHTML(title)}"/>
<meta name="twitter:description" content="${escapeHTML(description)}"/>
<meta name="twitter:image" content="${preview}"/>
<meta name="twitter:image:alt" content="${escapeHTML(previewAlt)}"/>
<link rel="alternate" type="application/rss+xml" title="Paprika engineering blog" href="${prefix}feed.xml"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&amp;family=Barlow+Condensed:wght@400;500;600;700&amp;display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="${prefix}site.css?v=public-content-1"/>
<link rel="stylesheet" href="${prefix}content.css?v=dashboard-notes-1"/>
${article?.kind === 'blog' ? `<link rel="stylesheet" href="${prefix}article-demos.css?v=editorial-lab-1"/>` : ''}
<script type="application/ld+json">${jsonScript(structured)}</script>
<script src="${prefix}content.js?v=public-content-1" defer></script>
${article?.kind === 'blog' ? `<script src="${prefix}article-demos.js?v=editorial-lab-1" type="module"></script>` : ''}
</head><body class="content-page">
${header(prefix, active)}
${body}
${footer(prefix)}
</body></html>\n`;
}

function articleSidebar(docs, current, prefix) {
  const sections = [...new Set(docs.map((item) => item.section))];
  return `<aside class="docs-sidebar"><nav aria-label="Documentation">${sections.map((section) => `<section><h2>${escapeHTML(section)}</h2><ul>${docs.filter((item) => item.section === section).map((item) => `<li><a href="${prefix}${item.route}"${item.slug === current.slug ? ' aria-current="page"' : ''}>${escapeHTML(item.title)}</a></li>`).join('')}</ul></section>`).join('')}</nav></aside>`;
}

function articlePage(item, document, manifest) {
  const prefix = assetPrefix(item.route);
  const blog = item.kind === 'blog';
  const groupLabel = blog ? 'Blog' : 'Docs';
  const breadcrumbs = [{ name: 'Paprika', route: '' }, { name: groupLabel, route: `${item.kind}/` }, { name: item.title, route: item.route }];
  const list = blog ? manifest.posts : manifest.docs.filter((doc) => doc.section === item.section);
  const index = list.indexOf(item);
  const previous = list[index - 1];
  const next = list[index + 1];
  const { image } = item;
  const editorialCover = blog ? `<figure class="editorial-cover"><img src="${prefix}${item.cover.src}" alt="${escapeHTML(item.cover.alt)}" width="1200" height="675" decoding="async" fetchpriority="high"/><figcaption>${escapeHTML(item.cover.caption)}</figcaption></figure>` : '';
  const figure = `<figure class="article-figure"><picture><source media="(max-width: 600px)" srcset="${prefix}${image.mobile.src}" width="${image.mobile.width}" height="${image.mobile.height}"/><img src="${prefix}${image.src}" alt="${escapeHTML(image.alt)}" width="${image.width}" height="${image.height}" decoding="async"/></picture><figcaption><span>${escapeHTML(image.caption)}</span> <a href="${prefix}${image.src}">Open full-size diagram</a></figcaption></figure>`;
  const illustratedBody = document.html.includes('</p>')
    ? document.html.replace('</p>', () => `</p>${figure}`) : figure + document.html;
  const toc = `<aside class="article-toc"><details><summary>On this page</summary><nav aria-label="On this page"><ol>${document.toc.map((heading) => `<li class="toc-level-${heading.level}"><a href="#${escapeHTML(heading.id)}">${escapeHTML(heading.title)}</a></li>`).join('')}</ol></nav></details></aside>`;
  const body = `<div class="shell article-breadcrumbs">${breadcrumbHTML(breadcrumbs, prefix)}</div>
<div class="article-layout${blog ? ' article-layout--blog' : ''} shell">
${blog ? '' : articleSidebar(manifest.docs, item, prefix)}
${toc}
<main id="main-content" class="article-main" tabindex="-1"><article>
<header class="article-header">${editorialEyebrow(prefix, blog ? 'Paprika / Engineering' : 'Paprika / Guides')}<h1 id="${escapeHTML(document.headingID)}">${escapeHTML(item.title)}</h1><p class="article-description">${escapeHTML(item.description)}</p><div class="article-meta"><span>${blog ? 'By' : 'Maintained by'} <a rel="author" href="${repositoryURL}">Paprika maintainers</a></span><span class="article-section">${escapeHTML(blog ? item.category : item.section)}</span>${blog ? `<time datetime="${item.date}">${dateLabel(item.date)}</time><span>${document.readingMinutes} min read</span>` : ''}<a href="${sourceURL(item.source)}">View source on GitHub <span aria-hidden="true">↗</span></a></div></header>
${editorialCover}
<div class="prose">${illustratedBody}</div>
</article>
<nav class="article-next" aria-label="${blog ? 'More articles' : 'More guides'}">${previous ? `<a href="${prefix}${previous.route}" rel="prev"><span>Previous ${blog ? 'article' : 'guide'}</span><strong>${escapeHTML(previous.title)}</strong></a>` : `<a href="${prefix}${item.kind}/"><span>Browse</span><strong>All ${blog ? 'engineering articles' : 'documentation'}</strong></a>`}${next ? `<a href="${prefix}${next.route}" rel="next"><span>Next ${blog ? 'article' : 'guide'}</span><strong>${escapeHTML(next.title)}</strong></a>` : `<a href="${prefix}${blog ? 'docs/' : 'blog/'}"><span>Keep exploring</span><strong>${blog ? 'Read the documentation' : 'Read the engineering blog'}</strong></a>`}</nav>
</main></div>`;
  return page({
    route: item.route, active: item.kind,
    title: `${item.title} · Paprika ${blog ? 'engineering' : 'docs'}`,
    description: item.description, body,
    breadcrumbs, article: item,
  });
}

function docsIndex(manifest) {
  const title = 'Paprika documentation';
  const description = 'Install Paprika, deliver applications to Kubernetes, connect telemetry, and build dashboards with practical guides and API references.';
  const sections = [...new Set(manifest.docs.map((item) => item.section))];
  const breadcrumbs = [{ name: 'Paprika', route: '' }, { name: 'Documentation', route: 'docs/' }];
  const body = `<main id="main-content" tabindex="-1"><header class="content-hero shell">${breadcrumbHTML(breadcrumbs, '../')}${editorialEyebrow('../', 'Paprika / Documentation')}<h1>Paprika documentation</h1><p>${description}</p><a class="btn" href="./getting-started/">Deploy your first Application</a></header>
<div class="content-index shell">
<section class="docs-search" aria-label="Find documentation" data-docs-search hidden><form role="search"><label for="docs-query">Search documentation</label><div class="search-field"><input id="docs-query" name="q" type="search" placeholder="Try promotion, Prometheus, or MCP" autocomplete="off" enterkeyhint="search"/><button type="button" data-search-clear hidden aria-label="Clear search">Clear</button></div></form><p class="search-status" role="status" aria-live="polite" aria-atomic="true"></p><div class="search-results" hidden></div></section>
<div class="docs-directory">${sections.map((section) => `<section class="doc-group" aria-labelledby="group-${section.toLowerCase()}"><div class="doc-group-heading"><h2 id="group-${section.toLowerCase()}">${escapeHTML(section)}</h2><p>${escapeHTML(sectionDescriptions[section] || '')}</p></div><ul class="doc-list">${manifest.docs.filter((item) => item.section === section).map((item) => `<li><a class="doc-link" href="./${item.slug}/"><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.description)}</p><span aria-hidden="true">↗</span></a></li>`).join('')}</ul></section>`).join('')}</div>
<noscript><p class="search-note">Browse the guides above. Search is available when JavaScript is enabled.</p></noscript>
</div></main>`;
  return page({ route: 'docs/', active: 'docs', title, description, body, breadcrumbs, listing: manifest.docs });
}

function dashboardPosts(manifest) {
  return manifest.posts.filter((post) => post.category === 'Dashboarding')
    .sort((left, right) => right.date.localeCompare(left.date));
}

function blogIndex(manifest, rendered) {
  const title = 'Kubernetes, observability and dashboarding articles · Paprika engineering';
  const breadcrumbs = [{ name: 'Paprika', route: '' }, { name: 'Engineering blog', route: 'blog/' }];
  const description = 'Practical guides for Kubernetes release dashboards, Prometheus queries, dashboard UX, MCP authoring and deployment operations.';
  const topicCards = dashboardPosts(manifest).slice(0, 3).map((post) => `<li>
    <a class="topic-article" href="./${post.slug}/" aria-label="Read ${escapeHTML(post.title)}">
      <img src="../${post.cover.src}" alt="" width="1200" height="675" loading="lazy" decoding="async"/>
      <span class="topic-article-content"><small>Dashboarding · ${rendered.get(post.source).readingMinutes} min</small><strong>${escapeHTML(post.title)}</strong></span>
    </a>
  </li>`).join('');
  const cards = [...manifest.posts].sort((left, right) => right.date.localeCompare(left.date)).map((post) => {
    const route = `./${post.slug}/`;
    return `<li><article class="post-card">
      <a class="post-cover" href="${route}" aria-label="Read ${escapeHTML(post.title)}"><img src="../${post.cover.src}" alt="" width="1200" height="675" loading="lazy" decoding="async"/></a>
      <div class="post-card-body">
        <div class="post-meta"><span>${escapeHTML(post.category)}</span><time datetime="${post.date}">${dateLabel(post.date)}</time><span>${rendered.get(post.source).readingMinutes} min read</span></div>
        <div class="post-copy"><h2><a href="${route}">${escapeHTML(post.title)}</a></h2><p>${escapeHTML(post.description)}</p><a class="link-arrow" href="${route}" aria-label="Read ${escapeHTML(post.title)}">Read article</a></div>
      </div>
    </article></li>`;
  }).join('');
  const body = `<main id="main-content" tabindex="-1">
    <header class="content-hero shell">${breadcrumbHTML(breadcrumbs, '../')}${editorialEyebrow('../', 'Paprika / Engineering journal')}<h1>Engineering notes on Kubernetes and observability.</h1><p>${description}</p><a href="../feed.xml" class="link-arrow">Subscribe with RSS</a></header>
    <div class="content-index shell">
      <section class="blog-topic-hub" aria-labelledby="dashboarding-topic-title">
        <div class="blog-topic-heading"><div><span class="topic-kicker">Featured subject / Dashboarding</span><h2 id="dashboarding-topic-title">From query to dashboard.</h2>
        <p>How to select signals, build reliable PromQL, arrange readable panels and verify the result in a real browser.</p></div>
        <a href="../charts/#charts" class="link-arrow">Explore chart gallery</a></div>
        <ol class="topic-article-list">${topicCards}</ol>
      </section>
      <section aria-labelledby="all-engineering-title"><h2 id="all-engineering-title" class="blog-index-heading">All engineering articles</h2><ol class="post-list">${cards}</ol></section>
      <section class="blog-next"><h2>Put it into practice.</h2><p>Articles link to maintained implementation and guides. Explore synthetic dashboard examples, then bind their queries to real data sources.</p><a href="../docs/dashboards/" class="btn">Read dashboards guide</a></section>
    </div></main>`;
  return page({ route: 'blog/', active: 'blog', title, description, body, breadcrumbs, listing: [...manifest.posts].sort((left, right) => right.date.localeCompare(left.date)) });
}

function notFoundPage() {
  const body = `<main id="main-content" class="content-hero shell" tabindex="-1"><h1>That page isn’t here.</h1><p>The link may have moved. Browse the documentation, read the engineering blog, or return to Paprika.</p><div class="hero-actions"><a href="/paprika/docs/" class="btn">Browse documentation</a><a href="/paprika/" class="link-arrow">Paprika home</a></div></main>`;
  // A Pages 404 is served at the requested URL, so all resource URLs must be absolute from the host root.
  return page({ route: '404.html', fileRoute: true, title: 'Page not found · Paprika', description: 'Find Paprika documentation, engineering articles, and Kubernetes delivery resources.', active: '', noindex: true, body }).replaceAll('href="./', 'href="/paprika/').replaceAll('src="./', 'src="/paprika/');
}

function rss(manifest) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Paprika engineering blog</title><link>${siteURL}blog/</link><description>Engineering notes on Kubernetes delivery, observability and dashboard design.</description><language>en</language><atom:link href="${siteURL}feed.xml" rel="self" type="application/rss+xml"/>${[...manifest.posts].sort((left, right) => right.date.localeCompare(left.date)).map((post) => `<item><title>${escapeXML(post.title)}</title><link>${publicURL(post.route)}</link><guid isPermaLink="true">${publicURL(post.route)}</guid><description>${escapeXML(post.description)}</description><category>${escapeXML(post.category)}</category><dc:date>${post.date}</dc:date></item>`).join('')}</channel></rss>\n`;
}

function featuredPosts(manifest) {
  const latest = [...manifest.posts].sort((left, right) => right.date.localeCompare(left.date)).slice(0, 3);
  return `<ol class="reading-list">${latest.map((post) => `<li>
    <a class="reading-thumb" href="./${post.route}" aria-label="Read ${escapeHTML(post.title)}"><img src="./${post.cover.src}" alt="" width="1200" height="675" loading="lazy" decoding="async"/></a>
    <div class="reading-meta"><span>${escapeHTML(post.category)}</span><span>Engineering</span></div>
    <div class="reading-copy"><h3><a href="./${post.route}">${escapeHTML(post.title)}</a></h3><p>${escapeHTML(post.description)}</p></div>
    <a class="reading-open" href="./${post.route}" aria-label="Read ${escapeHTML(post.title)}">Read article <span aria-hidden="true">→</span></a>
  </li>`).join('')}</ol>`;
}

function dashboardArticles(manifest) {
  const selection = dashboardPosts(manifest).slice(0, 3);
  return `<section class="chart-showcase-reading" aria-labelledby="dashboard-notes-title">
    <div class="chart-showcase-reading-head">
      <div><p class="chart-showcase-context-label">Engineering field notes / Dashboarding</p>
        <h3 id="dashboard-notes-title">Build charts that make a decision easier.</h3>
        <p>Go beyond the gallery: discover the right signals, select an honest visual form and verify the live result.</p></div>
      <a href="./blog/" class="link-arrow">All engineering articles</a>
    </div>
    <div class="chart-showcase-reading-grid">${selection.map((post) => `<a class="chart-reading-card" href="./${post.route}">
      <img src="./${post.cover.src}" alt="" width="1200" height="675" loading="lazy" decoding="async"/>
      <span class="chart-reading-card-body"><small>${escapeHTML(post.category)} / Field note</small><strong>${escapeHTML(post.title)}</strong><span>Read article <span aria-hidden="true">↗</span></span></span>
    </a>`).join('')}</div>
  </section>`;
}

export function buildContent(output) {
  const destination = stagingDestination(output);
  const manifest = readManifest();
  const analytics = readAnalyticsConfig();
  const items = [...manifest.docs, ...manifest.posts];
  const sourceRoutes = new Map(items.map((item) => [item.source, item.route]));
  const assets = new Map();
  const rendered = new Map(items.map((item) => [item.source, renderDocument(item, sourceRoutes, assets)]));
  mkdirSync(destination, { recursive: true });
  for (const directory of ['docs', 'blog', 'content-assets', 'editorial']) {
    rmSync(join(destination, directory), { recursive: true, force: true });
  }
  const articleImages = new Set(items.flatMap(item => [item.image.src, item.image.mobile.src]));
  for (const source of articleImages) {
    const target = join(destination, source);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(landingRoot, source), target);
  }
  for (const post of manifest.posts) {
    const target = join(destination, post.cover.src);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(landingRoot, post.cover.src), target);
  }
  const writePage = (route, html) => {
    const path = join(destination, route, 'index.html');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, html);
  };
  for (const item of items) writePage(item.route, articlePage(item, rendered.get(item.source), manifest));
  writePage('docs/', docsIndex(manifest));
  writePage('blog/', blogIndex(manifest, rendered));
  for (const [source, absolute] of assets) {
    const target = join(destination, 'content-assets', source);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(absolute, target);
  }
  writeFileSync(join(destination, '404.html'), notFoundPage());
  writeFileSync(join(destination, 'feed.xml'), rss(manifest));
  writeFileSync(join(destination, 'search-index.json'), JSON.stringify(manifest.docs.map((item) => ({ title: item.title, description: item.description, section: item.section, href: item.route, text: rendered.get(item.source).text }))) + '\n');
  const routes = ['', 'tour.html', 'charts/', 'docs/', 'blog/', ...items.map((item) => item.route)];
  writeFileSync(join(destination, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${routes.map((route) => `<url><loc>${publicURL(route)}</loc></url>`).join('')}</urlset>\n`);
  const homepage = join(destination, 'index.html');
  if (existsSync(homepage)) {
    const content = readFileSync(homepage, 'utf8');
    assert.equal([...content.matchAll(/<!-- dashboard-articles:start -->[\s\S]*?<!-- dashboard-articles:end -->/g)].length, 1,
      'Homepage needs one dashboard articles placeholder');
    const decode = new MarkdownIt().utils.unescapeAll;
    const title = decode(content.match(/<title>([^<]+)<\/title>/)?.[1] || '');
    const description = decode(content.match(/<meta name="description" content="([^"]+)"/)?.[1] || '');
    assert.ok(title && description, 'Homepage metadata is required for structured data');
    const marker = /<!-- structured-data:start -->[\s\S]*?<!-- structured-data:end -->/g;
    assert.equal([...content.matchAll(marker)].length, 1, 'Homepage needs one structured-data placeholder');
    const structured = jsonScript(pageStructuredData({ route: '', title, description }));
    writeFileSync(homepage, content
      .replace(marker, () => `<!-- structured-data:start -->\n<script type="application/ld+json">${structured}</script>\n<!-- structured-data:end -->`)
      .replace(/<!-- featured-posts:start -->[\s\S]*?<!-- featured-posts:end -->/, `<!-- featured-posts:start -->\n${featuredPosts(manifest)}\n<!-- featured-posts:end -->`)
      .replace(/<!-- dashboard-articles:start -->[\s\S]*?<!-- dashboard-articles:end -->/, `<!-- dashboard-articles:start -->\n${dashboardArticles(manifest)}\n<!-- dashboard-articles:end -->`));
  }
  for (const route of [...routes, '404.html']) {
    const path = join(destination, route.endsWith('.html') ? route : `${route}index.html`);
    if (existsSync(path)) writeFileSync(path, instrumentPage(readFileSync(path, 'utf8'), route, analytics));
  }
  if (analytics.siteId) copyFileSync(join(landingRoot, 'analytics.js'), join(destination, 'analytics.js'));
  console.log(analytics.siteId ? 'Flaggr analytics configured with a public site identifier.' : 'Flaggr analytics disabled: register the site through Flaggr MCP and set content/analytics.json.');
  console.log(`Built ${manifest.docs.length} documentation pages, ${manifest.posts.length} articles, two indexes, RSS, search and ${routes.length} sitemap URLs.`);
}

export function selfTest() {
  const sources = new Map([['docs/getting-started.md', 'docs/getting-started/'], ['docs/guides/pipelines.md', 'docs/pipelines/']]);
  const item = { source: 'docs/guides/pipelines.md', slug: 'pipelines', route: 'docs/pipelines/' };
  assert.equal(rewriteURL('../getting-started.md#install-the-cli', item.source, item.route, sources), '../../docs/getting-started/#install-the-cli');
  assert.equal(rewriteURL(`${repositoryURL}/blob/master/docs/getting-started.md#install-the-cli`, item.source, item.route, sources), '../../docs/getting-started/#install-the-cli');
  assert.equal(rewriteURL('../getting-started.md#L10', item.source, item.route, sources), `${repositoryURL}/blob/master/docs/getting-started.md#L10`);
  assert.equal(rewriteURL('../../charts/chart/values.yaml', item.source, item.route, sources), `${repositoryURL}/blob/master/charts/chart/values.yaml`);
  assert.equal(rewriteURL('javascript:alert(1)', item.source, item.route, sources), '');
  assert.equal(rewriteURL('data:text/html,bad', item.source, item.route, sources), '');
  assert.equal(rewriteURL('/dashboard/insights/', item.source, item.route, sources), '');
  assert.throws(() => rewriteURL('../../../../outside.md', item.source, item.route, sources), /escapes the repository/);
  assert.throws(() => stagingDestination('/'), /repository or one of its ancestors/);
  assert.throws(() => stagingDestination(repoRoot), /repository or one of its ancestors/);
  assert.throws(() => stagingDestination(resolve(repoRoot, '..')), /repository or one of its ancestors/);
  assert.throws(() => stagingDestination(landingRoot), /outside landing sources/);
  const entry = { slug: 'start', title: 'Start', description: 'Start with a test cluster', section: 'Start', source: 'docs/getting-started.md', image: readManifest().docs[0].image };
  assert.throws(() => validateManifest({ docs: [entry, { ...entry, source: 'docs/cli.md' }], posts: [] }), /Duplicate route/);
  const document = renderDocument(item, sources, new Map(), '# Source title\n\n## Repeat `code`\n\n## Repeat `code`\n\n<script>alert(1)</script>\n\n[Bad](javascript:alert(1))\n\n```html\n<img src=x onerror=alert(1)>\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n');
  assert.equal(document.headingID, 'source-title');
  assert.deepEqual(document.toc.map((heading) => heading.id), ['repeat-code', 'repeat-code-1']);
  assert.ok(!document.html.includes('<h1'));
  assert.ok(!document.html.includes('<script>'));
  assert.ok(!document.html.includes('href="javascript:'));
  assert.ok(document.html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(document.html.includes('class="table-scroll"'));
  const productLink = renderDocument(item, sources, new Map(), '# Test\n\n[Open Insights](/dashboard/insights/)');
  assert.ok(productLink.html.includes('on your Paprika server:'));
  assert.ok(!productLink.html.includes('href="/dashboard/'));
  assert.equal(escapeHTML('"<&>'), '&quot;&lt;&amp;&gt;');
  const inactive = { provider: 'flaggr', siteId: null, projectId: null, serviceId: null };
  const configured = { ...inactive, siteId: 'site_test_fixture_0001' };
  assert.deepEqual(validateAnalyticsConfig(inactive), inactive);
  assert.throws(() => validateAnalyticsConfig({ ...inactive, siteId: 'mcp_do_not_publish_a_credential' }), /public site_/);
  assert.throws(() => validateAnalyticsConfig({ ...inactive, siteId: 'site_bad"><script>' }), /public site_/);
  const html = '<html><head></head><body><a href="../docs/getting-started/">Start</a><a href="#heading">Contents</a></body></html>';
  const tagged = instrumentPage(html, 'blog/', configured);
  assert.equal((tagged.match(/id="paprika-analytics"/g) || []).length, 1);
  assert.ok(tagged.includes('src="../analytics.js?v=flaggr-1"'));
  assert.ok(tagged.includes('data-analytics-event="get_started"'));
  assert.ok(tagged.includes('<a href="#heading">'));
  assert.ok(!annotateAnalyticsLinks('<a href="https://github.com/paprikacd/paprika/releases/download/v0.4.7/checksums.txt">Checksums</a>', '').includes('cli_download'));
  assert.equal(instrumentPage(tagged, 'blog/', configured), tagged, 'Rebuilding must not duplicate analytics');
  assert.ok(!instrumentPage(tagged, 'blog/', inactive).includes('id="paprika-analytics"'), 'Disabling must remove an older configured loader');
  console.log('Passed content builder checks: Markdown safety, GitHub anchors, source links, traversal, fenced code and tables.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') selfTest();
  else if (process.argv[2] === '--validate-output') console.log(stagingDestination(process.argv[3]));
  else if (process.argv[2]) buildContent(process.argv[2]);
  else throw new Error('Usage: node landing/build-content.mjs <staging-output-directory> | --validate-output <directory> | --self-test');
}
