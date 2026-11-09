import { applyWidgetChanges } from "./gamma-controls.mjs";
// Local visual/interaction loop, backed by real Insights persistence and synthetic queries.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { createReferenceDashboardEnvironment } from './fixtures/reference-dashboard-environment.mjs';
import { polishDashboards, polishQuery, polishRange, polishPods } from './fixtures/dashboard-polish.mjs';

const root = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const output = process.env.INSIGHTS_POLISH_OUTPUT || join(root, 'artifacts/insights/local-polish/after');
const review = process.argv.includes('--review');
const reports = [], errors = [];
let environment, browser, page, reversed = false;
await mkdir(output, { recursive: true });
const tile = id => page.locator(`[data-widget-id="${id}"]`);
async function check(name, run) {
  try { const evidence = await run(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`); }
  catch (error) { reports.push({ name, passed: false, error: error.message }); await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
}
async function loaded() {
  await page.getByRole('heading', { name: 'Service investigation', exact: true }).waitFor();
  for (const panel of await page.locator('[data-widget-id]').all()) await panel.scrollIntoViewIfNeeded();
  await tile('cpu').locator('svg[role="group"]').waitFor();
  await page.waitForFunction(() => !document.querySelector('[aria-label="Loading widget"]'));
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
try {
  environment = await createReferenceDashboardEnvironment(root, process.env.INSIGHTS_E2E_URL);
  const boards = polishDashboards(environment.providerIds.metrics);
  for (const board of boards) await environment.api(`dashboards/${board.id}`, 'PUT', board, { 'If-None-Match': '*' });
  const targetBefore = await environment.api(`dashboards/${boards[1].id}`);
  browser = await chromium.launch({ headless: !review });
  if (review) {
    const stopReview = () => { void browser.close(); };
    process.once('SIGINT', stopReview); process.once('SIGTERM', stopReview);
    const context = await browser.newContext({ viewport: { width: 1512, height: 980 } });
    page = await context.newPage();
    await environment.installQueryFixture(page, polishQuery);
    await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${boards[0].id}`, { waitUntil: 'networkidle' });
    await loaded();
    await page.screenshot({ path: join(output, 'review-ready.png'), fullPage: true });
    console.log('Local design playground is open. Synthetic observations; edits persist for this session. Close the browser to stop.');
    await once(browser, 'disconnected');
    process.removeListener('SIGINT', stopReview); process.removeListener('SIGTERM', stopReview);
  } else {
    for (const theme of ['light', 'dark']) for (const width of [1512, 768, 390]) {
      const revision = await environment.api(`dashboards/${boards[0].id}`);
      await environment.api(`dashboards/${boards[0].id}`, 'PUT', boards[0], { 'If-Match': revision.etag });
      const context = await browser.newContext({ viewport: { width, height: 980 }, reducedMotion: 'reduce', timezoneId: 'Australia/Melbourne', ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
      await context.addInitScript(theme => localStorage.setItem('paprika-insights-theme', theme), theme);
      page = await context.newPage(); page.setDefaultTimeout(10000);
      page.on('pageerror', error => errors.push(error.message));
      await environment.installQueryFixture(page, request => polishQuery(request, reversed));
      const label = `${theme} ${width}px`;
      await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${boards[0].id}`, { waitUntil: 'networkidle' });
      await loaded();
      await check(`${label}: readable plots and stable colours`, async () => {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await tile('requests').locator('[data-stat-summary] time').innerText(), '01:00 UTC', 'KPI time follows the dashboard zone, not the Melbourne browser zone');
        const plot = await tile('cpu').locator('svg[role="group"]').boundingBox();
        assert.ok(plot.height >= 150, `CPU plot must retain useful height: ${plot.height}`);
        const legend = tile('cpu').getByRole('region', { name: 'Series statistics' });
        const readColours = () => legend.locator('[data-legend-series]').evaluateAll(rows => Object.fromEntries(rows.map(row => [row.getAttribute('data-legend-series'), row.querySelector('i').style.background])));
        const before = await readColours();
        assert.equal(Object.keys(before).length, 3);
        assert.ok((await legend.innerText()).includes('No data'), 'Missing latest sample is not zero');
        if (width === 390) {
          assert.match(await tile('cpu').getByText('Scroll to see all statistics', { exact: false }).innerText(), /↔/);
          await legend.focus();
          for (let i = 0; i < 20; i++) await legend.press('ArrowRight', { delay: 20 });
          await page.waitForFunction(() => { const el = document.querySelector('[aria-label="Series statistics"]'); return el.scrollLeft + el.clientWidth >= el.scrollWidth - 1; });
          const last = await legend.getByRole('columnheader', { name: 'Max', exact: true }).boundingBox(), region = await legend.boundingBox();
          assert.ok(last.x + last.width <= region.x + region.width + 1, 'Keyboard scrolling reveals the final statistics column');
          for (let i = 0; i < 20; i++) await legend.press('ArrowLeft', { delay: 20 });
          await page.waitForFunction(() => document.querySelector('[aria-label="Series statistics"]').scrollLeft === 0);
        }
        await page.screenshot({ path: join(output, `${theme}-${width}.png`), fullPage: true });
        reversed = !reversed;
        await page.reload({ waitUntil: 'networkidle' }); await loaded();
        assert.deepEqual(await readColours(), before, 'Metric colours follow identity after a provider reorder');
        return { plotHeight: plot.height, series: 3, coloursPreserved: true };
      });
      await check(`${label}: inspector keeps time ahead of full source details`, async () => {
        const plot = tile('cpu').locator('svg[role="group"]');
        await plot.focus(); await plot.press('ArrowLeft'); await plot.press('Enter');
        const tip = page.getByRole('region', { name: 'Observation details', exact: true });
        await tip.waitFor();
        const bounds = await tip.boundingBox(), time = await tip.locator('[data-observation-details] time').boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1 && bounds.y >= 0 && bounds.y + bounds.height <= 981);
        assert.ok(time.y >= bounds.y && time.y + time.height <= bounds.y + bounds.height, 'Sample time is visible without scrolling');
        assert.match(await tip.locator('[data-observation-details] time').innerText(), /UTC/);
        assert.equal(await tip.locator('details').first().getAttribute('open'), null);
        await page.screenshot({ path: join(output, `inspector-${theme}-${width}.png`) });
        await tip.getByText('Source details', { exact: true }).click();
        assert.ok((await tip.locator('details').first().innerText()).includes(polishPods[reversed ? 2 : 0]));
        await tip.focus(); await tip.press('Escape');
        await tip.waitFor({ state: 'detached' });
        assert.equal(await plot.evaluate(el => el === document.activeElement), true);
        if (width === 390) {
          await plot.tap({ position: { x: 100, y: 80 } });
          await tip.getByRole('button', { name: 'Unpin observation', exact: true }).waitFor();
          await tip.getByRole('button', { name: 'Close observation', exact: true }).click();
          await tip.waitFor({ state: 'detached' });
        }
        return { timestampVisible: true, sourceExpandable: true, keyboardFocusRestored: true, emulatedTouch: width === 390 };
      });
      await check(`${label}: historical drilldown, range and browser Back`, async () => {
        const plot = tile('percentiles').getByRole('img', { name: 'Request latency', exact: true });
        await plot.focus(); for (let i = 0; i < 8; i++) await plot.press('ArrowRight');
        const tip = page.getByRole('tooltip');
        assert.equal(await tip.getByRole('button', { name: 'Inspect workload', exact: true }).count(), 0, 'Hover does not navigate');
        await plot.press('Enter');
        const observation = tip.locator('[data-observation-value]');
        const reading = await observation.getAttribute('data-observation-value');
        assert.ok(Number.isFinite(Number(reading)));
        const timestamp = Number(await observation.getAttribute('data-observation-timestamp'));
        const series = await observation.getAttribute('data-observation-series');
        const expected = polishQuery({ query: 'fixture_percentiles' }).series.find(item => item.name === series).points.find(point => point.timestamp === timestamp);
        assert.equal(Number(reading), expected.value, 'Navigation uses the exact historical observation');
        assert.ok(timestamp < Date.parse(polishRange.to), 'The selected observation is historical, not the latest value');
        await tip.getByRole('button', { name: 'Use sample for dashboard links', exact: true }).click();
        const selected = tile('percentiles').getByRole('status');
        assert.match(await selected.innerText(), /UTC/);
        await page.screenshot({ path: join(output, `selection-${theme}-${width}.png`) });
        const explore = tile('percentiles').getByRole('button', { name: 'Open related dashboard from Request latency', exact: true });
        assert.match(await explore.innerText(), /Explore/);
        await explore.click();
        const link = page.getByRole('menuitem', { name: /Inspect workload/ });
        assert.match(await link.innerText(), /Current time range/);
        await link.click();
        await page.getByRole('heading', { name: 'Workload detail', exact: true }).waitFor();
        await page.getByRole('img', { name: 'Latency for selected service', exact: true }).waitFor();
        const colours = await tile('detail-latency').getByRole('list', { name: 'Latest values by series' }).getByRole('listitem').evaluateAll(items => Object.fromEntries(items.map(item => [item.children[1].textContent.trim(), item.firstElementChild.style.background])));
        assert.deepEqual(colours, { p50: 'rgb(40, 103, 185)', p95: 'rgb(124, 88, 173)', p99: 'rgb(187, 80, 55)' }, 'Percentile identity keeps its colour across linked dashboards');
        assert.ok(environment.queryCalls.some(call => call.request?.query === 'fixture_percentiles{service="checkout-api"}' && call.request.start === Date.parse(polishRange.from) / 1000 && call.request.end === Date.parse(polishRange.to) / 1000), 'Destination query uses the carried service and exact range');
        const url = new URL(page.url());
        assert.deepEqual(JSON.parse(url.searchParams.get('vars')), { service: 'checkout-api', reading, pod: 'all' });
        assert.equal(url.searchParams.get('from'), polishRange.from);
        assert.equal(url.searchParams.get('to'), polishRange.to);
        assert.equal(await page.getByLabel('Selected reading', { exact: true }).inputValue(), reading);
        assert.deepEqual(await environment.api(`dashboards/${boards[1].id}`), targetBefore, 'Following a link never rewrites destination defaults');
        await page.screenshot({ path: join(output, `destination-${theme}-${width}.png`), fullPage: true });
        await page.goBack({ waitUntil: 'networkidle' }); await loaded();
        return { reading, range: polishRange, savedTargetUnchanged: true };
      });
      await check(`${label}: pinned workload action carries exact context and rejects missing samples`, async () => {
        const plot = tile('cpu').locator('svg[role="group"]');
        await plot.focus(); await plot.press('ArrowDown'); await plot.press('Enter');
        const tip = page.getByRole('region', { name: 'Observation details', exact: true });
        const action = tip.getByRole('button', { name: 'Inspect workload', exact: true });
        assert.equal(await action.isDisabled(), true, 'An unavailable observation cannot become a numeric drilldown');
        await tip.getByText('Selected signal has no finite value', { exact: true }).waitFor();
        await plot.press('ArrowUp');
        const reading = await tip.locator('[data-metric-value]').first().getAttribute('data-metric-value');
        assert.equal(await action.isEnabled(), true);
        await action.click();
        await page.getByRole('heading', { name: 'Workload detail', exact: true }).waitFor();
        const vars = JSON.parse(new URL(page.url()).searchParams.get('vars'));
        assert.deepEqual(vars, { pod: polishPods[reversed ? 2 : 0], service: 'checkout-api', reading });
        assert.equal(new URL(page.url()).searchParams.get('from'), polishRange.from);
        assert.deepEqual(await environment.api(`dashboards/${boards[1].id}`), targetBefore);
        await page.goBack({ waitUntil: 'networkidle' }); await loaded();
        return { exactReading: reading, pod: vars.pod, missingObservationDisabled: true };
      });
      await check(`${label}: single-row menus with pointer, touch and keyboard scrolling`, async () => {
        await page.getByRole('button', { name: 'Edit dashboard', exact: true }).click();
        await page.getByRole('button', { name: 'Edit Request latency', exact: true }).click();
        const editor = page.getByRole('region', { name: 'Widget editor', exact: true });
        const tabs = editor.getByRole('tablist', { name: 'Widget settings', exact: true });
        // At 390px all four labels fit. Exercise an actual overflowing touch strip too.
        if (width === 390) {
          await page.setViewportSize({ width: 320, height: 980 });
          await page.waitForFunction(() => {
            const list = document.querySelector('[role="tablist"][aria-label="Widget settings"]');
            return list.scrollWidth > list.clientWidth + 1;
          });
        }
        const query = tabs.getByRole('tab', { name: 'Style', exact: true });
        const source = tabs.getByRole('tab', { name: 'Layout', exact: true });
        const count = environment.queryCalls.length;
        const assertSelectedVisible = async () => {
          await page.waitForFunction(() => {
            const list = document.querySelector('[role="tablist"][aria-label="Widget settings"]');
            const selected = list.querySelector('[aria-selected="true"]').getBoundingClientRect();
            const bounds = list.getBoundingClientRect();
            return selected.left >= bounds.left + 3 && selected.right <= bounds.right - 3;
          });
        };
        const geometry = await tabs.getByRole('tab').evaluateAll(items => items.map(item => {
          const bounds = item.getBoundingClientRect();
          return { top: bounds.top, height: bounds.height, label: item.textContent, nowrap: getComputedStyle(item).whiteSpace === 'nowrap' };
        }));
        assert.equal(geometry.length, 4);
        assert.ok(geometry.every(tab => tab.top === geometry[0].top && tab.nowrap), 'All menu labels stay in one row');
        assert.equal(await editor.getByRole('button', { name: /^Scroll widget settings tabs/ }).count(), 0, 'Overflow uses native scrolling without arrow buttons');
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await query.focus(); await query.press('End'); await assertSelectedVisible();
        assert.equal(await source.getAttribute('aria-selected'), 'true');
        assert.equal(await source.evaluate(el => document.activeElement === el), true);
        assert.equal(await editor.getByRole('tabpanel', { name: 'Layout', exact: true }).isVisible(), true);
        await source.press('ArrowRight'); await assertSelectedVisible();
        assert.equal(await query.getAttribute('aria-selected'), 'true');
        await query.press('ArrowLeft'); await assertSelectedVisible();
        assert.equal(await source.getAttribute('aria-selected'), 'true');
        await source.press('Home'); await assertSelectedVisible();
        const overflowing = await tabs.evaluate(el => el.scrollWidth > el.clientWidth + 1);
        if (width === 390) assert.equal(overflowing, true, '320px stress view must exercise touch scrolling');
        if (overflowing) {
          if (width === 390) {
            assert.ok(geometry.every(tab => tab.height >= 44), 'Touch tabs retain 44px targets');
            const session = await context.newCDPSession(page);
            const bounds = await tabs.boundingBox();
            const x = bounds.x + bounds.width - 12, y = bounds.y + bounds.height / 2;
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
            for (let step = 1; step <= 5; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - step * 25, y }] });
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await session.detach();
          } else {
            await tabs.hover();
            await page.mouse.wheel(240, 0);
          }
          await page.waitForFunction(() => document.querySelector('[aria-label="Widget settings"][role="tablist"]').scrollLeft > 0);
          assert.equal(await query.getAttribute('aria-selected'), 'true', 'Scrolling the menu never changes the panel');
          await source.click(); await assertSelectedVisible();
          await page.screenshot({ path: join(output, `menu-${theme}-${width === 390 ? 320 : width}.png`) });
          await source.press('Home');
        } else {
          await query.press('Home');
        }
        await editor.getByRole('button', { name: 'Configure tooltips', exact: true }).click();
        await assertSelectedVisible();
        assert.equal(await tabs.getByRole('tab', { name: 'Tooltips', exact: true }).evaluate(el => el === document.activeElement), true);
        if (width === 390) {
          await page.setViewportSize({ width, height: 980 });
          await page.waitForFunction(() => {
            const list = document.querySelector('[role="tablist"][aria-label="Widget settings"]');
            return list.scrollWidth <= list.clientWidth + 1;
          });
          await assertSelectedVisible();
        }
        await page.waitForTimeout(450);
        assert.equal(environment.queryCalls.length, count, 'Navigating and scrolling tabs never issues provider queries');
        return { singleRow: true, overflowing, keyboardWraps: true, activeTabVisible: true, touchSwipe: width === 390, stressWidth: width === 390 ? 320 : undefined, navigationQueryCount: 0 };
      });
      await check(`${label}: appearance previews, undo, validation and durable save`, async () => {
        const before = await environment.api(`dashboards/${boards[0].id}`);
        const editor = page.getByRole('region', { name: 'Widget editor', exact: true });
        await editor.getByRole('tab', { name: 'Style', exact: true }).click();
        const count = environment.queryCalls.length;
        await editor.getByRole('button', { name: 'Clean line', exact: true }).focus();
        await page.keyboard.press('Enter');
        await editor.getByRole('button', { name: 'Soft area', exact: true }).click();
        assert.equal(await editor.getByRole('button', { name: 'Soft area', exact: true }).getAttribute('aria-pressed'), 'true');
        await tile('percentiles').locator('g.ts-chart__area path').first().waitFor();
        assert.ok(await tile('percentiles').locator('stop[stop-opacity="0.12"]').count() > 0, 'The preview renders the preset fill');
        assert.ok(await tile('percentiles').locator('path[stroke-width="2"]').count() >= 3, 'All three plotted series use the chosen line weight');
        await page.screenshot({ path: join(output, `editor-${theme}-${width}.png`) });
        const line = editor.getByLabel('Line width', { exact: true });
        await line.fill('99');
        await editor.getByRole('alert').waitFor();
        assert.equal(await editor.getByRole('button', { name: 'Apply changes', exact: true }).isDisabled(), true);
        assert.equal(await line.inputValue(), '99', 'Invalid input remains available for correction');
        await line.fill('2');
        await editor.getByRole('button', { name: 'Apply changes', exact: true }).click();
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        assert.equal(await tile('percentiles').locator('g.ts-chart__area path').count(), 0, 'Undo restores the original line rendering');
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await tile('percentiles').locator('g.ts-chart__area path').first().waitFor();
        assert.equal((await environment.api(`dashboards/${boards[0].id}`)).etag, before.etag, 'Preview is not a durable write');
        await page.waitForTimeout(450); // Longer than the query-edit debounce: presentation must remain request-free.
        assert.equal(environment.queryCalls.length, count, 'Appearance controls issue no provider queries');
        const styleQueryCount = environment.queryCalls.length - count;
        await applyWidgetChanges(page);
        await page.getByRole('button', { name: 'Save dashboard', exact: true }).click();
        await page.getByText('All changes saved', { exact: true }).waitFor();
        const saved = await environment.api(`dashboards/${boards[0].id}`);
        const original = before.document.widgets.find(w => w.id === 'percentiles'), changed = saved.document.widgets.find(w => w.id === 'percentiles');
        assert.equal(changed.options.display, 'area');
        assert.equal(changed.options.lineWidth, 2);
        assert.deepEqual(changed.options.seriesColors, original.options.seriesColors);
        assert.equal(changed.query, original.query); assert.equal(changed.providerId, original.providerId);
        assert.deepEqual(changed.drilldowns, original.drilldowns); assert.deepEqual(changed.layout, original.layout);
        await page.reload({ waitUntil: 'networkidle' }); await loaded();
        await tile('percentiles').locator('g.ts-chart__area path').first().waitFor();
        await page.screenshot({ path: join(output, `styled-${theme}-${width}.png`), fullPage: true });
        return { styleQueryCount, savedWithETag: saved.etag !== before.etag, display: changed.options.display };
      });
      await context.close();
    }
    await check('Saved appearance survives a service restart and a different service still renders its own values', async () => {
      const saved = await environment.api(`dashboards/${boards[0].id}`);
      await environment.restart();
      assert.deepEqual((await environment.api(`dashboards/${boards[0].id}`)).document, saved.document);
      assert.deepEqual((await environment.api(`dashboards/${boards[1].id}`)).document, targetBefore.document);
      const context = await browser.newContext({ viewport: { width: 1512, height: 980 }, reducedMotion: 'reduce' });
      page = await context.newPage();
      await environment.installQueryFixture(page, polishQuery);
      await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${boards[1].id}`, { waitUntil: 'networkidle' });
      const plot = page.getByRole('img', { name: 'Latency for selected service', exact: true });
      await plot.focus(); await plot.press('Enter');
      const observation = page.getByRole('tooltip').locator('[data-observation-value]');
      const name = await observation.getAttribute('data-observation-series'), timestamp = Number(await observation.getAttribute('data-observation-timestamp'));
      const request = environment.queryCalls.at(-1).request;
      assert.equal(request.query, 'fixture_percentiles{service="payments-worker"}');
      const expected = polishQuery(request).series.find(series => series.name === name).points.find(point => point.timestamp === timestamp).value;
      assert.equal(Number(await observation.getAttribute('data-observation-value')), expected);
      await page.screenshot({ path: join(output, 'independent-service.png') });
      await context.close();
      return { persistedAcrossRestart: true, targetDefaultsPreserved: true, independentService: 'payments-worker', exactValue: expected };
    });
    assert.deepEqual(errors, []); assert.deepEqual(environment.failures, []);
  }
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  if (!review) await writeFile(join(output, 'report.json'), JSON.stringify({ reports, pageErrors: errors, fixtureErrors: environment?.failures ?? [] }, null, 2));
  await browser?.close(); await environment?.close();
}
