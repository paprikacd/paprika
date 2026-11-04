// Renderer and editor integration with deterministic provider fixtures.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { selectGammaOption } from "./gamma-controls.mjs";
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs";

const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015";
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  for (const theme of ["Light", "Dark"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      const fixture = await installRichChartFixtureAPI(page, base);
      const dashboard = fixture.documents.get("example-artboard-market-lens");
      const widget = dashboard.widgets.find(item => item.id === "composition");
      widget.config.colorField = "short_interest";
      await page.goto(`${base}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor();
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme);
      const tile = page.locator('[data-widget-id="composition"]');
      const cells = tile.locator("[data-treemap-color-value]");
      await cells.first().waitFor({ state: "attached" });
      assert.equal(await cells.count(), 4);
      const fills = await cells.evaluateAll(nodes => nodes.map(node => node.getAttribute("fill")));
      assert.ok(new Set(fills).size > 1, "Different short interest values must be encoded by color");
      const legend = tile.getByRole("group", { name: "Treemap color scale" });
      await legend.getByText("Short interest", { exact: true }).waitFor();
      assert.ok(await tile.locator('g[aria-label*="Short interest"]').count() === 4, "Each tile needs the exact color value in its accessible name");
      await selectGammaOption(page, page.getByRole("combobox", { name: "Sector", exact: true }), "Financials");
      await page.waitForFunction(() => document.querySelector('[data-widget-id="composition"] g[aria-label^="CBA:"]'));
      if (theme === "Light") {
        await page.getByRole("button", { name: "Edit dashboard", exact: true }).click();
        await tile.getByRole("button", { name: "Edit Company composition by market cap", exact: true }).click();
        const editor = page.getByRole("region", { name: "Widget editor", exact: true });
        await editor.getByRole("tab", { name: "Query", exact: true }).click();
        assert.equal(await editor.getByLabel("Area field").inputValue(), "market_cap");
        assert.equal(await editor.getByLabel("Color field").inputValue(), "short_interest");
        await editor.getByLabel("Color minimum").fill("0");
        await editor.getByLabel("Color maximum").fill("10");
        await editor.getByRole("button", { name: "Apply widget", exact: true }).click();
        await editor.getByRole("button", { name: "Close widget editor", exact: true }).click();
        await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
        await page.getByText("All changes saved", { exact: true }).waitFor();
        await page.reload({ waitUntil: "networkidle" });
        const persisted = fixture.documents.get(dashboard.id).widgets.find(item => item.id === "composition");
        assert.deepEqual([persisted.config.value, persisted.config.colorField, persisted.config.colorMin, persisted.config.colorMax], ["market_cap", "short_interest", 0, 10]);
        await page.locator('[data-widget-id="composition"] [data-treemap-color-value]').first().waitFor({ state: "attached" });
        assert.ok(fixture.calls.some(call => call.method === "PUT" && call.path === `/dashboards/${dashboard.id}`));
      }
      assert.deepEqual(fixture.failures, []);
      console.log(`PASS ${theme}: separate area/color, labels, legend and sector filter${theme === "Light" ? ", edit, save and reload" : ""}`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
