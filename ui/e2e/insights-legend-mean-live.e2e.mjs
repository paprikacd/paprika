// Verify the legend's mean agrees with the MCP summary for actual Prometheus
// observations, including a small value between cancelling large values.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { chromium } from "playwright"

const receipt = JSON.parse(await readFile(process.argv[2], "utf8"))
assert.equal(receipt.syntheticData, true)
const origin = new URL(receipt.url)
const connection = JSON.parse(await readFile(join(receipt.state, "private-connection.json"), "utf8"))
const mcp = new URL(connection.mcpURL)
for (const url of [origin, mcp]) assert.ok(url.protocol === "http:" && url.hostname === "127.0.0.1" && !url.username && !url.password)
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}: ${await response.clone().text()}`)
  return response
}
const saved = (await (await api("/api/insights/saved-queries")).json()).queries.find(query => query.id === "local-signal-rate")
assert.ok(saved?.providerId)
const start = Math.floor(Date.now() / 1000) - 60
const query = `(time() == bool ${start}) * 1e16 + (time() == bool ${start + 1}) - (time() == bool ${start + 2}) * 1e16`
const id = `legend-mean-${Date.now()}`
const path = `/api/insights/dashboards/${id}`
const document = { schemaVersion: 1, id, title: "Legend mean validation", timeRange: "1h", customTimeRange: { from: new Date(start * 1000).toISOString(), to: new Date((start + 2) * 1000).toISOString() }, refreshInterval: 0, variables: [], widgets: [{ id: "mean", title: "Sample mean", type: "plugin", pluginId: "stacked-timeseries", dataKind: "metrics", providerId: saved.providerId, query, unit: "", options: { decimals: 2, showLegend: true }, config: { legendDisplay: "table" }, layout: { x: 0, y: 0, w: 12, h: 6 } }] }
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  const response = await fetch(mcp, { method: "POST", headers: { Authorization: `Bearer ${connection.mcpViewerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_dashboard", arguments: { id, start: document.customTimeRange.from, end: document.customTimeRange.to } } }) })
  assert.equal(response.status, 200)
  const text = await response.text()
  const envelope = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(text)
  assert.notEqual(envelope.result.isError, true)
  const bundle = envelope.result.structuredContent
  const signal = bundle.signals.find(item => item.id === bundle.widgets[0].signalId)
  assert.equal(signal.series[0].mean, 1 / 3)
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(value => localStorage.setItem("paprika-insights-theme", value), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
    const mean = page.locator('[data-widget-id="mean"] [data-summary="mean"]')
    await mean.waitFor()
    assert.equal(Number(await mean.getAttribute("data-value")), signal.series[0].mean)
    assert.match(await mean.innerText(), /0\.33/)
    assert.deepEqual(errors, [])
    await context.close()
    console.log(`PASS ${theme} ${width}px: Prometheus legend mean equals MCP`)
  }
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
} finally {
  await browser.close()
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
