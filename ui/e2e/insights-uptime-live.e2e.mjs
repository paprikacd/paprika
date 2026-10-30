// The real Go Insights/Observe service owns documents and ETags. Only metric
// query responses use deterministic test observations; no production data.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { selectGammaOption } from "./gamma-controls.mjs";
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs";
import { uptimeExample, uptimeExampleQueries, uptimeExampleResult } from "./fixtures/uptime-reference-data.mjs";

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const staticURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015";
let environment, browser, context;
try {
  environment = await createReferenceDashboardEnvironment(repository, staticURL);
  for (const source of uptimeExampleQueries) {
    const query = { ...source, providerId: environment.providerIds.metrics };
    await environment.api(`saved-queries/${query.id}`, "PUT", query, { "If-None-Match": "*" });
  }
  const board = structuredClone(uptimeExample);
  board.widgets.forEach(widget => { widget.providerId = environment.providerIds.metrics; });
  await environment.api(`dashboards/${board.id}`, "PUT", board, { "If-None-Match": "*" });
  const original = await environment.api(`dashboards/${board.id}`);
  assert.ok(original.etag, "real storage returns a dashboard ETag");
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, reducedMotion: "reduce" });
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await environment.installQueryFixture(page, uptimeExampleResult);
  await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${board.id}`, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: board.title, exact: true }).waitFor();
  const grid = page.locator('[data-widget-id="sample-monitor-grid"]');
  await grid.locator('[data-status-index="0"]').waitFor();
  assert.equal(await grid.locator('[data-status-index]').count(), 480);
  await selectGammaOption(page, page.getByRole("combobox", { name: "Environment" }), "staging");
  await page.waitForFunction(() => document.querySelector('[data-widget-id="sample-monitor-grid"] [data-status-index="8"]')?.getAttribute("data-status-value") === "unknown");
  assert.ok(environment.queryCalls.some(call => call.request?.query.includes('scope="staging"')));
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).click();
  await page.getByRole("button", { name: "Edit Current monitor observations", exact: true }).click();
  const editor = page.getByRole("region", { name: "Widget editor" });
  await editor.getByRole("tab", { name: "Style" }).click();
  await editor.getByLabel("Threshold 1 label", { exact: true }).fill("Unavailable locally");
  await editor.getByRole("button", { name: "Apply widget" }).click();
  await editor.getByRole("button", { name: "Close widget editor" }).click();
  assert.equal((await environment.api(`dashboards/${board.id}`)).etag, original.etag, "draft is not persisted before Save");
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
  await page.getByText("All changes saved", { exact: true }).waitFor();
  const saved = await environment.api(`dashboards/${board.id}`);
  assert.notEqual(saved.etag, original.etag);
  assert.equal(saved.document.widgets.find(widget => widget.id === "sample-monitor-grid").options.thresholds[0].label, "Unavailable locally");
  assert.equal(saved.document.variables[0].defaultValue, "production");
  await environment.api(`dashboards/${board.id}`, "PUT", board, { "If-Match": original.etag }, 412);
  await page.reload({ waitUntil: "networkidle" });
  await grid.getByRole("button", { name: /Unavailable locally/ }).first().waitFor();
  assert.deepEqual(errors, []); assert.deepEqual(environment.failures, []);
  console.log("PASS real Insights service: uptime widgets, saved-query filter, draft preview, ETag save/conflict and reload");
} finally {
  await context?.close(); await browser?.close(); await environment?.close();
}
