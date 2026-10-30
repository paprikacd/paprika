// Read-only verification against a newly started isolated gallery service.
// Wait for a genuine later worker tick, then query the same bounded saved
// queries used by Edge Watch. This never changes clocks or provider data.
import assert from "node:assert/strict"

const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only an isolated local gallery is supported")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response.json()
}
const queries = (await api("/api/insights/saved-queries")).queries
const blocked = queries.find(query => query.id === "local-edge-blocked-requests")
const events = queries.find(query => query.id === "local-edge-gateway-events")
assert.ok(blocked && events && blocked.providerId === events.providerId)
async function request(query) {
  const now = Math.floor(Date.now() / 1000)
  const result = await api("/api/insights/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: blocked.providerId, kind: "records", query, start: now - 1800, end: now, step: 60 }) })
  assert.ok(result.records, "A successful record frame is required")
  return result.records
}
const clockQuery = "SELECT through_at FROM gallery.synthetic_history_clock WHERE name='edge-blocks'"
const baseline = Date.parse((await request(clockQuery)).rows[0][0])
assert.ok(Number.isFinite(baseline))
let through = baseline
for (let attempt = 0; attempt < 11 && through <= baseline; attempt++) {
  await new Promise(resolve => setTimeout(resolve, 20000))
  through = Date.parse((await request(clockQuery)).rows[0][0])
}
assert.ok(through > baseline, "The worker must append another blocked-request tick after the test begins")
for (const cluster of ["omega", "delta"]) {
  for (const [name, saved, field] of [["blocked requests", blocked, "time"], ["events", events, "date"]]) {
    const frame = await request(saved.query.replaceAll("{{gateway}}", JSON.stringify(cluster)))
    const timeIndex = frame.columns.findIndex(column => column.key === field)
    assert.ok(timeIndex >= 0 && frame.rows.length > 0, `${cluster}: ${name} should have records in the selected 30-minute window`)
    const observed = frame.rows.map(row => Date.parse(row[timeIndex]))
    const now = Date.now()
    assert.ok(observed.every(at => Number.isFinite(at) && at <= now && at >= now - 1800_000 - 1000), `${cluster}: ${name} timestamps must remain in the selected historical range`)
    if (saved === blocked) assert.ok(observed.some(at => Math.abs(at - through) < 1000), `${cluster}: the dashboard query should expose the newly appended tick`)
  }
  console.log(`PASS ${cluster}: recent blocked requests and annotations remain visible after a later worker tick`)
}
