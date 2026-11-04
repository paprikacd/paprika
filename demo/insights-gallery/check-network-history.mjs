// Validate the synthetic Edge traffic through the real Insights provider path.
import assert from "node:assert/strict"

const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only a loopback gallery is supported")
const response = await fetch(new URL("/api/insights/saved-queries", origin))
assert.equal(response.status, 200)
const saved = (await response.json()).queries
const end = Math.floor(Date.now() / 60_000) * 60 - 120
async function run(id, cluster) {
  const query = saved.find(item => item.id === id)
  assert.ok(query, `${id}: missing saved query`)
  const result = await fetch(new URL("/api/insights/query", origin), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: query.providerId, kind: "metrics", query: query.query.replaceAll("{{gateway}}", JSON.stringify(cluster)), start: end - 1800, end, step: 60 }),
  })
  assert.equal(result.status, 200, `${id}/${cluster}: ${await result.clone().text()}`)
  return (await result.json()).series
}
for (const cluster of ["omega", "delta"]) {
  const series = await run("local-ab-edge-watch-flow", cluster)
  assert.deepEqual(new Set(series.map(item => item.labels.direction)), new Set(["inbound", "outbound"]))
  for (const direction of ["inbound", "outbound"]) {
    const points = series.find(item => item.labels.direction === direction).points
    const values = points.map(point => point.value).filter(Number.isFinite)
    assert.ok(values.length >= 28, `${cluster}/${direction}: missing history`)
    assert.ok(values.every(value => value > 0 && value < 1500), `${cluster}/${direction}: values outside synthetic bounds`)
    assert.ok(Math.max(...values) - Math.min(...values) > (direction === "inbound" ? 100 : 25), `${cluster}/${direction}: traffic is too flat`)
    const turns = values.slice(1, -1).filter((value, i) => (value - values[i]) * (values[i + 2] - value) < 0).length
    assert.ok(turns >= 5, `${cluster}/${direction}: insufficient minute-scale variation: ${turns}`)
    const stat = (await run(`local-ab-edge-watch-${direction === "inbound" ? "ingress" : "egress"}`, cluster))[0].points.at(-1).value
    assert.equal(stat, values.at(-1), `${cluster}/${direction}: stat and flow must use the same observation`)
  }
  console.log(`PASS ${cluster}: bounded distinct directional history, visible peaks and matching stats`)
}
