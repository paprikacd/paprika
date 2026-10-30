// Verify Fleet Atlas's synthetic node conditions through real Prometheus.
import assert from "node:assert/strict"
const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only a loopback gallery is supported")
const response = await fetch(new URL("/api/insights/saved-queries", origin))
assert.equal(response.status, 200)
const saved = (await response.json()).queries
const end = Math.floor(Date.now() / 60_000) * 60 - 60
async function query(id, cluster) {
  const definition = saved.find(item => item.id === id)
  assert.ok(definition, `${id}: saved query missing`)
  const result = await fetch(new URL("/api/insights/query", origin), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: definition.providerId, kind: "metrics", query: definition.query.replaceAll("{{cluster}}", JSON.stringify(cluster)), start: end - 6 * 3600, end, step: 180 }),
  })
  assert.equal(result.status, 200, `${id}: ${await result.clone().text()}`)
  return (await result.json()).series
}
for (const cluster of ["omega", "delta"]) {
  const [conditions, counts] = await Promise.all([
    query("local-ab-fleet-atlas-states", cluster), query("local-ab-fleet-atlas-nodes", cluster),
  ])
  assert.equal(conditions.length, 8)
  assert.ok(conditions.every(series => series.labels.cluster === cluster && series.labels.node))
  assert.deepEqual(new Set(conditions.flatMap(series => series.points.map(point => point.value))), new Set([0, 1, 2]))
  const missing = conditions.find(series => series.labels.node === "node-06")
  assert.ok(missing.points.some((point, i) => i > 0 && point.timestamp - missing.points[i - 1].timestamp > 180_000), "Unobserved node conditions must remain a gap")
  const latestStates = conditions.flatMap(series => series.points.filter(point => point.timestamp === end * 1000))
  const lastCount = counts[0].points.find(point => point.timestamp === end * 1000)
  assert.ok(lastCount && latestStates.length > 0)
  assert.equal(lastCount.value, latestStates.filter(point => point.value > 0).length, "Ready count must include observed ready and pressure states only")
  console.log(`PASS ${cluster}: eight node histories, all three observed states, missing interval and matching ready count`)
}
