// Observe every visible frame, including the loading/result transition. Settled
// screenshots cannot detect an inspector painting at its old size or position.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { installChartSystemFixture } from './fixtures/chart-system.mjs';

const base = process.env.INSIGHTS_E2E_URL || 'http://127.0.0.1:3015';
const output = resolve(process.env.INSIGHTS_MOTION_OUTPUT || '../artifacts/insights/tooltip-motion');
await mkdir(output, { recursive: true });
const browser = await chromium.launch(), reports = [], mapReports = [];
try {
  for (const theme of ['light', 'dark']) for (const height of [1050, 2034]) {
    const context = await browser.newContext({ viewport: { width: 1512, height } });
    const page = await context.newPage(), errors = [];
    let queryGate = Promise.resolve(), releaseQuery = () => {};
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(theme => {
      localStorage.setItem('paprika-insights-theme', theme);
      window.__tooltipFrames = [];
      window.__recordTooltip = false;
      const sample = () => {
        if (window.__recordTooltip) for (const node of document.querySelectorAll('[role="tooltip"]')) {
          if (getComputedStyle(node).visibility !== 'visible') continue;
          const box = node.getBoundingClientRect();
          window.__tooltipFrames.push({ left: box.left, right: box.right, top: box.top, bottom: box.bottom,
            height: box.height, placement: node.dataset.placement, pointer: node.dataset.tooltipPointer,
            loaded: !!node.querySelector('[data-tooltip-widget="stat"] [data-metric-value]') });
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, theme);
    try {
      const fixture = await installChartSystemFixture(page, base);
      const markers = structuredClone(fixture.dashboard.widgets.find(widget => widget.id === 'markers'));
      const host = structuredClone(fixture.dashboard.widgets.find(widget => widget.id === 'honeycomb'));
      const spacer = structuredClone(fixture.dashboard.widgets.find(widget => widget.id === 'records'));
      spacer.layout = { x: 0, y: 0, w: 12, h: 12 };
      host.layout = { x: 0, y: 12, w: 12, h: 12 };
      host.options.tooltipView = { type: 'stat', source: { type: 'query', providerId: 'example-prometheus', query: 'tooltip_motion_value{location={{location}}}', bindings: [{ variable: 'location', field: 'series' }] } };
      fixture.dashboard.widgets = [spacer, host, { ...spacer, id: 'after-records', layout: { ...spacer.layout, y: 24 } }];
      await page.route(`${new URL(base).origin}/api/insights/query`, async route => {
        const request = route.request().postDataJSON();
        if (!request.query.startsWith('tooltip_motion_value{')) return route.fallback();
        await queryGate;
        await route.fulfill({ json: { series: [{ name: 'Recorded requests', labels: {}, points: [{ timestamp: request.end * 1000, value: 42 }] }] } });
      });
      for (const mode of ['grid', 'map']) {
        host.config.mode = mode;
        // Pick real marks in both viewport halves. Each context is independent
        // and the source result is held until several loading frames have painted.
        for (const half of ['upper', 'lower']) {
          await page.mouse.move(1, 1);
          await page.goto(`${base}/dashboard/insights/?dashboard=${fixture.dashboard.id}`);
          const marks = page.locator('[data-geo-cell]');
          await marks.first().waitFor();
          const index = await marks.evaluateAll(nodes => nodes.findIndex(node => {
            const r = node.getBoundingClientRect(); return r.x > 350 && r.right < innerWidth - 360;
          }));
          assert.ok(index >= 0);
          await marks.nth(index).evaluate((node, half) => {
            node.scrollIntoView({ block: 'center' });
            const r = node.getBoundingClientRect();
            let scroll = node.parentElement;
            while (scroll && !(scroll.scrollHeight > scroll.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(scroll).overflowY))) scroll = scroll.parentElement;
            (scroll || window).scrollBy(0, r.y + r.height / 2 - innerHeight * (half === 'upper' ? .3 : .62));
          }, half);
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const target = await marks.evaluateAll((nodes, index) => nodes.map((node, index) => {
            const r = node.getBoundingClientRect(); return { index, x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })[index], index);
          assert.ok(target, `${mode}: fixture needs a mark in the ${half} viewport half`);
          assert.ok(half === 'upper' ? target.y < height / 2 : target.y > height / 2, `Native scrolling positions the target in the intended viewport half: ${JSON.stringify({ height, mode, half, target })}`);
          queryGate = new Promise(resolve => { releaseQuery = resolve; });
          await page.evaluate(() => { window.__tooltipFrames = []; window.__recordTooltip = true; });
          await page.mouse.move(target.x, target.y);
          const tooltip = page.getByRole('tooltip');
          await tooltip.waitFor();
          await page.evaluate(() => new Promise(resolve => { let frames = 0; const next = () => ++frames === 4 ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next); }));
          releaseQuery();
          await tooltip.locator('[data-tooltip-widget="stat"] [data-metric-value]').waitFor();
          await page.evaluate(() => new Promise(resolve => { let frames = 0; const next = () => ++frames === 6 ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next); }));
          const frames = await page.evaluate(() => { window.__recordTooltip = false; return window.__tooltipFrames; });
          reports.push({ theme, height, mode, half, target, frames });
          assert.ok(frames.some(frame => !frame.loaded) && frames.some(frame => frame.loaded), 'Record both loading and loaded frames');
          assert.equal(new Set(frames.map(frame => frame.placement)).size, 1, 'Loading a result must not flip sides');
          for (const frame of frames) {
            assert.equal(frame.pointer, 'true', `First visible frame must already follow the pointer: ${JSON.stringify(frame)}`);
            const gap = frame.placement.startsWith('pointer-top') ? target.y - frame.bottom : frame.top - target.y;
            assert.ok(Math.abs(gap - 16) < 1, `Every frame retains the pointer gap: ${JSON.stringify({ gap, frame })}`);
            assert.ok(frame.left >= 11 && frame.right <= 1501 && frame.top >= 11 && frame.bottom <= height - 11, 'Every frame stays inside the viewport');
          }
          // Pinning changes lifetime and interactivity, not the panel's anchor.
          // Keep recording through click, pointer departure and keyboard use:
          // a settled pinned screenshot misses the jump from the hover frame.
          const hovering = frames.at(-1);
          await page.evaluate(() => { window.__tooltipFrames = []; window.__recordTooltip = true; });
          await page.mouse.click(target.x, target.y);
          await page.mouse.move(1, 1);
          await page.keyboard.press('PageDown');
          await page.evaluate(() => new Promise(resolve => { let frames = 0; const next = () => ++frames === 8 ? resolve() : requestAnimationFrame(next); requestAnimationFrame(next); }));
          const pinnedFrames = await page.evaluate(() => { window.__recordTooltip = false; return window.__tooltipFrames; });
          reports.push({ theme, height, mode, half, target, stage: 'pinned', frames: pinnedFrames });
          assert.ok(pinnedFrames.length >= 4);
          assert.notEqual(await tooltip.evaluate(node => getComputedStyle(node).pointerEvents), 'none', 'The retained panel becomes interactive');
          for (const frame of pinnedFrames) {
            assert.equal(frame.placement, hovering.placement, 'Pinning must not switch to outside-widget placement');
            const x = hovering.placement.endsWith('-left') ? 'right' : 'left';
            const y = hovering.placement.startsWith('pointer-top') ? 'bottom' : 'top';
            assert.ok(Math.abs(frame[x] - hovering[x]) < 1 && Math.abs(frame[y] - hovering[y]) < 1, `Every pinned frame retains the pointer-facing corner: ${JSON.stringify({ hovering, frame })}`);
          }
          await page.screenshot({ path: resolve(output, `${theme}-${height}-${mode}-${half}.png`) });
        }
      }
      // A point's circular contour remains above adjacent marks in hover,
      // keyboard and pinned states; its magnitude/colour do not change.
      // Real maps cluster observations: make neighbours closer than a hitbox.
      fixture.records.rows.forEach((row, index) => { row[1] = 42 + index % 20 * .2; row[2] = -79 + Math.floor(index / 20) * .2; });
      fixture.dashboard.widgets = [{ ...markers, layout: { x: 0, y: 0, w: 12, h: 8 } }];
      await page.goto(`${base}/dashboard/insights/?dashboard=${fixture.dashboard.id}`);
      const point = page.locator('[data-map-location-key] button').last();
      await point.waitFor();
      const hitCoverage = await page.locator('[data-map-plane]').evaluate(plane => {
        const misses = []; let covered = 0;
        for (const button of plane.querySelectorAll('button')) {
          const box = button.getBoundingClientRect();
          for (const offset of [0, .4, -.4]) {
            const x = box.x + box.width * (.5 + offset), y = box.y + box.height * (.5 + offset);
            const hits = document.elementsFromPoint(x, y);
            if (!hits.some(node => node.closest('[data-map-location-key] button'))) continue;
            covered++;
            if (hits[0]?.matches('[data-map-location-key]')) misses.push({ x, y });
          }
        }
        return { covered, misses };
      });
      assert.ok(hitCoverage.covered > 500, 'Exercise dense overlapping marker hit targets');
      assert.equal(hitCoverage.misses.length, 0, `Invisible wrapper corners must not intercept a visible neighbouring point: ${JSON.stringify(hitCoverage.misses.slice(0, 5))}`);
      mapReports.push({ theme, height, ...hitCoverage });
      const appearance = () => point.evaluate(node => {
        const style = getComputedStyle(node), dot = node.firstElementChild, box = dot.getBoundingClientRect();
        return { width: box.width, height: box.height, fill: getComputedStyle(dot).backgroundColor,
          outline: style.outlineStyle, outlineWidth: style.outlineWidth, radius: style.borderRadius,
          layer: Number(getComputedStyle(node.parentElement).zIndex) };
      });
      const resting = await appearance();
      await point.hover();
      const hovering = await appearance();
      assert.equal(hovering.outline, 'solid'); assert.equal(hovering.outlineWidth, '2px');
      assert.equal(hovering.radius, '50%'); assert.ok(hovering.layer > resting.layer);
      await point.focus(); await point.press('Enter');
      await page.mouse.move(1, 1);
      assert.equal(await point.getAttribute('aria-pressed'), 'true');
      const pinned = await appearance();
      assert.equal(pinned.outline, 'solid'); assert.equal(pinned.outlineWidth, '2px');
      assert.ok(pinned.layer > resting.layer);
      for (const key of ['width', 'height', 'fill']) assert.equal(pinned[key], resting[key]);
      await page.screenshot({ path: resolve(output, `${theme}-${height}-map-pinned.png`) });
      await page.keyboard.press('Escape');
      await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      assert.deepEqual(errors, []); assert.deepEqual(fixture.failures, []);
      console.log(`PASS ${theme} ${height}px: map/grid loading and hover-to-pin frames retain their corner and viewport bounds`);
    } catch (error) {
      await page.screenshot({ path: resolve(output, `failure-${theme}-${height}.png`) });
      throw error;
    } finally { releaseQuery(); await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, 'frames.json'), JSON.stringify(reports, null, 2));
  await writeFile(resolve(output, 'map-hits.json'), JSON.stringify(mapReports, null, 2));
}
