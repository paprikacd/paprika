// Provider-generated label sets remain distinguishable without losing exact identity.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { selectGammaOption } from "./gamma-controls.mjs";
const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1");
const app = new URL(process.env.INSIGHTS_E2E_URL || origin.href);
assert.equal(origin.hostname, "127.0.0.1"); assert.equal(app.hostname, "127.0.0.1");
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    try {
      const page = await context.newPage(), errors = [];
      page.on("pageerror", error => errors.push(error.message));
      if (app.origin !== origin.origin) await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
        const original = new URL(route.request().url());
        const destination = new URL(original.pathname + original.search, origin);
        const headers = { ...route.request().headers() }; delete headers.origin; delete headers.host;
        await route.fulfill({ response: await route.fetch({ url: destination.href, headers }) });
      });
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-collection-control", app).href, { waitUntil: "networkidle" });
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme);
      const tile = page.locator('[data-widget-id="source-freshness"]');
      await tile.scrollIntoViewIfNeeded();
      const plot = tile.getByRole("img", { name: "Freshness by source" }); await plot.waitFor();
      const text = await plot.textContent();
      assert.match(text, /brandbr(?:ain|…)/); assert.match(text, /tempo/);
      assert.doesNotMatch(text, /paprika…/);
      const legend = tile.getByRole("list", { name: "Latest values by category" }); await legend.waitFor();
      const items = legend.getByRole("listitem"); assert.equal(await items.count(), 5);
      for (const name of ["brandbrain", "market-sync", "prometheus", "shorted-api", "tempo"]) {
        const item = items.filter({ hasText: name }); await item.waitFor();
        assert.match(await item.getAttribute("title"), new RegExp(`source="${name}"`));
        const bounds = await item.evaluate(el => { const a=el.getBoundingClientRect(), b=el.parentElement.getBoundingClientRect(), c=el.closest('[data-widget-id]').getBoundingClientRect(); return { contained: a.top>=b.top-1 && a.bottom<=b.bottom+1 && a.left>=b.left-1 && a.right<=b.right+1 && a.top>=c.top-1 && a.bottom<=c.bottom+1, value:el.querySelector('[data-legend-value]')?.getAttribute('data-legend-value') } });
        assert.ok(bounds.contained, `${name} must be visible without scrolling: ${JSON.stringify(bounds)}`);
        assert.ok(Number.isFinite(Number(bounds.value)), `${name} needs a recorded value`);
      }
      const height = await plot.evaluate(el => el.getBoundingClientRect().height);
      assert.ok(height >= 80, `The category key must leave usable plot space; got ${height}px`);
      await tile.getByRole("button", { name: "Inspect chart data for Freshness by source" }).click();
      const inspector = page.getByRole("dialog", { name: /Freshness by source data/ });
      await inspector.waitFor(); assert.match(await inspector.innerText(), /paprika_demo_source_freshness_seconds/);
      assert.deepEqual(errors, []);
      console.log(`PASS ${theme} ${width}px: all five visible categories and exact source identity`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
