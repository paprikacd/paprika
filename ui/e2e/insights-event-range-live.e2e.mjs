// Verify the gallery's point-in-time event tables and annotations follow the
// dashboard window using the real isolated PostgreSQL provider.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const documents = ["local-gallery-edge-watch", "local-gallery-collection-control"]
const etag = response => response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
const revisions = await Promise.all(documents.map(async id => etag(await api(`/api/insights/dashboards/${id}`))))
assert.ok(revisions.every(Boolean))
const queries = (await (await api("/api/insights/saved-queries")).json()).queries
const cases = [
  { id: "local-edge-blocked-requests", table: "gallery.edge_blocked_requests", time: "occurred_at", variable: "gateway", dashboard: documents[0], widget: "blocked-requests", visible: "Blocked" },
  { id: "local-edge-gateway-events", table: "gallery.edge_events", time: "occurred_at", variable: "gateway" },
  { id: "local-ab-collection-control-failures", table: "gallery.jobs", time: "started_at", variable: "pipeline", extra: " AND state <> 'Succeeded'", dashboard: documents[1], widget: "failures", visible: /Failed|Retrying/ },
]
const saved = cases.map(item => ({ ...item, query: queries.find(query => query.id === item.id) }))
assert.ok(saved.every(item => item.query))
const now = Math.floor(Date.now() / 1000)
const request = async (query, start, end) => (await (await api("/api/insights/query", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ providerId: saved[0].query.providerId, kind: "records", query, start, end, step: 60 }),
})).json()).records
for (const item of saved) {
  for (const cluster of ["omega", "delta"]) {
    const raw = await request(`SELECT ${item.time} FROM ${item.table} d WHERE to_jsonb(d)->>'cluster'='${cluster}'${item.extra ?? ""} ORDER BY ${item.time} DESC LIMIT 1`, now - 7 * 86400, now)
    assert.equal(raw.rows.length, 1, `${item.id}/${cluster} needs a seeded observation`)
    const sample = Date.parse(raw.rows[0][0]) / 1000
    assert.ok(Number.isFinite(sample))
    const start = Math.floor(sample) - 1, end = Math.floor(sample) + 1
    const expanded = item.query.query.replaceAll(`{{${item.variable}}}`, JSON.stringify(cluster))
    const selected = await request(expanded, start, end)
    const dateColumn = selected.columns.findIndex(column => ["date", "time", "started"].includes(column.key))
    assert.ok(dateColumn >= 0 && selected.rows.length > 0, `${item.id}/${cluster} must include the selected event`)
    assert.ok(selected.rows.every(row => Date.parse(row[dateColumn]) / 1000 >= start && Date.parse(row[dateColumn]) / 1000 <= end), `${item.id}/${cluster} returned an event outside the range`)
    assert.equal((await request(expanded, 1577836800, 1577923200)).rows.length, 0, `${item.id}/${cluster} must not show newer events in 2020`)
    if (cluster === "omega") Object.assign(item, { start, end })
  }
}
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      for (const item of saved.filter(item => item.dashboard)) for (const [start, end, empty] of [[item.start, item.end, false], [1577836800, 1577923200, true]]) {
        const url = new URL("/dashboard/insights/", origin)
        url.searchParams.set("dashboard", item.dashboard)
        url.searchParams.set("from", new Date(start * 1000).toISOString())
        url.searchParams.set("to", new Date(end * 1000).toISOString())
        await page.goto(url.href, { waitUntil: "networkidle" })
        const panel = page.locator(`[data-widget-id="${item.widget}"]`)
        await panel.scrollIntoViewIfNeeded()
        if (empty) await panel.getByText(/no data|no records/i).first().waitFor()
        else await panel.getByText(item.visible).first().waitFor()
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: Edge and Collection event tables follow selected range`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
assert.deepEqual(await Promise.all(documents.map(async id => etag(await api(`/api/insights/dashboards/${id}`)))), revisions)
console.log("PASS real PostgreSQL events and annotations use selected windows and cluster bindings")
