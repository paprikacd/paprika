#!/usr/bin/env node
/** Build readable public pages from the maintained repository Markdown. */
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import MarkdownIt from 'markdown-it';
import GithubSlugger from 'github-slugger';

const landingRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(landingRoot, '..');
export const siteURL = 'https://paprikacd.github.io/paprika/';
const repositoryURL = 'https://github.com/paprikacd/paprika';
const socialImage = `${siteURL}demo-applications.webp`;
const publisher = { '@type': 'Organization', name: 'Paprika maintainers', url: repositoryURL };
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
const jsonScript = (value) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const encodePath = (value) => value.split('/').map(encodeURIComponent).join('/');
const publicURL = (route) => new URL(route, siteURL).href;
const assetPrefix = (route) => '../'.repeat(route.split('/').filter(Boolean).length) || './';
const sourceURL = (source) => `${repositoryURL}/blob/master/${encodePath(source)}`;
const dateLabel = (date) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

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
        assert.match(item.date, /^\d{4}-\d{2}-\d{2}$/, `${item.slug} needs a publication date`);
        const date = new Date(`${item.date}T00:00:00Z`);
        assert.ok(!Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === item.date, `Invalid publication date: ${item.date}`);
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
    token.attrSet('src', rewriteURL(token.attrGet('src'), item.source, item.route, sourceRoutes, assets, true));
    token.attrSet('loading', 'lazy');
    token.attrSet('decoding', 'async');
    return defaultImage(renderTokens, index, options, env, renderer);
  };
  parser.renderer.rules.fence = (renderTokens, index) => {
    const token = renderTokens[index];
    const language = token.info.trim().split(/\s+/)[0].replace(/[^a-zA-Z0-9_+-]/g, '');
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

function breadcrumbHTML(items) {
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><ol>${items.map((item, index) => `<li>${item.href ? `<a href="${escapeHTML(item.href)}">${escapeHTML(item.name)}</a>` : `<span aria-current="page">${escapeHTML(item.name)}</span>`}${index < items.length - 1 ? '<span aria-hidden="true">/</span>' : ''}</li>`).join('')}</ol></nav>`;
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

function footer(prefix) {
  return `<footer class="content-footer"><div class="shell"><a href="${prefix}" class="footer-brand">Paprika</a><p>Open source Kubernetes delivery and observability.</p><nav aria-label="Footer"><a href="${prefix}docs/">Documentation</a><a href="${prefix}blog/">Engineering blog</a><a href="${prefix}feed.xml">RSS feed</a><a href="${repositoryURL}">GitHub</a><a href="${repositoryURL}/blob/master/LICENSE">Apache 2.0</a></nav></div></footer>`;
}

function page({ route, title, description, active, body, schema, breadcrumbs, noindex = false, fileRoute = false }) {
  const prefix = fileRoute ? './' : assetPrefix(route);
  const canonical = publicURL(route);
  const graph = [schema, {
    '@type': 'BreadcrumbList',
    itemListElement: breadcrumbs.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: publicURL(item.route) })),
  }];
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
<meta property="og:image" content="${socialImage}"/>
<meta property="og:image:alt" content="Paprika console showing synthetic application data"/>
${schema.datePublished ? `<meta property="article:published_time" content="${schema.datePublished}"/>` : ''}
<meta name="twitter:card" content="summary_large_image"/>
<meta name="twitter:title" content="${escapeHTML(title)}"/>
<meta name="twitter:description" content="${escapeHTML(description)}"/>
<meta name="twitter:image" content="${socialImage}"/>
<meta name="twitter:image:alt" content="Paprika console showing synthetic application data"/>
<link rel="alternate" type="application/rss+xml" title="Paprika engineering blog" href="${prefix}feed.xml"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&amp;family=Barlow+Condensed:wght@400;500;600;700&amp;display=swap" rel="stylesheet"/>
<link rel="stylesheet" href="${prefix}site.css?v=public-content-1"/>
<link rel="stylesheet" href="${prefix}content.css?v=public-content-1"/>
<script type="application/ld+json">${jsonScript({ '@context': 'https://schema.org', '@graph': graph })}</script>
<script src="${prefix}content.js?v=public-content-1" defer></script>
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
  const list = blog ? manifest.posts : manifest.docs.filter((doc) => doc.section === item.section);
  const index = list.indexOf(item);
  const previous = list[index - 1];
  const next = list[index + 1];
  const toc = `<aside class="article-toc"><details><summary>On this page</summary><nav aria-label="On this page"><ol>${document.toc.map((heading) => `<li class="toc-level-${heading.level}"><a href="#${escapeHTML(heading.id)}">${escapeHTML(heading.title)}</a></li>`).join('')}</ol></nav></details></aside>`;
  const body = `<div class="shell article-breadcrumbs">${breadcrumbHTML([{ name: 'Paprika', href: prefix }, { name: groupLabel, href: `${prefix}${item.kind}/` }, { name: blog ? item.category : item.section }])}</div>
<div class="article-layout${blog ? ' article-layout--blog' : ''} shell">
${blog ? '' : articleSidebar(manifest.docs, item, prefix)}
${toc}
<main id="main-content" class="article-main" tabindex="-1"><article>
<header class="article-header"><h1 id="${escapeHTML(document.headingID)}">${escapeHTML(item.title)}</h1><p class="article-description">${escapeHTML(item.description)}</p><div class="article-meta">${blog ? `<span>By Paprika maintainers</span><time datetime="${item.date}">${dateLabel(item.date)}</time><span>${document.readingMinutes} min read</span>` : '<span>Maintained with the source</span>'}<a href="${sourceURL(item.source)}">View source on GitHub <span aria-hidden="true">↗</span></a></div></header>
<div class="prose">${document.html}</div>
</article>
<nav class="article-next" aria-label="${blog ? 'More articles' : 'More guides'}">${previous ? `<a href="${prefix}${previous.route}" rel="prev"><span>Previous ${blog ? 'article' : 'guide'}</span><strong>${escapeHTML(previous.title)}</strong></a>` : `<a href="${prefix}${item.kind}/"><span>Browse</span><strong>All ${blog ? 'engineering articles' : 'documentation'}</strong></a>`}${next ? `<a href="${prefix}${next.route}" rel="next"><span>Next ${blog ? 'article' : 'guide'}</span><strong>${escapeHTML(next.title)}</strong></a>` : `<a href="${prefix}${blog ? 'docs/' : 'blog/'}"><span>Keep exploring</span><strong>${blog ? 'Read the documentation' : 'Read the engineering blog'}</strong></a>`}</nav>
</main></div>`;
  return page({
    route: item.route, active: item.kind,
    title: `${item.title} · Paprika ${blog ? 'engineering' : 'docs'}`,
    description: item.description, body,
    breadcrumbs: [{ name: 'Paprika', route: '' }, { name: groupLabel, route: `${item.kind}/` }, { name: item.title, route: item.route }],
    schema: { '@type': blog ? 'BlogPosting' : 'TechArticle', headline: item.title, description: item.description, url: publicURL(item.route), mainEntityOfPage: publicURL(item.route), author: publisher, publisher, inLanguage: 'en', image: socialImage, ...(blog ? { datePublished: item.date, articleSection: item.category } : {}), isPartOf: { '@type': blog ? 'Blog' : 'WebSite', name: blog ? 'Paprika engineering blog' : 'Paprika documentation', url: publicURL(`${item.kind}/`) } },
  });
}

function docsIndex(manifest) {
  const title = 'Paprika documentation';
  const description = 'Install Paprika, deliver applications to Kubernetes, connect telemetry, and build dashboards with practical guides and API references.';
  const sections = [...new Set(manifest.docs.map((item) => item.section))];
  const body = `<main id="main-content" tabindex="-1"><header class="content-hero shell">${breadcrumbHTML([{ name: 'Paprika', href: '../' }, { name: 'Documentation' }])}<h1>Paprika documentation</h1><p>${description}</p><a class="btn" href="./getting-started/">Deploy your first Application</a></header>
<div class="content-index shell">
<section class="docs-search" aria-label="Find documentation" data-docs-search hidden><form role="search"><label for="docs-query">Search documentation</label><div class="search-field"><input id="docs-query" name="q" type="search" placeholder="Try promotion, Prometheus, or MCP" autocomplete="off" enterkeyhint="search"/><button type="button" data-search-clear hidden aria-label="Clear search">Clear</button></div></form><p class="search-status" role="status" aria-live="polite" aria-atomic="true"></p><div class="search-results" hidden></div></section>
<div class="docs-directory">${sections.map((section) => `<section class="doc-group" aria-labelledby="group-${section.toLowerCase()}"><div class="doc-group-heading"><h2 id="group-${section.toLowerCase()}">${escapeHTML(section)}</h2><p>${escapeHTML(sectionDescriptions[section] || '')}</p></div><ul class="doc-list">${manifest.docs.filter((item) => item.section === section).map((item) => `<li><a class="doc-link" href="./${item.slug}/"><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.description)}</p><span aria-hidden="true">↗</span></a></li>`).join('')}</ul></section>`).join('')}</div>
<noscript><p class="search-note">Browse the guides above. Search is available when JavaScript is enabled.</p></noscript>
</div></main>`;
  return page({ route: 'docs/', active: 'docs', title, description, body, breadcrumbs: [{ name: 'Paprika', route: '' }, { name: 'Documentation', route: 'docs/' }], schema: { '@type': 'CollectionPage', name: title, description, url: publicURL('docs/'), hasPart: manifest.docs.map((item) => ({ '@type': 'TechArticle', name: item.title, url: publicURL(item.route) })) } });
}

function blogIndex(manifest, rendered) {
  const title = 'Paprika engineering blog';
  const description = 'Practical notes on Kubernetes delivery, drift detection, release promotion, and building observability dashboards through MCP.';
  const body = `<main id="main-content" tabindex="-1"><header class="content-hero shell">${breadcrumbHTML([{ name: 'Paprika', href: '../' }, { name: 'Engineering blog' }])}<h1>Notes from the control plane.</h1><p>${description}</p><a href="../feed.xml" class="link-arrow">Subscribe with RSS</a></header><div class="content-index shell"><ol class="post-list">${manifest.posts.map((post) => `<li><article class="post-card"><div class="post-meta"><span>${escapeHTML(post.category)}</span><time datetime="${post.date}">${dateLabel(post.date)}</time><span>${rendered.get(post.source).readingMinutes} min read</span></div><div class="post-copy"><h2><a href="./${post.slug}/">${escapeHTML(post.title)}</a></h2><p>${escapeHTML(post.description)}</p><a class="link-arrow" href="./${post.slug}/" aria-label="Read ${escapeHTML(post.title)}">Read article</a></div></article></li>`).join('')}</ol><section class="blog-next"><h2>Put it into practice.</h2><p>Each article links back to the maintained implementation and guides. Start with a test cluster and a first Application.</p><a href="../docs/getting-started/" class="btn">Open the getting started guide</a></section></div></main>`;
  return page({ route: 'blog/', active: 'blog', title, description, body, breadcrumbs: [{ name: 'Paprika', route: '' }, { name: 'Engineering blog', route: 'blog/' }], schema: { '@type': 'Blog', name: title, description, url: publicURL('blog/'), publisher, blogPost: manifest.posts.map((post) => ({ '@type': 'BlogPosting', headline: post.title, url: publicURL(post.route), datePublished: post.date, author: publisher })) } });
}

function notFoundPage() {
  const body = `<main id="main-content" class="content-hero shell" tabindex="-1"><h1>That page isn’t here.</h1><p>The link may have moved. Browse the documentation, read the engineering blog, or return to Paprika.</p><div class="hero-actions"><a href="/paprika/docs/" class="btn">Browse documentation</a><a href="/paprika/" class="link-arrow">Paprika home</a></div></main>`;
  // A Pages 404 is served at the requested URL, so all resource URLs must be absolute from the host root.
  return page({ route: '404.html', fileRoute: true, title: 'Page not found · Paprika', description: 'Find Paprika documentation, engineering articles, and Kubernetes delivery resources.', active: '', noindex: true, body, breadcrumbs: [{ name: 'Paprika', route: '' }], schema: { '@type': 'WebPage', name: 'Page not found', url: publicURL('404.html') } }).replaceAll('href="./', 'href="/paprika/').replaceAll('src="./', 'src="/paprika/');
}

function rss(manifest) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Paprika engineering blog</title><link>${siteURL}blog/</link><description>Practical notes on Kubernetes delivery and observability.</description><language>en</language><atom:link href="${siteURL}feed.xml" rel="self" type="application/rss+xml"/>${manifest.posts.map((post) => `<item><title>${escapeXML(post.title)}</title><link>${publicURL(post.route)}</link><guid isPermaLink="true">${publicURL(post.route)}</guid><description>${escapeXML(post.description)}</description><category>${escapeXML(post.category)}</category><dc:date>${post.date}</dc:date></item>`).join('')}</channel></rss>\n`;
}

function featuredPosts(manifest) {
  return `<ol class="reading-list">${manifest.posts.slice(0, 3).map((post) => `<li><div class="reading-meta"><span>${escapeHTML(post.category)}</span><span>Guide</span></div><div><h3><a href="./${post.route}">${escapeHTML(post.title)}</a></h3><p>${escapeHTML(post.description)}</p></div><a class="reading-open" href="./${post.route}" aria-label="Read ${escapeHTML(post.title)}">Read article <span aria-hidden="true">→</span></a></li>`).join('')}</ol>`;
}

export function buildContent(output) {
  const destination = stagingDestination(output);
  const manifest = readManifest();
  const items = [...manifest.docs, ...manifest.posts];
  const sourceRoutes = new Map(items.map((item) => [item.source, item.route]));
  const assets = new Map();
  const rendered = new Map(items.map((item) => [item.source, renderDocument(item, sourceRoutes, assets)]));
  mkdirSync(destination, { recursive: true });
  for (const directory of ['docs', 'blog', 'content-assets']) {
    rmSync(join(destination, directory), { recursive: true, force: true });
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
    writeFileSync(homepage, content.replace(/<!-- featured-posts:start -->[\s\S]*?<!-- featured-posts:end -->/, `<!-- featured-posts:start -->\n${featuredPosts(manifest)}\n<!-- featured-posts:end -->`));
  }
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
  const entry = { slug: 'start', title: 'Start', description: 'Start with a test cluster', section: 'Start', source: 'docs/getting-started.md' };
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
  console.log('Passed content builder checks: Markdown safety, GitHub anchors, source links, traversal, fenced code and tables.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === '--self-test') selfTest();
  else if (process.argv[2] === '--validate-output') console.log(stagingDestination(process.argv[3]));
  else if (process.argv[2]) buildContent(process.argv[2]);
  else throw new Error('Usage: node landing/build-content.mjs <staging-output-directory> | --validate-output <directory> | --self-test');
}
