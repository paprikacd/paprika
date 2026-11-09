// Real local synthetic providers: plot budgets, compact keys and event inspection.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright"
const app = new URL(process.env.INSIGHTS_E2E_URL ?? "http://127.0.0.1:3199")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:64867")
assert.equal(app.hostname, "127.0.0.1")
assert.equal(api.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
const output = resolve("artifacts/insights/local-polish/demo-refinement")
await mkdir(output, { recursive: true })
const reports = []
const documentPath = "/api/insights/dashboards/local-gallery-reliability-room"
const beforeResponse = await fetch(new URL(documentPath, api))
assert.ok(beforeResponse.ok)
const original = await beforeResponse.text(), etag = beforeResponse.headers.get("x-paprika-document-etag") ?? beforeResponse.headers.get("etag")
try {
  for (const width of [1592, 1512, 768, 390, 320]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 988 }, reducedMotion: "reduce", ...(width <= 390 ? { hasTouch: true, isMobile: true } : {}) })
    await context.addInitScript(theme => { localStorage.setItem("paprika-insights-theme", theme); localStorage.setItem("paprika-insights-compact-view", "true") }, theme)
    const page = await context.newPage(), errors = [], queries = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("request", request => { if (new URL(request.url()).pathname === "/api/insights/query") queries.push(request.postDataJSON()) })
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), headers = { ...route.request().headers() }
      delete headers.origin; delete headers.host
      const response = await route.fetch({ url: new URL(original.pathname + original.search, api).href, headers })
      await route.fulfill({ response })
    })
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-reliability-room", app).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="burn"]')
      await panel.scrollIntoViewIfNeeded()
      const graph = panel.getByRole("img", { name: "Availability burn rate · request errors", exact: true })
      await graph.waitFor()
      await panel.locator('[data-annotation-timestamp]').first().waitFor()
      const summary = panel.locator("summary", { hasText: /events in view/ })
      await summary.waitFor()
      const legend = panel.getByRole("list", { name: "Latest values by series" })
      assert.equal(await legend.getByRole("listitem").count(), 2)
      // Details must not resize the plot, including when their scroll surface opens.
      assert.equal(await panel.locator('[data-chart-footer]').evaluate(el => getComputedStyle(el.previousElementSibling).overflowY), "clip")
      const beforeOpen = await graph.boundingBox()
      await summary.click()
      const events = panel.getByRole("list", { name: "Recorded chart events" })
      await events.waitFor()
      assert.equal((await graph.boundingBox()).height, beforeOpen.height, "Opening recorded events preserves the plot budget")
      const eventBounds = await events.boundingBox(), cardBounds = await panel.boundingBox()
      assert.ok(eventBounds.x >= cardBounds.x && eventBounds.x + eventBounds.width <= cardBounds.x + cardBounds.width + 1)
      assert.ok(eventBounds.y >= cardBounds.y && eventBounds.y + eventBounds.height <= cardBounds.y + cardBounds.height + 1)
      const lastEvent = await events.locator("time").last().getAttribute("datetime")
      assert.ok(Number.isFinite(Date.parse(lastEvent)), "The details retain recorded timestamps")
      await events.focus()
      await events.press("End")
      await page.waitForFunction(() => { const list = document.querySelector('[aria-label="Recorded chart events"]'); return list.scrollTop + list.clientHeight >= list.scrollHeight - 2 })
      await page.screenshot({ path: resolve(output, `events-${theme}-${width}.png`), animations: "disabled" })
      await events.press("Escape")
      assert.equal(await summary.evaluate(el => el === document.activeElement), true)
      assert.equal(await panel.locator("[data-chart-events]").getAttribute("open"), null)
      await page.waitForFunction(panel => {
        const plot = document.querySelector(panel)?.querySelector('[data-chart-footer]')?.previousElementSibling
        const svg = plot?.querySelector('svg')
        return svg && Math.abs(svg.getBoundingClientRect().height - plot.getBoundingClientRect().height) < 2
      }, '[data-widget-id="burn"]')
      const layout = await panel.evaluate(el => {
        const footer = el.querySelector('[data-chart-footer]').getBoundingClientRect()
        const plot = el.querySelector('[data-chart-footer]').previousElementSibling
        const ticks = [...plot.querySelectorAll('[data-ts-key^="x-tick-label:"]')].map(t => t.getBoundingClientRect())
        return { plotHeight: plot.getBoundingClientRect().height, footerTop: footer.top, ticks: ticks.map(t => t.bottom) }
      })
      assert.ok(layout.plotHeight >= 100, `Chart must remain readable: ${layout.plotHeight}px`)
      assert.ok(layout.ticks.length >= 2 && layout.ticks.every(bottom => bottom <= layout.footerTop - 2), `Axis must clear footer: ${JSON.stringify(layout)}`)
      await graph.focus()
      const tooltip = page.getByRole("tooltip")
      await tooltip.waitFor()
      assert.ok(Number.isFinite(Number(await tooltip.locator('[data-observation-value]').first().getAttribute('data-observation-value'))))
      await graph.press("Escape")
      await page.evaluate(() => scrollTo(0, 0))
      await page.screenshot({ path: resolve(output, `reliability-${theme}-${width}.png`), animations: "disabled" })
      await panel.getByRole("button", { name: /Compare window for/ }).click()
      const dialog = page.getByRole("dialog", { name: "Compare a window" })
      await dialog.getByRole("button", { name: "Zoom chart to window" }).click()
      await panel.getByRole("button", { name: "Reset chart zoom" }).click()
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", app).href, { waitUntil: "networkidle" })
      // Prime the intersection-gated panels before counting inspection queries.
      // Returning focus can scroll the page and legitimately reveal another panel.
      for (const widget of await page.locator("[data-widget-id]").all()) {
        await widget.scrollIntoViewIfNeeded()
        await widget.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        await widget.getByRole("status", { name: "Loading widget" }).waitFor({ state: "hidden" })
      }
      await page.waitForLoadState("networkidle")
      const flow = page.locator('[data-widget-id="flow"]'), outcomes = page.locator('[data-widget-id="outcomes"]')
      await flow.scrollIntoViewIfNeeded()
      await flow.locator('svg[role="group"]').waitFor()
      const flowHeight = (await flow.locator('svg[role="group"]').boundingBox()).height
      assert.ok(flowHeight >= 140, `Directional plot keeps a useful height: ${flowHeight}`)
      await outcomes.scrollIntoViewIfNeeded()
      const outcomePlot = outcomes.locator('svg[role="group"]')
      await outcomePlot.waitFor()
      const outcomeHeight = (await outcomePlot.boundingBox()).height
      assert.ok(outcomeHeight >= 100, `Stacked outcome plot keeps a useful height: ${outcomeHeight}`)
      const key = outcomes.getByRole("region", { name: "Latest recorded values" })
      const keyGeometry = await key.evaluate(el => {
        const box = el.getBoundingClientRect(), rows = [...el.children].map(row => row.getBoundingClientRect())
        return { rows: rows.length, allVisible: rows.every(row => row.left >= box.left - 1 && row.right <= box.right + 1 && row.top >= box.top - 1 && row.bottom <= box.bottom + 1), horizontal: el.scrollWidth > el.clientWidth + 1, vertical: el.scrollHeight > el.clientHeight + 1 }
      })
      assert.equal(keyGeometry.rows, 3)
      assert.equal(keyGeometry.vertical, false, "A compact key never clips a second legend row")
      if (width >= 1512) assert.equal(keyGeometry.allVisible, true, "All ordinary outcome series fit together")
      if (keyGeometry.horizontal) {
        assert.equal(await key.getAttribute("tabindex"), "0")
        await key.focus()
        for (let i = 0; i < 15; i++) await key.press("ArrowRight", { delay: 20 })
        assert.ok(await key.evaluate(el => el.scrollLeft + el.clientWidth >= el.scrollWidth - 2), "Keyboard scrolling reveals the final series")
      }
      await page.waitForLoadState("networkidle")
      const queryCount = queries.length
      await outcomePlot.focus(); await outcomePlot.press("Enter")
      const inspection = page.getByRole("region", { name: "Observation details", exact: true })
      await inspection.waitFor()
      assert.ok(Number.isFinite(Number(await inspection.locator("[data-metric-value]").getAttribute("data-metric-value"))))
      await inspection.focus(); await inspection.press("Escape")
      assert.equal(queries.length, queryCount, "Inspecting recorded outcomes performs no provider queries")
      assert.equal(await outcomePlot.evaluate(el => el === document.activeElement), true)
      await page.evaluate(() => scrollTo(0, 0))
      await page.screenshot({ path: resolve(output, `edge-${theme}-${width}.png`), animations: "disabled" })
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-signal-kit", app).href, { waitUntil: "networkidle" })
      const rate = page.locator('[data-widget-id="request-history"]')
      await rate.scrollIntoViewIfNeeded()
      await rate.getByRole("img", { name: "Request rate · selected service and worker", exact: true }).waitFor()
      await rate.locator('[data-chart-axis-unit]').waitFor()
      const axis = await rate.evaluate(el => {
        const plot = el.querySelector('[data-chart-footer]').previousElementSibling
        const bounds = plot.getBoundingClientRect()
        const ticks = [...plot.querySelectorAll('[data-ts-key^="y-tick-label:"]')].map(t => t.getBoundingClientRect())
        return { left: bounds.left, right: bounds.right, ticks: ticks.map(t => ({ left: t.left, right: t.right })) }
      })
      assert.ok(axis.ticks.length >= 2 && axis.ticks.every(t => t.left >= axis.left - 1 && t.right <= axis.right + 1), `Y-axis digits must be visible: ${JSON.stringify(axis)}`)
      assert.equal(await rate.locator('[data-chart-axis-unit]').innerText(), "req/s")
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      assert.deepEqual(errors, [])
      reports.push({ width, theme, burnPlot: layout.plotHeight, flowPlot: flowHeight, outcomesPlot: outcomeHeight, keyGeometry, eventsKeepPlot: true, keyboardFocusRestored: true })
      console.log(`PASS ${theme} ${width}px: plot proportions, recorded events, complete keys, tooltip and zoom`)
    } catch (error) {
      await page.screenshot({ path: resolve(output, `failure-${theme}-${width}.png`), fullPage: true }).catch(() => {})
      await writeFile(resolve(output, `failure-${theme}-${width}.json`), JSON.stringify({ error: error.message, queries }, null, 2))
      throw error
    } finally { await context.close() }
  }
  const afterResponse = await fetch(new URL(documentPath, api))
  assert.equal(await afterResponse.text(), original, "Viewing and inspecting never changes the saved document")
  assert.ok(etag)
  assert.equal(afterResponse.headers.get("x-paprika-document-etag") ?? afterResponse.headers.get("etag"), etag)
} finally {
  await writeFile(resolve(output, "report.json"), JSON.stringify(reports, null, 2))
  await browser.close()
}
