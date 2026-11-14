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
async function contour(button, state) {
 const observed = await button.evaluate(node => {
  const fill = node.querySelector('[data-geo-cell]'), outline = node.querySelector('[data-geo-outline]');
  const edge = outline?.querySelector('polygon:last-child'), buttonStyle = getComputedStyle(node);
  const rect = element => { const r = element.getBoundingClientRect(); return [r.x,r.y,r.width,r.height]; };
  return { rectangularOutline: buttonStyle.outlineStyle, shadow: buttonStyle.boxShadow,
   fill: getComputedStyle(fill).backgroundColor, hatch: getComputedStyle(fill).backgroundImage,
   filter: getComputedStyle(fill).filter, bounds: rect(fill),
   ring: edge ? { visible: getComputedStyle(outline).opacity === '1', stroke: getComputedStyle(edge).stroke,
    weight: parseFloat(getComputedStyle(edge).strokeWidth), vector: getComputedStyle(edge).vectorEffect,
    points: [...edge.points].flatMap(point => [point.x,point.y]), bounds: rect(outline),
    clip: getComputedStyle(fill).clipPath.match(/[\d.]+/g)?.map(Number), pointerEvents: getComputedStyle(outline).pointerEvents } : null };
 });
 assert.ok(observed.ring, `${state}: hex marks need a contour matching their six edges`);
 assert.equal(observed.rectangularOutline, 'none', `${state}: no square border around the hexagonal mark`);
 assert.equal(observed.shadow, 'none', `${state}: no rectangular shadow around the hit target`);
 assert.equal(observed.filter, 'none', `${state}: inspection preserves the encoded fill colour`);
 assert.equal(observed.ring.visible, state !== 'rest', `${state}: contour follows interaction state`);
 assert.equal(observed.ring.points.length, 12);
 assert.deepEqual(observed.ring.points, observed.ring.clip, `${state}: the border follows the actual painted polygon`);
 assert.deepEqual(observed.ring.bounds, observed.bounds, `${state}: border and fill share the same geometry`);
 assert.equal(observed.ring.vector, 'non-scaling-stroke', `${state}: resizing does not enlarge the border`);
 assert.equal(observed.ring.pointerEvents, 'none', `${state}: the border cannot steal pointer input`);
 if(state !== 'rest') assert.ok(observed.ring.weight >= 2 && observed.ring.stroke !== 'none');
 return observed;
}
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
    assert.equal(await tile.getByText("Scroll to explore all records").isVisible(), true);
   }
   const button = tile.getByRole("button", {name:/Melbourne/});
   await page.mouse.move(1,1);
   const rest = await contour(button, 'rest');
   await button.hover();
   const tooltip = page.getByRole("tooltip"); await tooltip.getByText("Sum of value", { exact: false }).first().waitFor();
   const hovered = await contour(button, 'hover');
   assert.equal(hovered.fill, rest.fill); assert.deepEqual(hovered.bounds, rest.bounds);
   await tile.screenshot({path:resolve(output,`${theme.toLowerCase()}-${width}-${mode}-hover.png`)});
   await button.click(); assert.equal(await button.getAttribute("aria-pressed"), "true");
   await page.mouse.move(1,1);
   await contour(button, 'pinned');
   await tile.screenshot({path:resolve(output,`${theme.toLowerCase()}-${width}-${mode}-pinned.png`)});
   await page.keyboard.press("Escape"); await tooltip.waitFor({state:"hidden"});
   await button.press('Tab'); await page.keyboard.press('Shift+Tab');
   assert.equal(await button.evaluate(node=>node.matches(':focus-visible')), true);
   await contour(button, 'focus');
   await tile.screenshot({path:resolve(output,`${theme.toLowerCase()}-${width}-${mode}-focus.png`)});
   await button.press("Enter"); assert.equal(await button.getAttribute("aria-pressed"), "true");
   await page.keyboard.press("Escape"); await tooltip.waitFor({state:"hidden"});
   assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
   await page.screenshot({path:resolve(output,`${theme.toLowerCase()}-${width}-${mode}.png`),animations:"disabled"});
   if (theme === 'Light' && width === 1512 && mode === 'grid') {
    await page.emulateMedia({forcedColors:'active'});
    await contour(button, 'focus');
    await tile.screenshot({path:resolve(output,'forced-colors-grid-focus.png')});
   }
   assert.deepEqual(errors, []); assert.deepEqual(fixture.failures, []);
   console.log(`PASS ${theme} ${width}px ${mode}: hex-shaped hover/pin/focus, unchanged fills and geometry, keyboard dismissal and tooltip`);
  } finally { await context.close(); }
 }
} finally { await browser.close(); }
