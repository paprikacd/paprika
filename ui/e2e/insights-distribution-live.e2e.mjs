// Read-only browser check against the isolated local gallery's real provider.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "");
assert.equal(origin.hostname, "127.0.0.1", "Only the local demo gateway is permitted");
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/distribution-live");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) for (const service of ["checkout", "payments"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, colorScheme: theme, reducedMotion: "reduce" });
    try {
      const page = await context.newPage(), responses = [], errors = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || response.request().method() !== "POST" || !response.ok()) return;
        const query = response.request().postDataJSON()?.query;
        if (typeof query === "string" && query.startsWith("sum by (le)")) responses.push(response.json());
      });
      const url = new URL("/dashboard/insights/", origin); url.searchParams.set("dashboard", "local-gallery-service-pulse"); url.searchParams.set("vars", JSON.stringify({ service }));
      await page.goto(url.href, { waitUntil: "networkidle" });
      const widget = page.locator('[data-widget-id="latency-distribution"]');
      await widget.scrollIntoViewIfNeeded();
      const chart = widget.getByRole("group", { name: /histogram buckets/ });
      await chart.waitFor({ state: "visible", timeout: 30000 });
      const histogram = (await Promise.all(responses)).find(response => response?.series?.length);
      assert.ok(histogram?.series?.some(series => series.labels?.le), "real Prometheus must return labelled histogram buckets");
      assert.equal(histogram.series.filter(series => Number(series.labels?.le) === 1).length, 1, "The one-second boundary must have one canonical label across backfill and scrape");
      const values = await widget.locator("rect[data-bucket-value]").evaluateAll(cells => cells.map(cell => Number(cell.getAttribute("data-bucket-value"))).filter(Number.isFinite));
      assert.ok(values.length > 20 && values.some(value => value > 0), "histogram must render observed bucket rates");
      await chart.focus();
      await chart.press("ArrowUp");
      await chart.press("Enter");
      await page.getByRole("region", { name: "Observation details" }).waitFor();
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: resolve(output, `${service}-${theme}-${width}.png`), animations: "disabled" });
      console.log(`PASS ${service} ${theme} ${width}px: canonical real Prometheus histogram, keyboard inspection and layout`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
