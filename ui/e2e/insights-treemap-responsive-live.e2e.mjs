// Treemap labels should stay at reading size while layout follows the panel.
// Real synthetic PostgreSQL records feed the local Insights/Observe service.
import assert from "node:assert/strict";
import { chromium } from "playwright";

const app = new URL(process.env.INSIGHTS_E2E_URL ?? "http://127.0.0.1:3199");
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:61972");
assert.equal(app.hostname, "127.0.0.1");
assert.equal(api.hostname, "127.0.0.1");
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" });
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url());
      const destination = new URL(original.pathname + original.search, api);
      const headers = { ...route.request().headers() };
      delete headers.origin; delete headers.host;
      const response = await route.fetch({ url: destination.href, headers });
      await route.fulfill({ response });
    });
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-market-lens", app).href, { waitUntil: "networkidle" });
      const tile = page.locator('[data-widget-id="composition"]');
      await tile.scrollIntoViewIfNeeded();
      const svg = tile.getByRole("group", { name: "Company composition by market cap" });
      await svg.getByRole("button", { name: /^DEMO091:/ }).waitFor();
      await page.waitForFunction(() => {
        const svg = document.querySelector('[data-widget-id="composition"] svg[viewBox]');
        if (!svg) return false;
        const box = svg.getBoundingClientRect(), view = svg.viewBox.baseVal;
        return Math.abs(box.width - view.width) < 1 && Math.abs(box.height - view.height) < 1;
      });
      const geometry = await svg.evaluate(svg => {
        const box = svg.getBoundingClientRect(), view = svg.viewBox.baseVal;
        const text = [...svg.querySelectorAll("g > text")];
        const scale = svg.getScreenCTM().a;
        const first = text[0];
        return { width: box.width, height: box.height, viewWidth: view.width, viewHeight: view.height,
          scale, labels: text.length, physicalFont: first ? parseFloat(getComputedStyle(first).fontSize) * scale : 0,
          bounded: text.every(node => node.hasAttribute("clip-path")) };
      });
      assert.ok(geometry.labels >= 3, `Labels should remain visible: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.physicalFont >= 11, `Labels should be readable at actual screen size: ${JSON.stringify(geometry)}`);
      assert.ok(geometry.bounded, "Every label must be clipped to its tile");
      if (width === 390) await tile.screenshot({ path: `/tmp/paprika-treemap-${theme}.png`, animations: "disabled" });
      const company = svg.getByRole("button", { name: /^DEMO091:/ });
      await company.focus();
      await page.keyboard.press("Enter");
      const detail = page.locator('[data-widget-id="selected-company"]');
      await detail.scrollIntoViewIfNeeded();
      await detail.getByText("DEMO091", { exact: true }).waitFor();
      if (width === 390) {
        await page.setViewportSize({ width: 768, height: 1000 });
        await tile.scrollIntoViewIfNeeded();
        await page.waitForFunction(previousWidth => {
          const svg = document.querySelector('[data-widget-id="composition"] svg[viewBox]');
          if (!svg) return false;
          const box = svg.getBoundingClientRect(), view = svg.viewBox.baseVal;
          return box.width > previousWidth + 100 && Math.abs(box.width - view.width) < 1 && Math.abs(box.height - view.height) < 1;
        }, geometry.width);
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${theme} ${width}px treemap: ${JSON.stringify(geometry)}; keyboard selection updates detail`);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    }
  }
} finally { await browser.close(); }
