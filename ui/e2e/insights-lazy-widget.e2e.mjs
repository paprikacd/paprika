// Browser regression for deferred tiles: the workspace is real, query results
// are controlled so an empty response cannot race the assertions.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs";
import { until } from "./insights-portable-fixture.mjs";

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const staticURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015";
const environment = await createReferenceDashboardEnvironment(repository, staticURL);
const browser = await chromium.launch({ headless: true });
try {
  const providerId = environment.providerIds.metrics;
  const dashboard = { schemaVersion: 1, id: "lazy-widget-regression", title: "Lazy widget regression", timeRange: "1h", refreshInterval: 0, widgets: [
    { id: "top", title: "Top", type: "stat", providerId, query: "top", unit: "", layout: { x: 0, y: 0, w: 12, h: 12 } },
    { id: "deferred", title: "Deferred", type: "timeseries", providerId, query: "deferred", unit: "", layout: { x: 0, y: 12, w: 12, h: 8 } },
  ] };
  await environment.api(`dashboards/${dashboard.id}`, "PUT", dashboard, { "If-None-Match": "*" });
  for (const outcome of ["empty", "failure"]) {
    const context = await browser.newContext({ viewport: { width: 1000, height: 450 }, reducedMotion: "reduce" });
    const page = await context.newPage();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    await environment.installQueryFixture(page, async request => {
      if (request.query === "top") return { series: [{ name: "top", labels: {}, points: [{ timestamp: Date.now(), value: 1 }] }] };
      assert.equal(request.query, "deferred");
      await pending;
      if (outcome === "failure") throw new Error("Provider unavailable");
      return { series: [] };
    });
    try {
      const before = environment.queryCalls.length;
      await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      const tile = page.locator('[data-widget-id="deferred"]');
      await tile.getByRole("status", { name: "Widget waiting to load" }).waitFor({ state: "attached" });
      assert.equal(environment.queryCalls.slice(before).filter(call => call.request?.query === "deferred").length, 0, "An offscreen tile must not query the provider");
      await tile.evaluate(node => {
        window.__lazyStates = [];
        const record = () => window.__lazyStates.push(node.textContent);
        new MutationObserver(record).observe(node, { childList: true, subtree: true, characterData: true });
        record();
      });
      await tile.scrollIntoViewIfNeeded();
      await tile.getByRole("status", { name: "Loading widget" }).waitFor();
      await until(() => environment.queryCalls.slice(before).some(call => call.request?.query === "deferred"), "The tile should query once it enters view");
      const priorStates = await page.evaluate(() => window.__lazyStates);
      assert.ok(priorStates.every(text => !text.includes("No data in this time range")), "Never report an empty result before the response");
      release();
      if (outcome === "empty") await tile.getByText("No data in this time range").waitFor();
      else await tile.getByRole("alert").waitFor();
      assert.equal(environment.queryCalls.slice(before).filter(call => call.request?.query === "deferred").length, 1);
      console.log(`PASS lazy widget: deferred, loading and actual ${outcome}`);
    } finally { release(); await context.close(); }
  }
} finally { await browser.close(); await environment.close(); }
