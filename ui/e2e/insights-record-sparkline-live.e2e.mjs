// Optional read-only validation of the seeded local PostgreSQL demo through
// its real Insights/Observe gateway. No request or provider data is mocked.
// Point PAPRIKA_GALLERY_BASE_URL at the authenticated local demo proxy, or
// provide PAPRIKA_GALLERY_CONNECTION_FILE for the private Go harness.
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ready = process.env.PAPRIKA_GALLERY_CONNECTION_FILE;
const proxyURL = process.env.PAPRIKA_GALLERY_BASE_URL;
if (!ready && !proxyURL) throw Error("Set PAPRIKA_GALLERY_BASE_URL or PAPRIKA_GALLERY_CONNECTION_FILE for the local demo");
const connection = proxyURL ? { baseURL: proxyURL } : JSON.parse(await readFile(ready, "utf8"));
const origin = new URL(connection.baseURL);
assert.equal(origin.hostname, "127.0.0.1", "Only the local demo gateway is permitted");
if (!proxyURL) assert.equal(typeof connection.token, "string", "A local test token is required");
const dashboard = process.env.PAPRIKA_GALLERY_MARKET_DASHBOARD || "local-gallery-market-lens";
const widgetId = process.env.PAPRIKA_GALLERY_RANKINGS_WIDGET || "rankings";
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/record-sparkline-live");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, colorScheme: theme, reducedMotion: "reduce" });
    try {
      const page = await context.newPage(), responses = [];
      page.on("pageerror", error => errors.push(error.message));
      if (connection.token) await context.addInitScript(({ origin, token }) => { if (location.origin === origin) localStorage.setItem("paprika_id_token", token); }, { origin: origin.origin, token: connection.token });
      page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/insights/query" && response.request().method() === "POST" && response.ok()) responses.push(response.json().catch(() => null));
      });
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=${encodeURIComponent(dashboard)}`, { waitUntil: "networkidle" });
      const widget = page.locator(`[data-widget-id=${JSON.stringify(widgetId)}]`);
      await widget.scrollIntoViewIfNeeded();
      const chart = widget.locator('[data-cell-display="sparkline"] [data-stat-sparkline]').first();
      await chart.waitFor({ state: "visible", timeout: 30000 });
      const frames = (await Promise.all(responses)).map(result => result?.records).filter(Boolean);
      const frame = frames.find(item => item.columns?.some(column => column.key === "history"));
      assert.ok(frame, "The real gateway must return a records frame with the configured history column");
      const index = frame.columns.findIndex(column => column.key === "history");
      const source = JSON.parse(frame.rows[0][index]);
      assert.ok(source.length >= 2, "PostgreSQL must return actual timestamped history");
      assert.equal(await chart.getAttribute("data-sample-count"), String(source.length));
      assert.equal(await chart.getAttribute("data-history-start"), String(Date.parse(source[0].timestamp)));
      assert.equal(await chart.getAttribute("data-history-end"), String(Date.parse(source.at(-1).timestamp)));
      const finite = source.filter(point => typeof point.value === "number" && Number.isFinite(point.value));
      assert.ok(finite.length > 0, "PostgreSQL must return finite observations");
      assert.equal(Number(await chart.getAttribute("data-history-min")), Math.min(...finite.map(point => point.value)));
      assert.equal(Number(await chart.getAttribute("data-history-max")), Math.max(...finite.map(point => point.value)));
      assert.equal(await chart.getAttribute("data-latest-valid-time"), String(Date.parse(finite.at(-1).timestamp)));
      assert.equal(await widget.locator('[data-cell-display="sparkline"][data-history-state="invalid"]').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), animations: "disabled" });
      console.log(`PASS ${theme} ${width}px: PostgreSQL history through Observe and Insights into record-table sparkline`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  console.log("4 real PostgreSQL history browser cases passed.");
} finally { await browser.close(); }
