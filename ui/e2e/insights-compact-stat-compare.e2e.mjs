// Comparing stats in compact layouts: the change chip must never clip its value, scroll the card, or sit over a sparkline.
// Measured at 1512 and 390 px, light and dark, with the same cards compared against an identical copy without compare.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs";

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const environment = await createReferenceDashboardEnvironment(repository, process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015");
const browser = await chromium.launch({ headless: true });
try {
  const providerId = environment.providerIds.metrics;
  const stat = (id, title, x, y, w, h, options, unit = "req/s") => ({ id, title, type: "stat", providerId, query: id, unit, options, layout: { x, y, w, h } });
  const compare = (window, good) => ({ window, ...(good ? { good } : {}) });
  const cards = [
    stat("w1h1", "Narrow one", 0, 0, 1, 1, { decimals: 2, compare: compare("previous", "up") }),
    stat("w2h1", "Two columns", 1, 0, 2, 1, { decimals: 2, showSparkline: true, sparklinePlacement: "side", compare: compare("1d", "down") }),
    stat("w3h1breach", "Breach and stale", 3, 0, 3, 1, { decimals: 2, staleAfterSeconds: 30, showSparkline: true, sparklinePlacement: "side", thresholds: [{ value: 0, status: "ok" }, { value: 10, status: "critical", label: "Above the monthly error budget" }], compare: compare("7d", "up") }),
    stat("w2h2breach", "Errors this month", 1, 1, 2, 2, { decimals: 2, staleAfterSeconds: 30, thresholds: [{ value: 0, status: "ok" }, { value: 10, status: "critical", label: "Above the monthly error budget of 0.1%" }], compare: compare("previous", "up") }),
    stat("w1h2", "Narrow two", 4, 1, 1, 2, { decimals: 2, showSparkline: true, compare: compare("previous", "up") }),
    stat("w3h2", "Three by two", 5, 1, 3, 2, { showSparkline: true, sparklinePlacement: "side", compare: compare("1d") }),
  ];
  const plain = { schemaVersion: 1, id: "compare-compact-plain", title: "Compare compact plain", timeRange: "1h", refreshInterval: 0, widgets: cards.map(card => ({ ...card, options: Object.fromEntries(Object.entries(card.options ?? {}).filter(([key]) => key !== "compare")) })) };
  const dashboard = { schemaVersion: 1, id: "compare-compact", title: "Compare compact", timeRange: "1h", refreshInterval: 0, widgets: cards };
  for (const document of [plain, dashboard]) await environment.api(`dashboards/${document.id}`, "PUT", document, { "If-None-Match": "*" });
  // A deterministic current value and an earlier value that differs, so every card has a change to show.
  const values = { w2h1: [42.34, 30], w3h1breach: [1234567.89, 1000000], w2h2breach: [12, 9], w1h2: [42.34, 30], w3h2: [7, 7.4] };
  const resolver = request => {
    const now = Date.now() / 1000;
    const earlier = request.start < now - 3600 - 120;
    const [current, prior] = values[request.query] ?? [42.34, 30];
    const end = request.end * 1000;
    // Breach and stale cards end their series five minutes before the range end, so they are stale.
    const last = request.query.includes("breach") ? end - 300_000 : end - 1000;
    return { series: [{ name: "api", labels: { service: "api" }, points: [{ timestamp: last - 60_000, value: (earlier ? prior : current) * 0.9 }, { timestamp: last, value: earlier ? prior : current }] }] };
  };
  // Every card's measurements, read in the page: an inner scroller, a clipped value or chip, or a chip over the sparkline.
  const measure = page => page.locator("article[data-widget-id]").evaluateAll(tiles => tiles.map(tile => {
    const box = node => { const r = node.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
    const overlaps = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
    const chip = tile.querySelector("[data-stat-delta]:not([data-stat-delta='loading'])");
    const visible = node => node && getComputedStyle(node).display !== "none" && node.getBoundingClientRect().width > 0;
    const card = box(tile);
    const scrollers = [...tile.querySelectorAll("*")].filter(node => /(auto|scroll)/.test(getComputedStyle(node).overflowX + getComputedStyle(node).overflowY) && (node.scrollHeight > node.clientHeight + 1 || node.scrollWidth > node.clientWidth + 1)).map(node => `${node.className.toString().slice(0, 40)} scroll ${node.scrollWidth}x${node.scrollHeight} client ${node.clientWidth}x${node.clientHeight}`);
    // Screen-reader text is a 1px box that overflows by design, so only boxes of visible width count.
    const clipped = [...tile.querySelectorAll("[data-metric-value], [data-stat-delta] *")].filter(node => visible(node) && node.getBoundingClientRect().width > 2 && node.scrollWidth > node.clientWidth + 1).map(node => node.className.toString().slice(0, 40));
    // A side sparkline is a lane of its own, so a change drawn over it is a defect. A background trend sits behind the whole card by design.
    const side = tile.querySelector("[data-stat-summary]")?.getAttribute("data-sparkline-placement") === "side";
    const spark = side ? tile.querySelector("[data-stat-sparkline]") : null;
    const sparkOverlap = spark && visible(chip) ? overlaps(box(chip), box(spark)) : false;
    const chipOutside = visible(chip) && (box(chip).r > card.r + 1 || box(chip).b > card.b + 1 || box(chip).l < card.l - 1);
    // A change is drawn when it is laid out at its own width and not hidden by the fit. A hidden change is a 1 px box.
    const chipDrawn = !!chip && !chip.hasAttribute("data-stat-delta-fit") && visible(chip) && box(chip).r - box(chip).l > 20;
    const valueTitle = tile.querySelector("[data-metric-value]")?.getAttribute("title") ?? "";
    return { id: tile.dataset.widgetId, scrollers, clipped, sparkOverlap, chipOutside, chipDrawn, chipState: chip?.getAttribute("data-stat-delta") ?? null, chipVisible: visible(chip), valueTitle };
  }));
  const cases = [];
  // A card's own layout can clip or scroll with or without a comparison, so each comparing card is judged against its
  // plain twin on the same page: the change must add no clipping, scrolling, overlap or escape from its card.
  const settle = async (page, id) => page.locator(`[data-widget-id="${id}"] [data-metric-value]`).first().waitFor({ timeout: 20_000 });
  for (const colorScheme of ["light", "dark"]) for (const viewport of [{ width: 1512, height: 900 }, { width: 390, height: 2400 }]) {
    const context = await browser.newContext({ viewport, colorScheme, reducedMotion: "reduce", ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
    const page = await context.newPage();
    await environment.installQueryFixture(page, resolver);
    try {
      const measured = {};
      for (const document of [plain, dashboard]) {
        await page.goto(`${environment.baseURL}/dashboard/insights/?dashboard=${document.id}`, { waitUntil: "networkidle" });
        for (const card of cards) await settle(page, card.id);
        await page.waitForTimeout(1500);
        measured[document.id] = await measure(page);
      }
      const plainTiles = Object.fromEntries(measured[plain.id].map(tile => [tile.id, tile]));
      for (const tile of measured[dashboard.id]) {
        const label = `${colorScheme} ${viewport.width} ${tile.id}`;
        const twin = plainTiles[`${tile.id}plain`] ?? plainTiles[tile.id];
        assert.ok(twin, `${label}: no plain twin measured`);
        assert.ok(tile.scrollers.length <= twin.scrollers.length, `${label}: the change adds a scroller: ${tile.scrollers.join("; ")}`);
        assert.ok(tile.clipped.length <= twin.clipped.length, `${label}: the change clips a value or chip: ${tile.clipped.join("; ")}`);
        assert.equal(tile.sparkOverlap, false, `${label}: the change sits over the side sparkline`);
        assert.equal(tile.chipOutside, false, `${label}: the change is outside its card`);
        // A change that does not fit is hidden, and its words stay on the reading's title so a pointer can reach them.
        if (!tile.chipDrawn && tile.chipState !== null) assert.match(tile.valueTitle, /Exact change /, `${label}: a hidden change is not named on the reading`);
        // Cards with room show their change: every card at 390 px, and the three-by-two card at 1512 px.
        if (viewport.width === 390 || tile.id === "w3h2") assert.ok(tile.chipDrawn, `${label}: a card with room hides its change (${tile.chipState})`);
      }
      const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      assert.equal(pageOverflow, false, `${colorScheme} ${viewport.width}: the page scrolls sideways`);
      cases.push({ colorScheme, width: viewport.width, count: measured[dashboard.id].length });
    } finally { await context.close(); }
  }
  console.log(`PASS compact stat comparisons: ${cases.map(item => `${item.colorScheme} ${item.width}`).join(", ")}`);
} finally {
  await browser.close();
  await environment.close();
}
