// Check cancellation through a real local Prometheus provider and MCP, with
// a short history limit. This creates and deletes only its own dashboard.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const receipt = JSON.parse(await readFile(process.argv[2], "utf8"))
assert.equal(receipt.syntheticData, true)
const origin = new URL(receipt.url)
const connection = JSON.parse(await readFile(join(receipt.state, "private-connection.json"), "utf8"))
const mcp = new URL(connection.mcpURL)
for (const url of [origin, mcp]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password)
const savedResponse = await fetch(new URL("/api/insights/saved-queries", origin))
assert.equal(savedResponse.status, 200)
const saved = (await savedResponse.json()).queries.find(item => item.id === "local-service-comparison")
assert.ok(saved?.providerId)
const start = Math.floor(Date.now() / 1000) - 60
const expression = (large, small) => `(time() == bool ${start}) * ${large} + (time() == bool ${start + 1}) * ${small} - (time() == bool ${start + 2}) * ${large}`
const id = `mean-cancellation-${Date.now()}`
const widget = (id, query, x) => ({ id, title: id, type: "stat", providerId: saved.providerId, query, unit: "", layout: { x, y: 0, w: 4, h: 3 } })
const document = { schemaVersion: 1, id, title: "Mean cancellation test", timeRange: "1h", refreshInterval: 0, variables: [], widgets: [widget("cancellation", expression("1e16", "1"), 0), widget("subnormal", expression("1e308", "1e-308"), 4)] }
const path = new URL(`/api/insights/dashboards/${id}`, origin)
const created = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
assert.equal(created.status, 200, await created.clone().text())
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
try {
  const response = await fetch(mcp, { method: "POST", headers: { Authorization: `Bearer ${connection.mcpViewerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_dashboard", arguments: { id, start: new Date(start * 1000).toISOString(), end: new Date((start + 2) * 1000).toISOString(), history_points: 2 } } }) })
  assert.equal(response.status, 200)
  const body = await response.text()
  const envelope = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(body.split("\n").find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(body)
  assert.equal(envelope.error, undefined)
  assert.notEqual(envelope.result.isError, true)
  const bundle = envelope.result.structuredContent
  assert.equal(bundle.dashboard.etag, etag)
  assert.equal(bundle.range.stepSeconds, 1)
  for (const [widgetID, expected] of [["cancellation", 1 / 3], ["subnormal", 1e-308 / 3]]) {
    const widget = bundle.widgets.find(item => item.id === widgetID)
    const signal = bundle.signals.find(item => item.id === widget.signalId)
    assert.equal(signal.state, "ok")
    assert.equal(signal.series.length, 1)
    const series = signal.series[0]
    assert.equal(series.valid, 3)
    assert.equal(series.mean, expected)
    assert.equal(series.historyTruncated, true)
    assert.equal(series.history.length, 2)
  }
  const text = envelope.result.content.find(item => item.type === "text")?.text ?? ""
  assert.match(text, /sample mean=/)
  const current = await fetch(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  console.log("PASS Prometheus to MCP cancellation and subnormal means over all samples, truncated history, text output and unchanged ETag")
} finally {
  const deleted = await fetch(path, { method: "DELETE", headers: { "If-Match": etag } })
  assert.equal(deleted.status, 204, `cleanup: ${deleted.status}`)
}
