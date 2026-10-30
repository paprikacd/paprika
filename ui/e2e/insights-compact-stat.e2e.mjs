// Exercise compact and backdrop KPI presentations through the real document API
// and browser layout at desktop and mobile sizes. Query values are deterministic.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs";
import { selectGammaOption } from "./gamma-controls.mjs";

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const environment = await createReferenceDashboardEnvironment(repository, process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015");
const browser = await chromium.launch({ headless: true });
try {
  const providerId = environment.providerIds.metrics;
  const widget = (id, x, options) => ({ id, title: id === "side" ? "Ingress" : id === "background" ? "Egress" : "Target (SLO)", type: "stat", providerId, query: id, unit: "Mb/s", color: "#008fab", options, layout: { x, y: 0, w: 4, h: 1 } });
  const dashboard = { schemaVersion: 1, id: "compact-kpi", title: "Compact KPI", timeRange: "1h", refreshInterval: 0, widgets: [widget("side", 0, { showSparkline: true, sparklinePlacement: "side", statIcon: "arrow-down", decimals: 2 }), widget("background", 4, { showSparkline: true }), widget("plain", 8, { showSparkline: false, statIcon: "target", decimals: 2, showStatBar: true, min: 0, max: 100, thresholds: [{ value: 0, color: "#008866" }, { value: 40, color: "#dd8800" }] })] };
  await environment.api(`dashboards/${dashboard.id}`, "PUT", dashboard, { "If-None-Match": "*" });
  const saved = (await environment.api(`dashboards/${dashboard.id}`)).document;
  assert.equal(saved.widgets[0].options.sparklinePlacement, "side");
  assert.equal(saved.widgets[0].options.statIcon, "arrow-down");
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await environment.installQueryFixture(page, () => ({ series: [{ name: "api", labels: {}, points: [{ timestamp: Date.now(), value: 42.34 }] }] }));
    try {
      await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click();
      await page.getByRole("button", { name: "Edit Ingress", exact: true }).click();
      const editor = page.getByRole("region", { name: "Widget editor" });
      await editor.getByRole("tab", { name: "Style" }).click();
      await selectGammaOption(page, editor.getByRole("combobox", { name: "Stat icon" }), "Arrow up");
      await editor.getByRole("switch", { name: /^Show value bar/ }).check();
      await editor.getByLabel("Bar minimum").fill("10");
      await editor.getByLabel("Bar maximum").fill("200");
      await editor.getByRole("tab", { name: "Layout" }).click();
      assert.ok((await editor.getByRole("combobox", { name: "Height" }).innerText()).includes("1 row"));
      await editor.getByRole("button", { name: "Apply widget" }).click();
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
      assert.equal((await environment.api(`dashboards/${dashboard.id}`)).document.widgets[0].options.statIcon, "arrow-up", "Editor changes should persist through the dashboard API");
      const edited = (await environment.api(`dashboards/${dashboard.id}`)).document.widgets[0];
      assert.equal(edited.layout.h, 1);
      assert.deepEqual({ showStatBar: edited.options.showStatBar, min: edited.options.min, max: edited.options.max }, { showStatBar: true, min: 10, max: 200 });
    } finally { await context.close(); }
  }
  for (const theme of ["light", "dark"]) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce", ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    const errors = []; page.on("pageerror", error => errors.push(error.message));
    await environment.installQueryFixture(page, () => ({ series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: Date.now() - 60000, value: 14 }, { timestamp: Date.now(), value: 42.34 }] }] }));
    try {
      await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      const side = page.locator('[data-widget-id="side"]');
      await side.locator('[data-metric-value="42.34"]').waitFor();
      const measurements = await side.evaluate(card => {
        const bounds = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const chain = []; for (let p = card.querySelector("[data-metric-value]"); p && p !== card; p = p.parentElement) { const cs = getComputedStyle(p); chain.push({ tag:p.tagName, class:p.className, box:bounds(p), display:cs.display, flex:cs.flex, minHeight:cs.minHeight, overflow:cs.overflow }); }
        return { chain, card: bounds(card), value: bounds(card.querySelector('[data-metric-value]')), plot: bounds(card.querySelector('[data-stat-sparkline]')), icon: bounds(card.querySelector('[aria-hidden="true"]')), headingFont: getComputedStyle(card.querySelector('h3')).fontFamily, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      assert.equal(measurements.pageOverflow, false, `${theme} ${viewport.width}: page overflow`);
      assert.ok(measurements.plot.width > 15 && measurements.plot.height >= 20, `side sparkline has drawable area: ${JSON.stringify(measurements)}`);
      assert.ok(measurements.plot.left >= measurements.value.right - 1, `sparkline must sit beside the value: ${JSON.stringify(measurements)}`);
      assert.ok(measurements.plot.top >= measurements.card.top && measurements.plot.bottom <= measurements.card.bottom + 1 && measurements.value.top >= measurements.card.top && measurements.value.bottom <= measurements.card.bottom + 1, `reading and trend must fit vertically: ${JSON.stringify(measurements)}`);
      assert.ok(measurements.plot.right <= measurements.card.right + 1 && measurements.value.left >= measurements.card.left - 1, `reading and trend must fit card: ${JSON.stringify(measurements)}`);
      assert.ok(!measurements.headingFont.includes("Barlow Condensed"), `normal UI face expected: ${measurements.headingFont}`);
      assert.equal(await side.getAttribute("data-stat-icon"), "true");
      assert.equal(await page.locator('[data-widget-id="background"] [data-stat-summary]').getAttribute("data-sparkline-placement"), "background");
      const backdrop = await page.locator('[data-widget-id="background"]').evaluate(card => { const c = card.getBoundingClientRect(), v = card.querySelector('[data-metric-value]').getBoundingClientRect(); const chain = []; for (let p = card.querySelector('[data-metric-value]'); p && p !== card; p = p.parentElement) { const r = p.getBoundingClientRect(), st = getComputedStyle(p); chain.push({ class: p.className, top: r.top, bottom: r.bottom, flex: st.flex, padding:st.padding, minHeight:st.minHeight }); } return { c: { top: c.top, bottom: c.bottom }, v: { top: v.top, bottom: v.bottom }, chain }; });
      assert.ok(backdrop.v.top >= backdrop.c.top && backdrop.v.bottom <= backdrop.c.bottom + 1, `backdrop value must fit: ${JSON.stringify(backdrop)}`);
      const plain = page.locator('[data-widget-id="plain"]');
      await plain.locator('[data-metric-value="42.34"]').waitFor();
      const plainBounds = await plain.evaluate(card => {
        const bounds = node => { const r = node.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom }; };
        const value = card.querySelector('[data-metric-value]');
        const chain = []; for (let p = value; p && p !== card; p = p.parentElement) { const css = getComputedStyle(p); chain.push({ class:p.className, box:bounds(p), flex:css.flex, padding:css.padding, minHeight:css.minHeight }); }
        return { card:bounds(card), title:bounds(card.querySelector('h3')), value:bounds(value), chain };
      });
      assert.ok(plainBounds.value.top >= plainBounds.title.bottom - 1 && plainBounds.value.bottom <= plainBounds.card.bottom - 1, `icon stat without sparkline must be fully visible: ${JSON.stringify(plainBounds)}`);
      assert.equal(await plain.getAttribute("data-stat-icon"), "true");
      assert.equal(await plain.locator('[data-stat-sparkline]').count(), 0);
      const meter = plain.getByRole("meter", { name: "Target (SLO) value on configured scale" });
      assert.equal(await meter.getAttribute("aria-valuenow"), "42.34");
      assert.ok(Math.abs(Number(await meter.getAttribute("data-stat-bar-fraction")) - .4234) < .00001);
      const barBounds = await meter.evaluate(bar => { const c = bar.closest('[data-widget-id]').getBoundingClientRect(), b = bar.getBoundingClientRect(); return { card: { left: c.left, right: c.right, top: c.top, bottom: c.bottom }, bar: { left: b.left, right: b.right, top: b.top, bottom: b.bottom }, color: getComputedStyle(bar.firstElementChild).backgroundColor }; });
      assert.ok(barBounds.bar.left >= barBounds.card.left && barBounds.bar.right <= barBounds.card.right && barBounds.bar.top >= barBounds.card.top && barBounds.bar.bottom <= barBounds.card.bottom, `value bar fits: ${JSON.stringify(barBounds)}`);
      assert.equal(barBounds.color, "rgb(221, 136, 0)", "value bar uses the reached threshold color");
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `/tmp/paprika-compact-stat-${theme}-${viewport.width}.png`, fullPage: true });
      console.log(`PASS compact stat ${theme} ${viewport.width}`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); await environment.close(); }
