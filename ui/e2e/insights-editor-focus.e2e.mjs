import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { installChartSystemFixture } from './fixtures/chart-system.mjs';
import { polishDashboards, polishQuery } from './fixtures/dashboard-polish.mjs';
import { activateDashboardAction, selectGammaOption } from './gamma-controls.mjs';

const base = process.env.INSIGHTS_E2E_URL || 'http://127.0.0.1:3015';
const output = resolve('../artifacts/insights/editor-focus');
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const reports = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [1512, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1050 }, reducedMotion: 'reduce', ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage(); page.setDefaultTimeout(10_000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(theme => localStorage.setItem('paprika-insights-theme', theme), theme);
    try {
      const fixture = await installChartSystemFixture(page, base);
      const board = polishDashboards('example-prometheus')[0];
      fixture.documents.set(board.id, board);
      let queries = 0;
      await page.route(`${base}/api/insights/query`, async route => {
        const request = route.request().postDataJSON();
        if (!request.query.startsWith('fixture_')) return route.fallback();
        queries++;
        await route.fulfill({ json: polishQuery(request) });
      });
      await page.goto(`${base}/dashboard/insights/?dashboard=${board.id}`);
      await page.getByRole("heading", { name: board.title, exact: true }).waitFor();
      const edit = async title => {
        if (await page.getByRole('button', { name: 'Edit dashboard', exact: true }).isVisible()) await activateDashboardAction(page, 'Edit dashboard');
        await page.getByRole('button', { name: `Edit ${title}`, exact: true }).click();
        await page.getByRole('region', { name: 'Widget editor', exact: true }).waitFor();
      };
      await activateDashboardAction(page, 'Edit dashboard');
      const chart = page.locator('[data-widget-id="percentiles"]');
      await chart.scrollIntoViewIfNeeded();
      await chart.locator('svg').first().waitFor();
      await page.waitForTimeout(450);
      const checkIdleRetention = theme === 'light' && width === 1512;
      // Let the scheduler's five-second cache expire. Focus must retain the
      // completed request independently when automatic refresh is disabled.
      if (checkIdleRetention) await page.waitForTimeout(5_500);
      const beforeQueries = queries;
      await edit('Request latency');
      const editor = page.getByRole('region', { name: 'Widget editor', exact: true });
      const history = async name => {
        const button = editor.getByRole('button', { name, exact: true });
        if (await button.isVisible()) await button.click();
        else {
          await editor.getByRole('button', { name: 'Chart actions', exact: true }).click();
          await page.getByRole('menuitem', { name, exact: true }).click();
        }
      };
      await editor.getByRole('heading', { name: 'Request latency', exact: true, level: 2 }).waitFor();
      assert.equal(await page.locator('[data-widget-id]').count(), 1, 'Only the selected chart is mounted');
      assert.equal(await page.getByRole('complementary', { name: 'Insights navigation' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Save dashboard', exact: true }).isVisible(), false);
      const plotHeight = await chart.locator('[data-chart-footer]').evaluate(footer => footer.previousElementSibling.getBoundingClientRect().height);
      assert.ok(plotHeight >= 130, `Focused plots retain useful height: ${plotHeight}px`);
      await page.screenshot({ path: resolve(output, `${theme}-${width}-focused.png`) });
      if (width <= 950) {
        const sections = editor.getByRole('navigation', { name: 'Chart editor sections', exact: true });
        await sections.getByRole('button', { name: 'Query', exact: true }).click();
        assert.equal(await editor.getByRole('region', { name: 'Chart data', exact: true }).evaluate(element => element === document.activeElement), true);
        const bounds = await editor.getByRole('tablist', { name: 'Chart data', exact: true }).boundingBox();
        assert.ok(bounds.y > 0 && bounds.y + bounds.height < 1050, 'Query navigation reveals its controls below the sticky header');
        await page.screenshot({ path: resolve(output, `${theme}-${width}-query.png`) });
        await sections.getByRole('button', { name: 'Settings', exact: true }).click();
        assert.equal(await editor.getByRole('complementary', { name: 'Chart settings', exact: true }).evaluate(element => element === document.activeElement), true);
      }
      const original = structuredClone(fixture.documents.get(board.id));
      await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Latency preview');
      await chart.getByRole('heading', { name: 'Latency preview', exact: true }).waitFor();
      await editor.getByRole('button', { name: 'Soft area', exact: true }).click();
      await page.waitForTimeout(400);
      assert.equal(queries, beforeQueries, 'Entering focus and presentation changes reuse loaded data');
      assert.deepEqual(fixture.documents.get(board.id), original, 'Preview is not persisted');
      await history('Undo chart change');
      assert.equal(await editor.getByRole('button', { name: 'Soft area', exact: true }).getAttribute('aria-pressed'), 'false');
      await history('Redo chart change');
      assert.equal(await editor.getByRole('button', { name: 'Soft area', exact: true }).getAttribute('aria-pressed'), 'true');
      // Invalid drafts remain editable and cannot replace the visible chart.
      await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('');
      assert.equal(await editor.getByRole('button', { name: 'Apply changes', exact: true }).isDisabled(), true);
      await chart.getByRole('heading', { name: 'Latency preview', exact: true }).waitFor();
      await history('Undo chart change');
      // A nested listbox owns Escape before the workbench does.
      await editor.getByRole('combobox', { name: 'Visualization', exact: true }).click();
      await page.keyboard.press('Escape');
      assert.equal(await editor.isVisible(), true);
      assert.equal(await page.getByRole('alertdialog').isVisible(), false);
      await editor.getByRole('button', { name: 'Back to dashboard', exact: true }).click();
      await page.getByRole('alertdialog', { name: 'Discard chart changes?' }).waitFor();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      if (checkIdleRetention) await page.waitForTimeout(5_500);
      await editor.getByRole('button', { name: 'Discard', exact: true }).click();
      await page.getByRole('button', { name: 'Edit Request latency', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Edit Request latency', exact: true }).evaluate(element => element === document.activeElement), true, 'Return focus to the chart edit button');
      assert.equal(await page.locator('[data-widget-id]').count(), board.widgets.length);
      await chart.getByRole('heading', { name: 'Request latency', exact: true }).waitFor();
      if (checkIdleRetention) {
        await page.waitForTimeout(450);
        assert.equal(queries, beforeQueries, 'Leaving focus after the scheduler cache expires reuses all unchanged chart results');
      }
      // Applying is one dashboard history entry; saving is the separate durable action.
      await edit('Request latency');
      await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Latency applied');
      await editor.getByRole('button', { name: 'Apply changes', exact: true }).click();
      await chart.getByRole('heading', { name: 'Latency applied', exact: true }).waitFor();
      assert.deepEqual(fixture.documents.get(board.id), original);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await chart.getByRole('heading', { name: 'Request latency', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Redo', exact: true }).click();
      await page.getByRole('button', { name: 'Save dashboard', exact: true }).click();
      await page.getByText('All changes saved', { exact: true }).waitFor();
      assert.equal(fixture.documents.get(board.id).widgets.find(item => item.id === 'percentiles').title, 'Latency applied');
      await page.reload();
      await chart.getByRole('heading', { name: 'Latency applied', exact: true }).waitFor();
      await edit('Latency applied');
      await editor.getByRole('tab', { name: 'Tooltips', exact: true }).click();
      await editor.getByRole('button', { name: 'Apply changes', exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      const settings = await editor.getByRole('tablist', { name: 'Widget settings', exact: true }).evaluate(list => [...list.children].map(item => item.getBoundingClientRect().top));
      assert.ok(Math.max(...settings) - Math.min(...settings) < 2, 'Settings remain a single scrollable row');
      await page.screenshot({ path: resolve(output, `${theme}-${width}-tooltips.png`) });
      if (width <= 950) {
        await editor.getByRole('navigation', { name: 'Chart editor sections' }).getByRole('button', { name: 'Query', exact: true }).click();
        const request = page.waitForRequest(request => request.url().endsWith('/api/insights/query') && request.postDataJSON()?.query === 'fixture_p95{service="checkout-api"}');
        await editor.getByRole('textbox', { name: 'PromQL query', exact: true }).fill('fixture_p95{service="checkout-api"}');
        await request;
      }
      await editor.getByRole('button', { name: 'Discard', exact: true }).click();
      if (theme === 'light' && width === 1512) {
        await edit('Latency applied');
        await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Keep this chart draft');
        await editor.getByRole('tab', { name: 'Tooltips', exact: true }).click();
        await editor.getByRole('button', { name: 'Use saved query', exact: true }).click();
        await editor.getByRole('button', { name: 'Manage saved queries', exact: true }).click();
        const explorer = page.getByRole('region', { name: 'Data source explorer', exact: true }).first();
        await explorer.waitFor();
        const navigation = page.getByRole('complementary', { name: 'Insights navigation' });
        for (const destination of [/^Examples\b/, /^Data sources\b/, /^Dashboard as code$/, /^New dashboard$/]) {
          await navigation.getByRole('button', { name: destination }).click();
          const confirmation = page.getByRole('alertdialog', { name: /Discard (?:chart|unsaved) changes\?/ });
          await confirmation.waitFor();
          await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
          assert.equal(await explorer.isVisible(), true, `Cancelling ${destination} keeps Explore and its underlying chart draft`);
        }
        await explorer.getByRole('button', { name: 'Dashboard', exact: true }).click();
        assert.equal(await editor.getByRole('textbox', { name: 'Title', exact: true }).inputValue(), 'Keep this chart draft');
        await history('Undo chart change');
        assert.equal(await editor.getByRole('button', { name: 'Use saved query', exact: true }).isVisible(), true, 'Returning from Explore preserves chart undo history');
        await editor.getByRole('button', { name: 'Discard', exact: true }).click();
        await edit('Latency applied');
        await editor.getByRole('textbox', { name: 'Title', exact: true }).fill('Copy draft');
        await editor.getByRole('tab', { name: 'Layout', exact: true }).click();
        await selectGammaOption(page, editor.getByRole('combobox', { name: 'Width', exact: true }), '8 columns');
        await editor.getByRole('button', { name: 'Chart actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Duplicate chart', exact: true }).click();
        await editor.getByRole('heading', { name: 'Copy draft (copy)', exact: true, level: 2 }).waitFor();
        await editor.getByRole('tab', { name: 'Source', exact: true }).click();
        const copy = JSON.parse(await editor.getByRole('textbox', { name: 'Widget JSON', exact: true }).inputValue());
        assert.equal(copy.layout.w, 8, 'Duplicate uses the valid staged dimensions');
        await editor.getByRole('button', { name: 'Apply changes', exact: true }).click();
        assert.equal(await page.locator('[data-widget-id]').count(), board.widgets.length + 1);
        await edit('Copy draft (copy)');
        await editor.getByRole('button', { name: 'Chart actions', exact: true }).click();
        await page.getByRole('menuitem', { name: 'Remove chart', exact: true }).click();
        assert.equal(await page.locator('[data-widget-id]').count(), board.widgets.length);
        assert.equal(await page.evaluate(() => document.activeElement !== document.body), true, 'Removing a chart restores useful dashboard focus');
        await chart.getByRole('heading', { name: 'Latency applied', exact: true }).waitFor();
        await page.getByRole('button', { name: 'Undo', exact: true }).click();
        await page.getByRole('heading', { name: 'Copy draft (copy)', exact: true }).waitFor();
        assert.equal(await page.locator('[data-widget-id]').count(), board.widgets.length + 1);
        await page.getByRole('button', { name: 'Redo', exact: true }).click();
        await edit('Latency applied');
        await selectGammaOption(page, editor.getByRole('combobox', { name: 'Visualization', exact: true }), /^Threshold gauge/);
        await editor.getByRole('tab', { name: 'Options', exact: true }).click();
        await history('Undo chart change');
        await editor.getByRole('button', { name: 'Clean line', exact: true }).waitFor();
        assert.equal(await editor.getByRole('tab', { name: 'Style', exact: true }).getAttribute('aria-selected'), 'true');
        await history('Redo chart change');
        await editor.getByLabel('Meter label', { exact: true }).waitFor();
        await editor.getByRole('button', { name: 'Discard', exact: true }).click();
      }
      // Canonical previews also handle the map, honeycomb and record table.
      await page.goto(`${base}/dashboard/insights/?dashboard=${fixture.dashboard.id}`);
      await page.getByRole("heading", { name: fixture.dashboard.title, exact: true }).waitFor();
      await activateDashboardAction(page, 'Edit dashboard');
      for (const id of ['hex-map', 'honeycomb', 'records']) {
        const widget = fixture.dashboard.widgets.find(item => item.id === id);
        await edit(widget.title);
        const preview = page.locator(`[data-widget-id="${id}"]`);
        await preview.locator('[data-geo-cell],table').first().waitFor();
        await editor.getByRole('tab', { name: 'Options', exact: true }).click();
        assert.equal(await page.locator('[data-widget-id]').count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.screenshot({ path: resolve(output, `${theme}-${width}-${id}.png`) });
        await editor.getByRole('button', { name: 'Discard', exact: true }).click();
      }
      assert.deepEqual(errors, []); assert.deepEqual(fixture.failures, []);
      reports.push({ theme, width, passed: true, queryFreeFocus: true, stagedApplyDiscard: true, invalidDraftUndoRedo: true, focusReturn: true, saveReload: true, families: ['time series', 'map', 'honeycomb', 'table'] });
      console.log(`PASS focused editor ${theme} ${width}: preview, draft lifecycle, keyboard, persistence and four chart families`);
    } catch (error) {
      await page.screenshot({ path: resolve(output, `failure-${theme}-${width}.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(reports, null, 2)); }
