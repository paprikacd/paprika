// Optional real-provider E2E: genuine previous windows for independent
// directional series and stacked contributions. No requests are mocked.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1");
assert.equal(origin.hostname, "127.0.0.1", "Only the local gallery is supported");
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/rich-prior-live");
await mkdir(output, { recursive: true });
const cases = [
  { dashboard: "local-gallery-edge-watch", widget: "flow", label: "Previous directions" },
  { dashboard: "local-gallery-collection-control", widget: "throughput", label: "Previous stacked boundaries" },
];
const browser = await chromium.launch({ headless: true });
try {
  for (const { dashboard, widget, label } of cases) for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, colorScheme: theme, reducedMotion: "reduce" });
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme); }, { expected: origin.origin, theme });
    try {
      const page = await context.newPage(), errors = [], requests = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/insights/query" && response.request().method() === "POST" && response.ok()) {
          requests.push({ request: response.request().postDataJSON(), response: response.json().catch(() => null) });
        }
      });
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=${dashboard}`, { waitUntil: "networkidle" });
      const tile = page.locator(`[data-widget-id="${widget}"]`);
      await tile.scrollIntoViewIfNeeded();
      const compare = tile.getByRole("button", { name: /Compare window for/ });
      await compare.waitFor({ timeout: 30000 });
      await page.waitForLoadState("networkidle");
      await compare.click();
      const dialog = page.getByRole("dialog", { name: "Compare a window" });
      const start = dialog.getByRole("slider", { name: "Window start" }), end = dialog.getByRole("slider", { name: "Window end" });
      const max = Number(await end.getAttribute("max"));
      assert.ok(max > 10, "The provider must return real history for both windows");
      await end.fill(String(Math.floor(max * .75)));
      await start.fill(String(Math.floor(max * .4)));
      const selectedStart = Date.parse(await start.locator("..").locator("time").getAttribute("datetime"));
      const selectedEnd = Date.parse(await end.locator("..").locator("time").getAttribute("datetime"));
      const before = requests.length;
      await dialog.getByRole("button", { name: "Compare previous period" }).click();
      await dialog.getByRole("region", { name: "Previous period results" }).waitFor({ timeout: 30000 });
      const overlay = dialog.getByRole("button", { name: "Overlay previous period" });
      assert.equal(await overlay.isEnabled(), true, `${dashboard}: complete uniquely matched previous series must be available`);
      const priorCall = requests.slice(before).find(item => item.request.kind === "metrics" && item.request.end < selectedStart / 1000);
      assert.ok(priorCall, "A real preceding provider query must have been made");
      const frame = await priorCall.response;
      assert.ok(frame.series?.length > 0);
      const queryCount = requests.filter(item => item.request.query === priorCall.request.query).length;
      await overlay.click();
      const legend = tile.getByRole("group", { name: "Previous period overlay" });
      await legend.waitFor();
      assert.match(await legend.innerText(), new RegExp(label));
      assert.ok(await tile.locator('[data-prior-path][stroke-dasharray="5 4"]').count() > 0, "Real prior boundaries should be dashed");
      const first = legend.locator("[data-prior-original-first]").first();
      const original = Number(await first.getAttribute("data-prior-original-first")), aligned = Number(await first.getAttribute("data-prior-aligned-first"));
      assert.equal(aligned - original, selectedEnd - selectedStart);
      assert.ok(frame.series.some(series => series.points.some(point => point.timestamp === original)), "The inspector timestamp must come from the prior provider response");
      await page.screenshot({ path: resolve(output, `overlay-${widget}-${theme}-${width}.png`), animations: "disabled" });
      await tile.getByRole("button", { name: /Inspect chart data for .*Previous period/ }).click();
      await page.getByRole("dialog").waitFor();
      assert.ok(await page.getByRole("dialog").getByText(/1970|20\d\d/).count() > 0);
      await page.getByRole("dialog").getByRole("button", { name: /close/i }).click();
      await tile.getByRole("button", { name: "Reset chart zoom" }).click();
      assert.equal(await tile.getByRole("group", { name: "Previous period overlay" }).count(), 0);
      assert.equal(requests.filter(item => item.request.query === priorCall.request.query).length, queryCount, "Overlay and reset must not issue extra provider queries for this chart");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: resolve(output, `${widget}-${theme}-${width}.png`), animations: "disabled" });
      console.log(`PASS ${widget} ${theme} ${width}px: genuine prior period, aligned boundaries, original inspector and reset`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
