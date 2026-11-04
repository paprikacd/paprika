// Check that the synthetic incident records correspond to actual Prometheus
// error-rate spikes. This only talks to the isolated loopback demo harness.
import assert from "node:assert/strict"
const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only a loopback gallery is supported")
async function request(path, options = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(30000) })
    const body = await response.json()
    if (response.status === 429 && attempt < 7) { await new Promise(done => setTimeout(done, 300 * (attempt + 1))); continue }
    assert.equal(response.status, 200, `${path}: ${body.error ?? response.status}`)
    return body
  }
  throw Error("Provider remained rate limited")
}
const saved = (await request("/api/insights/saved-queries")).queries
const burn = saved.find(q => q.id === "local-ab-reliability-room-burn")
const events = saved.find(q => q.id === "local-reliability-events")
assert.ok(burn && events, "The Reliability saved queries must exist")
const end = Math.floor(Date.now() / 1000), start = end - 30 * 86400
for (const service of ["checkout", "payments"]) {
  async function query(item) {
    return request("/api/insights/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: item.providerId, kind: item.kind, query: item.query.replaceAll("{{service}}", JSON.stringify(service)), start, end, step: 1800 }) })
  }
  const history = await query(burn), incident = (await query(events)).records
  const index = key => incident.columns.findIndex(column => column.key === key)
  const row = incident.rows.find(row => row[index("label")] === "Synthetic elevated request errors")
  assert.ok(row, `${service}: a recorded synthetic incident is required`)
  const from = Date.parse(row[index("date")]), to = Date.parse(row[index("ended_at")])
  assert.ok(Number.isFinite(from) && to > from, `${service}: invalid recorded interval`)
  const one = history.series.find(series => series.labels.window === "1h")
  const six = history.series.find(series => series.labels.window === "6h")
  assert.ok(one && six, `${service}: both rolling rates must be returned`)
  const finite = points => points.filter(p => Number.isFinite(p.value))
  const within = finite(one.points).filter(p => p.timestamp >= from && p.timestamp <= to)
  const outside = finite(one.points).filter(p => p.timestamp >= from - 6 * 3600_000 && p.timestamp < from - 3600_000)
  assert.ok(within.length >= 4 && outside.length >= 4, `${service}: insufficient recorded observations`)
  const peak = Math.max(...within.map(p => p.value)), baseline = Math.max(...outside.map(p => p.value))
  assert.ok(peak > 2 && peak > baseline + 0.5, `${service}: recorded incident does not coincide with an error-rate spike (${peak} vs ${baseline})`)
  const other = new Map(finite(six.points).map(p => [p.timestamp, p.value]))
  assert.ok(within.some(p => other.has(p.timestamp) && Math.abs(p.value - other.get(p.timestamp)) > 0.1), `${service}: 1h and 6h burn rates must diverge during the event`)
  console.log(`PASS ${service}: incident ${new Date(from).toISOString()}–${new Date(to).toISOString()}, 1h burn peak ${peak.toFixed(2)}×`)
}
