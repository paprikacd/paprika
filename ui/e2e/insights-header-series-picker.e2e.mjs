// The series picker for links sits in the tile header (R18). Bar and stat charts have no other way to pick the
// series a link uses, so the picker must stay usable on the standard canvas, the Compact canvas and a phone, and must
// never push the title out, overlap Explore or grow past its tile.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs";

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const environment = await createReferenceDashboardEnvironment(repository, process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015");
const browser = await chromium.launch({ headless: true });
try {
  const providerId = environment.providerIds.metrics;
  const link = { id: "service", title: "Service detail", dashboardId: "series-picker", carryTimeRange: true, bindings: [{ variable: "service", source: "label", value: "service" }] };
  const widget = (id, type, title, layout) => ({ id, title, type, providerId, query: id, unit: "req/s", drilldowns: [link], layout });
  const dashboard = {
    schemaVersion: 1, id: "series-picker", title: "Series picker", timeRange: "1h", refreshInterval: 0,
    variables: [{ name: "service" }],
    widgets: [
      widget("bars", "bar", "Requests by service", { x: 0, y: 0, w: 4, h: 4 }),
      widget("kpi", "stat", "Request rate", { x: 4, y: 0, w: 2, h: 2 }),
      widget("narrow", "bar", "Errors by service across every region", { x: 6, y: 0, w: 2, h: 4 }),
      widget("trend", "timeseries", "Latency by service", { x: 8, y: 0, w: 4, h: 4 }),
    ],
  };
  await environment.api(`dashboards/${dashboard.id}`, "PUT", dashboard, { "If-None-Match": "*" });
  const now = Date.now();
  const series = ["checkout", "payments", "search"].map((service, index) => ({
    name: service, labels: { service }, points: [0, 1, 2, 3].map(step => ({ timestamp: now - (3 - step) * 60_000, value: 10 * (index + 1) + step })),
  }));

  const measure = page => page.evaluate(ids => ids.map(id => {
    const card = document.querySelector(`[data-widget-id="${id}"]`);
    if (!card) return { id, missing: true };
    const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const header = card.querySelector("[class*='tileHeader']");
    const picker = card.querySelector("[aria-label^='Series for ']");
    const explore = [...card.querySelectorAll("button")].find(button => /Explore/.test(button.textContent ?? ""));
    return { id, card: box(card), header: box(header), title: box(card.querySelector("h3")), picker: box(picker), explore: box(explore), inHeader: !!picker && header?.contains(picker) };
  }), dashboard.widgets.map(entry => entry.id));

  const check = (label, tiles) => {
    for (const tile of tiles) {
      assert.ok(!tile.missing, `${label}: ${tile.id} renders`);
      assert.ok(tile.picker, `${label}: ${tile.id} offers the series picker`);
      assert.ok(tile.inHeader, `${label}: ${tile.id} picker sits in the tile header`);
      assert.ok(tile.picker.width >= 44, `${label}: ${tile.id} picker is at least 44px wide (${tile.picker.width})`);
      assert.ok(tile.picker.left >= tile.card.left - 0.5 && tile.picker.right <= tile.card.right + 0.5, `${label}: ${tile.id} picker stays inside its tile`);
      assert.ok(tile.title.width >= 40, `${label}: ${tile.id} title keeps room (${tile.title.width})`);
      if (tile.explore) assert.ok(tile.picker.right <= tile.explore.left + 0.5, `${label}: ${tile.id} picker does not overlap Explore`);
      // A narrow tile wraps the controls under the title: the header is at most the title plus one control row.
      assert.ok(tile.header.height <= tile.title.height + 64, `${label}: ${tile.id} header height ${tile.header.height}, title ${tile.title.height}`);
      // The picker names its placeholder in full ("Series"), rather than an ellipsis.
      assert.ok(tile.picker.width >= 72, `${label}: ${tile.id} picker shows its label (${tile.picker.width})`);
    }
  };

  const scenarios = [
    { label: "standard 1512px", viewport: { width: 1512, height: 982 } },
    { label: "Compact 1512px", viewport: { width: 1512, height: 982 }, compact: true },
    { label: "phone 390px", viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true },
  ];
  for (const scenario of scenarios) {
    const context = await browser.newContext({ viewport: scenario.viewport, hasTouch: !!scenario.hasTouch, isMobile: !!scenario.isMobile });
    const page = await context.newPage();
    await environment.installQueryFixture(page, () => ({ series }));
    try {
      await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      if (scenario.compact) {
        await page.getByRole("button", { name: "Compact view", exact: true }).click();
        await page.waitForFunction(() => document.querySelector('[data-density="compact"]') !== null);
      }
      await page.getByRole("combobox", { name: "Series for Requests by service" }).waitFor();
      for (const id of dashboard.widgets.map(entry => entry.id)) await page.locator(`[data-widget-id="${id}"]`).scrollIntoViewIfNeeded();
      const tiles = await measure(page);
      if (process.env.SERIES_PICKER_SHOTS) {
        await page.screenshot({ path: `${process.env.SERIES_PICKER_SHOTS}/${scenario.label.replace(/\W+/g, "-")}.png`, fullPage: true });
        console.log(scenario.label, JSON.stringify(tiles));
      }
      check(scenario.label, tiles);
      // The keyboard reaches the picker and picks a series; one caption names it.
      const picker = page.getByRole("combobox", { name: "Series for Request rate" });
      await picker.focus();
      await page.keyboard.press("Enter");
      await page.getByRole("option", { name: /payments/ }).click();
      const card = page.locator('[data-widget-id="kpi"]');
      await card.getByText("Selected: payments", { exact: true }).waitFor();
      assert.equal(await card.getByRole("status").filter({ hasText: "Selected:" }).count(), 1, `${scenario.label}: one visible caption`);
      console.log(`PASS ${scenario.label}`);
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await environment.close();
}
