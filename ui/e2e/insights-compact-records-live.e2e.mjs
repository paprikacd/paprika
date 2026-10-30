// Compact cells must remain readable within a dense dashboard. Fetch through
// the isolated real Insights/Observe/Postgres demo, never a mocked result.
import assert from "node:assert/strict"
import { chromium } from "playwright"
const app = new URL(process.env.INSIGHTS_E2E_URL ?? "http://127.0.0.1:3199")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:64142")
assert.equal(app.hostname, "127.0.0.1")
assert.equal(api.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url())
      const destination = new URL(original.pathname + original.search, api)
      const headers = { ...route.request().headers() }
      delete headers.origin
      delete headers.host
      const response = await route.fetch({ url: destination.href, headers })
      await route.fulfill({ response })
    })
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", app).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="risks"]')
      await panel.scrollIntoViewIfNeeded()
      const region = panel.getByRole("region", { name: "Risk by source records" })
      await region.getByRole("table").waitFor()
      await region.getByText("AS64501").waitFor()
      const metrics = await region.evaluate(region => {
        const rows = [...region.querySelectorAll("tbody tr")]
        const header = [...region.querySelectorAll("thead th")]
        const r = region.getBoundingClientRect()
        const last = header.at(-1).getBoundingClientRect()
        const spark = region.querySelector('[data-cell-display="sparkline"]').getBoundingClientRect()
        const bar = region.querySelector('[data-cell-display="bar-segments"]').getBoundingClientRect()
        return { client: region.clientWidth, scroll: region.scrollWidth, scrollLeft: region.scrollLeft,
          rightVisible: last.right <= r.right + 1, rows: rows.length, header: header.map(e => e.innerText), spark: spark.width, bar: bar.width }
      })
      assert.equal(metrics.rows, 5)
      assert.ok(metrics.header.some(label => /status/i.test(label)))
      assert.ok(metrics.spark >= 80 && metrics.bar >= 80, `Visual cells must remain legible: ${JSON.stringify(metrics)}`)
      // A desktop-sized quarter-width panel should show every column at once.
      if (width === 1512) assert.ok(metrics.scroll <= metrics.client + 1 && metrics.rightVisible, `Unnecessary compact-table overflow: ${JSON.stringify(metrics)}`)
      if (metrics.scroll > metrics.client + 1) {
        const hint = panel.getByText("Scroll horizontally to see more columns")
        await hint.waitFor()
        assert.equal(await region.getAttribute("aria-describedby"), await hint.getAttribute("id"), "Overflow guidance must be associated with the scroll region")
        await region.focus()
        for (let n = 0; n < 8; n++) await page.keyboard.press("ArrowRight")
        await page.waitForTimeout(200)
        assert.ok(await region.evaluate(element => element.scrollLeft > 0), "Narrow tables must remain keyboard-scrollable")
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px compact table: ${JSON.stringify(metrics)}`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
