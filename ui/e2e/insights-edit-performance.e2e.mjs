import { applyWidgetChanges } from "./gamma-controls.mjs";
// Run against a production export, without other browser suites in parallel.
// Timings are diagnostic (machine dependent); lifecycle/query/motion checks gate CI.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { installChartSystemFixture } from './fixtures/chart-system.mjs';

const base = process.env.INSIGHTS_E2E_URL || 'http://127.0.0.1:3015';
const output = resolve(process.env.INSIGHTS_PERF_OUTPUT || '../artifacts/insights/edit-performance');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const reports = [];
const percentile = (values, fraction) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * fraction))] ?? 0;
try {
  for (const motion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ viewport: { width: 1592, height: 988 }, reducedMotion: motion });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(() => { localStorage.setItem('paprika-insights-theme', 'dark'); localStorage.setItem('paprika-insights-compact-view', 'true'); });
    try {
      const fixture = await installChartSystemFixture(page, base);
      for (let index = 0; index < 8; index++) fixture.dashboard.widgets.push({ id: `series-${index}`, title: `Service ${index + 1}`, type: 'timeseries', providerId: 'example-prometheus', query: 'chart-performance-series', unit: 'ms', layout: { x: index % 2 * 6, y: 10 + Math.floor(index / 2) * 4, w: 6, h: 4 }, options: { showLegend: true } });
      await page.route(`${new URL(base).origin}/api/insights/query`, async route => {
        const query = route.request().postDataJSON();
        if (query.query !== 'chart-performance-series') return route.fallback();
        fixture.calls.push({ method: 'POST', path: '/query' });
        await route.fulfill({ json: { series: Array.from({ length: 8 }, (_, series) => ({ name: `instance ${series + 1}`, labels: { instance: String(series + 1) }, points: Array.from({ length: 2000 }, (_, index) => ({ timestamp: (query.start + (query.end - query.start) * index / 1999) * 1000, value: index % 101 === 0 ? null : 20 + series * 5 + 10 * Math.sin(index / 29) })) })) } });
      });
      await page.goto(`${base}/dashboard/insights/?dashboard=${fixture.dashboard.id}`);
      for (const widget of fixture.dashboard.widgets) {
        const tile = page.locator(`[data-widget-id="${widget.id}"]`);
        await tile.scrollIntoViewIfNeeded();
        await tile.locator('[data-geo-cell],table,[data-map-plane],[data-series-count="8"]').first().waitFor();
      }
      await page.getByRole('button', { name: 'Edit dashboard', exact: true }).scrollIntoViewIfNeeded();
      await page.evaluate(() => {
        window.__editProfile = { transitions: 0, longTasks: [], running: false, frames: [], inputFrames: [], reparentedCharts: 0 };
        new MutationObserver(records => {
          if (!window.__editProfile.running) return;
          for (const record of records) for (const node of record.removedNodes)
            if (node instanceof Element && (node.matches('[data-widget-id]') || node.querySelector('[data-widget-id]'))) window.__editProfile.reparentedCharts++;
        }).observe(document.querySelector('[data-testid="dashboard-canvas"]'), { childList: true, subtree: true });
        document.addEventListener('transitionrun', event => {
          if (event.target.closest('[data-testid="dashboard-canvas"]')) window.__editProfile.transitions++;
        });
        new PerformanceObserver(list => { if (window.__editProfile.running) window.__editProfile.longTasks.push(...list.getEntries().map(entry => entry.duration)); }).observe({ type: 'longtask' });
      });
      const started = performance.now();
      await page.getByRole('button', { name: 'Edit dashboard', exact: true }).click();
      await page.locator('.insights-drag-handle').first().waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const editMs = performance.now() - started;
      const cdp = await context.newCDPSession(page); await cdp.send('Performance.enable');
      const runs = [];
      for (let run = 0; run < 3; run++) {
        const handle = page.locator('[data-widget-id="hex-map"] .insights-drag-handle');
        await handle.scrollIntoViewIfNeeded();
        await page.locator('[data-widget-id="hex-map"]').focus();
        const box = await handle.boundingBox(), x = box.x + box.width / 2, y = box.y + box.height / 2;
        const placement = () => handle.evaluate(element => element.closest('.react-grid-item').style.transform);
        const initialPlacement = await placement();
        await page.mouse.move(x, y);
        await page.evaluate(() => {
          const p = window.__editProfile; p.running = true; p.frames = []; p.inputFrames = []; p.longTasks = []; p.reparentedCharts = 0;
          let last;
          const tick = now => { if (!p.running) return; if (last) p.frames.push(now - last); last = now; requestAnimationFrame(tick); }; requestAnimationFrame(tick);
          p.pointer = () => { const at = performance.now(); requestAnimationFrame(() => p.inputFrames.push(performance.now() - at)); };
          document.addEventListener('pointermove', p.pointer);
        });
        const queries = fixture.calls.filter(call => call.path === '/query').length;
        const before = await cdp.send('Performance.getMetrics');
        await page.mouse.down();
        assert.equal(await page.evaluate(() => document.body.classList.contains('react-draggable-transparent-selection') || !!document.getElementById('react-draggable-style-el')), false, 'Native handle selection must not restyle the page');
        for (let step = 1; step <= 60; step++) {
          const progress = Math.sin(step / 60 * Math.PI / 2);
          await page.mouse.move(x + (run % 2 ? -1 : 1) * progress * 150, y + progress * 110);
          if (step === 30) {
            assert.equal(await page.locator('[data-layout-interacting="true"]').count(), 1);
            assert.equal(await page.locator('.react-draggable-dragging').count(), 1, 'The benchmark is actually dragging a tile');
            assert.equal(await page.getByRole('tooltip').count(), 0, 'Moving charts never opens hover inspectors');
          }
        }
        await page.mouse.up();
        await page.locator('[data-layout-interacting]').waitFor({ state: 'detached' });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const after = await cdp.send('Performance.getMetrics');
        const measured = await page.evaluate(() => { const p = window.__editProfile; p.running = false; document.removeEventListener('pointermove', p.pointer); return { frames: p.frames, inputFrames: p.inputFrames, longTasks: p.longTasks, reparentedCharts: p.reparentedCharts }; });
        assert.notEqual(await placement(), initialPlacement, 'The drop commits a changed layout');
        assert.equal(measured.reparentedCharts, 0, 'Dropping never detaches/reinserts a loaded chart subtree');
        assert.equal(await page.locator('[data-widget-id="hex-map"]').evaluate(node => document.activeElement === node), true, 'The edited panel retains keyboard focus');
        assert.equal(await page.evaluate(() => window.getSelection()?.toString()), '', 'Dragging handles never selects chart text');
        assert.equal(fixture.calls.filter(call => call.path === '/query').length, queries, 'Dragging never refetches warmed data');
        const delta = name => 1000 * (after.metrics.find(metric => metric.name === name).value - before.metrics.find(metric => metric.name === name).value);
        runs.push({ frameP95Ms: percentile(measured.frames, .95), frameMaxMs: Math.max(...measured.frames), inputToAnimationFrameP95Ms: percentile(measured.inputFrames, .95), longTasks: measured.longTasks, scriptMs: delta('ScriptDuration'), styleMs: delta('RecalcStyleDuration'), layoutMs: delta('LayoutDuration') });
      }
      // Resize through the real handle, release outside the original panel, then
      // inspect and save the resulting document. Movement-only optimizations
      // must not suppress a changed size or leave the gesture guard behind.
      const resized = page.locator('[data-widget-id="hex-map"]');
      const resizeHandle = resized.locator('..').locator('.react-resizable-handle');
      await resizeHandle.scrollIntoViewIfNeeded();
      const originalSize = await resized.boundingBox(), grip = await resizeHandle.boundingBox();
      const resizeQueries = fixture.calls.filter(call => call.path === '/query').length;
      await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
      await page.mouse.down();
      await page.mouse.move(grip.x + 115, grip.y + 90, { steps: 30 });
      assert.equal(await page.locator('[data-layout-resizing]').count(), 1);
      await page.mouse.up();
      await page.locator('[data-layout-interacting]').waitFor({ state: 'detached' });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.waitForFunction(() => {
        const grid = document.querySelector('[data-widget-id="hex-map"]').closest('.react-grid-item'), box = grid.getBoundingClientRect();
        return Math.abs(box.width - parseFloat(grid.style.width)) < .5 && Math.abs(box.height - parseFloat(grid.style.height)) < .5;
      });
      const resizedSize = await resized.boundingBox();
      assert.ok(resizedSize.width > originalSize.width + 30 && resizedSize.height > originalSize.height + 30, 'Both dimensions commit after a real resize');
      assert.equal(fixture.calls.filter(call => call.path === '/query').length, resizeQueries, 'Resizing retains loaded observations');
      assert.equal(await page.locator('[data-layout-resizing]').count(), 0);
      assert.equal(await page.evaluate(() => document.body.classList.contains('react-draggable-transparent-selection') || !!document.getElementById('react-draggable-style-el')), false);
      const transitions = await page.evaluate(() => window.__editProfile.transitions);
      if (motion === 'reduce') assert.equal(transitions, 0, 'Reduced motion must not create transition storms');
      await page.screenshot({ path: resolve(output, `edited-${motion}.png`), fullPage: true });
      await page.locator('[data-widget-id="hex-map"]').getByRole('button', { name: /Sum of value/ }).first().click();
      await page.getByRole('tooltip').waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      await applyWidgetChanges(page);
      await page.getByRole('button', { name: 'Save dashboard', exact: true }).click();
      await page.getByRole('button', { name: 'Edit dashboard', exact: true }).waitFor();
      const saved = fixture.documents.get(fixture.dashboard.id).widgets.find(widget => widget.id === 'hex-map').layout;
      assert.ok(saved.w > 6 && saved.h > 5, 'The resized geometry reaches persistence');
      await page.reload();
      await page.getByRole('button', { name: 'Edit dashboard', exact: true }).click();
      await resized.locator('[data-geo-cell]').first().waitFor();
      await page.waitForFunction(expected => {
        const box = document.querySelector('[data-widget-id="hex-map"]').getBoundingClientRect();
        return Math.abs(box.width - expected.width) < 1 && Math.abs(box.height - expected.height) < 1;
      }, resizedSize);
      const restored = await resized.boundingBox();
      assert.ok(Math.abs(restored.width - resizedSize.width) < 1 && Math.abs(restored.height - resizedSize.height) < 1, 'Reload restores the saved size');
      await page.waitForLoadState('networkidle');
      const focusQueries = fixture.calls.filter(call => call.path === '/query').length;
      const focusStarted = performance.now();
      await resized.getByRole('button', { name: 'Edit Requests by location', exact: true }).click();
      const editor = page.getByRole('region', { name: 'Widget editor', exact: true });
      await editor.waitFor();
      await resized.locator('[data-geo-cell]').first().waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const focusedEditorMs = performance.now() - focusStarted;
      assert.equal(await page.locator('[data-widget-id]').count(), 1, 'Heavy-dashboard editing mounts only the selected chart');
      assert.equal(fixture.calls.filter(call => call.path === '/query').length, focusQueries, 'Opening the focused editor retains loaded observations');
      await page.screenshot({ path: resolve(output, `focused-${motion}.png`) });
      await editor.getByRole('button', { name: 'Discard', exact: true }).click();
      await editor.waitFor({ state: 'hidden' });
      assert.equal(await page.locator('[data-widget-id]').count(), 12, 'Leaving the focused editor restores the full heavy dashboard');
      assert.deepEqual(errors, []); assert.deepEqual(fixture.failures, []);
      const report = { browser: browser.version(), motion, viewport: [1592, 988], panels: 12, recordsPerMap: 500, seriesPerPlot: 8, rawSamplesPerSeries: 2000, editMs, focusedEditorMs, transitions, runs, queryRequestsDuringDrags: 0, queryRequestsEnteringFocus: 0, resizeAndReload: true, pageSelectionMutation: false, reparentedCharts: 0, focusRetained: true };
      reports.push(report); console.log(JSON.stringify(report));
    } finally { await context.close(); }
  }
} finally { await browser.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(reports, null, 2)); }
