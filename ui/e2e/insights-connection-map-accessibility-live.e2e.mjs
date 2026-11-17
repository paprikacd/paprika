// Exercise the dense map against the isolated PostgreSQL-backed gallery.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
const app = new URL(process.env.INSIGHTS_E2E_URL ?? "http://127.0.0.1:3199")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:64867")
assert.equal(app.hostname, "127.0.0.1")
assert.equal(api.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const { width, touch } of [{ width: 1512 }, { width: 390 }, { width: 390, touch: true }]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce", ...(touch ? { isMobile: true, hasTouch: true } : {}) })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url())
      const headers = { ...route.request().headers() }
      delete headers.origin
      delete headers.host
      const response = await route.fetch({ url: new URL(original.pathname + original.search, api).href, headers })
      await route.fulfill({ response })
    })
    try {
      const saved = await fetch(new URL("/api/insights/dashboards/local-gallery-edge-watch", api))
      assert.equal(saved.status, 200)
      const etag = saved.headers.get("x-paprika-document-etag") ?? saved.headers.get("etag")
      const original = await saved.json()
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", app).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="locations"]')
      await panel.scrollIntoViewIfNeeded()
      const map = panel.getByRole("group", { name: /Geographic map/ })
      await map.waitFor()
      const markers = map.getByRole("button")
      await markers.first().waitFor()
      assert.equal(await markers.count(), 432)
      assert.equal(await markers.evaluateAll(elements => elements.filter(element => element.tabIndex === -1).length), 432)
      const names = await markers.evaluateAll(elements => elements.map(element => element.getAttribute("aria-label")))
      assert.ok(names.every(name => !/\d{7}/.test(name)), "Spoken coordinates should not contain raw floating-point artifacts")
      const topMarker = markers.last()
      const pointerLabel = (await topMarker.getAttribute("aria-label")).split(" · ")[0]
      assert.ok(pointerLabel.startsWith("Global land sample "), "Global map samples must be selectable, not decorative pixels")
      if (touch) await topMarker.tap(); else await topMarker.click()
      const choices = panel.getByRole("region", { name: "Locations under this point" })
      if (await choices.count()) await choices.getByRole("button", { name: `Inspect overlapping location ${pointerLabel}`, exact: true }).click()
      assert.equal(await page.getByRole("textbox", { name: "Location", exact: true }).inputValue(), pointerLabel, "Clicking a recorded map point must update the linked location")
      const detail = page.locator('[data-widget-id="geo-selected-detail"]')
      await detail.scrollIntoViewIfNeeded()
      await detail.getByText(pointerLabel, { exact: true }).waitFor()
      await panel.scrollIntoViewIfNeeded()
      const summary = panel.locator("summary", { hasText: "Explore locations" })
      await summary.click()
      const list = panel.getByRole("region", { name: "Location observations" })
      const search = panel.getByRole("textbox", { name: "Filter locations" })
      await search.waitFor()
      assert.equal(await list.getByRole("button").count(), 20)
      const next = panel.getByRole("button", { name: "Next", exact: true })
      await next.scrollIntoViewIfNeeded()
      await next.click()
      assert.ok(await panel.getByText("21–40 of 432").isVisible())
      await search.fill("no such observation")
      assert.ok(await list.getByText("No locations match this filter.").isVisible())
      await search.fill("Tokyo region sample 16")
      const match = list.getByRole("button", { name: "Inspect location Tokyo region sample 16" })
      await match.waitFor()
      assert.equal(await list.getByRole("button").count(), 1)
      await match.focus()
      assert.equal(await match.evaluate(element => element === document.activeElement), true)
      assert.ok(await match.isVisible())
      await match.press("Enter")
      await detail.scrollIntoViewIfNeeded()
      await detail.getByText("Tokyo region sample 16", { exact: true }).waitFor()
      assert.equal(await page.getByRole("textbox", { name: "Location", exact: true }).inputValue(), "Tokyo region sample 16", "Map activation must update the view-only location variable")
      const selectedClusterRequest = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false
        try {
          const query = JSON.parse(response.request().postDataJSON().query)
          return query.sql.includes("gallery.geo_global_events") && query.parameters?.[0] === "delta" && query.parameters?.[1] === "Tokyo region sample 16"
        } catch { return false }
      })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "delta")
      await detail.scrollIntoViewIfNeeded()
      const selectedFrame = (await (await selectedClusterRequest).json()).records
      const selectedLabel = selectedFrame.columns.findIndex(column => column.key === "label")
      assert.equal(selectedFrame.rows.length, 1)
      assert.equal(selectedFrame.rows[0][selectedLabel], "Tokyo region sample 16", "Selection must remain scoped to the newly selected cluster")
      const after = await fetch(new URL("/api/insights/dashboards/local-gallery-edge-watch", api))
      assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag, "Map selection must not write the dashboard")
      assert.deepEqual(await after.json(), original)
      assert.deepEqual(errors, [])
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), "Dashboard must not overflow horizontally")
      console.log(`PASS ${theme} ${width}px${touch ? " touch" : ""}: 432 map markers, searchable keyboard selection and linked detail without a dashboard write`)
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" })
      await context.close()
    }
  }
} finally { await browser.close() }
