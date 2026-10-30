// A real Prometheus NaN tail must not make the previous valid Single value
// look current. The unique dashboard is removed with its exact ETag.
import assert from "node:assert/strict"
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
const metric = 'paprika_demo_source_freshness_seconds{cluster="omega",source="tempo"}'
// Before the last ten minutes, the expression adds zero; afterward it adds
// NaN (0 / 0). The actual Prometheus result is normalized by Insights to null.
const query = `${metric} + (0 / ((timestamp(${metric} @ end()) - time()) > bool 600))`
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const document = await (await api("/api/insights/dashboards/local-gallery-signal-kit")).json()
    const id = `stat-missing-${Date.now()}-${theme.toLowerCase()}-${width}`
    const original = document.widgets.find(widget => widget.id === "latency")
    document.id = id; document.title = "Latest observation missing test"; document.variables = []; document.timeRange = "1h"
    const widget = { ...original, id: "missing", title: "Observed source freshness", query, unit: "s", options: { showSparkline: true, sparklinePlacement: "side", decimals: 2 }, layout: { x: 0, y: 0, w: 6, h: 3 } }
    delete widget.queryRef; delete widget.annotationSource; delete widget.selectionBindings
    document.widgets = [widget]
    const created = await api(`/api/insights/dashboards/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
    const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    let closing = false
    if (app.origin !== origin.origin) await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const originalURL = new URL(route.request().url()), headers = { ...route.request().headers() }
      delete headers.origin; delete headers.host
      try { await route.fulfill({ response: await route.fetch({ url: new URL(originalURL.pathname + originalURL.search, origin).href, headers }) }) }
      catch (error) { if (!closing) throw error }
    })
    try {
      const observed = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false
        try { return response.request().postDataJSON().query === query } catch { return false }
      })
      await page.goto(`${app.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      const result = await (await observed).json(), points = result.series[0].points
      assert.equal(points.at(-1).value, null, "The live provider must return a missing final sample")
      const latestValid = [...points].reverse().find(point => typeof point.value === "number")
      assert.ok(latestValid, "A real earlier value is required")
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const tile = page.locator('[data-widget-id="missing"]')
      const status = tile.getByRole("status").filter({ hasText: "Last valid · latest missing" })
      await status.waitFor()
      assert.equal(Number(await tile.locator("[data-metric-value]").first().getAttribute("data-metric-value")), latestValid.value)
      if (process.env.STAT_MISSING_SCREENSHOTS) await tile.screenshot({ path: `${process.env.STAT_MISSING_SCREENSHOTS}/stat-missing-${theme.toLowerCase()}-${width}.png`, animations: "disabled" })
      await tile.getByRole("button", { name: "Inspect value for Observed source freshness" }).focus()
      await page.getByRole("tooltip").getByText("Latest valid sample", { exact: true }).waitFor()
      assert.deepEqual(errors, [])
      const current = await api(`/api/insights/dashboards/${id}`)
      assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
      console.log(`PASS ${theme} ${width}px: real missing tail with last-valid value`)
    } finally {
      closing = true
      await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close()
      const current = await api(`/api/insights/dashboards/${id}`)
      await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag") } })
    }
  }
} finally { await browser.close() }
