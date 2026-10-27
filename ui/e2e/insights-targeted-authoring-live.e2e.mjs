// Opt-in production acceptance. Creates isolated documents, exercises real
// providers and UI sync, then deletes only its own unchanged test documents.
// Configuration is private; never put tokens or credential paths in artifacts.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

assert.ok(process.env.INSIGHTS_SERVICE_OVERVIEW_CONFIG, "Provide private service overview configuration")
const config = JSON.parse(await readFile(process.env.INSIGHTS_SERVICE_OVERVIEW_CONFIG, "utf8"))
assert.equal(config.allowTemporaryWrites, true, "Explicit temporary-write validation must be enabled")
const origin = new URL(config.baseURL)
assert.equal(origin.protocol, "https:")
assert.equal(origin.pathname, "/")
assert.ok(!origin.username && !origin.password && !origin.search && !origin.hash)
assert.equal(config.mcpURL, `${origin.origin}/observe/mcp`)
const token = (await readFile(config.tokenFile, "utf8")).trim()
const mcpToken = (await readFile(config.mcpTokenFile, "utf8")).trim()
const output = resolve(config.outputDir ?? "../artifacts/insights/targeted-authoring-live")
const id = `observe-targeted-${Date.now()}`
const queryId = `${id}-rate`, reports = [], pageErrors = [], queryResponses = []
const owned = new Map(), schemas = {}
let rpcID = 0, browser, page, original, originalQuery, entry, queryEntry
const end = Math.floor(Date.now() / 60_000) * 60_000 - 120_000
const range = { start: new Date(end - 3600_000).toISOString(), end: new Date(end).toISOString() }

async function api(path, method = "GET", body, headers = {}) {
  const response = await fetch(`${origin.origin}/api/insights/${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(35_000),
  })
  const text = await response.text()
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}`)
  return { document: text ? JSON.parse(text) : undefined, etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") }
}
async function call(name, args, rejected = false) {
  const requestId = ++rpcID
  const response = await fetch(config.mcpURL, {
    method: "POST", headers: { Authorization: `Bearer ${mcpToken}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(35_000),
  })
  assert.equal(response.status, 200, `${name} HTTP ${response.status}`)
  const text = await response.text()
  const envelope = response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === requestId)
    : JSON.parse(text)
  assert.ok(envelope, `${name} has no response`)
  if (rejected) {
    assert.equal(envelope.result?.isError, true, `${name} must return an actionable conflict`)
    assert.match(envelope.result.content.map(item => item.text ?? "").join(" "), /get the latest document and ETag/)
    return
  }
  assert.equal(envelope.error, undefined, `${name}: ${envelope.error?.message}`)
  assert.notEqual(envelope.result?.isError, true, `${name} failed`)
  const result = envelope.result.structuredContent
  assert.ok(result, `${name} must return structuredContent`)
  if (/^(create|patch)_/.test(name)) owned.set(`${name.endsWith("saved_query") ? "saved-queries" : "dashboards"}/${result.document.id}`, result.etag)
  return result
}
async function check(name, action) {
  try { reports.push({ name, passed: true, evidence: await action() }); console.log(`PASS ${name}`) }
  catch (error) { reports.push({ name, passed: false, error: error.message }); throw error }
}
async function until(predicate, message, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 150)) }
  throw new Error(message)
}
const tile = () => page.locator('[data-widget-id="request-rate"]')
async function reading() { return Number(await tile().locator("[data-stat-reading] [data-metric-value]").getAttribute("data-metric-value")) }

try {
  await mkdir(output, { recursive: true })
  original = await api(`dashboards/${config.dashboardId ?? "service-overview"}`)
  const rate = original.document.widgets.find(widget => widget.id === "request-rate")
  assert.ok(rate?.queryRef, "Source dashboard must contain saved request-rate widget")
  originalQuery = await api(`saved-queries/${rate.queryRef.id}`)
  await check("Deployed schemas expose canonical fields and standalone widget references", async () => {
    for (const kind of ["dashboard", "widget", "saved_query"]) {
      schemas[kind] = await call("get_insights_schema", { kind })
      assert.equal(schemas[kind].kind, kind); assert.equal(schemas[kind].schemaVersion, 1)
      assert.ok(schemas[kind].schema.properties && schemas[kind].examples.length)
    }
    assert.ok(schemas.widget.schema.$defs)
    return { kinds: Object.keys(schemas) }
  })
  await check("MCP creates isolated saved query and service dashboard", async () => {
    queryEntry = await call("create_saved_query", { document: { ...originalQuery.document, id: queryId, name: "Temporary targeted authoring validation" } })
    entry = await call("create_dashboard", { document: {
      ...original.document, id, title: "Temporary Observe authoring validation", folder: "Validation", refreshInterval: 0,
      customTimeRange: { from: range.start, to: range.end },
      variables: original.document.variables.map(variable => variable.name === "service" ? { ...variable, defaultValue: "uptime-api" } : variable),
      widgets: original.document.widgets.map(widget => widget.queryRef?.id === originalQuery.document.id ? { ...widget, queryRef: { ...widget.queryRef, id: queryId } } : widget),
    } })
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1512, height: 960 }, reducedMotion: "reduce", timezoneId: "UTC" })
    await context.addInitScript(({ value, target }) => { if (location.origin === target) localStorage.setItem("paprika_id_token", value) }, { value: token, target: origin.origin })
    page = await context.newPage(); page.setDefaultTimeout(45_000)
    page.on("pageerror", error => pageErrors.push(error.message))
    page.on("response", response => {
      if (new URL(response.url()).pathname === "/api/insights/query") queryResponses.push({ status: response.status(), request: response.request().postDataJSON() })
    })
    const uiURL = new URL(entry.uiUrl)
    assert.equal(uiURL.origin, origin.origin); assert.equal(uiURL.pathname, "/dashboard/insights/"); assert.equal(uiURL.searchParams.get("dashboard"), id)
    await page.goto(entry.uiUrl, { waitUntil: "domcontentloaded" })
    await tile().locator("[data-stat-reading] [data-metric-value]").waitFor()
    await tile().locator("[data-stat-sparkline] [data-stat-trend]").waitFor()
    assert.ok(Number.isFinite(await reading()))
    return { widgets: entry.document.widgets.length, sharedVariable: "service", liveValue: await reading() }
  })
  await check("Targeted widget and dashboard edits synchronize into the open UI", async () => {
    const before = structuredClone(entry.document), stale = entry.etag
    entry = await call("patch_dashboard", { id, etag: stale, patch: { description: "Validated targeted MCP edit against real providers" }, widget_edits: [{ op: "update", id: "request-rate", patch: { title: "Live request rate", options: { decimals: 2, showSparkline: true } } }] })
    const expected = structuredClone(before)
    expected.description = entry.document.description
    expected.widgets.find(widget => widget.id === "request-rate").title = "Live request rate"
    expected.widgets.find(widget => widget.id === "request-rate").options = { ...expected.widgets.find(widget => widget.id === "request-rate").options, decimals: 2, showSparkline: true }
    assert.deepEqual(entry.document, expected)
    await tile().getByText("Live request rate", { exact: true }).waitFor()
    await call("patch_dashboard", { id, etag: stale, patch: { title: "Must not overwrite" } }, true)
    assert.deepEqual((await api(`dashboards/${id}`)).document, entry.document)
    return { staleETagRejected: true, siblingWidgetsPreserved: before.widgets.length - 1, uiUpdated: true }
  })
  await check("Targeted saved-query edit reexecutes Prometheus and updates the live sparkline", async () => {
    const before = await reading(), queryStart = queryResponses.length
    queryEntry = await call("patch_saved_query", { id: queryId, etag: queryEntry.etag, patch: { query: `(${originalQuery.document.query}) * 2`, description: "Temporary doubled-rate validation", tags: ["validation", "mcp"] } })
    const expectedQuery = queryEntry.document.query.replaceAll("{{service}}", JSON.stringify("uptime-api"))
    await until(() => queryResponses.slice(queryStart).some(result => result.status === 200 && result.request.query === expectedQuery && result.request.providerId === queryEntry.document.providerId), "UI did not execute the patched saved query")
    await until(async () => Math.abs(await reading() - before * 2) < 1e-9, "Open stat did not refresh to the patched saved query")
    assert.match((await tile().locator("[data-stat-reading]").innerText()).replace(/\s/g, ""), /\d+\.\d{2}req\/s/)
    assert.ok(Number(await tile().locator("[data-stat-sparkline]").getAttribute("data-sample-count")) > 1)
    return { before, after: await reading(), decimals: 2, sparkline: true }
  })
  await check("Dashboard bundle matches real Prometheus and Tempo with shared service filter", async () => {
    const bundle = await call("query_dashboard", { id, ...range, variables: { service: "uptime-api" }, history_points: 12 })
    assert.notEqual(bundle.state, "partial")
    const signal = bundle.signals.find(signal => signal.id === bundle.widgets.find(widget => widget.id === "request-rate")?.signalId)
    assert.equal(signal.state, "ok")
    const query = queryEntry.document.query.replaceAll("{{service}}", JSON.stringify("uptime-api"))
    const direct = (await api("query", "POST", { providerId: queryEntry.document.providerId, kind: "metrics", query, start: Date.parse(bundle.range.start) / 1000, end: Date.parse(bundle.range.end) / 1000, step: bundle.range.stepSeconds })).document
    assert.equal(direct.series.length, 1, "Request-rate query must aggregate to one service series")
    const last = direct.series[0].points.filter(point => Number.isFinite(point.value)).sort((a, b) => a.timestamp - b.timestamp).at(-1)
    assert.deepEqual(signal.series.find(series => series.index === signal.primarySeries).last, last)
    const traces = bundle.signals.find(signal => signal.id === bundle.widgets.find(widget => widget.id === "service-traces")?.signalId)
    assert.equal(traces?.state, "ok"); assert.ok(traces.traces.returned > 0)
    assert.ok(traces.traces.examples.every(trace => trace.service === "uptime-api"))
    const traceWidget = entry.document.widgets.find(widget => widget.id === "service-traces")
    const traceQuery = (await api(`saved-queries/${traceWidget.queryRef.id}`)).document
    const directTraces = (await api("query", "POST", { providerId: traceQuery.providerId, kind: "traces", query: traceQuery.query.replaceAll("{{service}}", JSON.stringify("uptime-api")), start: Date.parse(bundle.range.start) / 1000, end: Date.parse(bundle.range.end) / 1000, step: bundle.range.stepSeconds })).document.traces
    assert.equal(traces.traces.returned, directTraces.length)
    assert.ok(directTraces.every(trace => trace.service === "uptime-api"))
    const filter = page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: "Service", exact: true })
    for (const theme of ["Light", "Dark"]) {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      await selectGammaOption(page, filter, "brandbrain-api")
      await until(async () => (await tile().innerText()).includes("No data"), "Service filter did not update the request card")
      await selectGammaOption(page, filter, "uptime-api")
      await tile().locator("[data-stat-reading] [data-metric-value]").waitFor()
      await page.screenshot({ path: join(output, `targeted-${theme.toLowerCase()}.png`), fullPage: false })
    }
    await writeFile(join(output, "bundle.json"), JSON.stringify(bundle, null, 2))
    return { exactPrometheusMatch: true, tempoCountAndServiceMatch: true, requestRate: last.value, traces: traces.traces.returned, filterServices: ["uptime-api", "brandbrain-api"], themes: ["Light", "Dark"] }
  })
  await check("Source dashboard and query remain unchanged", async () => {
    assert.deepEqual(await api(`dashboards/${original.document.id}`), original)
    assert.deepEqual(await api(`saved-queries/${originalQuery.document.id}`), originalQuery)
    assert.deepEqual(pageErrors, [])
    return { unchanged: 2, browserErrors: 0 }
  })
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {})
  console.error(error.stack ?? error.message); process.exitCode = 1
} finally {
  await browser?.close()
  try {
    // Conditional deletes retain concurrent user edits instead of erasing them.
    for (const collection of ["dashboards", "saved-queries"]) {
      for (const [path, etag] of owned) if (path.startsWith(`${collection}/${id}`)) {
        await api(path, "DELETE", undefined, { "If-Match": etag })
        owned.delete(path)
      }
    }
    reports.push({ name: "Own temporary documents cleaned up with ETag protection", passed: owned.size === 0 })
  } catch (error) { reports.push({ name: "Conditional cleanup", passed: false, error: error.message, remaining: [...owned.keys()] }); process.exitCode = 1 }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "report.json"), JSON.stringify({ timestamp: new Date().toISOString(), reports }, null, 2))
}
