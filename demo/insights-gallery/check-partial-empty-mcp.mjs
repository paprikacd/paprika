// Run against an isolated gallery harness that includes a local Prometheus
// fixture called warning-prometheus. Never print its connection credentials.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

const receipt = JSON.parse(await readFile(process.argv[2], "utf8"))
assert.equal(receipt.syntheticData, true)
const origin = new URL(receipt.url)
const connection = JSON.parse(await readFile(join(receipt.state, "private-connection.json"), "utf8"))
const mcp = new URL(connection.mcpURL)
for (const url of [origin, mcp]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password)
const providers = await fetch(new URL("/api/insights/providers", origin))
assert.equal(providers.status, 200)
const provider = (await providers.json()).providers.find(item => item.providerRef === "observability/warning-prometheus")
assert.ok(provider && provider.capabilities.includes("metrics"), "Local warning provider is required")
const id = `partial-empty-${Date.now()}`
const widget = (id, query, x) => ({ id, title: id, type: "stat", providerId: provider.id, query, unit: "", layout: { x, y: 0, w: 4, h: 3 } })
const document = { schemaVersion: 1, id, title: "Partial empty test", timeRange: "1h", refreshInterval: 0, variables: [], widgets: [widget("limited", "partial_fixture", 0), widget("empty", "empty_fixture", 4), widget("zero", "zero_fixture", 8)] }
const path = new URL(`/api/insights/dashboards/${id}`, origin)
const created = await fetch(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
assert.equal(created.status, 200, await created.clone().text())
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
try {
  for (const [ids, expected] of [[["limited"], "partial"], [["empty"], "empty"], [["limited", "zero"], "partial"], [["zero", "limited"], "partial"], [["empty", "zero"], "ok"]]) {
    const response = await fetch(mcp, { method: "POST", headers: { Authorization: `Bearer ${connection.mcpViewerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_dashboard", arguments: { id, widget_ids: ids, start: "2026-10-26T00:00:00Z", end: "2026-10-26T01:00:00Z" } } }) })
    assert.equal(response.status, 200)
    const body = await response.text()
    const envelope = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(body.split("\n").find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(body)
    assert.equal(envelope.error, undefined)
    const result = envelope.result
    assert.notEqual(result.isError, true)
    assert.equal(result.structuredContent.state, expected)
    assert.equal(result.structuredContent.dashboard.etag, etag)
    const limited = result.structuredContent.widgets.find(item => item.id === "limited")
    if (limited) {
      const signal = result.structuredContent.signals.find(item => item.id === limited.signalId)
      assert.equal(signal.state, "partial")
      assert.equal(signal.providerTruncated, true)
      assert.ok(signal.primarySeries === undefined && !signal.series?.length, "Incomplete empty data must not invent a value")
      const text = result.content.find(item => item.type === "text").text
      assert.match(text, /partial source response/)
      assert.match(text, /"limited": partial/)
    }
    const zero = result.structuredContent.widgets.find(item => item.id === "zero")
    if (zero) {
      const signal = result.structuredContent.signals.find(item => item.id === zero.signalId)
      assert.equal(signal.state, "ok")
      assert.equal(signal.series[0].last.value, 0)
    }
    console.log(`PASS ${ids.join("+")}: ${expected}; source completeness, zero and ETag preserved`)
  }
} finally {
  const deleted = await fetch(path, { method: "DELETE", headers: { "If-Match": etag } })
  assert.equal(deleted.status, 204, `cleanup: ${deleted.status}`)
}
