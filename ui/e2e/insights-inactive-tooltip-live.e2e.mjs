// Changing visualizations must not hide or silently drop tooltip settings.
// Uses a unique ETag-protected dashboard and real local Prometheus data.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
const app = new URL(process.env.INSIGHTS_E2E_URL || origin.href)
for (const url of [origin, app]) assert.equal(url.hostname, "127.0.0.1")
const api = async (path, options) => {
  const response = await fetch(new URL(path, origin), options)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const base = await (await api("/api/insights/dashboards/local-gallery-service-pulse")).json()
const id = `inactive-tooltip-e2e-${Date.now()}`
const tooltipView = { type: "stat", source: { type: "widget" } }
const document = { schemaVersion: 1, id, title: "Inactive tooltip E2E", timeRange: "1h", refreshInterval: 0, variables: [], widgets: [{
  id: "rate", title: "Request rate", type: "timeseries", providerId: base.widgets[0].providerId,
  query: 'sum(rate(paprika_demo_requests_total{cluster="omega",service="checkout"}[5m]))', unit: "req/s", layout: { x: 0, y: 0, w: 6, h: 5 },
  options: { showTooltip: true, tooltipView },
}] }
const path = `/api/insights/dashboards/${id}`
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
let revision = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(revision)
const browser = await chromium.launch({ headless: true })
await mkdir("../artifacts/insights/inactive-tooltip-live", { recursive: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: app.origin, theme })
    const page = await context.newPage(), errors = []
    let closing = false
    page.on("pageerror", error => errors.push(error.message))
    if (app.origin !== origin.origin) await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), headers = { ...route.request().headers() }
      delete headers.origin; delete headers.host
      try { await route.fulfill({ response: await route.fetch({ url: new URL(original.pathname + original.search, origin).href, headers }) }) }
      catch (error) { if (!closing) throw error }
    })
    try {
      await page.goto(`${app.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      const tile = page.locator('[data-widget-id="rate"]')
      await tile.getByRole("img", { name: "Request rate" }).waitFor()
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await tile.getByRole("button", { name: "Edit Request rate", exact: true }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      const viz = editor.getByRole("combobox", { name: "Visualization", exact: true })
      await selectGammaOption(page, viz, /^Threshold gauge/)
      await editor.getByText(/configured tooltip widget is inactive/).waitFor()
      await editor.getByText(/configured tooltip widget is inactive/).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `../artifacts/insights/inactive-tooltip-live/${theme}-${width}.png`, animations: "disabled" })
      await selectGammaOption(page, viz, /^Time series/)
      await editor.getByRole("tab", { name: "Tooltips" }).click()
      await editor.getByRole("button", { name: "Remove tooltip widget", exact: true }).waitFor()
      assert.ok((await editor.getByRole("combobox", { name: "Tooltip visualization" }).innerText()).includes("Single value"), "Original tooltip visualization should be retained")
      await selectGammaOption(page, viz, /^Threshold gauge/)
      await editor.getByRole("button", { name: "Remove inactive tooltip widget" }).click()
      assert.equal(await editor.getByText(/configured tooltip widget is inactive/).count(), 0)
      if (theme === "dark" && width === 390) {
        await editor.getByRole("button", { name: "Apply widget" }).click()
        const write = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === path && response.ok())
        await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
        await write
        const saved = await api(path)
        const next = saved.headers.get("x-paprika-document-etag") ?? saved.headers.get("etag")
        assert.ok(next && next !== revision)
        const widget = (await saved.json()).widgets[0]
        assert.equal(widget.pluginId, "threshold-gauge")
        assert.equal(widget.options?.tooltipView, undefined)
        revision = next
      } else {
        await editor.getByRole("button", { name: "Close widget editor" }).click()
        const saved = await api(path)
        assert.equal(saved.headers.get("x-paprika-document-etag") ?? saved.headers.get("etag"), revision)
        assert.deepEqual((await saved.json()).widgets[0].options.tooltipView, tooltipView)
      }
      assert.deepEqual(errors, [])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
      console.log(`PASS ${theme} ${width}px: retained tooltip settings survive switching and explicit removal${theme === "dark" && width === 390 ? " persists on Save" : " stays a draft"}`)
    } finally { closing = true; await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), revision)
  await api(path, { method: "DELETE", headers: { "If-Match": revision } })
}
