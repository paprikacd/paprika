#!/usr/bin/env node
/** Export editable documentation diagrams as crawlable, self-contained PNGs. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../landing/node_modules/playwright/index.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'landing/article-images');
const C = { paper: '#f2f2f3', white: '#ffffff', ink: '#1d2d3d', steel: '#416180', pale: '#e7f0f8', line: '#b8c7d4', muted: '#52677b' };
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const text = (x, y, value, size = 24, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" ${extra}>${escape(value)}</text>`;
const lines = (x, y, values, size = 24, leading = 32, extra = '') => values.map((value, i) => text(x, y + i * leading, value, size, extra)).join('');
const path = d => `<path d="${d}"/>`;
function icon(name, x, y) {
  const shapes = {
    terminal: '<rect x="2" y="5" width="60" height="45" rx="2"/>' + path('M3 16H61 M13 26L22 33L13 40 M29 40H44'),
    document: path('M13 2H43L54 13V60H13Z M43 2V13H54 M23 26H43 M23 36H43 M23 46H37'),
    shield: path('M32 3L56 12V28C56 44 42 54 32 61C22 54 8 44 8 28V12Z M21 31L29 39L44 23'),
    routing: path('M4 32H24 M24 32V12H55 M24 32V52H55 M48 5L55 12L48 19 M48 45L55 52L48 59'),
    cluster: '<rect x="3" y="4" width="23" height="23"/><rect x="38" y="4" width="23" height="23"/><rect x="21" y="39" width="23" height="23"/>' + path('M14 27V33H49V27 M32 33V39'),
    database: '<ellipse cx="32" cy="11" rx="25" ry="8"/>' + path('M7 11V48C7 59 57 59 57 48V11 M7 29C7 40 57 40 57 29'),
    query: '<circle cx="25" cy="25" r="20"/>' + path('M40 40L60 60 M14 25H36 M25 14V36'),
    dashboard: '<rect x="3" y="4" width="58" height="56"/><rect x="11" y="13" width="17" height="13"/><rect x="36" y="13" width="17" height="13"/><rect x="11" y="35" width="42" height="17"/>',
    browser: '<rect x="2" y="4" width="60" height="47"/><rect x="41" y="29" width="21" height="32"/>' + path('M3 15H61 M18 25H31 M18 34H31'),
    metric: path('M4 54V8 M4 54H61 M12 39L23 27L34 34L47 12L58 20'),
    check: '<circle cx="32" cy="32" r="28"/>' + path('M17 32L28 43L48 21'),
  };
  return `<g transform="translate(${x} ${y})" fill="none" stroke="${C.steel}" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">${shapes[name]}</g>`;
}

// Each figure illustrates documented behavior, never live measurements or UI captures.
const figures = [
  { id: 'api-access', title: 'A request to Paprika', subtitle: 'The CLI and Connect-RPC API act on the same Kubernetes resource model.',
    cards: [
      { label: 'Client', icon: 'terminal', lines: ['Paprika CLI', 'Connect JSON request', 'Read or delivery action'] },
      { label: 'Paprika API', icon: 'shield', lines: ['Authenticate the caller', 'Check resource access', 'Run the requested action'] },
      { label: 'Kubernetes records', icon: 'cluster', lines: ['Applications + Releases', 'Pipelines + related CRs', 'Read back the result'] },
    ], note: ['A request is not a completed rollout.', 'Inspect the resulting resource and its observed state.'] },
  { id: 'canary', title: 'Advance traffic in verified steps', subtitle: 'Illustrative canary configuration: 10 → 25 → 50 → 100 percent.',
    cards: [
      { label: 'Configure', icon: 'document', lines: ['Stage or Application', 'Traffic weights + interval', 'Optional analysis checks'] },
      { label: 'Route traffic', icon: 'routing', lines: ['Stable + canary backends', 'Istio / Gateway API', 'Or chart-rendered weights'] },
      { label: 'Gate each step', icon: 'check', lines: ['Wait for workloads', 'Respect the soak interval', 'Pass configured analysis'] },
    ], note: ['Advance only after the step gates pass.', 'Rollback on failure must be configured.'] },
  { id: 'cluster-targets', title: 'Choose where a Stage deploys', subtitle: 'A Cluster registration describes the target connection.',
    cards: [
      { label: 'Application', icon: 'document', lines: ['Release + rendered YAML', 'Stage selects a Cluster', 'Target-specific settings'] },
      { label: 'Connection mode', icon: 'routing', lines: ['in-cluster: local account', 'direct: target API access', 'agent: reachable apply agent'] },
      { label: 'Target cluster', icon: 'cluster', lines: ['Namespaced resources', 'Workload health + sync', 'Satellite reports if enabled'] },
    ], note: ['Satellite reports carry observed state back to the control plane.', 'Reporting alone does not establish a working deployment transport.'] },
  { id: 'observe-gateway', title: 'Query across telemetry sources', subtitle: 'Paprika Observe provides a separate authenticated MCP surface.',
    cards: [
      { label: 'MCP client', icon: 'terminal', lines: ['Sign in with OAuth', 'Connect to /observe/mcp', 'Discover available sources'] },
      { label: 'Observe gateway', icon: 'shield', lines: ['Require paprika:observe', 'Authorize provider access', 'Bound the requested query'] },
      { label: 'Providers', icon: 'database', lines: ['Metrics', 'Logs', 'Traces'] },
    ], note: ['Provider health describes reachability, not the health of a service.', 'Inspect returned samples, errors and timestamps.'] },
  { id: 'dashboard-authoring', title: 'Build a dashboard from real queries', subtitle: 'Provider discovery, saved queries and widgets form one explicit chain.',
    cards: [
      { label: 'Discover', icon: 'query', lines: ['Canonical provider IDs', 'Actual metrics + labels', 'Execute a bounded query'] },
      { label: 'Bind', icon: 'dashboard', lines: ['Saved query + parameters', 'Widgets + provider IDs', 'Exact ETag when editing'] },
      { label: 'Verify', icon: 'check', lines: ['Run query_dashboard', 'Inspect freshness + errors', 'Review the rendered layout'] },
    ], note: ['A saved document does not prove its queries work.', 'Dashboard authoring requires write scope and human Insights permissions.'] },
  { id: 'metrics', title: 'From instrumentation to an alert', subtitle: 'Observe the operator and its delivery activity with Prometheus.',
    cards: [
      { label: 'Instrument', icon: 'metric', lines: ['Controller + reconciliation', 'Delivery, drift + pruning', 'Expose /metrics'] },
      { label: 'Scrape', icon: 'database', lines: ['Prometheus target', 'Metric labels + time series', 'Confirm sample freshness'] },
      { label: 'Evaluate', icon: 'query', lines: ['Query the relevant signal', 'Choose a useful duration', 'Adapt alert thresholds'] },
    ], note: ['An absent sample is not a zero.', 'Check scrape reachability before interpreting a quiet metric.'] },
  { id: 'browser-renderer', title: 'Inspect the saved dashboard visually', subtitle: 'The optional renderer captures the authenticated Insights interface.',
    cards: [
      { label: 'Authorize', icon: 'shield', lines: ['Dashboard ID + viewport', 'Human access permissions', 'Bind the document ETag'] },
      { label: 'Private worker', icon: 'browser', lines: ['Loopback-only sidecar', 'Trusted Insights origin', 'Real Chromium capture'] },
      { label: 'Inspect', icon: 'query', lines: ['PNG + matching revision', 'Desktop / mobile layout', 'Values, labels + tooltips'] },
    ], note: ['The worker must be explicitly deployed and configured.', 'Also run query_dashboard to check data freshness and query results.'] },
  { id: 'mcp-access', title: 'Connect a client to the right surface', subtitle: 'Codex, Claude Code and other remote MCP clients use native OAuth.',
    cards: [
      { label: 'Configure client', icon: 'terminal', lines: ['Plugin or endpoint setup', 'Your Paprika server URL', 'Fleet or Observe surface'] },
      { label: 'Sign in', icon: 'shield', lines: ['Native OAuth flow', 'Review requested access', 'Keep credentials private'] },
      { label: 'Verify access', icon: 'query', lines: ['/mcp: fleet tools', '/observe/mcp: telemetry', 'Discover authorized tools'] },
    ], note: ['Fleet and Observe use distinct token audiences and permissions.', 'Installing a plugin does not grant access to a server.'] },
];

function renderFigure(figure, mobile) {
  const width = mobile ? 600 : 1200;
  const height = mobile ? 820 : 675;
  const titleLines = figure.title.length > 31 && mobile
    ? [figure.title.slice(0, figure.title.lastIndexOf(' ', 31)), figure.title.slice(figure.title.lastIndexOf(' ', 31) + 1)] : [figure.title];
  let body = `<rect width="${width}" height="${height}" fill="${C.paper}"/>`;
  body += text(mobile ? 26 : 40, 38, 'PAPRIKA / CONCEPT GUIDE', 16, `fill="${C.steel}" letter-spacing="2"`);
  body += lines(mobile ? 26 : 40, mobile ? 78 : 94, titleLines, mobile ? 30 : 38, 36, 'font-weight="700"');
  if (!mobile) body += text(40, 135, figure.subtitle, 23, `fill="${C.muted}"`);
  figure.cards.forEach((card, index) => {
    const x = mobile ? 26 : 40 + index * 384;
    const y = mobile ? 156 + index * 174 : 184;
    const w = mobile ? 548 : 352;
    const h = mobile ? 150 : 340;
    body += `<path d="M${x} ${y}l6-6h${w}l-6 6 M${x+w} ${y}l6-6v${h}l-6 6" fill="${C.pale}" stroke="${C.line}"/>`;
    body += `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${C.white}" stroke="${C.line}"/>`;
    body += text(x + 22, y + 29, `0${index + 1}`, 17, `fill="${C.steel}" letter-spacing="2"`);
    if (mobile) {
      const label = card.label.length > 17 ? card.label.split(' ') : [card.label];
      body += lines(x + 22, y + 62, label, 25, 29, 'font-weight="700"');
      body += `<g transform="translate(${x+25} ${y+95}) scale(.6)">${icon(card.icon, 0, 0)}</g>`;
      body += lines(x + 252, y + 45, card.lines, 20, 33, `fill="${C.muted}"`);
    } else {
      body += text(x + 22, y + 72, card.label, 28, 'font-weight="700"');
      body += icon(card.icon, x + 24, y + 105);
      body += `<path d="M${x+22} ${y+191}H${x+w-22}" stroke="${C.line}"/>`;
      body += lines(x + 22, y + 230, card.lines, 21, 32, `fill="${C.muted}"`);
    }
    if (index < 2) body += mobile
      ? `<path d="M300 ${y+h+3}v17m-5-5l5 5 5-5" fill="none" stroke="${C.steel}" stroke-width="2"/>`
      : `<path d="M${x+w+8} 354h17m-5-5l5 5-5 5" fill="none" stroke="${C.steel}" stroke-width="2"/>`;
  });
  const note = mobile ? figure.note.flatMap(line => {
    const words = line.split(' ');const result=[''];
    for(const word of words){if((result.at(-1)+' '+word).trim().length>49)result.push(word);else result[result.length-1]=(result.at(-1)+' '+word).trim();}
    return result;
  }) : figure.note;
  body += `<path d="M${mobile?26:40} ${mobile?686:560}H${width-(mobile?26:40)}" stroke="${C.line}"/>`;
  body += lines(mobile ? 26 : 40, mobile ? 715 : 594, note, mobile ? 19 : 22, mobile ? 24 : 32, `fill="${C.muted}"`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"><title>${escape(figure.title)}</title><desc>${escape(figure.subtitle+' '+figure.note.join(' '))}</desc><g font-family="Arial, Helvetica, sans-serif" fill="${C.ink}">${body}</g></svg>\n`;
}

mkdirSync(output, { recursive: true });
for (const figure of figures) {
  for (const mobile of [false, true]) writeFileSync(join(output, `${figure.id}${mobile ? '-mobile' : ''}.svg`), renderFigure(figure, mobile));
}
const reused = ['deployment', 'pipeline-running', 'promotion', 'evidence'];
const sources = [...figures.map(f => ({ id: f.id, directory: output })), ...reused.map(id => ({ id, directory: join(root, 'landing/diagrams') }))];
const browser = await chromium.launch({ headless: true });
const dimensions = {};
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { id, directory } of sources) {
    for (const mobile of [false, true]) {
      const name = id + (mobile ? '-mobile' : '');
      const svg = readFileSync(join(directory, name + '.svg'), 'utf8');
      const [, rawWidth, rawHeight] = svg.match(/viewBox="0 0 (\d+) (\d+)"/);
      const width = Number(rawWidth), height = Number(rawHeight);
      await page.setViewportSize({ width, height });
      await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
      await page.evaluate(() => document.fonts.ready);
      const clipped = await page.locator('svg text').evaluateAll(nodes => nodes.filter(node => {
        const rect = node.getBoundingClientRect();
        return rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1;
      }).map(node => node.textContent));
      assert.deepEqual(clipped, [], `${name}: text must fit inside the image`);
      await page.screenshot({ path: join(output, `${name}.png`) });
      dimensions[name] = { src: `article-images/${name}.png`, width, height };
    }
  }
} finally { await browser.close(); }
console.log(JSON.stringify(dimensions, null, 2));
