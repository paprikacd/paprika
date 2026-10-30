// Optional read-only real PostgreSQL + Insights + Observe MCP event overlay test.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const ready = process.env.PAPRIKA_GALLERY_READY
if (!ready) throw Error("Set PAPRIKA_GALLERY_READY to the local gallery receipt")
const receipt = JSON.parse(await readFile(ready, "utf8")), origin = new URL(receipt.url)
assert.equal(origin.hostname, "127.0.0.1")
const connection = JSON.parse(await readFile(join(receipt.state, "private-connection.json"), "utf8")), mcp = new URL(connection.mcpURL)
assert.equal(mcp.hostname, "127.0.0.1")
const request = async (path, init) => { const response = await fetch(new URL(path, origin), init); assert.equal(response.status, 200, `${path}: ${response.status}`); return response }
const dashboardResponse = await request("/api/insights/dashboards/local-gallery-service-pulse")
const etag = dashboardResponse.headers.get("x-paprika-document-etag") ?? dashboardResponse.headers.get("etag")
const dashboard = await dashboardResponse.json(), chart = dashboard.widgets.find(widget => widget.id === "request-history")
assert.equal(chart.annotationSource.queryRef.id, "local-ab-reliability-room-incidents")
const queries = (await (await request("/api/insights/saved-queries")).json()).queries
const eventQuery = queries.find(query => query.id === chart.annotationSource.queryRef.id)
assert.ok(eventQuery && eventQuery.kind === "records")
const eventDocument = await request(`/api/insights/saved-queries/${encodeURIComponent(eventQuery.id)}`)
const eventETag = eventDocument.headers.get("x-paprika-document-etag") ?? eventDocument.headers.get("etag")
assert.ok(eventETag, "The event query must have a revision")
async function fetchEvents(service) {
  const end = Math.floor(Date.now() / 1000), start = end - 3600
  const response = await request("/api/insights/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: eventQuery.providerId, kind: "records", query: eventQuery.query.replaceAll("{{service}}", JSON.stringify(service)), start, end, step: 12 }) })
  const frame = (await response.json()).records, time = frame.columns.findIndex(column => column.key === "date"), label = frame.columns.findIndex(column => column.key === "label")
  assert.ok(time >= 0 && label >= 0)
  const row = frame.rows.find(row => Date.parse(row[time]) >= start * 1000 && Date.parse(row[time]) <= end * 1000)
  assert.ok(row, `${service} must have a recorded event within the last hour`)
  return { timestamp: new Date(row[time]).toISOString(), label: row[label] }
}
const samples = { checkout: await fetchEvents("checkout"), payments: await fetchEvents("payments") }
const gatewayQuery = queries.find(query => query.id === "local-edge-gateway-events")
assert.ok(gatewayQuery && gatewayQuery.kind === "records")
const now = Math.floor(Date.now() / 1000)
const gatewayResponse = await request("/api/insights/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: gatewayQuery.providerId, kind: "records", query: gatewayQuery.query.replaceAll("{{gateway}}", JSON.stringify("omega")), start: now - 6 * 3600, end: now, step: 60 }) })
const gatewayFrame = (await gatewayResponse.json()).records
const gatewayTime = gatewayFrame.columns.findIndex(column => column.key === "date"), gatewayLabel = gatewayFrame.columns.findIndex(column => column.key === "label")
assert.ok(gatewayTime >= 0 && gatewayLabel >= 0 && gatewayFrame.rows.length)
const gatewaySample = { timestamp: new Date(gatewayFrame.rows[0][gatewayTime]).toISOString(), label: gatewayFrame.rows[0][gatewayLabel] }
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    try {
      const page = await context.newPage(), errors = [], metricReplies = []
      page.on("pageerror", error => errors.push(error.message))
      page.on("response", response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return
        try {
          const query = response.request().postDataJSON().query
          if (query?.includes('code="5xx"')) metricReplies.push(response.json().catch(() => null))
        } catch { /* Non-query responses are not metric frames. */ }
      })
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-service-pulse`, { waitUntil: "networkidle" })
      const widget = page.locator('[data-widget-id="request-history"]')
      await widget.scrollIntoViewIfNeeded()
      const check = async sample => {
        const marker = widget.locator(`[data-annotation-timestamp=${JSON.stringify(sample.timestamp)}]`)
        // A vertical SVG line has a zero-width bounding box, so Playwright's
        // visibility test reports it hidden even when it is drawn.
        await marker.waitFor({ state: "attached", timeout: 30000 })
        await widget.getByRole("group", { name: "Chart events" }).locator("summary").click()
        assert.ok(await widget.getByRole("group", { name: "Chart events" }).getByText(sample.label, { exact: true }).count())
      }
      await check(samples.checkout)
      const ordinary = page.locator('[data-widget-id="error-history"]')
      await ordinary.scrollIntoViewIfNeeded()
      const ordinaryMarker = ordinary.locator(`[data-annotation-timestamp=${JSON.stringify(samples.checkout.timestamp)}]`)
      await ordinaryMarker.waitFor({ state: "attached", timeout: 30000 })
      const metric = (await Promise.all(metricReplies)).find(reply => reply?.series?.length)
      assert.ok(metric, "The ordinary chart must receive actual Prometheus observations")
      const times = metric.series.flatMap(series => series.points.map(point => point.timestamp)).filter(Number.isFinite)
      const plot = ordinaryMarker.locator(".."), width = await plot.evaluate(node => node.getBoundingClientRect().width)
      const expected = 54 + (Date.parse(samples.checkout.timestamp) - Math.min(...times)) / (Math.max(...times) - Math.min(...times)) * (width - 54 - 12)
      const position = await ordinaryMarker.evaluate(node => Number.parseFloat(node.style.left))
      assert.ok(Math.abs(position - expected) < 2, `Ordinary marker must align with its recorded timestamp: ${position} vs ${expected}`)
      assert.equal(await ordinaryMarker.evaluate(node => getComputedStyle(node).pointerEvents), "none", "Event markers must not block plot interactions")
      await selectGammaOption(page, page.getByRole("combobox", { name: "Service", exact: true }), "payments")
      await widget.scrollIntoViewIfNeeded()
      await widget.locator(`[data-annotation-timestamp=${JSON.stringify(samples.payments.timestamp)}]`).waitFor({ state: "attached", timeout: 30000 })
      assert.equal(await widget.locator(`[data-annotation-timestamp=${JSON.stringify(samples.checkout.timestamp)}]`).count(), 0, "Changing service must remove stale events")
      await ordinary.scrollIntoViewIfNeeded()
      await ordinary.locator(`[data-annotation-timestamp=${JSON.stringify(samples.payments.timestamp)}]`).waitFor({ state: "attached", timeout: 30000 })
      assert.equal(await ordinary.locator(`[data-annotation-timestamp=${JSON.stringify(samples.checkout.timestamp)}]`).count(), 0)
      assert.deepEqual(errors, [])
      if (theme === "light") {
        await page.getByRole("button", { name: "Dashboard as code", exact: true }).click()
        const editor = page.getByRole("region", { name: "Dashboard source editor", exact: true })
        await editor.getByRole("button", { name: "JSON", exact: true }).click()
        const pending = page.waitForEvent("download")
        await editor.getByRole("button", { name: "Export", exact: true }).click()
        const download = await pending
        const exported = JSON.parse(await readFile(await download.path(), "utf8"))
        assert.ok(exported.savedQueries.some(query => query.id === eventQuery.id), "Portable JSON includes the annotation dependency")
        assert.equal(exported.dashboards[0].widgets.find(item => item.id === chart.id).annotationSource.queryRef.id, eventQuery.id)
      }
      // Gateway events are seeded when the isolated stack starts. Select a
      // range around the recorded event so this remains reproducible as the
      // short default dashboard window moves past the seed time.
      const edgeURL = new URL("/dashboard/insights/", origin)
      edgeURL.searchParams.set("dashboard", "local-gallery-edge-watch")
      edgeURL.searchParams.set("from", new Date(Date.parse(gatewaySample.timestamp) - 15 * 60_000).toISOString())
      edgeURL.searchParams.set("to", new Date(Date.parse(gatewaySample.timestamp) + 15 * 60_000).toISOString())
      await page.goto(edgeURL.href, { waitUntil: "networkidle" })
      const flow = page.locator('[data-widget-id="flow"]')
      await flow.scrollIntoViewIfNeeded()
      await flow.locator(`[data-annotation-timestamp=${JSON.stringify(gatewaySample.timestamp)}]`).waitFor({ state: "attached", timeout: 30000 })
      const events = flow.getByRole("group", { name: "Chart events" })
      await events.locator("summary").click()
      assert.ok(await events.getByText(gatewaySample.label, { exact: true }).count())
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme}: recorded events on ordinary and directional charts with shared filters`)
    } finally { await context.close() }
  }
} finally { await browser.close() }

const response = await fetch(mcp, { method: "POST", headers: { Authorization: `Bearer ${connection.mcpViewerToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "query_dashboard", arguments: { id: dashboard.id, variables: { service: "checkout" } } } }) })
assert.equal(response.status, 200)
const text = await response.text(), payload = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(text)
const bundle = payload.result.structuredContent, entry = bundle.widgets.find(widget => widget.id === chart.id), signal = bundle.signals.find(item => item.id === entry.annotationSignalId)
assert.equal(bundle.dashboard.etag, etag)
assert.ok(bundle.savedQueries.some(query => query.id === eventQuery.id && query.etag === eventETag))
assert.deepEqual(entry.annotationColumns, { timestamp: "date", label: "label", severity: "status" })
assert.ok(signal?.records?.returned > 0)
assert.equal(entry.annotationError, undefined)
const ordinaryEntry = bundle.widgets.find(widget => widget.id === "error-history")
assert.equal(ordinaryEntry.annotationSignalId, entry.annotationSignalId, "Matching event queries should share one MCP signal")
assert.equal(ordinaryEntry.annotationError, undefined)
console.log("PASS Observe MCP: annotation signal, column mapping and saved-query ETag")
