// Isolated deterministic fixture test for the record-backed geo/honeycomb
// renderer, keyboard tooltip and responsive theme behavior.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { selectGammaOption } from "./gamma-controls.mjs";
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs";

const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015";
const output = resolve(process.cwd(), "../artifacts/insights/geo-heatmap");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
 for (const theme of ["Light", "Dark"]) for (const width of [1512,390]) for (const mode of ["map","grid"]) {
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, reducedMotion: "reduce" });
  try {
   const page = await context.newPage(), errors = []; page.on("pageerror", error => errors.push(error.message));
   const fixture = await installRichChartFixtureAPI(page, base);
   const dashboard = fixture.documents.get("example-artboard-edge-watch"), widget = dashboard.widgets.find(item => item.id === "locations");
   widget.pluginId = "geo-heatmap"; widget.config = { mode, latitude:"latitude", longitude:"longitude", label:"label", value:"value", aggregation:"sum", radius:18, maxRecords:200 };
   await page.goto(`${base}/dashboard/insights/?dashboard=${dashboard.id}`, {waitUntil:"networkidle"});
   await selectGammaOption(page, page.getByRole("combobox", { name:"Dashboard appearance", exact:true }), theme);
   const tile = page.locator('[data-widget-id="locations"]'); await tile.scrollIntoViewIfNeeded();
   const cells = tile.locator("[data-geo-cell]"); await cells.first().waitFor(); assert.ok(await cells.count() >= 3);
   if (mode === "grid" && width === 390) {
    const rects = await cells.evaluateAll(nodes => nodes.slice(0, 2).map(node => { const rect = node.closest("button").getBoundingClientRect(); return { left:rect.left, right:rect.right, width:rect.width }; }));
    assert.ok(rects.every(rect => rect.width >= 44)); assert.ok(rects[0].right <= rects[1].left + 1);
    assert.equal(await tile.getByText("Scroll horizontally to explore").isVisible(), true);
   }
   const button = tile.getByRole("button", {name:/Melbourne/}); await button.focus();
   const tooltip = page.getByRole("tooltip"); await tooltip.waitFor(); assert.ok((await tooltip.innerText()).includes("Sum of value"));
   await button.press("Enter"); assert.equal(await button.getAttribute("aria-pressed"), "true");
   await page.keyboard.press("Escape"); await tooltip.waitFor({state:"hidden"});
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
   await page.screenshot({path:resolve(output,`${theme.toLowerCase()}-${width}-${mode}.png`),animations:"disabled"});
   assert.deepEqual(errors, []); assert.deepEqual(fixture.failures, []);
   console.log(`PASS ${theme} ${width}px ${mode}: data cells, keyboard pin/dismiss and tooltip`);
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
