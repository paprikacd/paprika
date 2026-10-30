// End-to-end widget authoring using deterministic, intercepted provider responses.
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
      const dashboard = fixture.documents.get("example-artboard-fleet-atlas");
      const widget = dashboard.widgets.find(item => item.id === "node-cpu");
      const time = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      Object.assign(widget, { type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", config: { annotations: [{ timestamp: time, label: "Deployment", severity: "warning" }] }, options: { showTooltip: true, showLegend: true } });
      await page.goto(`${base}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor();
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme);
      const tile = page.locator('[data-widget-id="node-cpu"]');
      const marker = tile.locator("[data-annotation-timestamp]");
      await marker.waitFor({ state: "attached" });
      assert.equal(await marker.getAttribute("data-annotation-timestamp"), time);
      assert.equal(await marker.getAttribute("data-severity"), "warning");
      const events = tile.getByRole("group", { name: "Chart events" });
      await events.locator("summary").click();
      await events.getByText("Deployment", { exact: true }).waitFor();
      assert.equal(await events.locator("time").getAttribute("datetime"), time);
      assert.equal(await events.locator("time").getAttribute("title"), time);
      const plot = tile.getByRole("group", { name: /CPU utilization by node\. Stacked observations/ });
      await plot.focus();
      await page.getByRole("region", { name: "Observation details" }).waitFor();
      await page.keyboard.press("Escape");
      if (theme === "Light") {
        await page.getByRole("button", { name: "Edit dashboard", exact: true }).click();
        await tile.getByRole("button", { name: "Edit CPU utilization by node", exact: true }).click();
        const editor = page.getByRole("region", { name: "Widget editor", exact: true });
        await editor.getByRole("tab", { name: "Query", exact: true }).click();
        await editor.getByLabel("Event 1 label").fill("Deploy v2");
        await editor.getByRole("button", { name: "Apply widget", exact: true }).click();
        await editor.getByRole("button", { name: "Close widget editor", exact: true }).click();
        await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
        await page.getByText("All changes saved", { exact: true }).waitFor();
        await page.reload({ waitUntil: "networkidle" });
        const persisted = fixture.documents.get(dashboard.id).widgets.find(item => item.id === "node-cpu");
        assert.equal(persisted.config.annotations[0].label, "Deploy v2");
        assert.equal(persisted.config.annotations[0].timestamp, time);
        const list = page.locator('[data-widget-id="node-cpu"]').getByRole("group", { name: "Chart events" });
        await list.locator("summary").click();
        await list.getByText("Deploy v2", { exact: true }).waitFor();
        assert.ok(fixture.calls.some(call => call.method === "PUT" && call.path === `/dashboards/${dashboard.id}`));
      }
      assert.deepEqual(fixture.failures, []);
      console.log(`PASS ${theme}: event marker, exact timestamp, inspection${theme === "Light" ? ", edit, save and reload" : ""}`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
