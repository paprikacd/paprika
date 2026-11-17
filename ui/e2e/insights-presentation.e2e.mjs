// Synthetic observations exercise the same targeted presentation edits as live.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { installRichChartFixtureAPI } from './fixtures/rich-chart-api.mjs';

const edits = JSON.parse(await readFile(new URL('../../hack/dashboard-presentation/patches.json', import.meta.url), 'utf8'));
const base = process.env.INSIGHTS_E2E_URL || 'http://127.0.0.1:3015';
const output = process.env.INSIGHTS_PRESENTATION_OUTPUT || join(tmpdir(), 'paprika-presentation');
await mkdir(output, { recursive: true });
const start = Date.UTC(2026, 10, 9), end = start + 3600000;
const points = value => Array.from({ length: 61 }, (_, i) => ({ timestamp: start + i * 60000, value: value + Math.sin(i / 5) * value / 8 }));
const widget = (id, type, layout, extra = {}) => ({ id, title: id, type, providerId: 'example-prometheus', query: id, unit: '', layout, ...extra });
const document = (id, widgets) => ({ schemaVersion: 1, id, title: `${id} · test fixture`, description: 'Synthetic observations for presentation checks.', timeRange: '1h', customTimeRange: { from: new Date(start).toISOString(), to: new Date(end).toISOString() }, refreshInterval: 0, widgets });
const apply = (dashboard, updates) => ({ ...dashboard, widgets: dashboard.widgets.map(item => {
  const patch = updates.find(edit => edit.id === item.id)?.patch;
  return patch ? Object.fromEntries(Object.entries({ ...item, ...patch, ...Object.fromEntries(['options', 'layout', 'config'].filter(key => patch[key]).map(key => [key, { ...item[key], ...patch[key] }])) }).filter(([, value]) => value !== null)) : item;
}) });
const service = apply(document('service-overview', [
  ...['request-rate', 'client-errors', 'server-errors', 'latency-p95'].map((id, i) => widget(id, 'stat', { x: i * 3, y: 0, w: 3, h: 2 }, { unit: i === 3 ? 'ms' : i ? '%' : 'req/s', options: { decimals: 2, showSparkline: true, sparklinePlacement: 'side' } })),
  ...['request-trend', 'response-errors', 'latency-percentiles'].map((id, i) => widget(id, 'timeseries', { x: i * 4, y: 2, w: 4, h: 4 }, { unit: i === 2 ? 'ms' : i ? '%' : 'req/s', options: { decimals: 2, min: 0, showLegend: i > 0 } })),
]), edits['service-overview']);
const resources = ['omega-k8s-cluster-overview', 'omega-k8s-workload-resources'].map(id => {
  const [cpu, memory, ...rest] = edits[id].map(edit => edit.id);
  const drilldowns = [{ id: 'workload', title: 'Open workload resources', dashboardId: 'omega-k8s-workload-resources', carryTimeRange: true, bindings: [] }];
  return apply(document(id, [
    widget(cpu, 'plugin', { x: 0, y: 2, w: 7, h: 5 }, { drilldowns, description: 'Top eight workloads at range end · fixed selection', dataKind: 'metrics', pluginId: 'stacked-timeseries', unit: 'cores', options: { decimals: 2 }, config: { display: 'area', maxSeries: 12, legendDisplay: 'table', legendPosition: 'right' } }),
    widget(memory, 'plugin', { x: 7, y: 2, w: 5, h: 5 }, { drilldowns, description: 'Top eight workloads at range end · fixed selection', dataKind: 'metrics', pluginId: 'stacked-timeseries', unit: id.includes('cluster') ? 'GiB' : 'MiB', options: { decimals: 2 }, config: { display: 'area', maxSeries: 12, legendDisplay: 'table', legendPosition: 'bottom' } }),
    ...rest.map((name, i) => widget(name, 'stat', { x: i % 2 * 6, y: i < 2 ? 7 : 11, w: 6, h: i < 2 ? 4 : 3 })),
  ]), edits[id]);
});
// Deliberately return percentiles out of order; semantic colours must follow labels.
const percentiles = ['p99', 'p50', 'p95'].map((name, i) => ({ name, labels: { quantile: name }, points: points([312.53, 84.25, 193.71][i]) }));
const resourceSeries = Array.from({ length: 12 }, (_, i) => ({ name: `production-workload-${i + 1}`, labels: { namespace: `production-workload-${i + 1}` }, points: points((i + 1) / 10) }));
const browser = await chromium.launch({ headless: true });
let page;
try {
  for (const width of [1512, 768, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 982 }, reducedMotion: 'reduce', ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(theme => localStorage.setItem('paprika-insights-theme', theme), theme);
    page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const api = await installRichChartFixtureAPI(page, base);
    for (const doc of [service, ...resources]) api.documents.set(doc.id, structuredClone(doc));
    await page.route(`${base}/api/insights/query`, route => {
      const { query } = route.request().postDataJSON();
      const series = query === 'latency-percentiles' ? percentiles : query === 'response-errors'
        ? ['5xx', '4xx'].map((name, i) => ({ name, labels: { status_class: name }, points: points(i + .2) }))
        : /^(cpu|memory)-(namespace|pod)$/.test(query) ? resourceSeries.map(entry => ({ ...entry, points: entry.points.map(point => ({ ...point, value: query === 'memory-pod' ? point.value * 1024 : point.value })) }))
        : [{ name: query, labels: {}, points: points(query === 'latency-p95' ? 193.71 : 12) }];
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ series }) });
    });
    for (const doc of [service, ...resources]) {
      await page.goto(`${base}/dashboard/insights/?dashboard=${doc.id}`, { waitUntil: 'networkidle' });
      await page.getByRole('heading', { name: doc.title, exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      if (doc.id === service.id) {
        if (width === 1512) {
          const plotBottoms = await page.locator('[data-timeseries-footer]').evaluateAll(footers => footers.map(el => el.previousElementSibling.getBoundingClientRect().bottom));
          assert.equal(plotBottoms.length, 3);
          assert.ok(Math.max(...plotBottoms) - Math.min(...plotBottoms) < 2, 'All three service trend plots align');
        }
        for (const id of ['latency-percentiles', 'response-errors']) {
          const chart = page.locator(`[data-widget-id="${id}"]`);
          await chart.scrollIntoViewIfNeeded();
          const legend = chart.getByRole('list', { name: 'Latest values by series' });
          await legend.waitFor();
          const readings = await legend.evaluate(el => {
            const clip = el.getBoundingClientRect();
            return [...el.querySelectorAll('[role="listitem"]')].map(item => ({ text: item.textContent, color: item.firstElementChild.style.background, fits: [...item.children].every(child => {
              const range = window.document.createRange(); range.selectNodeContents(child);
              return [...range.getClientRects()].every(box => box.left >= clip.left - 1 && box.right <= clip.right + 1 && box.top >= clip.top - 1 && box.bottom <= clip.bottom + 1);
            }) }));
          });
          assert.ok(readings.every(reading => reading.fits), `${width}px ${theme}: all short legend names and values must be visible: ${JSON.stringify(readings)}`);
          // Patched series name semantic roles, so the swatch carries the role token (p99, p50, p95 and server-error, client-error).
          assert.deepEqual(readings.map(reading => reading.color), id === 'latency-percentiles' ? ['var(--gamma-series-p99, #a75fa7)', 'var(--gamma-series-p50, #127a8b)', 'var(--gamma-series-p95, #61516f)'] : ['var(--gamma-series-server-error, #b77080)', 'var(--gamma-series-client-error, #887fd0)']);
        }
        const chart = page.locator('[data-widget-id="latency-percentiles"]');
        await chart.getByRole('img', { name: 'latency-percentiles', exact: true }).focus();
        await page.keyboard.press('Enter');
        const tip = page.getByRole('tooltip');
        await page.waitForFunction(() => {
          const text = window.document.querySelector('[role="tooltip"]')?.innerText;
          return text?.includes('p99') && text.includes('p95');
        });
        const box = await tip.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1);
        await page.screenshot({ path: join(output, `inspector-${theme}-${width}.png`) });
        await page.keyboard.press('Escape');
      } else {
        const plots = [];
        for (const item of doc.widgets.slice(0, 2)) {
          const tile = page.locator(`[data-widget-id="${item.id}"]`); await tile.scrollIntoViewIfNeeded();
          const plot = tile.locator('svg[role="group"]'); await plot.waitFor();
          const box = await plot.boundingBox(); plots.push(box);
          assert.ok(box.height >= 160, `${width}px ${item.id}: useful resource plotting height (${box.height})`);
          const legend = tile.getByRole('region', { name: 'Series statistics' });
          await legend.focus(); await page.keyboard.press('End');
          await page.waitForFunction(id => { const el = window.document.querySelector(`[data-widget-id="${id}"] [aria-label="Series statistics"]`); return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; }, item.id);
        }
        if (width === 1512) assert.ok(Math.abs(plots[0].height - plots[1].height) < 2, 'Related resource plots have equal drawing height');
      }
      assert.ok(await page.evaluate(() => window.document.documentElement.scrollWidth <= innerWidth + 1), 'No page overflow');
      await page.screenshot({ path: join(output, `${doc.id}-${theme}-${width}.png`), fullPage: true });
      console.log(`PASS ${doc.id} ${theme} ${width}px: readable legends, stable colours, plot proportions and overflow`);
    }
    assert.deepEqual(errors, []); assert.deepEqual(api.failures, []);
    await context.close();
  }
  for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1400, height: 982 }, reducedMotion: 'reduce' });
    await context.addInitScript(theme => localStorage.setItem('paprika-insights-theme', theme), theme);
    page = await context.newPage();
    const api = await installRichChartFixtureAPI(page, base);
    const dense = document('dense-legends', [3, 4].map((h, i) => widget(`dense-${h}`, 'timeseries', { x: 0, y: i * 3, w: 5, h }, { unit: 'ms', options: { decimals: 2 } })));
    api.documents.set(dense.id, dense);
    await page.route(`${base}/api/insights/query`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ series: ['payments-production-primary', 'checkout-europe-secondary', 'notifications-background-worker', 'inventory-reconciliation'].map(name => ({ name, labels: { service: name }, points: points(123456.78) })) }) }));
    await page.goto(`${base}/dashboard/insights/?dashboard=${dense.id}`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    for (const item of dense.widgets) {
      const legend = page.locator(`[data-widget-id="${item.id}"]`).getByRole('list', { name: 'Latest values by series' });
      await legend.waitFor();
      const geometry = await legend.getByRole('listitem').evaluateAll(items => items.map(item => {
        const box = item.getBoundingClientRect(), children = [...item.children].map(child => child.getBoundingClientRect());
        return { nameWidth: children[1].width, contained: children.every(child => child.left >= box.left - 1 && child.right <= box.right + 1) };
      }));
      assert.equal(geometry.length, 4);
      assert.ok(geometry.every(item => item.contained && item.nameWidth >= 64), `Short dense legends keep each identity and value inside its own item: ${JSON.stringify(geometry)}`);
      await legend.focus();
      for (let step = 0; step < 30; step++) await page.keyboard.press('ArrowRight');
      await page.waitForFunction(id => {
        const el = window.document.querySelector(`[data-widget-id="${id}"] [aria-label="Latest values by series"]`);
        return el.scrollLeft + el.clientWidth >= el.scrollWidth - 2;
      }, item.id);
    }
    await page.screenshot({ path: join(output, `dense-legends-${theme}.png`), fullPage: true });
    assert.deepEqual(api.failures, []);
    await context.close(); console.log(`PASS ${theme}: short dense legends retain readable names, exact values and keyboard scrolling`);
  }
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png') });
  throw error;
} finally { await browser.close(); }
