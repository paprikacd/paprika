// Saved exact-label colors remain stable across filter changes and themes.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs";
import { selectGammaOption } from "./gamma-controls.mjs";

const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015";
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const fixture = await installRichChartFixtureAPI(page, base);
      const dashboard = fixture.documents.get("example-artboard-edge-watch");
      const flow = dashboard.widgets.find(item => item.id === "flow");
      flow.config = { ...flow.config, seriesColors: [{ label: "direction", value: "inbound", color: "#00cee2" }, { label: "direction", value: "outbound", color: "#a879ef" }] };
      await page.goto(`${base}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme);
      const tile = page.locator('[data-widget-id="flow"]');
      await tile.scrollIntoViewIfNeeded();
      const colors = async () => tile.locator("[data-series]").evaluateAll(groups => Object.fromEntries(groups.map(group => [group.getAttribute("data-series"), group.querySelector("path[stroke]")?.getAttribute("stroke")])));
      await tile.locator('[data-series="Inbound"]').waitFor();
      assert.deepEqual(await colors(), { Inbound: "#00cee2", Outbound: "#a879ef" });
      await selectGammaOption(page, page.getByRole("combobox", { name: "Gateway", exact: true }), "edge-02");
      const apply = page.getByRole("button", { name: "Apply values", exact: true });
      if (await apply.count() && await apply.isEnabled()) await apply.click();
      await tile.scrollIntoViewIfNeeded();
      await tile.locator('[data-series="Inbound"]').waitFor();
      assert.deepEqual(await colors(), { Inbound: "#00cee2", Outbound: "#a879ef" });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []); assert.deepEqual(fixture.failures, []);
      console.log(`PASS ${theme} ${width}px: exact label colors survive filter changes`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
