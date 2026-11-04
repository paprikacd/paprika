// Real local gallery: late incident details must never paint into the legend.
import assert from "node:assert/strict"
import { chromium } from "playwright"
const app = new URL(process.env.INSIGHTS_E2E_URL ?? "http://127.0.0.1:3199")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:64867")
assert.equal(app.hostname, "127.0.0.1")
assert.equal(api.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
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
      // The clipped plot is essential while ResizeObserver catches up. Opening
      // actual event details forces the same late height change as the incident.
      assert.equal(await panel.locator('[data-chart-footer]').evaluate(el => getComputedStyle(el.previousElementSibling).overflowY), "clip")
      await summary.click()
      await summary.click()
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
      await panel.getByRole("button", { name: /Compare window for/ }).click()
      const dialog = page.getByRole("dialog", { name: "Compare a window" })
      await dialog.getByRole("button", { name: "Zoom chart to window" }).click()
      await panel.getByRole("button", { name: "Reset chart zoom" }).click()
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
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: incident resize, axis digits, legend, tooltip, zoom`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
