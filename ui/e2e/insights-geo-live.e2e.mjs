// Optional live-provider validation for the isolated gallery's geo views.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1");
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated loopback gallery is supported");
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/geo-live");
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, colorScheme: theme, reducedMotion: "reduce" });
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme); }, { expected: origin.origin, theme });
    try {
      const page = await context.newPage(), frames = [], geoFrames = [], errors = [];
      let geoQueries = 0;
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => {
        if (new URL(request.url()).pathname !== "/api/insights/query" || request.method() !== "POST") return;
        try {
          const envelope = JSON.parse(request.postDataJSON().query);
          if (envelope.sql?.includes("FROM gallery.geo_events e") && envelope.sql.includes("ORDER BY label") && !envelope.sql.includes("label=$2")) geoQueries++;
        } catch { /* Other provider query kinds need no accounting here. */ }
      });
      page.on("response", response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return;
        const body = response.json().catch(() => null);
        frames.push(body);
        try {
          const envelope = JSON.parse(response.request().postDataJSON().query);
          if (envelope.sql?.includes("FROM gallery.geo_events e") && envelope.sql.includes("ORDER BY label") && !envelope.sql.includes("label=$2")) geoFrames.push(body);
        } catch { /* Other query kinds do not produce the geographic frame. */ }
      });
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-edge-watch`);
      for (const id of ["geo-density", "geo-honeycomb"]) {
        const widget = page.locator(`[data-widget-id="${id}"]`);
        await widget.scrollIntoViewIfNeeded();
        const cells = widget.locator("[data-geo-cell]");
        await cells.first().waitFor({ timeout: 30000 });
        assert.ok(await cells.count() > 1, `${id} must render real observations`);
        if (id === "geo-honeycomb" && width === 390) {
          const rects = await cells.evaluateAll(nodes => nodes.slice(0, 2).map(node => {
            const rect = node.closest("button").getBoundingClientRect();
            return { left: rect.left, right: rect.right, width: rect.width };
          }));
          assert.ok(rects.every(rect => rect.width >= 44), "Touch targets must be at least 44px wide");
          assert.ok(rects[0].right <= rects[1].left + 1, "Adjacent touch targets must not overlap horizontally");
          assert.equal(await widget.getByText("Scroll horizontally to explore").isVisible(), true);
        }
        let button = cells.first().locator("xpath=ancestor::button[1]");
        let selectedLabel;
        if (id === "geo-honeycomb") {
          const current = await page.getByRole("textbox", { name: "Location", exact: true }).inputValue();
          for (let index = 0; index < Math.min(await cells.count(), 10); index++) {
            const candidate = cells.nth(index).locator("xpath=ancestor::button[1]");
            const label = (await candidate.getAttribute("aria-label")).split(" · ")[0];
            if (label !== current) { button = candidate; selectedLabel = label; break; }
          }
          assert.ok(selectedLabel, "A different recorded location is needed to verify linked selection");
        }
        await button.hover();
        const tooltip = page.getByRole("tooltip"); await tooltip.waitFor();
        await page.waitForFunction(element => element.dataset.tooltipPointer === "true", await tooltip.elementHandle());
        const bounds = await button.boundingBox();
        assert.ok(bounds && bounds.width > 2 && bounds.height > 2);
        const pointer = { x: bounds.x + bounds.width * .65, y: bounds.y + bounds.height * .65 };
        await page.mouse.move(pointer.x, pointer.y);
        await page.waitForFunction(({ element, y }) => {
          const box = element.getBoundingClientRect();
          return Math.min(Math.abs(box.top - y - 16), Math.abs(box.bottom - y + 16)) <= 2;
        }, { element: await tooltip.elementHandle(), y: pointer.y });
        const hover = await tooltip.evaluate(element => {
          const box = element.getBoundingClientRect();
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight, pointer: getComputedStyle(element).pointerEvents };
        });
        assert.equal(hover.pointer, "none", `${id}: hover must not block access to nearby cells`);
        assert.ok(hover.left >= -1 && hover.top >= -1 && hover.right <= hover.width + 1 && hover.bottom <= hover.height + 1, `${id}: tooltip outside viewport ${JSON.stringify(hover)}`);
        await button.focus();
        assert.equal(await button.evaluate(element => element === document.activeElement), true, `${id}: keyboard focus must reach the same observation`);
        await page.waitForLoadState("networkidle");
        await button.focus();
        if (id === "geo-honeycomb") {
          const clearance = await button.evaluate(element => {
            const button = element.getBoundingClientRect(), region = element.closest('[role="region"]').getBoundingClientRect();
            return { left: button.left - region.left, top: button.top - region.top };
          });
          assert.ok(clearance.left >= 4 && clearance.top >= 4, "The keyboard focus outline must fit inside the scroll region");
        }
        await tooltip.waitFor();
        assert.match(await tooltip.innerText(), /Source records/);
        const pressedElement = await button.elementHandle();
        const baselineQueries = geoQueries;
        await button.press("Enter");
        await page.waitForFunction(element => element.getAttribute("aria-pressed") === "true", await button.elementHandle(), { timeout: 4000 }).catch(async error => { throw Error(`${id} ${theme} ${width}: pin failed; pressed=${await button.getAttribute("aria-pressed")}, focused=${await button.evaluate(element => element === document.activeElement)}, oldConnected=${await pressedElement.evaluate(element => element.isConnected)}, active=${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 350))}, tooltip=${await tooltip.count()}: ${error.message}`); });
        assert.equal(await pressedElement.evaluate(element => element.isConnected && element === document.activeElement), true, `${id}: selecting must preserve the focused cell`);
        if (selectedLabel) {
          const locationInput = page.getByRole("textbox", { name: "Location", exact: true });
          await page.waitForFunction(({ input, label }) => input.value === label, { input: await locationInput.elementHandle(), label: selectedLabel });
          await page.waitForLoadState("networkidle");
          assert.equal(geoQueries, baselineQueries, "Changing the linked location must not refetch the gateway-only source query");
        }
        await page.keyboard.press("Escape"); await tooltip.waitFor({ state: "hidden" });
        if (selectedLabel) {
          const detail = page.locator('[data-widget-id="geo-selected-detail"]');
          await detail.scrollIntoViewIfNeeded();
          await detail.getByText(selectedLabel, { exact: true }).waitFor();
        }
        if (id === "geo-honeycomb") {
          const source = (await Promise.all(geoFrames)).find(item => item?.records)?.records;
          assert.ok(source?.rows.length > 0, "PostgreSQL must return geographic records");
          assert.equal(await cells.count(), Math.min(source.rows.length, 500), "The honeycomb must reflect the returned geographic records up to its configured limit");
          if (source.rows.length > 500) assert.ok(await widget.getByText(`${source.rows.length - 500} records omitted by the display limit`).isVisible());
        }
      }
      const geo = (await Promise.all(frames)).map(item => item?.records).find(item => item?.columns?.some(column => column.key === "latitude") && item.columns.some(column => column.key === "requests"));
      assert.ok(geo?.rows?.length > 0, "PostgreSQL should return geographic records");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), animations: "disabled" });
      console.log(`PASS ${theme} ${width}px: geographic and honeycomb tooltips over PostgreSQL data`);
    } finally { await context.close(); }
  }
} finally { await browser.close(); }
