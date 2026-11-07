// Exercise large supported signed PostgreSQL values through real record charts.
// Out-of-contract larger numbers must fail at the provider, not be invented.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const saved = (await (await api("/api/insights/saved-queries")).json()).queries.find(query => query.id === "local-market-company-history")
assert.ok(saved)
const expression = "SELECT x::float8 AS coordinate, y::float8 AS value FROM (VALUES (-9007199254740000::float8,-9007199254740000::float8), (0::float8,0::float8), (9007199254740000::float8,9007199254740000::float8)) AS points(x,y) ORDER BY x"
const now = Math.floor(Date.now() / 1000)
const request = query => fetch(new URL("/api/insights/query", origin), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: saved.providerId, kind: "records", query, start: now - 3600, end: now, step: 60 }) })
const source = await request(expression)
assert.ok(source.ok)
assert.deepEqual((await source.json()).records.rows, [[-9007199254740000,-9007199254740000],[0,0],[9007199254740000,9007199254740000]])
const unsupported = await request("SELECT 1e308::float8 AS value")
assert.equal(unsupported.status, 502, "The provider must reject values beyond its documented record precision bound")
assert.equal((await unsupported.json()).error, "provider query failed; check the query and provider configuration")
const id = `record-scale-${Date.now()}`
const path = `/api/insights/dashboards/${id}`
const document = { schemaVersion: 1, id, title: "Record scale E2E", timeRange: "1h", refreshInterval: 0, variables: [], widgets: ["records-line", "records-bar"].map((pluginId, index) => ({ id: pluginId, title: pluginId, type: "plugin", pluginId, dataKind: "records", providerId: saved.providerId, query: expression, unit: "", config: { x: "coordinate", y: ["value"] }, options: { decimals: 2 }, layout: { x: index * 6, y: 0, w: 6, h: 5 } })) }
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512,390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
      for (const pluginId of ["records-line", "records-bar"]) {
        const panel = page.locator(`[data-widget-id="${pluginId}"]`)
        await panel.scrollIntoViewIfNeeded()
        const marks = panel.locator("[data-record-mark]")
        await marks.nth(2).waitFor()
        const coordinates = await marks.evaluateAll(elements => elements.map(element => ({ x: Number(element.getAttribute(element.tagName.toLowerCase() === "circle" ? "cx" : "x")), y: Number(element.getAttribute(element.tagName.toLowerCase() === "circle" ? "cy" : "y")) })))
        assert.equal(coordinates.length, 3)
        assert.ok(coordinates.every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))
        assert.ok(coordinates[0].x < coordinates[1].x && coordinates[1].x < coordinates[2].x)
        assert.doesNotMatch(await panel.innerText(), /NaN|Infinity/)
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: large signed PostgreSQL values render as distinct finite record marks`)
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
