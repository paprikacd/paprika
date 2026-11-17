// Check live, synthetic Tempo data through the real local Insights service.
import assert from "node:assert/strict"

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only isolated loopback galleries are supported")
const savedResponse = await fetch(new URL("/api/insights/saved-queries/local-signal-cluster-traces", origin))
assert.equal(savedResponse.status, 200)
const saved = await savedResponse.json()
const end = Math.floor(Date.now() / 1000), start = end - 120
async function query(service, cluster, traceId) {
  const traceql = saved.query.replaceAll("{{service}}", JSON.stringify(service)).replaceAll("{{cluster}}", JSON.stringify(cluster))
  const response = await fetch(new URL("/api/insights/query", origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: saved.providerId, kind: "traces", query: traceql, start, end, step: 1, ...(traceId ? { traceId } : {}) }) })
  assert.equal(response.status, 200, `Tempo query failed: ${response.status}`)
  return response.json()
}
for (const cluster of ["omega", "delta"]) {
  const traces = (await query("checkout", cluster)).traces ?? []
  const durations = new Set(traces.map(trace => trace.durationMs))
  assert.ok(durations.has(200), `${cluster} retains the canonical 200ms example`)
  assert.ok([120, 340, 520, 290, 760].some(duration => durations.has(duration)), `${cluster} exposes varied trace durations`)
  const canonical = traces.find(trace => trace.durationMs === 200)
  const varied = traces.find(trace => [120, 340, 520, 290, 760].includes(trace.durationMs))
  for (const trace of [canonical, varied]) {
    const spans = (await query("checkout", cluster, trace.traceId)).spans ?? []
    assert.equal(spans.length, 4)
    const byId = new Map(spans.map(span => [span.spanId, span]))
    const root = spans.find(span => !span.parentSpanId)
    assert.equal(root?.durationMs, trace.durationMs)
    for (const span of spans.filter(span => span.parentSpanId)) {
      const parent = byId.get(span.parentSpanId)
      assert.ok(parent, "Every synthetic child has its recorded parent")
      assert.ok(span.startTime >= parent.startTime && span.startTime + span.durationMs <= parent.startTime + parent.durationMs + .001, "Child timing must remain inside its parent")
    }
  }
  console.log(`PASS ${cluster}: canonical and varied Tempo traces retain correct parent-relative timing`)
}
