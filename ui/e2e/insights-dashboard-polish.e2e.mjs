// Deterministic regression observations for the operational dashboard review.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { installRichChartFixtureAPI } from './fixtures/rich-chart-api.mjs';
const base = process.env.INSIGHTS_E2E_URL || 'http://127.0.0.1:3015';
const output = process.env.INSIGHTS_POLISH_OUTPUT || join(tmpdir(), 'paprika-dashboard-polish');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
let lastPage;
const start = Date.UTC(2026, 10, 7), end = start + 3600000;
const series = Array.from({ length: 8 }, (_, index) => ({ name: `worker-${index + 1}`, labels: { node: `worker-${index + 1}` }, points: Array.from({ length: 61 }, (_, i) => ({ timestamp: start + i * 60000, value: 30 + index * 10 + 9 * Math.sin(i / 5 + index) })) }));
const widget = (id, title, type, layout, extra = {}) => ({ id, title, type, ...(type === 'plugin' ? { dataKind: 'metrics' } : {}), providerId: 'example-prometheus', query: id, unit: '%', layout, ...extra });
const dashboard = { schemaVersion: 1, id: 'polish-regression', title: 'Operations · local test fixture', description: 'Deterministic samples for layout and interaction checks.', timeZone: 'Australia/Melbourne', timeRange: '1h', customTimeRange: { from: new Date(start).toISOString(), to: new Date(end).toISOString() }, refreshInterval: 0, widgets: [
  widget('trend-a', 'Workload CPU', 'timeseries', { x: 0, y: 0, w: 6, h: 5 }, { options: { decimals: 1 } }),
  widget('trend-b', 'Service latency', 'timeseries', { x: 6, y: 0, w: 6, h: 5 }, { unit: 'ms', options: { decimals: 1 } }),
  widget('stack-wide', 'CPU by node', 'plugin', { x: 0, y: 5, w: 7, h: 4 }, { pluginId: 'stacked-timeseries', config: { legendDisplay: 'table', legendPosition: 'right', maxSeries: 8 } }),
  widget('stack-narrow', 'Memory by node', 'plugin', { x: 7, y: 5, w: 5, h: 4 }, { pluginId: 'stacked-timeseries', config: { legendDisplay: 'table', legendPosition: 'right', maxSeries: 8 } }),
  widget('gauges', 'Memory / request', 'plugin', { x: 0, y: 9, w: 6, h: 6 }, { pluginId: 'threshold-gauge', config: { seriesMode: 'all', maxSeries: 8, display: 'linear' }, options: { min: 0, max: 200, decimals: 0 } }),
  widget('history', 'Service availability', 'plugin', { x: 6, y: 9, w: 6, h: 6 }, { pluginId: 'status-history', config: { showTimeAxis: true, labelField: 'node', segmented: false }, options: { thresholds: [{ value: 0, color: '#b4473d', label: 'Unavailable' }, { value: 1, color: '#238269', label: 'Healthy' }] } }),
] };
try {
  for (const width of [1512, 768, 390]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 982 }, timezoneId: 'UTC', reducedMotion: 'reduce', ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    await context.addInitScript(theme => localStorage.setItem('paprika-insights-theme', theme), theme);
    const page = await context.newPage(), errors = [];
    lastPage = page;
    page.on('pageerror', error => errors.push(error.message));
    const api = await installRichChartFixtureAPI(page, base);
    api.documents.set(dashboard.id, structuredClone(dashboard));
    await page.route(`${base}/api/insights/query`, async route => {
      const { query } = route.request().postDataJSON();
      let data = structuredClone(series);
      if (query === 'trend-a') data = data.slice(0, 2);
      if (query === 'trend-b') data = data.slice(0, 4);
      if (query === 'gauges') data = data.map((entry, index) => ({ ...entry, name: `production-worker-long-identity-${index + 1}`, points: [{ timestamp: end, value: [558, 461, 298, 100, -12, null, 70, 140][index] }] }));
      if (query === 'history') data = data.slice(0, 5).map(entry => ({ ...entry, points: entry.points.map((point, i) => ({ ...point, value: i === 20 ? null : 1 })) }));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ series: data }) });
    });
    await page.goto(`${base}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: dashboard.title, exact: true }).waitFor();
    assert.equal(await page.title(), 'Paprika');
    await page.getByText('Nov 7, 11:00 AM — Nov 7, 12:00 PM GMT+11', { exact: true }).waitFor();
    const chart = page.locator('[data-widget-id="trend-b"]');
    await chart.getByRole('img', { name: 'Service latency', exact: true }).waitFor();
    await page.evaluate(() => document.fonts.ready);
    for (const id of ['stack-wide', 'stack-narrow']) {
      const tile = page.locator(`[data-widget-id="${id}"]`);
      await tile.scrollIntoViewIfNeeded();
      const svg = tile.locator('svg[role="group"]'); await svg.waitFor();
      assert.ok((await svg.boundingBox()).height >= 120, `${width}px ${id}: legend must not crush the plot`);
      const legend = tile.getByRole('region', { name: 'Series statistics' });
      await legend.focus(); await page.keyboard.press('End');
      await page.waitForFunction(id => { const el = document.querySelector(`[data-widget-id="${id}"] [aria-label="Series statistics"]`); return el.scrollTop + el.clientHeight >= el.scrollHeight - 2; }, id);
    }
    if (width === 1512) {
      const bottom = async id => page.locator(`[data-widget-id="${id}"] [data-chart-footer]`).evaluate(el => el.previousElementSibling.getBoundingClientRect().bottom);
      assert.ok(Math.abs(await bottom('trend-a') - await bottom('trend-b')) < 2, 'Different series counts retain aligned plots');
    }
    await chart.scrollIntoViewIfNeeded();
    await chart.getByRole('button', { name: /Compare window for/ }).click();
    await page.getByRole('dialog', { name: 'Compare a window' }).getByRole('button', { name: 'Zoom chart to window' }).click();
    await chart.getByRole('button', { name: 'Reset chart zoom' }).click();
    await chart.getByRole('button', { name: /Inspect chart data/ }).click();
    await page.getByRole('dialog').waitFor(); await page.keyboard.press('Escape');
    const history = page.locator('[data-widget-id="history"]'); await history.scrollIntoViewIfNeeded();
    const axis = history.getByRole('group', { name: 'Status history time scale in Australia/Melbourne' });
    assert.equal(await axis.locator('time').first().innerText(), '11:00');
    await history.locator('[data-history-key="0-0"]').focus(); await page.keyboard.press('Enter');
    const tip = page.getByRole('tooltip'); await tip.waitFor();
    assert.match(await tip.innerText(), /11:00:00/); await page.keyboard.press('Escape');
    const gauges = page.locator('[data-widget-id="gauges"]'); await gauges.scrollIntoViewIfNeeded();
    const rowsFit = await gauges.locator('[data-gauge-bank-item]').evaluateAll(rows => rows.every(row => {
      const bounds = row.getBoundingClientRect(), body = row.firstElementChild.getBoundingClientRect();
      return body.top >= bounds.top - 1 && body.bottom <= bounds.bottom + 1;
    }));
    assert.ok(rowsFit, 'Gauge labels and touch targets stay inside their own rows');
    assert.equal(await gauges.locator('[data-gauge-outside-scale="above"]').count(), 3);
    assert.equal(await gauges.locator('[data-gauge-outside-scale="below"]').count(), 1);
    assert.equal(await gauges.locator('[data-gauge-value="unknown"]').innerText(), 'No data');
    await gauges.getByRole('button', { name: /identity-1: 558%/ }).click();
    await tip.getByText('Above scale maximum: 200%', { exact: true }).waitFor();
    assert.match(await tip.innerText(), /Above scale maximum: 200%/);
    const box = await tip.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= width + 1, 'Pinned details fit viewport');
    await page.screenshot({ path: join(output, `inspector-${theme}-${width}.png`) });
    await page.keyboard.press('Escape');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page overflow');
    assert.deepEqual(errors, []); assert.deepEqual(api.failures, []);
    await page.screenshot({ path: join(output, `dashboard-${theme}-${width}.png`), fullPage: true });
    await context.close(); console.log(`PASS ${theme} ${width}px: plot budget, statistics scrolling, timezone, overflow, exact inspection, zoom and data actions`);
  }
} catch (error) {
  console.error((await lastPage?.locator('body').innerText())?.slice(0, 4000));
  await lastPage?.screenshot({ path: join(output, 'failure.png') });
  throw error;
} finally { await browser.close(); }
