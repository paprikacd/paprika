// Query the actual synthetic counters through the local Insights/Observe path.
import assert from "node:assert/strict"

const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only a loopback gallery is supported")
const definitions = await fetch(new URL("/api/insights/saved-queries", origin))
assert.equal(definitions.status, 200)
const saved = (await definitions.json()).queries
const end = Math.floor(Date.now() / 60_000) * 60 - 60
async function run(id, cluster) {
  const query = saved.find(item => item.id === id)
  assert.ok(query, `${id}: missing saved query`)
  const response = await fetch(new URL("/api/insights/query", origin), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ providerId: query.providerId, kind: "metrics", query: query.query.replaceAll("{{pipeline}}", JSON.stringify(cluster)), start: end - 3600, end, step: 60 }),
  })
  assert.equal(response.status, 200, `${id}/${cluster}: ${await response.clone().text()}`)
  return (await response.json()).series
}
for (const cluster of ["omega", "delta"]) {
  const rates = await run("local-ab-collection-control-throughput", cluster)
  assert.deepEqual(new Set(rates.map(series => series.labels.signal)), new Set(["metrics", "traces", "logs"]))
  const last = Object.fromEntries(rates.map(series => [series.labels.signal, series.points.at(-1)?.value]))
  assert.ok(last.metrics > last.traces && last.traces > last.logs && last.logs > 10_000, `${cluster}: invalid observed rates ${JSON.stringify(last)}`)
  const ingested = (await run("local-ab-collection-control-ingested", cluster))[0].points.at(-1)?.value
  assert.ok(Math.abs(ingested - last.metrics) < .01 * last.metrics, `${cluster}: ingested stat must equal metrics rate`)
  const rejected = (await run("local-ab-collection-control-rejected", cluster))[0].points.at(-1)?.value
  assert.ok(rejected > .01 && rejected < .1, `${cluster}: expected a meaningful rejection percentage`)
  console.log(`PASS ${cluster}: metrics > traces > logs; ingested and rejection rate match real counter queries`)
}
