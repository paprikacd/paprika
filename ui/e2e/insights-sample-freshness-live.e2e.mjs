// Exercise optional returned-sample age through the real editor, Insights
// persistence and the local Prometheus/Observe path. Only unique local
// dashboards are written and each is deleted with its current ETag.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { selectGammaOption } from "./gamma-controls.mjs";

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1");
assert.equal(origin.hostname, "127.0.0.1");
async function api(path, options) {
  const response = await fetch(new URL(path, origin), options);
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response;
}
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const document = await (await api("/api/insights/dashboards/local-gallery-signal-kit")).json();
    const id = `freshness-e2e-${Date.now()}-${theme.toLowerCase()}-${width}`;
    document.id = id; document.title = "Sample freshness E2E";
    const old = document.widgets.find(widget => widget.id === "expected-stale");
    delete old.options.staleAfterSeconds;
    const created = await api(`/api/insights/dashboards/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) });
    const initialETag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag");
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" });
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme);
      const tile = page.locator('[data-widget-id="expected-stale"]');
      await tile.scrollIntoViewIfNeeded();
      await tile.locator("[data-stat-sparkline]").waitFor();
      assert.equal(await tile.locator("[data-stale-observation]").count(), 0, "Threshold is opt-in");
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click();
      await tile.getByRole("button", { name: "Edit Old returned samples · expected", exact: true }).click();
      const editor = page.getByRole("region", { name: "Widget editor" });
      await editor.getByRole("tab", { name: "Style" }).click();
      await editor.getByRole("spinbutton", { name: "Warn when last valid sample is older than (seconds)" }).fill("300");
      await tile.locator("[data-stale-observation]").waitFor();
      await editor.getByRole("button", { name: "Apply widget" }).click();
      const write = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/insights/dashboards/${id}` && response.ok());
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
      await write;
      const savedResponse = await api(`/api/insights/dashboards/${id}`), saved = await savedResponse.json();
      assert.equal(saved.widgets.find(widget => widget.id === old.id).options.staleAfterSeconds, 300);
      assert.notEqual(savedResponse.headers.get("x-paprika-document-etag") ?? savedResponse.headers.get("etag"), initialETag);
      await page.reload({ waitUntil: "networkidle" });
      await tile.scrollIntoViewIfNeeded();
      await tile.locator("[data-stale-observation]").waitFor();
      assert.ok(await tile.locator("[data-stat-sparkline]").count());
      assert.deepEqual(errors, []);
      console.log(`PASS ${theme} ${width}px: configure, preview, save and reload returned-sample age`);
    } finally {
      await context.close();
      const current = await api(`/api/insights/dashboards/${id}`);
      const etag = current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag");
      assert.ok(etag);
      await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": etag } });
    }
  }
} finally { await browser.close(); }
