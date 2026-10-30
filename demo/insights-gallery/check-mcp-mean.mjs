// Compare the MCP sample mean with all real local Prometheus observations.
// The private MCP token is read from the harness receipt and never printed.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const receiptPath = process.argv[2]
if (!receiptPath) throw Error("Usage: node demo/insights-gallery/check-mcp-mean.mjs <gallery-ready.json>")
const receipt = JSON.parse(await readFile(receiptPath, "utf8"))
assert.equal(receipt.syntheticData, true)
const origin = new URL(receipt.url)
const connection = JSON.parse(await readFile(join(receipt.state, "private-connection.json"), "utf8"))
const endpoint = new URL(connection.mcpURL)
for (const url of [origin, endpoint]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password && !url.search && !url.hash)
assert.equal(endpoint.pathname, "/observe/mcp")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), { ...init, signal: AbortSignal.timeout(30_000) })
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const dashboardPath = "/api/insights/dashboards/local-gallery-service-pulse"
const etag = response => response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
const before = etag(await api(dashboardPath))
assert.ok(before)
const catalog = (await (await api("/api/insights/saved-queries")).json()).queries
const saved = catalog.find(query => query.id === "local-service-comparison")
assert.ok(saved)
const end = Math.floor(Date.now() / 60_000) * 60 - 60, start = end - 3600
const params = { id: "local-gallery-service-pulse", widget_ids: ["request-history"], variables: { service: "payments" }, start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString(), max_series: 8, history_points: 2 }
const response = await fetch(endpoint, { method: "POST", headers: { Authorization: `Bearer ${connection.mcpViewerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_dashboard", arguments: params } }), signal: AbortSignal.timeout(45_000) })
assert.equal(response.status, 200)
const raw = await response.text()
const envelope = response.headers.get("content-type")?.includes("text/event-stream") ? raw.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === 1) : JSON.parse(raw)
assert.equal(envelope.error, undefined)
assert.notEqual(envelope.result?.isError, true)
const bundle = envelope.result.structuredContent
const signal = bundle.signals.find(item => item.id === bundle.widgets[0].signalId)
assert.ok(signal?.series?.length === 3)
const expression = saved.query.replaceAll("{{service}}", JSON.stringify("payments"))
const direct = await (await api("/api/insights/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: saved.providerId, kind: "metrics", query: expression, start, end, step: bundle.range.stepSeconds }) })).json()
for (const summary of signal.series) {
  const source = direct.series.find(series => series.labels.service === summary.labels.service)
  assert.ok(source, `Missing source series ${summary.labels.service}`)
  const values = source.points.filter(point => Number.isFinite(point.timestamp) && Number.isFinite(point.value)).map(point => point.value)
  assert.ok(values.length > 2 && summary.historyTruncated, "The mean must cover more than the requested two history points")
  const expected = values.reduce((mean, value, index) => index ? mean * (index / (index + 1)) + value / (index + 1) : value, 0)
  assert.equal(summary.valid, values.length)
  assert.ok(Math.abs(summary.mean - expected) <= Math.max(1e-12, Math.abs(expected) * 1e-12), `Wrong mean for ${summary.labels.service}`)
}
const text = envelope.result.content.find(item => item.type === "text")?.text ?? ""
assert.ok(text.includes("sample mean="), "Text-only clients must receive sample means")
assert.equal(etag(await api(dashboardPath)), before)
console.log("PASS MCP sample means match full real Prometheus results for all three series with two-point history and unchanged dashboard ETag")
