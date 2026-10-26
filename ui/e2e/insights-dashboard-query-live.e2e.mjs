// Read-only production acceptance. Reuses the private service-overview config:
// baseURL, mcpURL, tokenFile, mcpTokenFile, dashboardId, services, outputDir.
// No telemetry mocks, document writes or credentials in artifacts.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

assert.ok(process.env.INSIGHTS_SERVICE_OVERVIEW_CONFIG, "Provide private service overview configuration")
const config = JSON.parse(await readFile(process.env.INSIGHTS_SERVICE_OVERVIEW_CONFIG, "utf8"))
const token = (await readFile(config.tokenFile, "utf8")).trim()
const mcpToken = (await readFile(config.mcpTokenFile, "utf8")).trim()
const output = resolve(config.outputDir ?? "../artifacts/insights/dashboard-query-live")
const reports = []
let rpcID = 0
for (const endpoint of [config.baseURL, config.mcpURL]) {
  const url = new URL(endpoint)
  assert.ok(["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search)
}
assert.match(config.dashboardId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
assert.ok(config.services?.length >= 2)

async function api(path, body) {
  assert.ok(body === undefined || path === "query", "Only telemetry reads may POST")
  const response = await fetch(`${config.baseURL.replace(/\/$/, "")}/api/insights/${path}`, {
    method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000),
  })
  assert.equal(response.status, 200, `${path} HTTP${response.status}`)
  return { document: await response.json(), etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") }
}
async function mcp(method, params) {
  const id = ++rpcID
  const response = await fetch(config.mcpURL, {
    method: "POST", headers: { Authorization: `Bearer ${mcpToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(35_000),
  })
  assert.equal(response.status, 200)
  const text = await response.text()
  const envelope = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === id)
    : JSON.parse(text)
  assert.equal(envelope.error, undefined, `${method}: ${envelope.error?.message}`)
  assert.notEqual(envelope.result?.isError, true, `${method} failed`)
  return envelope.result
}
async function query(args) {
  const result = await mcp("tools/call", { name: "query_dashboard", arguments: { id: config.dashboardId, ...args } })
  assert.ok(result.structuredContent)
  return result
}
async function check(name, action) {
  try { reports.push({ name, passed: true, evidence: await action() }); console.log(`PASS ${name}`) }
  catch (error) { reports.push({ name, passed: false, error: error.message }); throw error }
}
const finite = points => points.filter(p => Number.isFinite(p.timestamp) && typeof p.value === "number" && Number.isFinite(p.value)).sort((a, b) => a.timestamp - b.timestamp)
const signalFor = (result, id) => result.signals.find(s => s.id === result.widgets.find(w => w.id === id)?.signalId)
const end = Math.floor(Date.now() / 60_000) * 60_000 - 120_000
const bounds = { start: new Date(end - 3600_000).toISOString(), end: new Date(end).toISOString() }
let original, saved = new Map()

function resolved(widget, service, range) {
  const source = saved.get(widget.queryRef?.id)?.document
  assert.ok(source, `Expected saved query for ${widget.id}`)
  const variables = Object.fromEntries(original.document.variables.map(v => [v.name, v.defaultValue]))
  variables[config.variableName ?? "service"] = service
  const values = Object.fromEntries((source.parameters ?? []).map(p => [p.name, p.defaultValue]))
  for (const binding of widget.queryRef.bindings ?? []) values[binding.parameter] = binding.source === "constant" ? binding.value : variables[binding.variable]
  const query = source.query.trim().replace(/\{\{([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_, name) => {
    const parameter = source.parameters.find(p => p.name === name)
    assert.ok(parameter && values[name] !== undefined)
    const value = parameter.type === "number" ? Number(values[name]) : values[name]
    assert.ok(parameter.type === "number" ? Number.isFinite(value) : typeof value === "string")
    return JSON.stringify(value)
  })
  return { providerId: source.providerId, kind: source.kind, query, start: Date.parse(range.start) / 1000, end: Date.parse(range.end) / 1000, step: range.stepSeconds }
}

try {
  await mkdir(output, { recursive: true })
  original = await api(`dashboards/${config.dashboardId}`)
  for (const id of new Set(original.document.widgets.map(w => w.queryRef?.id).filter(Boolean))) saved.set(id, await api(`saved-queries/${id}`))
  await check("Live Observe advertises the read-only dashboard contract", async () => {
    const listed = (await mcp("tools/list", {})).tools.find(t => t.name === "query_dashboard")
    assert.equal(listed?.annotations.readOnlyHint, true)
    assert.equal(listed.outputSchema.properties.schemaVersion.const, 1)
    return { tool: listed.name, readOnly: true, schemaVersion: 1 }
  })
  for (const service of config.services) await check(`Compact dashboard matches real provider results for ${service}`, async () => {
    const envelope = await query({ ...bounds, variables: { [config.variableName ?? "service"]: service } }), result = envelope.structuredContent
    assert.equal(result.schemaVersion, 1)
    assert.equal(result.dashboard.etag, original.etag)
    assert.notEqual(result.state, "partial", "Provider errors must not pass live acceptance")
    assert.equal(result.widgets.length, original.document.widgets.length)
    assert.ok(result.queryCount.deduplicated >= 1, "Shared stat/chart query should execute once")
    const rawQueries = new Map(), comparisons = []
    let rawBytes = 0
    for (const widget of original.document.widgets) {
      const request = resolved(widget, service, result.range), key = JSON.stringify(request)
      if (!rawQueries.has(key)) {
        const raw = (await api("query", request)).document
        rawQueries.set(key, raw); rawBytes += Buffer.byteLength(JSON.stringify(raw))
      }
      const raw = rawQueries.get(key), signal = signalFor(result, widget.id)
      assert.ok(signal, `No signal for ${widget.id}`)
      if (request.kind === "metrics") {
        const index = raw.series.findIndex(s => finite(s.points).length)
        if (index < 0) { assert.equal(signal.state, "empty"); comparisons.push({ widget: widget.id, state: "empty" }); continue }
        assert.equal(signal.state, "ok"); assert.equal(signal.primarySeries, index)
        const summary = signal.series.find(s => s.index === index), points = finite(raw.series[index].points)
        assert.deepEqual(summary.last, points.at(-1))
        assert.equal(summary.min, Math.min(...points.map(p => p.value)))
        assert.equal(summary.max, Math.max(...points.map(p => p.value)))
        assert.equal(summary.valid, points.length)
        assert.equal(summary.history, undefined)
        comparisons.push({ widget: widget.id, state: signal.state, value: summary.last.value, timestamp: summary.last.timestamp, samples: summary.samples })
      } else {
        assert.equal(signal.state, raw.traces.length ? "ok" : "empty")
        assert.equal(signal.traces.returned, raw.traces.length)
        for (const trace of signal.traces.examples ?? []) assert.equal(trace.service, service)
        comparisons.push({ widget: widget.id, state: signal.state, traces: signal.traces.returned, examples: signal.traces.examples?.length ?? 0 })
      }
    }
    assert.equal(result.queryCount.executed, rawQueries.size)
    assert.deepEqual(new Map(result.savedQueries.map(q => [q.id, q.etag])), new Map([...saved].map(([id, value]) => [id, value.etag])))
    const compactBytes = Buffer.byteLength(JSON.stringify(envelope))
    const text = envelope.content.filter(c => c.type === "text").map(c => c.text).join("\n")
    assert.ok(text.length < JSON.stringify(result).length)
    await writeFile(join(output, `machine-${service}.json`), JSON.stringify(envelope, null, 2))
    return { service, range: result.range, widgets: comparisons, queryCount: result.queryCount, rawBytes, compactBytes, reductionPercent: Math.round(100 * (1 - compactBytes / rawBytes)) }
  })
  await check("Live widget drilldown has bounded history and preserves saved versions", async () => {
    const widget = original.document.widgets.find(w => w.type === "stat")
    const result = (await query({ ...bounds, variables: { [config.variableName ?? "service"]: config.services[0] }, widget_ids: [widget.id], history_points: 12 })).structuredContent
    assert.equal(result.queryCount.executed, 1); assert.equal(result.widgets.length, 1)
    for (const series of result.signals[0].series ?? []) assert.ok((series.history?.length ?? 0) <= 12)
    assert.deepEqual(await api(`dashboards/${config.dashboardId}`), original)
    for (const [id, before] of saved) assert.deepEqual(await api(`saved-queries/${id}`), before)
    return { queriedWidget: widget.id, historyPoints: result.signals[0].series?.[0]?.history?.length ?? 0, unchangedDocuments: saved.size + 1 }
  })
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1 }
finally {
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "machine-report.json"), JSON.stringify({ timestamp: new Date().toISOString(), reports }, null, 2))
}
