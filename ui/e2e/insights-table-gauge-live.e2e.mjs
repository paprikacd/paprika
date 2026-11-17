// Run against the isolated gallery harness, without replacing provider data.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1");
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated loopback gallery is supported");
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/table-gauges-live");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, colorScheme: theme });
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme); }, { expected: origin.origin, theme });
    try {
      const page = await context.newPage(), frames = [], errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/insights/query" && response.ok()) frames.push(response.json().catch(() => null));
      });
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-fleet-atlas`);
      const table = page.locator('[data-widget-id="resources"]');
      await table.scrollIntoViewIfNeeded();
      const gauge = table.locator('[data-cell-display="bar-segments"]').first();
      await gauge.waitFor({ timeout: 30000 });
      const bar = gauge.locator('[data-segmented]'), fill = gauge.locator('[data-bar-end]');
      assert.equal(await bar.evaluate(node => getComputedStyle(node).maskImage.includes("repeating-linear-gradient")), true, "Segmented track must render a mask");
      assert.match(await gauge.getAttribute("aria-label"), /%.*Scale 0% to 100%/);
      const returned = (await Promise.all(frames)).find(item => item?.records?.columns?.some(column => column.key === "cpu"));
      assert.ok(returned, "The real PostgreSQL records frame must be returned");
      const cpu = returned.records.columns.findIndex(column => column.key === "cpu");
      assert.equal(Number(await fill.getAttribute("data-bar-end")), returned.records.rows[0][cpu] / 100);
      assert.ok(await table.locator('[data-cell-display="bar"]').count() > 0, "Continuous gauges should render beside segmented gauges");
      assert.ok(await table.locator('[data-cell-display="color-text"]').count() > 0, "Threshold-colored readings should render");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), animations: "disabled" });
      console.log(`PASS ${theme} ${width}px: real PostgreSQL numeric values drive segmented and continuous gauges`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
