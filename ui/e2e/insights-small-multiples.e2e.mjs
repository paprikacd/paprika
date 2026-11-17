// Renderer-level integration with isolated deterministic provider responses.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { selectGammaOption } from "./gamma-controls.mjs";
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const output = resolve(root, "artifacts/insights/small-multiples");
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  for (const width of [1512, 390]) for (const theme of ["Light", "Dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1100 }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage(); page.setDefaultTimeout(15000);
      page.on("pageerror", error => errors.push(error.message));
      const fixture = await installRichChartFixtureAPI(page, base);
      const dashboard = fixture.documents.get("example-artboard-fleet-atlas");
      const widget = dashboard.widgets.find(item => item.id === "node-cpu");
      Object.assign(widget, { type: "plugin", pluginId: "small-multiples", dataKind: "metrics", config: { columns: 3, maxSeries: 6, maxPoints: 60 }, options: { min: 0, max: 100, showTooltip: true, showGrid: true, decimals: 2 } });
      if (width === 1512 && theme === "Light") Object.assign(widget.options, { background: "#f5f8f1", textColor: "#1c2630" });
      await page.goto(`${base}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor();
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme);
      const tile = page.locator('[data-widget-id="node-cpu"]'); await tile.scrollIntoViewIfNeeded();
      await tile.locator("[data-multiple-series]").first().waitFor();
      assert.equal(await tile.locator("[data-multiple-series]").count(), 6);
      const domains = await tile.locator("[data-domain-start]").evaluateAll(nodes => nodes.map(node => [node.dataset.domainStart, node.dataset.domainEnd, node.dataset.domainMin, node.dataset.domainMax]));
      assert.equal(new Set(domains.map(domain => JSON.stringify(domain))).size, 1, "Each series must share identical axes");
      assert.deepEqual(domains[0].slice(2), ["0", "100"]);
      const columns = await tile.locator("[data-multiple-series]").evaluateAll(nodes => new Set(nodes.map(node => Math.round(node.getBoundingClientRect().left))).size);
      assert.equal(columns, width === 390 ? 1 : 3, "Small multiples must reflow without changing the saved column preference");
      const sizing = await tile.locator('[data-multiple-series]').first().evaluate(node => {
        const svg = node.querySelector('svg').getBoundingClientRect();
        const text = node.querySelector('[aria-hidden="true"] span');
        return { plotWidth: svg.width, plotHeight: svg.height, fontSize: parseFloat(getComputedStyle(text).fontSize), tileWidth: node.getBoundingClientRect().width, background: getComputedStyle(node).backgroundColor, textColor: getComputedStyle(text).color };
      });
      assert.ok(sizing.plotWidth >= 50 && sizing.plotHeight >= 100, `Plots need drawable space: ${JSON.stringify(sizing)}`);
      assert.ok(sizing.fontSize >= 10, "HTML axis labels must not scale down inside SVG");
      if (width === 1512 && theme === "Light") { assert.equal(sizing.background, "rgb(245, 248, 241)"); assert.equal(sizing.textColor, "rgb(28, 38, 48)"); }
      const plot = tile.getByRole("group", { name: /node-01 trend/ }); await plot.scrollIntoViewIfNeeded(); await plot.focus();
      const tooltip = page.getByRole("tooltip"); await tooltip.getByText("Recorded sample").waitFor();
      const last = await tooltip.locator("time").getAttribute("datetime"); await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(previous => document.querySelector('[role="tooltip"] time')?.getAttribute("datetime") !== previous, last);
      await page.keyboard.press("Enter"); await page.keyboard.press("Escape"); await tooltip.waitFor({ state: "hidden" });
      await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "staging");
      await tile.scrollIntoViewIfNeeded();
      await page.waitForFunction(() => document.querySelectorAll('[data-widget-id="node-cpu"] [data-multiple-series]').length === 4);
      if (width === 390) {
        const scroll = tile.getByRole("region", { name: "CPU utilization by node trends" });
        await tile.getByText("Scroll to see all series").waitFor();
        assert.equal(await scroll.getAttribute("tabindex"), "0", "The overflowing small-multiples region must be keyboard accessible");
        await scroll.focus(); await scroll.press("End");
        await page.waitForFunction(() => { const node = document.querySelector('[data-widget-id="node-cpu"] [role="region"]'); return node.scrollTop >= node.scrollHeight - node.clientHeight - 1; });
        await scroll.press("Home");
        await page.waitForFunction(() => document.querySelector('[data-widget-id="node-cpu"] [role="region"]').scrollTop === 0);
      }
      await page.screenshot({ path: resolve(output, `${theme.toLowerCase()}-${width}.png`), animations: "disabled" });
      assert.deepEqual(fixture.failures, []);
      console.log(`PASS ${theme} ${width}px shared axes, tooltip keyboard selection and cluster filter`);
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []); console.log("4 small-multiples browser cases passed.");
} finally { await browser.close(); }
