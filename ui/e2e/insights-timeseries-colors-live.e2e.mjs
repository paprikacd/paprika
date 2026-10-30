// Exact-label series colors through the real Insights store and Prometheus.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { selectGammaOption } from "./gamma-controls.mjs";

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1");
assert.equal(origin.hostname, "127.0.0.1");
const out = resolve(fileURLToPath(new URL("../../artifacts/insights/timeseries-colors-live", import.meta.url)));
await mkdir(out, { recursive: true });
const api = async (path, options) => {
  const response = await fetch(new URL(path, origin), options);
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`);
  return response;
};
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const source = await (await api("/api/insights/dashboards/local-gallery-reliability-room")).json();
    const id = `series-color-e2e-${Date.now()}-${width}-${theme.toLowerCase()}`;
    source.id = id; source.title = "Series color E2E"; source.timeRange = "1h";
    const burn = source.widgets.find(widget => widget.id === "burn");
    burn.options.seriesColors = [{ label: "window", value: "1h", color: "#348cf0" }, { label: "window", value: "6h", color: "#15c7a1" }];
    await api(`/api/insights/dashboards/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(source) });
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    try {
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" });
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme);
      const tile = page.locator('[data-widget-id="burn"]'); await tile.scrollIntoViewIfNeeded();
      const legend = tile.getByRole("list", { name: "Latest values by series" });
      const colorFor = name => legend.getByRole("listitem", { name: new RegExp(name) }).locator('[aria-hidden="true"]').first().evaluate(el => getComputedStyle(el).backgroundColor);
      await legend.getByRole("listitem", { name: /1h/ }).waitFor();
      assert.equal(await colorFor("1h"), "rgb(52, 140, 240)");
      assert.equal(await colorFor("6h"), "rgb(21, 199, 161)");
      const plot = tile.getByRole("img", { name: "Availability burn rate · request errors" });
      await plot.focus();
      const tooltip = page.getByRole("tooltip"); await tooltip.waitFor();
      const selected = tooltip.locator("[data-observation-series]");
      const series = await selected.getAttribute("data-observation-series");
      const glyph = tooltip.locator("li i").first();
      const tipColor = await glyph.evaluate(el => getComputedStyle(el).backgroundColor);
      assert.equal(tipColor, series.includes("1h") ? "rgb(52, 140, 240)" : "rgb(21, 199, 161)", "Tooltip swatch must match its selected line");
      await plot.press("Escape");
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click();
      await tile.getByRole("button", { name: "Edit Availability burn rate · request errors", exact: true }).click();
      const editor = page.getByRole("region", { name: "Widget editor" });
      await editor.getByRole("tab", { name: "Style" }).click();
      await editor.getByRole("textbox", { name: "Color rule 1 color" }).fill("#297ac0");
      await editor.getByRole("button", { name: "Apply widget" }).click();
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
      const savedResponse = await api(`/api/insights/dashboards/${id}`);
      const saved = await savedResponse.json();
      assert.equal(saved.widgets.find(widget => widget.id === "burn").options.seriesColors[0].color, "#297ac0");
      await page.reload({ waitUntil: "networkidle" });
      await tile.scrollIntoViewIfNeeded(); await legend.getByRole("listitem", { name: /1h/ }).waitFor();
      assert.equal(await colorFor("1h"), "rgb(41, 122, 192)");
      await selectGammaOption(page, page.getByRole("combobox", { name: "Service", exact: true }), "payments");
      await tile.scrollIntoViewIfNeeded(); await legend.getByRole("listitem", { name: /1h/ }).waitFor();
      assert.equal(await colorFor("1h"), "rgb(41, 122, 192)");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${out}/${theme.toLowerCase()}-${width}.png` });
      console.log(`PASS ${theme} ${width}px: real Prometheus series, tooltip color, save/reload and service filter`);
    } finally {
      await context.close();
      const current = await api(`/api/insights/dashboards/${id}`);
      const etag = current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag");
      assert.ok(etag); await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": etag } });
    }
  }
} finally { await browser.close(); }
