// Browser checks for daily observation timelines and calendars (sample-only fixtures).
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { selectGammaOption } from "./gamma-controls.mjs";
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs";
import { installUptimeExample, uptimeExampleResult } from "./fixtures/uptime-reference-data.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015";
const output = resolve(root, "artifacts/insights/uptime-views");
const errors = [];
let activePage;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1512, 390]) for (const theme of ["Light", "Dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1100 }, reducedMotion: "reduce" });
    const page = await context.newPage(); activePage = page;
    page.on("pageerror", error => errors.push(error.message));
    const fixture = await installRichChartFixtureAPI(page, base); installUptimeExample(fixture);
    const dashboard = fixture.documents.get("local-uptime-study");
    for (const widget of dashboard.widgets.filter(item => item.id === "sample-uptime-timeline" || item.id === "sample-uptime-calendar")) {
      widget.drilldowns = [{ id: "selected-value", title: "Inspect selected value", dashboardId: "local-uptime-study", bindings: [{ variable: "scope", source: "value" }] }];
    }
    await page.route("**/api/insights/query", async route => {
      const request = route.request().postDataJSON();
      if (!request.query?.startsWith("paprika_uptime_example_")) return route.fallback();
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(uptimeExampleResult(request)) });
    });
    await page.goto(`${base}/dashboard/insights/?dashboard=local-uptime-study`, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Monitor availability · Sample data", exact: true }).waitFor();
    await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme);
    for (const [id, rows] of [["sample-uptime-timeline", 5], ["sample-uptime-calendar", 1]]) {
      const widget = page.locator(`[data-widget-id="${id}"]`), cells = widget.locator("[data-uptime-key]");
      await widget.scrollIntoViewIfNeeded();
      await cells.first().waitFor({ state: "visible" });
      assert.equal(await cells.count(), rows * 31, `${id} should show the 31 UTC days covered by the sample query`);
      if (width >= 1200) {
        const visible = await cells.evaluateAll(nodes => nodes.every(node => {
          const rect = node.getBoundingClientRect(), region = node.closest('[role="region"]').getBoundingClientRect();
          return rect.left >= region.left - 1 && rect.right <= region.right + 1 && rect.top >= region.top - 1 && rect.bottom <= region.bottom + 1;
        }));
        assert.ok(visible, `All ${id} sample days should fit in the desktop fixture without clipping`);
      }
      assert.equal(await widget.locator('[data-uptime-key][tabindex="0"]').count(), 1, "Only one day is in the keyboard tab order");
      assert.ok(await widget.getByText("Not a measured uptime percentage").isVisible());
      const empty = widget.locator('[data-uptime-state="unknown"]').first();
      await empty.scrollIntoViewIfNeeded(); await empty.hover({ force: true });
      const detail = page.getByRole("tooltip");
      await detail.getByText("No recorded value", { exact: true }).waitFor();
      assert.equal(await detail.evaluate(element => element.parentElement === document.body), true, "Details must escape the widget");
      await empty.click({ force: true }); assert.equal(await empty.getAttribute("aria-pressed"), "true");
      await page.keyboard.press("Escape"); await detail.waitFor({ state: "hidden" });
      const known = widget.locator('[data-uptime-state="observed"]').first();
      await known.focus(); const prior = await known.getAttribute("data-uptime-key");
      await page.keyboard.press("ArrowRight");
      const focused = widget.locator("[data-uptime-key]:focus");
      assert.notEqual(await focused.getAttribute("data-uptime-key"), prior, "Arrow keys inspect the next day");
      await page.keyboard.press("Enter"); assert.equal(await focused.getAttribute("aria-pressed"), "true");
      await page.keyboard.press("Escape"); await detail.waitFor({ state: "hidden" });
      // The selected daily value feeds the host's real drilldown context. A
      // no-data day must clear the prior value instead of reusing it.
      await known.click({ force: true });
      const linkButton = widget.getByRole("button", { name: /^Open related dashboard from/ });
      await linkButton.focus(); await page.keyboard.press("Enter");
      let item = page.getByRole("menuitem", { name: /Inspect selected value/ });
      await item.waitFor({ state: "visible" });
      await page.keyboard.press("Escape"); await item.waitFor({ state: "hidden" });
      assert.equal(await known.getAttribute("aria-pressed"), "true", "Closing the menu must leave the pinned observation open");
      await page.keyboard.press("Escape"); await detail.waitFor({ state: "hidden" });
      assert.notEqual(await known.getAttribute("aria-pressed"), "true", "The second Escape closes the pinned observation");
      await known.click({ force: true });
      await linkButton.click();
      item = page.getByRole("menuitem", { name: /Inspect selected value/ });
      assert.notEqual(await item.getAttribute("aria-disabled"), "true", "A known selected sample provides a finite drilldown value");
      await page.keyboard.press("Escape");
      await empty.click({ force: true }); await linkButton.click();
      item = page.getByRole("menuitem", { name: /Inspect selected value/ });
      assert.equal(await item.getAttribute("aria-disabled"), "true", "An unknown day must clear a previously selected value");
      await linkButton.click();
      await item.waitFor({ state: "hidden" });
      await page.keyboard.press("Escape");
      await detail.waitFor({ state: "hidden" });
      await page.screenshot({ path: resolve(output, `${id}-${theme.toLowerCase()}-${width}.png`), fullPage: false, animations: "disabled" });
    }
    assert.deepEqual(fixture.failures, []); await context.close();
    console.log(`PASS ${theme} ${width}px daily calendar and timeline`);
  }
  assert.deepEqual(errors, []);
  console.log("4 daily observation browser cases passed.");
} catch (error) {
  if (activePage) {
    await activePage.screenshot({ path: resolve(output, "failure.png"), fullPage: false }).catch(() => {});
    console.error((await activePage.locator("body").innerText().catch(() => "")).slice(0, 4000));
  }
  throw error;
} finally { await browser.close(); }
