// Real observations must remain fully readable in compact time-series legends.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const app = new URL(process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:60968/")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:58141/")
assert.equal(app.hostname, "127.0.0.1")
assert.equal(api.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390, 320]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
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
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-collection-control", app).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="throughput"]')
      await panel.scrollIntoViewIfNeeded()
      const legend = panel.getByRole("list", { name: "Latest values by series" })
      await legend.waitFor()
      await page.waitForFunction(() => document.querySelectorAll('[data-widget-id="throughput"] [data-legend-value]').length === 3)
      if (process.env.LEGEND_SCREENSHOTS) await panel.screenshot({ path: `${process.env.LEGEND_SCREENSHOTS}/legend-${theme}-${width}.png` })
      const measurements = await legend.evaluate(element => [...element.querySelectorAll('[data-legend-value]')].map(value => {
        const box = value.getBoundingClientRect(), item = value.closest('[role="listitem"]').getBoundingClientRect(), viewport = element.getBoundingClientRect(), style = getComputedStyle(value)
        const range = document.createRange(); range.selectNodeContents(value)
        return { text: value.textContent, exact: value.getAttribute('data-legend-value'), overflow: style.textOverflow,
          box: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
          item: { left: item.left, right: item.right, top: item.top, bottom: item.bottom },
          viewport: { top: viewport.top, bottom: viewport.bottom },
          lines: [...range.getClientRects()].map(rect => ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom })) }
      }))
      for (const value of measurements) {
        assert.ok(value.text?.includes("obs/s") && Number.isFinite(Number(value.exact)), `Expected a provider value with its full unit: ${JSON.stringify(value)}`)
        assert.notEqual(value.overflow, "ellipsis", "Values must not be ellipsized")
        assert.ok(value.lines.every(line => line.left >= value.item.left - 1 && line.right <= value.item.right + 1 && line.top >= value.item.top - 1 && line.bottom <= value.item.bottom + 1), `Value glyphs must fit their legend entry: ${JSON.stringify(value)}`)
        assert.ok(value.lines.every(line => line.top >= value.viewport.top - 1 && line.bottom <= value.viewport.bottom + 1), `Value glyphs must be visible within the legend: ${JSON.stringify(value)}`)
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: all three current legend values and units fit`)
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally { await browser.close() }
