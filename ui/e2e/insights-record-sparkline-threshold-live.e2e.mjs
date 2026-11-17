// Exercise missing row data and missing threshold configuration against the
// local PostgreSQL provider, using an isolated ETag-protected dashboard.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const api = async (path, init) => {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const edge = await (await api("/api/insights/dashboards/local-gallery-edge-watch")).json()
const source = edge.widgets.find(widget => widget.id === "risks")
assert.ok(source?.providerId)
const history = JSON.stringify([{ timestamp: "2026-10-28T12:00:00Z", value: 2 }, { timestamp: "2026-10-28T12:01:00Z", value: 3 }])
const query = risk => JSON.stringify({ sql: `SELECT 'node'::text AS source, 'US'::text AS country, '${history}'::text AS trend, ${risk} AS risk, 'Unknown'::text AS status`, parameters: [] })
const id = `sparkline-color-${Date.now()}`
const widget = (id, risk, y, thresholds) => {
  const copy = structuredClone(source)
  copy.id = id; copy.title = id; copy.query = query(risk); delete copy.queryRef
  copy.layout = { x: 0, y, w: 8, h: 3 }
  copy.options = { ...copy.options, thresholds }
  return copy
}
const document = { schemaVersion: 1, id, title: "Sparkline color states", timeRange: "1h", refreshInterval: 0, variables: [], widgets: [widget("unknown", "NULL::double precision", 0, source.options.thresholds), widget("unconfigured", "42::double precision", 3, undefined)] }
const path = `/api/insights/dashboards/${id}`
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
      for (const [widgetId, expected] of [["unknown", "Color by risk: no data"], ["unconfigured", "Color by risk: 42 · no thresholds configured"]]) {
        const panel = page.locator(`[data-widget-id="${widgetId}"]`)
        const sparkline = panel.locator('[data-cell-display="sparkline"][data-history-state="valid"]')
        await sparkline.waitFor()
        assert.equal(await sparkline.locator("[data-history-color-meaning]").textContent(), expected)
        assert.equal(await sparkline.locator("svg").evaluate(element => element.style.color), "var(--gamma-muted)")
        assert.equal(await sparkline.locator("svg").getAttribute("data-sample-count"), "2")
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: missing threshold value and absent thresholds remain neutral with actual PostgreSQL history`)
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
