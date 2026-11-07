// Optional end-to-end smoke test of the isolated local gallery. Uses real
// Insights, Observe, Prometheus, PostgreSQL and Tempo; no request mocks.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { selectGammaOption } from "./gamma-controls.mjs";

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1");
assert.equal(origin.hostname, "127.0.0.1", "The gallery harness must be on loopback");
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/gallery-live-review");
await mkdir(output, { recursive: true });
const boards = ["service-pulse", "fleet-atlas", "edge-watch", "market-lens", "reliability-room", "collection-control", "signal-kit", "availability-lab"];
function selectedRecordResponse(page, first, second) {
  return page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== "/api/insights/query" || response.request().method() !== "POST" || !response.ok()) return false;
    try {
      const request = response.request().postDataJSON();
      if (request.kind !== "records") return false;
      const parameters = JSON.parse(request.query).parameters;
      return Array.isArray(parameters) && parameters[0] === first && parameters[1] === second;
    } catch { return false; }
  });
}
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, colorScheme: theme, reducedMotion: "reduce" });
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme); }, { expected: origin.origin, theme });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(30000);
      const errors = [], failedQueries = [];
      let rateLimited = 0, expectedQueryErrors = 0;
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/insights/query" && response.request().method() === "POST" && !response.ok()) {
          if (response.status() === 429) rateLimited++;
          else {
            let expected = false;
            try { expected = response.request().postDataJSON().query === "rate(" && response.status() === 502; } catch { /* Keep unexpected transport failures visible. */ }
            if (expected) expectedQueryErrors++;
            else failedQueries.push(response.status());
          }
        }
      });
      for (const board of process.env.PAPRIKA_GALLERY_LINKS_ONLY ? [] : boards) {
        const id = `local-gallery-${board}`;
        await page.goto(`${origin.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" });
        const widgets = page.locator("[data-widget-id]");
        await widgets.first().waitFor();
        assert.ok(await widgets.count() >= (board === "availability-lab" ? 3 : 7), `${board} should show its dashboard widgets`);
        for (const widget of await widgets.all()) {
          await widget.scrollIntoViewIfNeeded();
          // Scrolling enables the widget's intersection-gated query. Give the
          // observer a frame before waiting for loading to finish.
          await widget.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          await widget.getByRole("status", { name: "Loading widget" }).waitFor({ state: "hidden" });
          const widgetId = await widget.getAttribute("data-widget-id");
          if (board === "signal-kit" && widgetId === "expected-empty") {
            await widget.getByText("No data in this time range").waitFor();
            assert.equal(await widget.getByText("Query failed", { exact: true }).count(), 0, "A genuine empty result is not an error");
          } else if (board === "signal-kit" && widgetId === "expected-error") {
            await widget.getByText("Query failed", { exact: true }).waitFor();
            assert.equal(await widget.getByText("No data in this time range").count(), 0, "A provider error is not an empty result");
          } else {
            const problem = widget.getByText(/Widget could not render|Query failed|No data in this time range/);
            assert.equal(await problem.count(), 0, `${board} ${widgetId}: ${await widget.innerText()}`);
            if (board === "signal-kit" && widgetId === "expected-stale") {
              await widget.locator('[data-stale-observation]').waitFor();
              assert.ok(await widget.locator('[data-stat-sparkline]').count(), "The old sample state must preserve its actual history");
            }
          }
        }
        if (board === "service-pulse") {
          const chart = page.locator('[data-widget-id="request-history"]');
          await chart.scrollIntoViewIfNeeded();
          await chart.getByRole("img", { name: "Request rate by service", exact: true }).waitFor();
          assert.equal(await chart.getByRole("list", { name: "Latest values by series" }).getByRole("listitem").count(), 3, "Service comparison must render three recorded series");
          const updated = page.waitForResponse(response => {
            if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false;
            try {
              const request = response.request().postDataJSON();
              return request.query.includes("paprika_demo_requests_total") && request.query.includes('service="payments"') && request.query.includes('worker|catalog');
            } catch { return false; }
          });
          await selectGammaOption(page, page.getByRole("combobox", { name: "Service", exact: true }), "payments");
          const data = await (await updated).json();
          assert.deepEqual(new Set(data.series.map(series => series.labels.service)), new Set(["payments", "catalog", "worker"]));
          await page.locator('[data-widget-id="error-history"]').getByText("Error budget burn rate · 1h").waitFor();
        }
        if (board === "signal-kit") {
          const rate = page.locator('[data-widget-id="request-history"]');
          const plot = rate.getByRole("img", { name: "Request rate · selected service and worker", exact: true });
          await plot.scrollIntoViewIfNeeded();
          await plot.focus();
          const tooltip = page.getByRole("tooltip");
          await tooltip.waitFor();
          const observed = tooltip.locator("[data-observation-value]");
          assert.ok(Number.isFinite(Number(await observed.getAttribute("data-observation-value"))), "Chart tooltip must expose a real observation");
          await plot.press("Escape");
          const rateResponse = page.waitForResponse(response => {
            if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false;
            try {
              const request = response.request().postDataJSON();
              return request.query.includes("paprika_demo_requests_total") && request.query.includes('service="payments"') && request.query.includes('service="worker"');
            } catch { return false; }
          });
          await selectGammaOption(page, page.getByRole("combobox", { name: "Service", exact: true }), "payments");
          const rateData = await (await rateResponse).json();
          assert.deepEqual(new Set(rateData.series.map(series => series.labels.service)), new Set(["payments", "worker"]), "Shared service filter must reach the live two-series Prometheus query");
          assert.ok(rateData.series.every(series => series.points.length > 1), "Both request series must have history");
          const latency = page.locator('[data-widget-id="latency"]');
          await latency.scrollIntoViewIfNeeded();
          await latency.locator("[data-metric-value]").waitFor();
          await latency.locator("[data-stat-sparkline]").waitFor();
          const clusterRateResponse = page.waitForResponse(response => {
            if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false;
            try {
              const request = response.request().postDataJSON();
              return request.query.includes("paprika_demo_requests_total") && request.query.includes('cluster="delta"') && request.query.includes('service="payments"') && request.query.includes('service="worker"');
            } catch { return false; }
          });
          await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "delta");
          const clusterRate = await (await clusterRateResponse).json();
          assert.deepEqual(new Set(clusterRate.series.map(series => series.labels.cluster)), new Set(["delta"]), "Cluster selection must reach both rate series");
          assert.deepEqual(new Set(clusterRate.series.map(series => series.labels.service)), new Set(["payments", "worker"]));
          const memory = page.locator('[data-widget-id="memory-meter"]');
          await memory.scrollIntoViewIfNeeded();
          await memory.locator('[data-gauge-series]').first().waitFor();
        }
        if (board === "availability-lab") {
          assert.ok(await page.locator('[data-widget-id="monitor-grid"] [data-status-grid] [role="img"], [data-widget-id="monitor-grid"] [data-status-grid] button').count() > 0, "Monitor grid must contain recorded monitor cells");
          for (const id of ["uptime-calendar", "uptime-timeline"]) {
            assert.ok(await page.locator(`[data-widget-id="${id}"] [data-uptime-day][data-uptime-state="observed"], [data-widget-id="${id}"] [data-uptime-day][data-uptime-state="mixed"]`).count() > 0, `${id} must contain recorded days`);
          }
          for (const [id, legend] of [["monitor-grid", "Monitor status legend"], ["uptime-calendar", "Recorded day legend"], ["uptime-timeline", "Recorded day legend"]]) {
            const tile = page.locator(`[data-widget-id="${id}"]`);
            await tile.scrollIntoViewIfNeeded();
            const bounds = await tile.getByRole("group", { name: legend }).evaluate(element => {
              const card = element.closest("[data-widget-id]").getBoundingClientRect();
              const box = element.getBoundingClientRect();
              return { visible: box.width > 0 && box.height > 0, within: box.left >= card.left - 1 && box.right <= card.right + 1 && box.top >= card.top - 1 && box.bottom <= card.bottom + 1 };
            });
            assert.ok(bounds.visible && bounds.within, `${id} legend must be visible within its widget`);
          }
        }
        await page.waitForLoadState("networkidle");
        assert.equal(await page.getByText("Widget could not render", { exact: false }).count(), 0, `${board}: widget render error`);
        assert.equal(await page.getByText("observability provider does not support this request", { exact: false }).count(), 0, `${board}: provider error`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${board}: page overflow`);
        await page.screenshot({ path: resolve(output, `${board}-${theme}.png`), fullPage: true, animations: "disabled" });
        console.log(`PASS ${theme} ${board}: all visible widgets on live local providers`);
      }
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-market-lens`, { waitUntil: "networkidle" });
      const detail = page.locator('[data-widget-id="selected-company"]');
      await detail.scrollIntoViewIfNeeded();
      await detail.getByText("Example company 001").waitFor();
      // Offscreen charts defer provider work; bring the treemap into view
      // before waiting for a company generated from its result.
      await page.locator('[data-widget-id="composition"]').scrollIntoViewIfNeeded();
      const company = page.locator('[data-widget-id="composition"]').getByRole("button", { name: /^DEMO091:/ });
      await company.hover();
      assert.equal(await detail.getByText("Example company 001").count(), 1, "Hover must not change the selected company");
      await company.focus(); await company.press("Enter");
      await detail.scrollIntoViewIfNeeded();
      await detail.getByText("Example company 091").waitFor();
      assert.ok(page.url().includes("DEMO091"), "Selection should be shareable in the URL");
      await selectGammaOption(page, page.getByRole("combobox", { name: "Sector", exact: true }), "Financials");
      await page.locator('[data-widget-id="composition"]').scrollIntoViewIfNeeded();
      const financial = page.locator('[data-widget-id="composition"]').getByRole("button", { name: /^DEMO093:/ });
      await financial.waitFor(); await financial.click();
      await detail.scrollIntoViewIfNeeded();
      await detail.getByText("Example company 093").waitFor();
      const sectorTrend = page.locator('[data-widget-id="history"]');
      await sectorTrend.scrollIntoViewIfNeeded();
      for (const sector of ["Consumer", "Energy", "Financials", "Healthcare", "Industrials", "Technology"]) {
        await sectorTrend.getByText(`${sector} · short_interest`, { exact: true }).waitFor();
      }
      const companyHistory = page.locator('[data-widget-id="selected-company-history"]');
      await companyHistory.scrollIntoViewIfNeeded();
      await companyHistory.getByRole("group", { name: "Selected company · short interest history" }).waitFor();
      await page.locator('[data-widget-id="composition"]').scrollIntoViewIfNeeded();
      const historyResponse = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false;
        try { const query = JSON.parse(response.request().postDataJSON().query); return query.sql.includes("FROM gallery.company_history WHERE symbol=$1") && query.parameters[0] === "DEMO094"; } catch { return false; }
      });
      await page.locator('[data-widget-id="composition"]').getByRole("button", { name: /^DEMO094:/ }).click();
      await companyHistory.scrollIntoViewIfNeeded();
      const historyResult = await (await historyResponse).json();
      assert.ok(JSON.stringify(historyResult).includes("short_interest"), "Selected company history must return provider records");
      await detail.getByText("Example company 094").waitFor();
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-fleet-atlas`, { waitUntil: "networkidle" });
      const nodeDetail = page.locator('[data-widget-id="selected-node-detail"]');
      await nodeDetail.scrollIntoViewIfNeeded();
      await nodeDetail.getByText("node-01").waitFor();
      const nodeList = page.locator('[data-widget-id="resources"]');
      await nodeList.scrollIntoViewIfNeeded();
      await nodeList.locator("tr").filter({ hasText: "node-02" }).getByRole("button", { name: /Select row/ }).click();
      await nodeDetail.scrollIntoViewIfNeeded();
      await nodeDetail.getByText("node-02").waitFor();
      assert.ok(page.url().includes("node-02"));
      const nodeDelta = selectedRecordResponse(page, "delta", "node-02");
      await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "delta");
      await nodeDetail.scrollIntoViewIfNeeded();
      await nodeDelta;
      await nodeDetail.getByText("node-02").waitFor();
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-collection-control`, { waitUntil: "networkidle" });
      const sourceDetail = page.locator('[data-widget-id="selected-source-detail"]');
      await sourceDetail.scrollIntoViewIfNeeded();
      await sourceDetail.getByText("prometheus").waitFor();
      const sourceList = page.locator('[data-widget-id="sources-table"]');
      await sourceList.scrollIntoViewIfNeeded();
      await sourceList.locator("tr").filter({ hasText: "tempo" }).getByRole("button", { name: /Select row/ }).click();
      await sourceDetail.scrollIntoViewIfNeeded();
      await sourceDetail.getByText("tempo").waitFor();
      assert.ok(page.url().includes("tempo"));
      const sourceDelta = selectedRecordResponse(page, "delta", "tempo");
      await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "delta");
      await sourceDetail.scrollIntoViewIfNeeded();
      await sourceDelta;
      await sourceDetail.getByText("tempo").waitFor();
      assert.deepEqual(errors, [], "No uncaught browser errors");
      assert.deepEqual(failedQueries, [], "Only the labelled Signal Kit demonstration query may fail");
      if (!process.env.PAPRIKA_GALLERY_LINKS_ONLY) assert.ok(expectedQueryErrors > 0, "The labelled invalid query must have reached the real provider");
      console.log(`PASS ${theme}: company, node and source selections update real provider-backed detail with shared filters (${rateLimited} transient 429 responses)`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
