// Verify finite observations whose sum overflows still render truthful pie
// shares through the isolated Prometheus, Insights and browser stack.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const saved = (await (await api("/api/insights/saved-queries")).json()).queries.find(query => query.id === "local-signal-rate")
assert.ok(saved)
const expression = 'label_replace(vector(1e308),"kind","a","","") or label_replace(vector(1e308),"kind","b","","") or label_replace(vector(5e307),"kind","c","","")'
const id = `pie-extreme-${Date.now()}`
const path = `/api/insights/dashboards/${id}`
const document = { schemaVersion: 1, id, title: "Extreme pie observations", timeRange: "1h", refreshInterval: 0, variables: [], widgets: [{ id: "extreme", title: "Finite observations", type: "plugin", pluginId: "pie", dataKind: "metrics", providerId: saved.providerId, query: expression, unit: "", options: { decimals: 2, showTooltip: true }, config: { donut: true }, layout: { x: 0, y: 0, w: 8, h: 5 } }] }
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = [], responses = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("response", response => {
      if (new URL(response.url()).pathname === "/api/insights/query" && response.ok()) {
        try { if (response.request().postDataJSON().query === expression) responses.push(response.json()) } catch { /* Ignore unrelated requests. */ }
      }
    })
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
      const chart = page.locator('[data-widget-id="extreme"]')
      await chart.scrollIntoViewIfNeeded()
      const slices = chart.locator("[data-pie-index]")
      await slices.nth(2).waitFor()
      assert.equal(await slices.count(), 3)
      assert.ok(responses.length > 0)
      const data = await responses.at(-1)
      assert.deepEqual(data.series.map(series => series.points.at(-1).value).sort((a, b) => a - b), [5e307, 1e308, 1e308])
      const paths = await slices.locator("path").evaluateAll(paths => paths.map(path => path.getAttribute("d")))
      assert.equal(new Set(paths).size, 3, "Overflow must not collapse all sectors")
      assert.ok(paths.every(path => path && !/NaN|Infinity/.test(path)))
      const first = slices.first()
      await first.focus()
      const tip = page.getByRole("tooltip")
      await tip.waitFor()
      await tip.getByText("Share of positive observations: 40.00%", { exact: true }).waitFor()
      assert.equal(Number(await first.getAttribute("data-pie-value")), 1e308)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: finite overflow-scale observations retain exact 40/40/20 shares`)
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
