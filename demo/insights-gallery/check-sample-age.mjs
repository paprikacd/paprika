// The Signal Kit gap must follow the query window, not the seed time.
import assert from "node:assert/strict"

const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only a loopback gallery is supported")
const savedResponse = await fetch(new URL("/api/insights/saved-queries", origin))
assert.equal(savedResponse.status, 200)
const saved = (await savedResponse.json()).queries.find(query => query.id === "local-signal-old-samples")
assert.ok(saved, "The old-sample saved query must exist")
const now = Math.floor(Date.now() / 60_000) * 60
for (const cluster of ["omega", "delta"]) for (const offset of [0, 20 * 60]) {
  const end = now - offset
  const response = await fetch(new URL("/api/insights/query", origin), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: saved.providerId, kind: "metrics", query: saved.query.replaceAll("{{cluster}}", JSON.stringify(cluster)), start: end - 3600, end, step: 60 }),
  })
  assert.equal(response.status, 200, `${cluster}/${offset}: ${await response.clone().text()}`)
  const result = await response.json()
  const points = result.series?.flatMap(series => series.points ?? []).filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value)) ?? []
  assert.ok(points.length > 1, `${cluster}/${offset}: expected real returned history`)
  const age = end - Math.max(...points.map(point => point.timestamp)) / 1000
  // The @ end() anchor is the latest provider sample, which may itself be up
  // to Prometheus's five-minute lookback behind the requested range end.
  assert.ok(age >= 600 && age <= 960, `${cluster}/${offset}: expected a ten-minute gap plus at most one lookback period, got ${age}s`)
  console.log(`PASS ${cluster}: ${offset ? "historical" : "current"} window returns a ${age}s sample gap`)
}
