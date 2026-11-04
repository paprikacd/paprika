// Verify Market Lens historical charts and row histories use the selected
// dashboard range against the isolated real PostgreSQL provider.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const etag = response => response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
const dashboardPath = "/api/insights/dashboards/local-gallery-market-lens"
const before = etag(await api(dashboardPath))
assert.ok(before)
const queries = (await (await api("/api/insights/saved-queries")).json()).queries
const company = queries.find(query => query.id === "local-market-company-history")
const sectors = queries.find(query => query.id === "local-market-sector-history")
const sector = queries.find(query => query.id === "local-ab-market-lens-history")
const rankings = queries.find(query => query.id === "local-ab-market-lens-companies-list")
assert.ok(company && sectors && sector && rankings)
const now = Math.floor(Date.now() / 1000)
const query = async (document, start, end) => (await (await api("/api/insights/query", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ providerId: company.providerId, kind: "records", query: document, start, end, step: 60 }),
})).json()).records
const all = await query("SELECT observed_at FROM gallery.company_history WHERE symbol='DEMO001' ORDER BY observed_at", now - 7 * 86400, now)
const times = all.rows.map(row => Date.parse(row[0]) / 1000)
assert.ok(times.length > 8 && times.every(Number.isFinite))
const start = times[2], end = times[5], expected = times.slice(2, 6)
const bind = document => document.query.replaceAll("{{company}}", JSON.stringify("DEMO001")).replaceAll("{{sector}}", JSON.stringify("Technology"))
for (const item of [company, sector]) {
  const frame = await query(bind(item), start, end)
  assert.deepEqual(frame.rows.map(row => Date.parse(row[0]) / 1000), expected, `${item.id} must include only the actual selected timestamps`)
  assert.equal((await query(bind(item), 1577836800, 1577923200)).rows.length, 0, `${item.id} must be empty before stored history`)
}
const grouped = await query(bind(sectors), start, end)
assert.deepEqual([...new Set(grouped.rows.map(row => Date.parse(row[0]) / 1000))].sort((a, b) => a - b), expected)
assert.equal((await query(bind(sectors), 1577836800, 1577923200)).rows.length, 0)
const list = await query(bind(rankings), start, end)
const historyColumn = list.columns.findIndex(column => column.key === "history")
assert.ok(historyColumn >= 0 && list.rows.length > 0)
for (const row of list.rows) assert.deepEqual(JSON.parse(row[historyColumn]).map(point => Date.parse(point.timestamp) / 1000), expected)
const oldList = await query(bind(rankings), 1577836800, 1577923200)
assert.ok(oldList.rows.length > 0, "Rankings remain a seed-time snapshot")
assert.ok(oldList.rows.every(row => row[historyColumn] === null), "No sparkline history is invented outside the range")

// The other relational sparklines also honor the same bounded range, keeping
// actual chronological observations instead of accumulating an invalid array.
const nodeQuery = queries.find(item => item.id === "local-ab-fleet-atlas-resources")
const riskQuery = queries.find(item => item.id === "local-ab-edge-watch-risks")
assert.ok(nodeQuery && riskQuery)
const bindCluster = item => item.query.replaceAll("{{cluster}}", JSON.stringify("omega")).replaceAll("{{gateway}}", JSON.stringify("omega"))
const nodeSource = await query("SELECT observed_at,cpu_ratio FROM gallery.node_history n WHERE to_jsonb(n)->>'cluster'='omega' AND node='node-01' ORDER BY observed_at", now - 7 * 86400, now)
const nodeTimes = nodeSource.rows.slice(2, 6).map(row => Date.parse(row[0]) / 1000)
assert.equal(nodeTimes.length, 4)
const nodes = await query(bindCluster(nodeQuery), nodeTimes[0], nodeTimes[3])
const nodeColumn = nodes.columns.findIndex(column => column.key === "node")
const cpuColumn = nodes.columns.findIndex(column => column.key === "cpu")
const nodeHistoryColumn = nodes.columns.findIndex(column => column.key === "history")
const node = nodes.rows.find(row => row[nodeColumn] === "node-01")
assert.ok(node)
assert.deepEqual(JSON.parse(node[nodeHistoryColumn]).map(point => Date.parse(point.timestamp) / 1000), nodeTimes)
assert.ok(Math.abs(node[cpuColumn] - nodeSource.rows[5][1] * 100) < 0.01, "CPU is the latest sample inside the selected range")
assert.equal((await query(bindCluster(nodeQuery), 1577836800, 1577923200)).rows.length, 0)
const riskSource = await query("SELECT source,observed_at FROM gallery.edge_source_history h WHERE to_jsonb(h)->>'cluster'='omega' ORDER BY source,observed_at", now - 7 * 86400, now)
const firstSource = riskSource.rows[0][0]
const riskTimes = riskSource.rows.filter(row => row[0] === firstSource).slice(2, 6).map(row => Date.parse(row[1]) / 1000)
assert.equal(riskTimes.length, 4)
const risks = await query(bindCluster(riskQuery), riskTimes[0], riskTimes[3])
const sourceColumn = risks.columns.findIndex(column => column.key === "source")
const trendColumn = risks.columns.findIndex(column => column.key === "trend")
const risk = risks.rows.find(row => row[sourceColumn] === firstSource)
assert.ok(risk)
assert.deepEqual(JSON.parse(risk[trendColumn]).map(point => Date.parse(point.timestamp) / 1000), riskTimes)
const oldRisks = await query(bindCluster(riskQuery), 1577836800, 1577923200)
assert.ok(oldRisks.rows.length > 0 && oldRisks.rows.every(row => row[trendColumn] === null), "Seed-time risk snapshots must not invent historical trends")

const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      for (const [from, to, empty] of [[start, end, false], [1577836800, 1577923200, true]]) {
        const url = new URL("/dashboard/insights/", origin)
        url.searchParams.set("dashboard", "local-gallery-market-lens")
        url.searchParams.set("from", new Date(from * 1000).toISOString())
        url.searchParams.set("to", new Date(to * 1000).toISOString())
        await page.goto(url.href, { waitUntil: "networkidle" })
        const chart = page.locator('[data-widget-id="selected-company-history"]')
        await chart.scrollIntoViewIfNeeded()
        if (empty) await chart.getByText(/no data|no records/i).first().waitFor()
        else await chart.locator("circle[aria-label]").first().waitFor()
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: Market Lens selected and empty historical windows`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
assert.equal(etag(await api(dashboardPath)), before)
console.log("PASS PostgreSQL market, node and risk histories honor selected inclusive boundaries; other fields remain seed-time snapshots")
