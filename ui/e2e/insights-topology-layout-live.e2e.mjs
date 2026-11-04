// Exercise the gallery's real PostgreSQL pipeline at the rendered card size.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const app = new URL(process.env.INSIGHTS_E2E_URL ?? "http://127.0.0.1:3199")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:61972")
assert.equal(app.hostname, "127.0.0.1")
assert.equal(api.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(value => localStorage.setItem("paprika-insights-theme", value), theme)
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
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-collection-control", app).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="topology"]')
      await panel.scrollIntoViewIfNeeded()
      const diagram = panel.getByRole("region", { name: "Pipeline diagram" })
      const retry = diagram.getByRole("button", { name: "Inspect stage retry" })
      await retry.waitFor()
      const next = panel.getByRole("button", { name: "Next pipeline stages" })
      while (await next.isVisible() && await next.isEnabled()) {
        await next.click()
        await page.waitForTimeout(150)
      }
      const geometry = await retry.evaluate(node => {
        const nodeRect = node.getBoundingClientRect(), viewport = node.closest('[aria-label="Pipeline diagram"]').getBoundingClientRect()
        return { top: nodeRect.top, bottom: nodeRect.bottom, viewportTop: viewport.top, viewportBottom: viewport.bottom, left: nodeRect.left, right: nodeRect.right, viewportLeft: viewport.left, viewportRight: viewport.right }
      })
      assert.ok(geometry.top >= geometry.viewportTop - 1 && geometry.bottom <= geometry.viewportBottom + 1, `A stage is vertically clipped at the normal card size: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.left >= geometry.viewportLeft - 1 && geometry.right <= geometry.viewportRight + 1, `A stage remains horizontally clipped after navigation: ${JSON.stringify(geometry)}`)
      if (process.env.TOPOLOGY_SCREENSHOTS) await panel.screenshot({ path: `${process.env.TOPOLOGY_SCREENSHOTS}/topology-${theme}-${width}.png` })
      await retry.click()
      await page.getByRole("tooltip").getByText("Recorded pipeline stage").waitFor()
      await page.keyboard.press("Escape")
      await panel.getByText("Connections · 4").click()
      const connections = panel.getByRole("region", { name: "Connection observations" })
      const connection = connections.getByRole("button", { name: /Inspect connection collect to normalize/ })
      await connection.click()
      await page.getByRole("tooltip").getByText("Sum of observed values").waitFor()
      await page.keyboard.press("Escape")
      assert.equal(await connections.getAttribute("tabindex"), "0")
      await panel.getByText("Connections · 4").click()

      // Small user-authored cards may still need two-axis scrolling. The
      // region must disclose that vertical scrolling is possible and support
      // a keyboard user in reaching the lower stage.
      await diagram.evaluate(element => { element.style.flex = "none"; element.style.minHeight = "100px"; element.style.height = "100px"; element.scrollTop = 0 })
      const hint = panel.getByText("Scroll to explore all stages vertically")
      await hint.waitFor()
      assert.equal(await diagram.getAttribute("aria-describedby"), await hint.getAttribute("id"))
      await diagram.focus()
      for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowDown")
      await page.waitForTimeout(200)
      assert.ok(await diagram.evaluate(element => element.scrollTop > 0), "The diagram must scroll vertically by keyboard")
      assert.deepEqual(errors, [])
      console.log(`PASS topology ${theme} ${width}px: complete node, inspection, disclosed keyboard scrolling`)
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" })
      await context.close()
    }
  }
} finally { await browser.close() }
