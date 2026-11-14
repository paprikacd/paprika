import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { installChartSystemFixture } from './fixtures/chart-system.mjs';
import { activateDashboardAction } from './gamma-controls.mjs';

const base = process.env.INSIGHTS_E2E_URL || 'http://127.0.0.1:3015';
const output = resolve('../artifacts/insights/chart-system');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const reports = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [1512, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1050 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(theme => { localStorage.setItem('paprika-insights-theme', theme); localStorage.setItem('paprika-insights-compact-view', 'true'); }, theme);
    try {
      const fixture = await installChartSystemFixture(page, base);
      await page.goto(`${base}/dashboard/insights/?dashboard=${fixture.dashboard.id}`);
      if (width === 390) await page.locator('[data-testid="dashboard-canvas"][data-layout-mode="stacked"]').waitFor();
      for (const mode of ['view', 'edit']) {
        if (mode === 'edit') await activateDashboardAction(page, 'Edit dashboard');
        for (const id of ['hex-map', 'honeycomb', 'records', 'markers']) {
          const tile = page.locator(`[data-widget-id="${id}"]`);
          await tile.scrollIntoViewIfNeeded();
          await tile.locator('[data-geo-cell],table,[data-map-plane]').first().waitFor();
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          if (id === 'hex-map' || id === 'markers') {
            const geometry = await tile.locator('[data-map-plane]').evaluate(plane => {
              const box = plane.getBoundingClientRect(), host = plane.parentElement, bounds = host.getBoundingClientRect();
              return { ratio: box.width / box.height, height: box.height, inside: box.top >= bounds.top && box.bottom <= bounds.bottom + 1 && box.left >= bounds.left && box.right <= bounds.right + 1, scroll: host.scrollHeight > host.clientHeight + 1 || host.scrollWidth > host.clientWidth + 1 };
            });
            assert.ok(geometry.inside && !geometry.scroll && geometry.height > 75 && Math.abs(geometry.ratio - 2) < .02, JSON.stringify({ id, geometry }));
          }
          if (id === 'honeycomb') {
            assert.equal(await tile.locator('[data-geo-cell]').count(), 500);
            assert.match(await tile.locator('[data-geo-cell][data-missing]').evaluate(cell => getComputedStyle(cell).backgroundImage), /gradient/, 'Missing observations retain the shared hatch');
            const bounds = await tile.locator('[data-geo-plane="grid"]').evaluate(plane => {
              const host = plane.parentElement, box = plane.getBoundingClientRect();
              return { scroll: host.scrollHeight > host.clientHeight + 1 || host.scrollWidth > host.clientWidth + 1, contained: [...plane.querySelectorAll('[data-geo-cell]')].every(cell => { const c = cell.getBoundingClientRect(); return c.left >= box.left - 1 && c.right <= box.right + 1 && c.top >= box.top - 1 && c.bottom <= box.bottom + 1; }), target: plane.querySelector('button').getBoundingClientRect().width };
            });
            assert.ok(bounds.contained, 'Every honeycomb record fits its plane');
            if (width > 700) assert.equal(bounds.scroll, false, 'Desktop honeycomb fits all records');
            else { assert.ok(bounds.target >= 44); assert.ok(await tile.getByText('Scroll to explore all records').isVisible()); }
          }
          if (id === 'records') {
            assert.ok((await tile.boundingBox()).height >= 240, 'Short tables retain their own reading height, independent of neighbouring maps');
            const typography = await tile.locator('tbody td').first().evaluate(cell => ({ fontSize: parseFloat(getComputedStyle(cell).fontSize), rowHeight: cell.parentElement.getBoundingClientRect().height }));
            assert.ok(typography.fontSize >= 12 && typography.rowHeight >= (width === 390 ? 44 : 24), JSON.stringify(typography));
            await tile.getByRole('button', { name: 'Next', exact: true }).click();
            await tile.getByText('Page 2 of 100').waitFor();
            await tile.getByRole('button', { name: 'Previous', exact: true }).click();
          }
          await page.mouse.move(1, 1);
          await tile.screenshot({ path: resolve(output, `${theme}-${width}-${mode}-${id}.png`), animations: 'disabled' });
        }
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        reports.push({ theme, width, mode, families: ['hex-map', 'honeycomb', 'record-table', 'connection-map'], passed: true });
      }
      const honeycomb = page.locator('[data-widget-id="honeycomb"]');
      if (width === 390) {
        // Both ends must be reachable by touch, including an overflowing plane's
        // first column (centering it would leave that column outside the scroller).
        for (const label of ['Location 001', 'Location 500']) {
          const cell = honeycomb.getByRole('button', { name: new RegExp(`^${label} ·`) });
          await cell.scrollIntoViewIfNeeded();
          await cell.tap();
          await page.getByRole('tooltip').getByText(label, { exact: true }).first().waitFor();
          await page.keyboard.press('Escape');
          await page.getByRole('tooltip').waitFor({ state: 'hidden' });
        }
      }
      const missing = honeycomb.getByRole('button', { name: /^Location 002 ·/ });
      await missing.focus(); await missing.press('Enter');
      await page.getByRole('tooltip').getByText('No complete value', { exact: true }).waitFor();
      await page.screenshot({ path: resolve(output, `${theme}-${width}-missing-inspector.png`) });
      await page.keyboard.press('Escape');
      await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []); assert.deepEqual(fixture.failures, []);
      console.log(`PASS ${theme} ${width}: all four families, view/edit, map bounds, 500 hexes, table paging and missing-value inspection`);
    } catch (error) {
      await page.screenshot({ path: resolve(output, `failure-${theme}-${width}.png`), fullPage: true }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(reports, null, 2)); }
