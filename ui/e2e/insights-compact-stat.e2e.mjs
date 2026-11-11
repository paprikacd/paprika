import { applyWidgetChanges } from "./gamma-controls.mjs";
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
  // A regular two-row KPI must use the full card reading/history body,
  // without breaking the existing one-row compact and mobile behaviour.
  dashboard.widgets.push({ ...widget("roomy", 0, { showSparkline: true, sparklinePlacement: "side", statIcon: "activity", decimals: 2 }),
    title: "Roomy service rate", layout: { x: 0, y: 1, w: 4, h: 2 } });
  // Edit-mode geometry cases: Explore on a one-row stat, a one-column stat, and a title that fits in view mode.
  const exploreLink = { id: "inspect", title: "Inspect service", dashboardId: "compact-kpi", carryTimeRange: true, bindings: [{ variable: "service", source: "label", value: "service" }] };
  dashboard.widgets.push({ ...widget("explore", 4, { showSparkline: true, decimals: 2 }), title: "Ingress explored", drilldowns: [exploreLink], layout: { x: 4, y: 1, w: 4, h: 1 } });
  dashboard.widgets.push({ ...widget("narrow", 8, { showSparkline: true, decimals: 2 }), title: "Narrow errors", layout: { x: 8, y: 1, w: 1, h: 2 } });
  dashboard.widgets.push({ ...widget("titleFit", 9, { decimals: 2 }), title: "Checkout availability across every region", layout: { x: 9, y: 1, w: 3, h: 1 } });
  // A breached one-row card with a long label on a narrow column: the reading must stay whole and clear of the chip,
  // which gives way by ellipsis and then collapses to its glyph (the status word stays for screen readers).
  dashboard.widgets.push({ ...widget("breach", 0, { showSparkline: true, sparklinePlacement: "side", decimals: 2, thresholds: [{ value: 0, status: "ok" }, { value: 10, status: "critical", label: "Above the monthly error budget of 0.1%" }] }), title: "Errors this month", layout: { x: 0, y: 3, w: 2, h: 1 } });
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
      await editor.getByRole("button", { name: "Apply changes" }).click();
      await applyWidgetChanges(page);
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click();
      assert.equal((await environment.api(`dashboards/${dashboard.id}`)).document.widgets[0].options.statIcon, "arrow-up", "Editor changes should persist through the dashboard API");
      const edited = (await environment.api(`dashboards/${dashboard.id}`)).document.widgets[0];
      assert.equal(edited.layout.h, 1);
      assert.deepEqual({ showStatBar: edited.options.showStatBar, min: edited.options.min, max: edited.options.max }, { showStatBar: true, min: 10, max: 200 });
    } finally { await context.close(); }
  }
  // Edit mode adds affordances to every header without changing its height, and never lets them cover
  // Explore, the sparkline, the title or a reading. Measured at 1512px with fine and touch pointers.
  const editIds = ["side", "background", "plain", "roomy", "explore", "narrow", "titleFit"];
  const measureTiles = page => page.evaluate(widgetIds => widgetIds.map(id => {
    const card = document.querySelector(`[data-widget-id="${id}"]`);
    const box = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const chip = card.querySelector("[data-widget-edit]");
    const chipStyle = chip ? getComputedStyle(chip) : null;
    const h3 = card.querySelector("h3");
    return {
      id,
      card: box(card),
      header: box(card.querySelector("[class*='tileHeader']")),
      h3: box(h3),
      h3Line: parseFloat(getComputedStyle(h3).lineHeight),
      chip: box(chip),
      chipColor: chipStyle?.color,
      cardBackground: getComputedStyle(card).backgroundColor,
      chipBackground: chipStyle?.backgroundColor,
      chipBefore: chip ? parseFloat(getComputedStyle(chip, "::before").width) : null,
      explore: box(card.querySelector('button[aria-label^="Open related dashboard"]')),
      value: box(card.querySelector("[data-metric-value]")),
      sparkline: box(card.querySelector("[data-stat-sparkline]")),
    };
  }), editIds);
  const overlaps = (a, b) => !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const inside = (a, b, tolerance = 1) => a.left >= b.left - tolerance && a.right <= b.right + tolerance && a.top >= b.top - tolerance && a.bottom <= b.bottom + tolerance;
  const describe = entry => JSON.stringify(entry);
  const luminance = color => {
    const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(channel => { const c = Number(channel) / 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; });
    return .2126 * r + .7152 * g + .0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  const assertEditGeometry = (view, edit, label) => {
    for (const entry of edit) {
      const before = view[entry.id];
      assert.ok(entry.chip, `${label} ${entry.id}: edit mode must offer the Edit affordance: ${describe(entry)}`);
      assert.ok(Math.abs(entry.header.height - before.header.height) < .5, `${label} ${entry.id}: edit mode must not change the header height (${before.header.height} to ${entry.header.height}): ${describe(entry)}`);
      assert.ok(inside(entry.chip, entry.header, .5), `${label} ${entry.id}: the chip must stay inside the header band: ${describe(entry)}`);
      assert.ok(inside(entry.chip, entry.card, .5), `${label} ${entry.id}: the chip must stay inside its card: ${describe(entry)}`);
      assert.ok(!overlaps(entry.chip, entry.explore), `${label} ${entry.id}: the chip must not cover Explore: ${describe(entry)}`);
      assert.ok(!overlaps(entry.chip, entry.sparkline), `${label} ${entry.id}: the chip must not cover the sparkline: ${describe(entry)}`);
      assert.ok(!overlaps(entry.chip, entry.value), `${label} ${entry.id}: the chip must not cover the reading: ${describe(entry)}`);
      assert.ok(!overlaps(entry.chip, entry.h3), `${label} ${entry.id}: the chip must not cover the title: ${describe(entry)}`);
      assert.ok(entry.h3.height <= entry.h3Line + .5, `${label} ${entry.id}: the title must stay on one line in edit mode: ${describe(entry)}`);
      // Edit mode must not move a reading. Where the view mode already fits it, edit mode must keep it inside its card.
      // Compare offsets within the card: entering edit mode also shifts the page.
      const offset = (box, card) => [box.top - card.top, box.bottom - card.top];
      const [viewTop, viewBottom] = offset(before.value, before.card), [editTop, editBottom] = offset(entry.value, entry.card);
      assert.ok(Math.abs(editTop - viewTop) < .5 && Math.abs(editBottom - viewBottom) < .5, `${label} ${entry.id}: edit mode must not move the reading: ${describe({ view: before.value, edit: entry.value })}`);
      if (inside(before.value, before.card)) assert.ok(inside(entry.value, entry.card) && entry.value.top >= entry.header.bottom - .5, `${label} ${entry.id}: the reading must stay inside its card below the header: ${describe(entry)}`);
      assert.ok(contrast(entry.chipColor, entry.cardBackground) >= 3, `${label} ${entry.id}: the chip icon must keep 3:1 against its tile: ${describe(entry)}`);
      assert.equal(entry.chipBackground, "rgba(0, 0, 0, 0)", `${label} ${entry.id}: the chip must be transparent so its icon follows the tile`);
    }
  };
  {
    const context = await browser.newContext({ viewport: { width: 1512, height: 900 } });
    const page = await context.newPage();
    await environment.installQueryFixture(page, () => ({ series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: Date.now() - 60000, value: 14 }, { timestamp: Date.now(), value: 42.34 }] }] }));
    try {
      await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      for (const id of editIds) await page.locator(`[data-widget-id="${id}"] [data-metric-value]`).first().waitFor();
      const view = Object.fromEntries((await measureTiles(page)).map(entry => [entry.id, entry]));
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click();
      for (const id of editIds) await page.locator(`[data-widget-id="${id}"] [data-widget-edit]`).waitFor();
      assertEditGeometry(view, await measureTiles(page), "fine 1512");
      // Keyboard focus draws its ring inside the chip, where the tile's overflow clip cannot cut it.
      for (const id of ["side", "roomy"]) {
        const chip = page.locator(`[data-widget-id="${id}"] [data-widget-edit]`);
        await chip.focus();
        await page.keyboard.press("Tab");
        await page.keyboard.press("Shift+Tab");
        const ring = await chip.evaluate(node => { const cs = getComputedStyle(node); return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), offset: parseFloat(cs.outlineOffset), focused: document.activeElement === node, visible: node.matches(":focus-visible") }; });
        assert.ok(ring.focused && ring.visible, `${id}: Edit chip must take keyboard focus: ${JSON.stringify(ring)}`);
        assert.equal(ring.style, "solid", `${id}: focus ring must be drawn: ${JSON.stringify(ring)}`);
        assert.ok(ring.offset <= 0 && ring.width > 0, `${id}: focus ring must sit inside the chip so the tile clip cannot cut it: ${JSON.stringify(ring)}`);
        assert.equal(await chip.getAttribute("aria-label"), `Edit ${id === "side" ? "Ingress" : "Roomy service rate"}`);
      }
    } finally { await context.close(); }
  }
  {
    // Touch: the visible chip keeps its size; the 44px target is a transparent hit area.
    const context = await browser.newContext({ viewport: { width: 1512, height: 900 }, hasTouch: true });
    const page = await context.newPage();
    await environment.installQueryFixture(page, () => ({ series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: Date.now() - 60000, value: 14 }, { timestamp: Date.now(), value: 42.34 }] }] }));
    try {
      await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" });
      await page.locator('[data-widget-id="side"] [data-metric-value]').first().waitFor();
      const view = Object.fromEntries((await measureTiles(page)).map(entry => [entry.id, entry]));
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click();
      for (const id of editIds) await page.locator(`[data-widget-id="${id}"] [data-widget-edit]`).waitFor();
      assert.equal(await page.evaluate(() => matchMedia("(pointer: coarse)").matches), true, "touch context must report a coarse pointer");
      const edit = await measureTiles(page);
      assertEditGeometry(view, edit, "touch 1512");
      for (const entry of edit) assert.equal(entry.chipBefore, 44, `touch ${entry.id}: the touch target must be 44px: ${describe(entry)}`);
      for (const entry of edit) assert.ok(entry.chip.width <= 32.5, `touch ${entry.id}: the visible chip must stay at its normal size: ${describe(entry)}`);
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
      // Stat cards taller than the 40px compact band fit their box: the band's own overflow:auto rule covers shorter ones.
      const scrolling = await page.locator("article[data-widget-id]").evaluateAll(tiles => tiles.flatMap(tile => {
        const summary = tile.querySelector("[data-stat-summary]");
        if (!summary) return [];
        const stat = summary.parentElement;
        return stat.clientHeight > 40 && stat.scrollHeight > stat.clientHeight + 1 ? [{ id: tile.dataset.widgetId, scrollHeight: stat.scrollHeight, clientHeight: stat.clientHeight }] : [];
      }));
      assert.deepEqual(scrolling, [], "Stat cards must not scroll internally");
      const measurements = await side.evaluate(card => {
        const bounds = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        const chain = []; for (let p = card.querySelector("[data-metric-value]"); p && p !== card; p = p.parentElement) { const cs = getComputedStyle(p); chain.push({ tag:p.tagName, class:p.className, box:bounds(p), display:cs.display, flex:cs.flex, minHeight:cs.minHeight, overflow:cs.overflow }); }
        return { chain, card: bounds(card), value: bounds(card.querySelector('[data-metric-value]')), plot: bounds(card.querySelector('[data-stat-sparkline]')), icon: bounds(card.querySelector('[aria-hidden="true"]')), headingFont: getComputedStyle(card.querySelector('h3')).fontFamily, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      assert.equal(measurements.pageOverflow, false, `${theme} ${viewport.width}: page overflow`);
      const roomy = page.locator('[data-widget-id="roomy"]');
      await roomy.locator('[data-metric-value="42.34"]').waitFor();
      const fullKPI = await roomy.evaluate(card => {
        const bounds = element => {
          const box = element.getBoundingClientRect();
          return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height };
        };
        const stat = card.querySelector('[data-stat-sparkline-enabled="true"]');
        const value = card.querySelector('[data-metric-value]');
        const plot = card.querySelector('[data-stat-sparkline]');
        return {
          card: bounds(card), title: bounds(card.querySelector('h3')),
          value: bounds(value), plot: bounds(plot),
          fontSize: Number.parseFloat(getComputedStyle(value).fontSize),
          innerScroll: stat.scrollHeight > stat.clientHeight + 1,
        };
      });
      assert.equal(fullKPI.innerScroll, false, `${theme} ${viewport.width}: two-row KPI must never scroll inside the card: ${JSON.stringify(fullKPI)}`);
      assert.ok(fullKPI.fontSize >= (viewport.width >= 600 ? 28 : 26), `two-row KPI value should dominate: ${JSON.stringify(fullKPI)}`);
      assert.ok(fullKPI.plot.height >= (viewport.width >= 600 ? 42 : 38), `trend must use available vertical space: ${JSON.stringify(fullKPI)}`);
      assert.ok(fullKPI.value.top >= fullKPI.title.bottom - 1 && fullKPI.value.bottom <= fullKPI.card.bottom,
        `the prominent reading must fit its KPI card: ${JSON.stringify(fullKPI)}`);
      assert.ok(fullKPI.plot.top >= fullKPI.card.top && fullKPI.plot.bottom <= fullKPI.card.bottom + 1,
        `the expanded trend must fit its KPI card: ${JSON.stringify(fullKPI)}`);
      assert.ok(measurements.plot.width > 15 && measurements.plot.height >= 20, `side sparkline has drawable area: ${JSON.stringify(measurements)}`);
      assert.ok(measurements.plot.left >= measurements.value.right - 1, `sparkline must sit beside the value: ${JSON.stringify(measurements)}`);
      assert.ok(measurements.plot.top >= measurements.card.top && measurements.plot.bottom <= measurements.card.bottom + 1 && measurements.value.top >= measurements.card.top && measurements.value.bottom <= measurements.card.bottom + 1, `reading and trend must fit vertically: ${JSON.stringify(measurements)}`);
      assert.ok(measurements.plot.right <= measurements.card.right + 1 && measurements.value.left >= measurements.card.left - 1, `reading and trend must fit card: ${JSON.stringify(measurements)}`);
      assert.ok(!measurements.headingFont.includes("Barlow Condensed"), `normal UI face expected: ${measurements.headingFont}`);
      assert.equal(await side.getAttribute("data-stat-icon"), "true");
      assert.equal(await page.locator('[data-widget-id="background"] [data-stat-summary]').getAttribute("data-sparkline-placement"), "background");
      const backdrop = await page.locator('[data-widget-id="background"]').evaluate(card => { const c = card.getBoundingClientRect(), v = card.querySelector('[data-metric-value]').getBoundingClientRect(); const chain = []; for (let p = card.querySelector('[data-metric-value]'); p && p !== card; p = p.parentElement) { const r = p.getBoundingClientRect(), st = getComputedStyle(p); chain.push({ class: p.className, top: r.top, bottom: r.bottom, flex: st.flex, padding:st.padding, minHeight:st.minHeight }); } return { c: { top: c.top, bottom: c.bottom }, v: { top: v.top, bottom: v.bottom }, chain }; });
      assert.ok(backdrop.v.top >= backdrop.c.top && backdrop.v.bottom <= backdrop.c.bottom + 1, `backdrop value must fit: ${JSON.stringify(backdrop)}`);
      // Stacked phone layouts put this card below the fold, where its tile loads only once it is scrolled into view.
      const breach = page.locator('[data-widget-id="breach"]');
      await breach.scrollIntoViewIfNeeded();
      await breach.locator('[data-metric-value="42.34"]').waitFor();
      const breached = await breach.evaluate(card => {
        const box = node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width }; };
        const value = card.querySelector("[data-metric-value]"), chip = card.querySelector("[data-stat-chip]");
        return { card: box(card), value: box(value), chip: chip ? box(chip) : null, glyph: chip ? box(chip.querySelector('[aria-hidden="true"]')) : null, chipText: chip?.textContent ?? null };
      });
      assert.ok(breached.chip && breached.chipText?.includes("Critical"), `breached card must name its critical band: ${JSON.stringify(breached)}`);
      assert.ok(breached.value.left >= breached.card.left - 1 && breached.value.right <= breached.card.right + 1 && breached.value.top >= breached.card.top - 1 && breached.value.bottom <= breached.card.bottom + 1, `long-label chip must not push the reading out of its card: ${JSON.stringify(breached)}`);
      assert.ok(breached.value.right <= breached.chip.left + 1, `the reading must not run under the status chip: ${JSON.stringify(breached)}`);
      assert.ok(breached.chip.right <= breached.card.right + 1 && breached.chip.top >= breached.card.top - 1 && breached.chip.bottom <= breached.card.bottom + 1, `the chip must stay inside its card: ${JSON.stringify(breached)}`);
      assert.ok(breached.glyph && breached.glyph.width >= 10 && breached.glyph.left >= breached.chip.left - 1, `the status glyph must stay visible when the label collapses: ${JSON.stringify(breached)}`);
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
