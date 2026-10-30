// Selected chart observations drive a saved-query tooltip and an explicit
// dashboard link without mutating either saved dashboard's defaults.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const readDashboard = async id => {
  const response = await fetch(new URL(`/api/insights/dashboards/${id}`, origin))
  assert.equal(response.status, 200)
  return { body: await response.json(), etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") }
}
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const source = await readDashboard("local-gallery-service-pulse")
    const target = await readDashboard("local-gallery-reliability-room")
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce", ...(width === 390 ? { hasTouch: true, isMobile: true } : {}) })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = [], requests = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("response", response => {
      if (new URL(response.url()).pathname === "/api/insights/query" && response.ok()) {
        try { requests.push({ request: response.request().postDataJSON(), data: response.json().catch(() => null) }) } catch { /* Ignore unrelated requests. */ }
      }
    })
    try {
      const end = Math.floor(Date.now() / 60_000) * 60_000 - 60_000, start = end - 3600_000
      const url = new URL("/dashboard/insights/", origin)
      url.searchParams.set("dashboard", "local-gallery-service-pulse")
      url.searchParams.set("from", new Date(start).toISOString())
      url.searchParams.set("to", new Date(end).toISOString())
      await page.goto(url.href, { waitUntil: "networkidle" })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Service", exact: true }), "payments")
      const tile = page.locator('[data-widget-id="request-history"]')
      await tile.scrollIntoViewIfNeeded()
      const chart = tile.getByRole("img", { name: "Request rate by service", exact: true })
      await chart.waitFor()
      const line = chart.locator('path[stroke][stroke-width]').first()
      await line.waitFor()
      const coordinate = await line.evaluate(element => {
        const point = element.getPointAtLength(element.getTotalLength() * .4), transform = element.getScreenCTM()
        if (!transform) throw Error("Chart line has no screen transform")
        const screen = new DOMPoint(point.x, point.y).matrixTransform(transform)
        return { x: screen.x, y: screen.y }
      })
      if (width === 390) {
        await page.touchscreen.tap(coordinate.x, coordinate.y)
        await page.getByRole("tooltip").getByRole("button", { name: "View service traces", exact: true }).waitFor()
      } else {
        await page.mouse.move(coordinate.x, coordinate.y)
        const hover = page.getByRole("tooltip")
        await hover.waitFor()
        assert.equal(await hover.getByRole("button", { name: "View service traces" }).count(), 0, "Hover does not expose an unpinned navigation action")
        await page.mouse.click(coordinate.x, coordinate.y)
        await hover.getByRole("button", { name: "View service traces", exact: true }).waitFor()
        const selected = hover.locator("[data-observation-timestamp]")
        const pinnedTime = await selected.getAttribute("data-observation-timestamp")
        const pinnedSeries = await selected.getAttribute("data-observation-series")
        const anotherPoint = await line.evaluate(element => {
          const point = element.getPointAtLength(element.getTotalLength() * .8), transform = element.getScreenCTM()
          if (!transform) throw Error("Chart line has no screen transform")
          const screen = new DOMPoint(point.x, point.y).matrixTransform(transform)
          return { x: screen.x, y: screen.y }
        })
        await page.mouse.move(anotherPoint.x, anotherPoint.y)
        assert.equal(await selected.getAttribute("data-observation-timestamp"), pinnedTime, "Moving across the chart must not change the pinned sample")
        assert.equal(await selected.getAttribute("data-observation-series"), pinnedSeries, "Moving across the chart must not change the pinned series")
      }
      await page.keyboard.press("Escape")
      await page.getByRole("tooltip").waitFor({ state: "hidden" })
      await chart.focus()
      const tip = page.getByRole("tooltip")
      await chart.press("ArrowRight")
      await tip.waitFor()
      for (let attempt = 0; attempt < 12 && !(await tip.innerText()).includes("service: catalog"); attempt++) await chart.press("ArrowRight")
      assert.match(await tip.innerText(), /service:\s*catalog/, "Select a series different from the dashboard filter")
      assert.equal(await tip.getByRole("button", { name: "View service traces" }).count(), 0, "Hover/focus details must not expose a navigation action until pinned")
      const sampleTime = Number(await tip.locator("[data-observation-timestamp]").getAttribute("data-observation-timestamp"))
      assert.ok(Number.isFinite(sampleTime) && sampleTime >= start && sampleTime <= end)
      await tip.getByRole("region", { name: "Selected service · request history" }).waitFor()
      await page.waitForFunction(() => document.querySelector('[aria-label="Selected service · request history"] [data-tooltip-widget], [data-tooltip-widget="timeseries"] svg'))
      const childRequest = requests.find(entry => entry.request.query?.includes('service="catalog"') && entry.request.query.includes("paprika_demo_requests_total") && !entry.request.query.includes("sum by (service)"))
      assert.ok(childRequest, "The tooltip must execute the saved query using the hovered series label")
      const child = await childRequest.data
      assert.ok(child?.series?.some(series => series.points.length > 1), "The selected service's actual provider history must render")
      await chart.press("Enter")
      if (process.env.TOOLTIP_FLOW_SCREENSHOTS) await page.screenshot({ path: `${process.env.TOOLTIP_FLOW_SCREENSHOTS}/tooltip-flow-${theme}-${width}.png`, animations: "disabled" })
      await tip.getByRole("button", { name: "View service traces", exact: true }).click()
      await page.waitForURL(value => value.searchParams.get("dashboard") === "local-gallery-reliability-room")
      const destination = new URL(page.url())
      assert.equal(JSON.parse(destination.searchParams.get("vars")).service, "catalog")
      assert.equal(Date.parse(destination.searchParams.get("from")), start)
      assert.equal(Date.parse(destination.searchParams.get("to")), end)
      const traces = page.locator('[data-widget-id="incident-traces"]')
      await traces.scrollIntoViewIfNeeded()
      await traces.getByRole("button", { name: "View waterfall" }).first().waitFor({ timeout: 30000 })
      assert.ok(requests.some(entry => entry.request.kind === "traces" && entry.request.query?.includes('"catalog"') && entry.request.start === start / 1000 && entry.request.end === end / 1000), "The destination must query real traces for the selected series and carried range")
      assert.deepEqual(await readDashboard("local-gallery-service-pulse"), source)
      assert.deepEqual(await readDashboard("local-gallery-reliability-room"), target)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: selected-series saved-query tooltip and carried-range trace drilldown`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
