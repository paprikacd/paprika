import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { installChartSystemFixture } from './fixtures/chart-system.mjs';
import { polishDashboards, polishQuery, polishRange, polishPods } from './fixtures/dashboard-polish.mjs';

const base = process.env.INSIGHTS_E2E_URL || 'http://127.0.0.1:3015';
const output = resolve('../artifacts/insights/tooltip-structure');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true }), reports = [];

// Measure real text, not the padded wrapper. These checks would pass a shell
// with adequate padding only if every chart's content actually uses it.
async function anatomy(panel, width) {
  const measured = await panel.evaluate(node => {
    const box = node.getBoundingClientRect(), insets = [], failures = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode, owner = text.parentElement;
      if (!text.textContent.trim() || !owner || owner.closest('svg,[hidden],[class*="srOnly"],[class*="VisuallyHidden"]')) continue;
      if (owner.closest('details:not([open])') && !owner.closest('summary')) continue;
      const range = document.createRange(); range.selectNodeContents(text);
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        let visibleLeft = rect.left, visibleRight = rect.right;
        for (let clip = owner; clip && clip !== node; clip = clip.parentElement) {
          if (['hidden', 'clip'].includes(getComputedStyle(clip).overflowX)) {
            const bounds = clip.getBoundingClientRect();
            visibleLeft = Math.max(visibleLeft, bounds.left); visibleRight = Math.min(visibleRight, bounds.right);
          }
        }
        if (visibleRight <= visibleLeft) continue;
        const left = visibleLeft - box.left, right = box.right - visibleRight;
        insets.push(Math.min(left, right));
        if (left < 12 || right < 12) failures.push({ text: text.textContent.trim().slice(0, 60), left, right });
      }
    }
    const title = node.querySelector('[class*="tooltipTitle"]')?.getBoundingClientRect();
    const reading = node.querySelector('[data-metric-value]')?.getBoundingClientRect();
    const fact = node.querySelector('dt')?.getBoundingClientRect();
    return { box: { x: box.x, y: box.y, right: box.right, bottom: box.bottom }, minInset: Math.min(...insets), failures,
      alignment: title && (reading || fact) ? Math.abs(title.left - (reading || fact).left) : 0,
      overflow: node.scrollWidth > node.clientWidth + 1,
      overflowDetails: [...node.querySelectorAll('*')].flatMap(el => { const r = el.getBoundingClientRect(); return r.right > box.right + 1 ? [{ tag: el.tagName, class: el.className.baseVal ?? el.className, right: r.right - box.right, width: r.width }] : []; }).slice(0, 12) };
  });
  assert.deepEqual(measured.failures, [], 'Every tooltip text row retains an inner gutter');
  assert.equal(measured.overflow, false, `Long values wrap without horizontal scrolling: ${JSON.stringify(measured.overflowDetails)}`);
  assert.ok(measured.alignment < 1, 'Title and reading/fact column share the same inset');
  assert.ok(measured.box.x >= 8 && measured.box.right <= width - 8 && measured.box.y >= 8 && measured.box.bottom <= 1042, JSON.stringify(measured));
  return measured;
}

try {
  for (const theme of ['light', 'dark']) for (const width of [1512, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1050 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(theme => { localStorage.setItem('paprika-insights-theme', theme); localStorage.setItem('paprika-insights-compact-view', 'true'); }, theme);
    try {
      const fixture = await installChartSystemFixture(page, base);
      fixture.records.rows[0][0] = 'europe-production-ingestion-primary-with-a-long-source-identifier-7c9c6b8f5d-k4w2n';
      const metricWidgets = polishDashboards('example-prometheus')[0].widgets.filter(widget => ['cpu', 'percentiles'].includes(widget.id));
      fixture.dashboard.widgets.push(...metricWidgets.map((widget, index) => ({ ...widget, layout: { x: index * 6, y: 10, w: 6, h: 6 }, options: { ...widget.options, tooltipView: widget.id === 'percentiles' ? { type: 'timeseries' } : undefined } })));
      fixture.dashboard.customTimeRange = polishRange; fixture.dashboard.timeZone = 'UTC';
      await page.route(`${new URL(base).origin}/api/insights/query`, async route => {
        const query = route.request().postDataJSON();
        if (!query.query.startsWith('fixture_')) return route.fallback();
        await route.fulfill({ json: polishQuery(query) });
      });
      await page.goto(`${base}/dashboard/insights/?dashboard=${fixture.dashboard.id}`);
      if (width <= 768) await page.locator(`[data-testid="dashboard-canvas"][data-layout-mode="${width === 390 ? 'stacked' : 'compact'}"]`).waitFor();
      const tile = id => page.locator(`[data-widget-id="${id}"]`);
      const cases = [
        ['hex-map', () => tile('hex-map').getByRole('button', { name: /Sum of value/ }).first(), 'tooltip'],
        ['honeycomb', () => tile('honeycomb').getByRole('button', { name: /^Location 002 ·/ }), 'tooltip'],
        ['records', () => tile('records').locator('td[data-record-cell-column="0"]').first(), 'Record cell details'],
        ['markers', () => tile('markers').getByRole('button', { name: /^Location 003 ·/ }).first(), 'tooltip'],
        ['cpu', () => tile('cpu').locator('svg[role="group"]').first(), 'Observation details'],
        ['percentiles', () => tile('percentiles').getByRole('img', { name: 'Request latency', exact: true }), 'tooltip'],
      ];
      for (const [id, target, role] of cases) {
        await tile(id).scrollIntoViewIfNeeded();
        await target().waitFor();
        await target().focus();
        await target().press('Enter');
        const panel = role === 'tooltip' ? page.getByRole('tooltip') : page.getByRole('region', { name: role, exact: true });
        await panel.waitFor();
        if (id === 'honeycomb') await panel.getByText('No complete value', { exact: true }).waitFor();
        if (id === 'records') await panel.getByText(fixture.records.rows[0][0], { exact: true }).waitFor();
        if (id === 'cpu' || id === 'percentiles') {
          const before = await panel.locator('[data-metric-value]').getAttribute('data-metric-value');
          assert.ok(before !== null && Number.isFinite(Number(before)));
          await panel.getByText('Source details', { exact: true }).first().click();
          assert.equal(await panel.locator('[data-metric-value]').getAttribute('data-metric-value'), before, 'Expanding metadata preserves the exact selected observation');
          if (id === 'cpu') assert.ok((await panel.innerText()).includes(polishPods[0]));
          if (id === 'percentiles') await panel.locator('[data-tooltip-widget="timeseries"] svg').waitFor();
        }
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const measured = await anatomy(panel, width);
        await page.screenshot({ path: resolve(output, `${theme}-${width}-${id}.png`) });
        await panel.screenshot({ path: resolve(output, `${theme}-${width}-${id}-detail.png`) });
        if (width === 390 && await panel.getByRole('button', { name: 'Minimize inspector', exact: true }).count()) {
          const minimize = panel.getByRole('button', { name: 'Minimize inspector', exact: true });
          await minimize.click();
          assert.ok((await panel.boundingBox()).height < 100, 'A pinned mobile inspector can be minimized');
          await panel.getByRole('button', { name: 'Show inspector details', exact: true }).click();
        }
        await page.keyboard.press('Escape');
        await panel.waitFor({ state: 'hidden' });
        reports.push({ theme, width, family: id, minInset: measured.minInset, aligned: true, passed: true });
      }
      assert.deepEqual(errors, []); assert.deepEqual(fixture.failures, []);
      console.log(`PASS ${theme} ${width}: six tooltip families, text gutters, exact values, long labels, metadata, history and dismissal`);
    } catch (error) {
      await page.screenshot({ path: resolve(output, `failure-${theme}-${width}.png`) }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(reports, null, 2)); }
