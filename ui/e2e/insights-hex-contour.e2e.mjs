// Pixel containment: an inspection contour may change its own hex, never a
// neighbouring cell or the map beneath it. Computed stroke styles cannot prove this.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { installChartSystemFixture } from './fixtures/chart-system.mjs';

const base = process.env.INSIGHTS_E2E_URL || 'http://127.0.0.1:3015';
const output = resolve(process.env.INSIGHTS_HEX_OUTPUT || '../artifacts/insights/hex-contour');
await mkdir(output, { recursive: true });
const browser = await chromium.launch(), reports = [];
try {
  for (const theme of ['light', 'dark']) for (const width of [1512, 390]) for (const scale of [1, 2]) {
    const context = await browser.newContext({ viewport: { width, height: 1050 }, deviceScaleFactor: scale, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(theme => localStorage.setItem('paprika-insights-theme', theme), theme);
    try {
      const fixture = await installChartSystemFixture(page, base);
      await page.goto(`${base}/dashboard/insights/?dashboard=${fixture.dashboard.id}`);
      if (width === 390) await page.locator('[data-testid="dashboard-canvas"][data-layout-mode="stacked"]').waitFor();
      for (const id of ['hex-map', 'honeycomb']) {
        const tile = page.locator(`[data-widget-id="${id}"]`);
        await tile.scrollIntoViewIfNeeded();
        await tile.locator('[data-geo-cell]').first().waitFor();
        await page.mouse.move(1, 1);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const geometry = await tile.evaluate(tile => {
          const cells = [...tile.querySelectorAll('[data-geo-cell]')].map((node, index) => {
            const box = node.getBoundingClientRect();
            const values = getComputedStyle(node).clipPath.match(/[\d.]+/g).map(Number);
            const polygon = Array.from({ length: values.length / 2 }, (_, i) => [box.x + box.width * values[i * 2] / 100, box.y + box.height * values[i * 2 + 1] / 100]);
            return { index, missing: node.hasAttribute('data-missing'), x: box.x, y: box.y, width: box.width, height: box.height, polygon };
          });
          const visible = cells.filter(c => !c.missing && c.x > 24 && c.y > 100 && c.x + c.width < innerWidth - 24 && c.y + c.height < innerHeight - 24);
          for (const cell of visible) {
            const neighbours = cells.filter(other => other !== cell && Math.hypot(other.x - cell.x, other.y - cell.y) < cell.height * 1.15);
            if (neighbours.length >= 3) return { cell, neighbours };
          }
          return null;
        });
        assert.ok(geometry, 'The fixture must contain visible, tightly adjacent hexes');
        const { cell } = geometry;
        const clip = { x: Math.floor(cell.x) - 6, y: Math.floor(cell.y) - 6, width: Math.ceil(cell.width) + 13, height: Math.ceil(cell.height) + 13 };
        const prefix = `${theme}-${width}-${scale}x-${id}`;
        // Hide only the separate tooltip layer in these paint comparisons.
        // Hover, focus and pin still go through their real native input paths.
        const capture = state => page.screenshot({ clip, path: resolve(output, `${prefix}-${state}.png`), style: '[role="tooltip"] { opacity: 0 !important; }' });
        const before = await capture('rest');
        const button = tile.locator('[data-geo-cell]').nth(cell.index).locator('..');
        for (const state of ['hover', 'pinned', 'focus']) {
          if (state === 'hover') await button.hover();
          if (state === 'pinned') { await button.click(); await page.mouse.move(1, 1); }
          if (state === 'focus') { await page.keyboard.press('Escape'); await button.press('Tab'); await page.keyboard.press('Shift+Tab'); }
          await page.getByRole('tooltip').waitFor();
          const actualBounds = await button.locator('[data-geo-cell]').boundingBox();
          assert.deepEqual(actualBounds, { x: cell.x, y: cell.y, width: cell.width, height: cell.height }, 'Inspection must not move the selected hex');
          const after = await capture(state);
          const diff = await page.evaluate(async ({ before, after, geometry, clip, scale }) => {
            const pixels = async png => {
              const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
              const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
              const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext('2d');
              ctx.drawImage(bitmap, 0, 0); bitmap.close();
              return ctx.getImageData(0, 0, canvas.width, canvas.height);
            };
            const [a, b] = await Promise.all([pixels(before), pixels(after)]);
            const inside = (x, y, polygon) => polygon.every(([ax, ay], i) => {
              const [bx, by] = polygon[(i + 1) % polygon.length];
              return (bx - ax) * (y - ay) - (by - ay) * (x - ax) >= 0;
            });
            const distance = (x, y, polygon) => Math.min(...polygon.map(([ax, ay], i) => {
              const [bx, by] = polygon[(i + 1) % polygon.length], dx = bx - ax, dy = by - ay;
              const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
              return Math.hypot(x - ax - t * dx, y - ay - t * dy);
            }));
            let own = 0, outside = 0, neighbours = 0;
            const outsidePixels = [];
            for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
              const offset = (y * a.width + x) * 4;
              if (Math.max(...[0, 1, 2].map(c => Math.abs(a.data[offset + c] - b.data[offset + c]))) <= 12) continue;
              const px = clip.x + (x + .5) / scale, py = clip.y + (y + .5) / scale;
              if (inside(px, py, geometry.cell.polygon)) own++;
              // Raising a cell can rerasterize adjacent polygon edges. Exclude
              // their subpixel antialias fringe, never a neighbouring interior
              // or the clear gap between cells.
              else if (distance(px, py, geometry.cell.polygon) > .75 / scale && !geometry.neighbours.some(n => distance(px, py, n.polygon) <= .75 / scale)) {
                outside++;
                if (outsidePixels.length < 12) outsidePixels.push({ px, py, distance: distance(px, py, geometry.cell.polygon), before: [...a.data.slice(offset, offset + 4)], after: [...b.data.slice(offset, offset + 4)] });
              }
              if (geometry.neighbours.some(n => inside(px, py, n.polygon) && distance(px, py, n.polygon) > .5 / scale)) neighbours++;
            }
            return { own, outside, neighbours, ...(outside ? { polygon: geometry.cell.polygon, outsidePixels } : {}) };
          }, { before: before.toString('base64'), after: after.toString('base64'), geometry, clip, scale });
          reports.push({ theme, width, scale, id, state, cellWidth: cell.width, adjacentCells: geometry.neighbours.length, ...diff });
          assert.ok(diff.own > 3, `${prefix} ${state}: the selected contour must be visible`);
          assert.equal(diff.outside, 0, `${prefix} ${state}: contour paints outside the selected hex (${JSON.stringify(diff)})`);
          assert.equal(diff.neighbours, 0, `${prefix} ${state}: contour changes neighbouring hex pixels`);
        }
        await page.keyboard.press('Escape');
        await page.getByRole('tooltip').waitFor({ state: 'hidden' });
        // Move focus off the chart before taking the next resting capture.
        await page.getByRole('heading', { level: 1 }).click();
        console.log(`PASS ${prefix}: hover/pin/focus paint stays inside the selected hex`);
      }
      assert.deepEqual(errors, []); assert.deepEqual(fixture.failures, []);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(reports, null, 2));
}
