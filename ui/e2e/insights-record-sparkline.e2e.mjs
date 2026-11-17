// Isolated browser fixture. Real PostgreSQL integration is validated separately.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015";
const output = resolve(root, "artifacts/insights/record-sparkline");
const points = [
  { timestamp: "2026-10-28T11:00:00Z", value: 4.0 },
  { timestamp: "2026-10-28T11:05:00Z", value: 0 },
  { timestamp: "2026-10-28T11:11:00Z", value: null },
  { timestamp: "2026-10-28T11:30:00Z", value: 12.345 },
];
const board = { schemaVersion: 1, id: "sparkline-cell-test", title: "Company trends · test fixture", timeRange: "1h", refreshInterval: 0, widgets: [
  { id: "trends", title: "Recorded company trends", type: "plugin", pluginId: "record-table", dataKind: "records", providerId: "example-records", query: "test_record_history", unit: "", config: { columns: ["company", "trend"], density: "compact", showSearch: false, cellStyles: [{ column: "trend", display: "sparkline", unit: "%" }] }, options: { decimals: 2 }, layout: { x: 0, y: 0, w: 8, h: 4 } },
] };
const frame = { columns: [{ key: "company", type: "string" }, { key: "trend", label: "Trend", type: "string" }], rows: [["Alpha", JSON.stringify(points)], ["No history", null], ["Invalid", "not-json"], ["Latest missing", JSON.stringify([...points, { timestamp: "2026-10-28T11:45:00Z", value: null }])]] };
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      page.on("pageerror", error => errors.push(error.message));
      const fixture = await installRichChartFixtureAPI(page, base); fixture.documents.set(board.id, structuredClone(board));
      await page.route("**/api/insights/query", route => {
        if (route.request().postDataJSON()?.query !== "test_record_history") return route.fallback();
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ records: frame }) });
      });
      await page.goto(`${base}/dashboard/insights/?dashboard=${board.id}`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: board.title }).waitFor();
      const table = page.getByRole("region", { name: "Recorded company trends records" });
      const first = table.getByRole("row").filter({ hasText: "Alpha" });
      const graph = first.getByRole("img", { name: "History for Trend" });
      await graph.waitFor();
      assert.equal(await graph.getAttribute("data-sample-count"), "4");
      assert.equal(await graph.getAttribute("data-history-min"), "0");
      assert.equal((await graph.locator("[data-stat-trend]").getAttribute("d")).match(/M/g).length, 2, "a missing sample must break the line");
      assert.match(await first.innerText(), /12\.35%/);
      assert.ok(await table.getByRole("row").filter({ hasText: "Latest missing" }).getByText("No data").isVisible());
      assert.ok(await table.getByRole("row").filter({ hasText: "Invalid" }).getByText("Invalid history").isVisible());
      assert.equal(await table.getByRole("columnheader", { name: "Trend" }).getByRole("button").count(), 0, "serialized history is not sorted as text");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "table scrolling stays inside the widget");
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), animations: "disabled" });
      assert.deepEqual(fixture.failures, []);
      console.log(`PASS ${theme} ${width}px record history cells`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("4 record history browser cases passed.");
} finally { await browser.close(); }
