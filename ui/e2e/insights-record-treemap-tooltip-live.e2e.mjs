// Real local PostgreSQL treemap hover, selection and pointer behavior.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium } from "playwright"

const app = new URL(process.env.INSIGHTS_E2E_URL ?? "http://127.0.0.1:1")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:1")
assert.equal(app.hostname, "127.0.0.1"); assert.equal(api.hostname, "127.0.0.1")
const endpoint = new URL("/api/insights/dashboards/local-gallery-market-lens", api)
const before = await fetch(endpoint), original = await before.text()
const board = JSON.parse(original), areaFallbackUnit = board.widgets.find(widget => widget.id === "composition").unit
const etag = before.headers.get("x-paprika-document-etag") ?? before.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) for (const touch of width === 390 ? [false, true] : [false]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce", hasTouch: touch, isMobile: touch })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), destination = new URL(original.pathname + original.search, api)
      const headers = { ...route.request().headers() }; delete headers.origin; delete headers.host
      const response = await route.fetch({ url: destination.href, headers }); await route.fulfill({ response })
    })
    try {
      const response = page.waitForResponse(response => {
        if (!response.url().includes("/api/insights/query") || response.request().method() !== "POST") return false
        try { return response.request().postDataJSON().query?.includes("x.market_cap DESC LIMIT 4") } catch { return false }
      })
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-market-lens", app).href, { waitUntil: "networkidle" })
      const tile = page.locator('[data-widget-id="composition"]')
      await tile.scrollIntoViewIfNeeded()
      const chart = tile.getByRole("group", { name: "Company composition by market cap" })
      const company = chart.getByRole("button", { name: /^DEMO091:/ })
      await company.waitFor()
      assert.ok((await company.getAttribute("aria-label")).includes("B AUD"), "The full area unit remains available to assistive technology")
      const frame = (await (await response).json()).records
      const index = name => frame.columns.findIndex(column => column.key === name)
      const row = frame.rows.find(row => row[index("ticker")] === "DEMO091")
      assert.ok(row, "Selected tile must come from the returned PostgreSQL frame")
      if (touch) await company.tap()
      else {
        const box = await company.locator("rect").first().boundingBox()
        assert.ok(box && box.width > 8 && box.height > 8)
        const point = { x: box.x + box.width * .4, y: box.y + box.height * .4 }
        await page.mouse.move(point.x, point.y)
        const tip = page.getByRole("tooltip")
        await tip.waitFor({ timeout: 5000 })
        await page.waitForFunction(({ element, point }) => {
          const box = element.getBoundingClientRect()
          return Math.min(Math.abs(box.top - point.y - 16), Math.abs(box.bottom - point.y + 16)) <= 2
        }, { element: await tip.elementHandle(), point })
        assert.equal(await tip.evaluate(element => getComputedStyle(element).pointerEvents), "none")
        const placement = await tip.evaluate(element => {
          const box = element.getBoundingClientRect()
          return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: innerWidth, height: innerHeight }
        })
        assert.ok(placement.left >= -1 && placement.top >= -1 && placement.right <= placement.width + 1 && placement.bottom <= placement.height + 1, `Tooltip must remain in viewport: ${JSON.stringify(placement)}`)
        const inset = await tip.evaluate(element => {
          const outer = element.getBoundingClientRect(), title = element.querySelector("strong")?.getBoundingClientRect()
          return title ? { left: title.left - outer.left, top: title.top - outer.top } : null
        })
        assert.ok(inset && inset.left >= 8 && inset.top >= 8, `Tooltip text needs breathing room: ${JSON.stringify(inset)}`)
        assert.equal(await company.getAttribute("aria-pressed"), "false", "Hover must not select or pin")
        assert.equal(await tip.locator("[data-treemap-observation]").getAttribute("data-treemap-observation"), String(row[index("market_cap")]))
        assert.equal(await tip.locator("[data-treemap-color-observation]").getAttribute("data-treemap-color-observation"), String(row[index("short_interest")]))
        if (process.env.TREEMAP_TOOLTIP_SCREENSHOTS) {
          await mkdir(process.env.TREEMAP_TOOLTIP_SCREENSHOTS, { recursive: true })
          await page.screenshot({ path: `${process.env.TREEMAP_TOOLTIP_SCREENSHOTS}/${theme}-${width}.png`, animations: "disabled" })
        }
        await company.focus(); await company.press("Enter")
      }
      const pinned = page.getByRole("tooltip")
      await pinned.waitFor()
      assert.equal(await company.getAttribute("aria-pressed"), "true")
      assert.equal(await pinned.locator("[data-treemap-observation]").getAttribute("data-treemap-observation"), String(row[index("market_cap")]))
      assert.equal(await pinned.locator("[data-treemap-color-observation]").getAttribute("data-treemap-color-observation"), String(row[index("short_interest")]))
      const areaUnit = frame.columns[index("market_cap")].unit || areaFallbackUnit
      if (areaUnit) {
        assert.ok((await pinned.locator("[data-treemap-observation]").innerText()).includes(areaUnit), "Area value must show its column or widget unit")
        if (!frame.columns[index("short_interest")].unit) assert.ok(!(await pinned.locator("[data-treemap-color-observation]").innerText()).includes(areaUnit), "Area units must not leak into the independent color value")
      }
      const detail = page.locator('[data-widget-id="selected-company"]')
      await detail.scrollIntoViewIfNeeded(); await detail.getByText("DEMO091", { exact: true }).waitFor()
      await company.scrollIntoViewIfNeeded(); await company.focus(); await company.press("Escape")
      await pinned.waitFor({ state: "hidden" })
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px${touch ? " touch" : ""}: exact treemap data, selection and tooltip`)
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally { await browser.close() }
const after = await fetch(endpoint)
assert.equal(await after.text(), original)
assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag)
