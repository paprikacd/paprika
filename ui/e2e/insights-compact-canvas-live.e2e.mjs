// View-only compact projection, exercised against the local real provider stack.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const app = new URL(process.env.INSIGHTS_E2E_URL ?? "http://127.0.0.1:3199")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:57263")
assert.equal(app.hostname, "127.0.0.1")
assert.equal(api.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 1332, 1000, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 1332 ? 826 : 1024 }, colorScheme: theme, reducedMotion: "reduce" })
    const page = await context.newPage()
    await context.addInitScript(theme => { localStorage.setItem("paprika-insights-theme", theme) }, theme)
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), destination = new URL(original.pathname + original.search, api)
      const headers = { ...route.request().headers() }; delete headers.origin; delete headers.host
      const response = await route.fetch({ url: destination.href, headers })
      await route.fulfill({ response })
    })
    try {
      const path = "/dashboard/insights/?dashboard=local-gallery-edge-watch"
      const endpoint = new URL("/api/insights/dashboards/local-gallery-edge-watch", api)
      const beforeDocument = await fetch(endpoint)
      const originalDocument = await beforeDocument.text(), etag = beforeDocument.headers.get("x-paprika-document-etag") ?? beforeDocument.headers.get("etag")
      await page.goto(new URL(path, app).href, { waitUntil: "networkidle" })
      if (width === 1332) await page.getByRole("button", { name: "Toggle sidebar" }).click()
      const canvas = page.getByTestId("dashboard-canvas"), toggle = page.getByRole("button", { name: "Compact view" })
      await canvas.waitFor(); await page.locator('[data-widget-id="flow"] svg').first().waitFor()
      const before = await canvas.boundingBox()
      if (width >= 1200) await toggle.click()
      else {
        assert.equal(await toggle.isDisabled(), true, "Compact control is disabled when the available canvas is not wide")
        await page.evaluate(() => localStorage.setItem("paprika-insights-compact-view", "true"))
        await page.reload({ waitUntil: "networkidle" })
      }
      await page.waitForFunction(expected => document.querySelector('[data-testid="dashboard-canvas"]').dataset.density === expected, width >= 1200 ? "compact" : "standard")
      if (width >= 1200) await page.waitForFunction(height => document.querySelector('[data-testid="dashboard-canvas"]').getBoundingClientRect().height < height * .9, before.height)
      const after = await canvas.boundingBox()
      if (width >= 1200) {
        assert.ok(after.height < before.height * .8, `Compact view should materially reduce canvas height: ${before.height} -> ${after.height}`)
        const boxes = await page.locator('[data-widget-id]').evaluateAll(nodes => nodes.map(node => {
          const b = node.getBoundingClientRect(); return { id: node.dataset.widgetId, x:b.x, y:b.y, right:b.right, bottom:b.bottom }
        }))
        for (const [i,a] of boxes.entries()) for (const b of boxes.slice(i + 1))
          assert.ok(!(a.x < b.right - 1 && a.right > b.x + 1 && a.y < b.bottom - 1 && a.bottom > b.y + 1), `${a.id} overlaps ${b.id}`)
        for (const id of ["ingress", "egress", "blocked", "connections"]) {
          const stat = page.locator(`[data-widget-id="${id}"]`)
          const value = stat.getByRole("button", { name: /^Inspect value/ })
          await value.waitFor()
          assert.ok(await value.evaluate(el => { const b = el.getBoundingClientRect(), tile = el.closest('[data-widget-id]').getBoundingClientRect(); return b.height > 0 && b.bottom <= tile.bottom + 1 }), `${id} value must fit its tile`)
        }
        const outcome = page.locator('[data-widget-id="outcomes"]')
        await outcome.scrollIntoViewIfNeeded()
        const outcomePlot = outcome.locator('svg[role="group"]')
        await outcomePlot.waitFor()
        const plotBounds = await outcomePlot.boundingBox()
        assert.ok(plotBounds.height >= 85, `Compact layout must keep request outcomes usable: ${plotBounds.height}px`)
        const destinations = page.locator('[data-widget-id="destinations"]')
        await destinations.scrollIntoViewIfNeeded()
        const destinationRegion = destinations.getByRole("region", { name: "Top destinations records" })
        await destinationRegion.getByRole("row").nth(10).waitFor()
        const tableGeometry = await destinationRegion.evaluate(region => {
          const box = region.getBoundingClientRect(), rows = [...region.querySelectorAll("tbody tr")]
          const last = rows.at(-1).getBoundingClientRect()
          return { count: rows.length, lastRowVisible: last.bottom <= box.bottom + 1 }
        })
        assert.deepEqual(tableGeometry, { count: 10, lastRowVisible: true }, "All ranked destinations should be visible in compact view")
        const risk = page.locator('[data-widget-id="risks"]')
        await risk.scrollIntoViewIfNeeded()
        await risk.getByText("AS64501").waitFor()
        assert.equal(await risk.getByText("Blocking").count(), 1)
      } else assert.ok(Math.abs(after.height - before.height) < 2, "Touch projection must retain usable panel heights")
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No page-level horizontal overflow")
      await page.screenshot({ path: `/tmp/paprika-compact-canvas-${theme}-${width}.png`, fullPage: true })
      await page.reload({ waitUntil: "networkidle" })
      assert.equal(await toggle.getAttribute("aria-pressed"), "true", "Local viewing preference persists")
      await page.getByRole("button", { name: "Edit dashboard" }).click()
      assert.equal(await canvas.getAttribute("data-density"), "standard", "Editing uses the actual saved grid")
      assert.equal(await toggle.isDisabled(), true)
      await page.getByRole("button", { name: "Preview", exact: true }).click()
      assert.equal(await canvas.getAttribute("data-density"), width >= 1200 ? "compact" : "standard")
      const afterDocument = await fetch(endpoint)
      assert.equal(await afterDocument.text(), originalDocument, "Compact viewing never changes the saved document")
      assert.ok(etag, "The live dashboard exposes a version")
      assert.equal(afterDocument.headers.get("x-paprika-document-etag") ?? afterDocument.headers.get("etag"), etag, "Viewing does not write a new dashboard version")
      if (width >= 1200) {
        await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-reliability-room", app).href, { waitUntil: "networkidle" })
        const timeline = page.locator('[data-widget-id="service-timeline"]')
        await timeline.scrollIntoViewIfNeeded()
        const lanes = timeline.locator('[data-history-series]')
        await lanes.nth(5).waitFor()
        const lanesVisible = await timeline.evaluate(tile => {
          const region = tile.querySelector('[role="region"][aria-label$=" history"]'), rows = [...region.querySelectorAll('[data-history-series]')]
          return rows.length === 6 && rows.at(-1).getBoundingClientRect().bottom <= region.getBoundingClientRect().bottom + 1
        })
        assert.equal(lanesVisible, true, "All service lanes should be visible in compact view")
        const calendar = page.locator('[data-widget-id="calendar"]')
        await calendar.scrollIntoViewIfNeeded()
        await calendar.locator('[data-operational-chart="incident-calendar"] [class*="dayTrigger"]').last().waitFor()
        const lastDayVisible = await calendar.evaluate(tile => {
          const scroll = tile.querySelector('[class*="calendarScroll"]'), days = [...scroll.querySelectorAll('[class*="dayTrigger"]')]
          return { count: days.length, last: days.at(-1).getBoundingClientRect().bottom, edge: scroll.getBoundingClientRect().bottom, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, tileHeight: tile.getBoundingClientRect().height }
        })
        assert.ok(lastDayVisible.count >= 28 && lastDayVisible.last <= lastDayVisible.edge + 1, `The last calendar week should be visible in compact view: ${JSON.stringify(lastDayVisible)}`)
        // August 2026 starts on a Saturday and has 31 days: six calendar
        // rows. Keep live provider results while varying only the local view.
        await page.route("**/api/insights/dashboards/local-gallery-reliability-room", async route => {
          const response = await route.fetch({ url: new URL("/api/insights/dashboards/local-gallery-reliability-room", api).href })
          const doc = await response.json()
          doc.widgets.find(widget => widget.id === "calendar").config.endDate = "2026-08-31"
          await route.fulfill({ response, json: doc })
        })
        await page.reload({ waitUntil: "networkidle" })
        const sixWeekCalendar = page.locator('[data-widget-id="calendar"]')
        await sixWeekCalendar.scrollIntoViewIfNeeded()
        await sixWeekCalendar.locator('[data-operational-chart="incident-calendar"] [class*="dayTrigger"]').last().waitFor()
        const sixWeeks = await sixWeekCalendar.evaluate(tile => {
          const scroll = tile.querySelector('[class*="calendarScroll"]'), days = [...scroll.querySelectorAll('[class*="dayTrigger"]')]
          return { count: days.length, last: days.at(-1).getBoundingClientRect().bottom, edge: scroll.getBoundingClientRect().bottom }
        })
        assert.ok(sixWeeks.count === 31 && sixWeeks.last <= sixWeeks.edge + 1, `Six-week month must fit: ${JSON.stringify(sixWeeks)}`)
        await sixWeekCalendar.locator('[data-operational-chart="incident-calendar"] [class*="dayTrigger"]').last().click()
        await page.getByRole("tooltip").getByText("2026-08-31 · UTC").waitFor()
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: compact projection, controls and saved editing geometry`)
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally { await browser.close() }
