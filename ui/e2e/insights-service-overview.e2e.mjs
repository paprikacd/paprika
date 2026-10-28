// Read-only acceptance of a pre-existing MCP-authored service dashboard.
// INSIGHTS_SERVICE_OVERVIEW_CONFIG points to private JSON with baseURL, mcpURL,
// tokenFile, mcpTokenFile, dashboardId and services. Optional expectedDocument,
// expectedSavedQueries and expectations[service][widgetId] strengthen assertions.
// Every configured service must return data; state: "empty" explicitly opts a
// widget into a negative missing-data case. Sparklines require real history.
// Native provider responses are observed, never replaced or mocked.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { assertCoverage, finitePoints } from "./service-overview-coverage.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
assert.ok(process.env.INSIGHTS_SERVICE_OVERVIEW_CONFIG, "Set INSIGHTS_SERVICE_OVERVIEW_CONFIG to private configuration")
const config = JSON.parse(await readFile(process.env.INSIGHTS_SERVICE_OVERVIEW_CONFIG, "utf8"))
function httpURL(value) {
  const url = new URL(value)
  assert.ok(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
  return url.href.replace(/\/$/, "")
}
const baseURL = httpURL(config.baseURL), mcpURL = httpURL(config.mcpURL)
const token = (await readFile(config.tokenFile, "utf8")).trim(), mcpToken = (await readFile(config.mcpTokenFile, "utf8")).trim()
assert.ok(token && mcpToken)
assert.match(config.dashboardId, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
assert.ok(Array.isArray(config.services) && config.services.length >= 2 && config.services.every(value => typeof value === "string" && value))
const services = [...new Set(config.services)], variableName = config.variableName ?? "service"
assert.ok(services.length >= 2)
const output = config.outputDir ? resolve(config.outputDir) : join(repository, "artifacts/insights/service-overview", config.dashboardId)
const reports = [], pageErrors = [], responses = [], writes = [], requests = [], completedRequests = []
const pendingQueries = new Map()
const queries = new Map()
let browser, context, page, dashboard, variable, initialDashboard, usageBefore, usageAfter, rpcId = 0, contextId = 0, loadTime = 0
const dashboardURL = `${baseURL}/dashboard/insights/?dashboard=${encodeURIComponent(config.dashboardId)}`
const snapshotVersion = response => response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
const compact = value => value.replace(/\s+/g, "")
const seriesName = (series, index) => series.name || Object.entries(series.labels ?? {}).map(([key, value]) => `${key}=${value}`).join(", ") || `Series ${index + 1}`

async function until(predicate, message, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 75)) }
  throw new Error(message)
}
async function api(path) {
  const response = await fetch(`${baseURL}/api/insights/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, `GET ${path}: HTTP${response.status}`)
  return { document: await response.json(), etag: snapshotVersion(response) }
}
async function mcp(method, params) {
  const id = ++rpcId
  const response = await fetch(mcpURL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcpToken}`, "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(45_000) })
  assert.equal(response.status, 200)
  const text = await response.text()
  const envelope = response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === id) : JSON.parse(text)
  assert.equal(envelope.error, undefined, `${method}: ${envelope.error?.message}`)
  return envelope.result
}
async function tool(name, args) {
  assert.ok(["get_dashboard", "get_saved_query"].includes(name), "This validator may only read MCP documents")
  const result = await mcp("tools/call", { name, arguments: args })
  assert.notEqual(result.isError, true, `${name} failed`)
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === "text").text)
}
async function usage() {
  const response = await fetch(new URL("/observe/api/usage", mcpURL), { headers: { Authorization: `Bearer ${mcpToken}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200)
  return response.json()
}
function resolveWidget(widget, service) {
  const saved = queries.get(widget.queryRef.id).document
  const variables = Object.fromEntries(dashboard.variables.map(item => [item.name, item.defaultValue]))
  variables[variableName] = service
  const values = Object.fromEntries((saved.parameters ?? []).map(parameter => [parameter.name, parameter.defaultValue]))
  for (const binding of widget.queryRef.bindings ?? []) values[binding.parameter] = binding.source === "constant" ? binding.value : variables[binding.variable]
  const query = saved.query.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, name) => {
    const parameter = saved.parameters.find(item => item.name === name)
    assert.ok(parameter && values[name] !== undefined, `Unbound ${saved.id}.${name}`)
    const value = parameter.type === "number" ? Number(values[name]) : values[name]
    assert.ok(parameter.type === "number" ? Number.isFinite(value) : typeof value === "string")
    return JSON.stringify(value)
  })
  return { providerId: saved.providerId, kind: saved.kind, query }
}
function rangeMatches(request) {
  if (![request.start, request.end, request.step].every(Number.isFinite) || request.end <= request.start) return false
  if (dashboard.customTimeRange) return request.start === Date.parse(dashboard.customTimeRange.from) / 1000 && request.end === Date.parse(dashboard.customTimeRange.to) / 1000 && request.step === Math.max(1, Math.ceil((request.end - request.start) / 300))
  const duration = { "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "6h": 21600, "12h": 43200, "24h": 86400, "7d": 604800, "30d": 2592000 }[dashboard.timeRange]
  return (!duration || request.end - request.start === duration) && Math.abs(request.end * 1000 - loadTime) < 120_000
}
function matchingResponse(widget, service) {
  const resolved = resolveWidget(widget, service)
  return responses.findLast(item => item.contextId === contextId && Object.entries(resolved).every(([key, value]) => item.request[key] === value) && rangeMatches(item.request))
}
async function open(width) {
  await context?.close(); contextId++; loadTime = Date.now()
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1050 }, reducedMotion: "reduce", colorScheme: "light", locale: "en-US", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  await context.addInitScript(value => localStorage.setItem("paprika_id_token", value), token)
  page = await context.newPage(); page.setDefaultTimeout(45_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  const owner = contextId
  page.on("request", request => {
    const path = new URL(request.url()).pathname
    if (path === "/api/insights/query") { requests.push({ contextId: owner, request: JSON.parse(request.postData() || "{}"), at: Date.now() }); pendingQueries.set(request, owner) }
    if (/^\/api\/insights\/(dashboards|saved-queries)(\/|$)/.test(path) && !["GET", "HEAD"].includes(request.method())) writes.push({ path, method: request.method() })
  })
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/api/insights/query") void response.json().then(body => responses.push({ contextId: owner, status: response.status(), request: JSON.parse(response.request().postData() || "{}"), body })).catch(() => {})
  })
  for (const event of ["requestfinished", "requestfailed"]) page.on(event, request => {
    if (!pendingQueries.delete(request)) return
    completedRequests.push({ contextId: owner, request: JSON.parse(request.postData() || "{}"), outcome: event === "requestfailed" ? "cancelled-or-failed" : "finished", at: Date.now() })
  })
  await page.goto(dashboardURL, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor()
  await page.bringToFront()
}
const tile = widget => page.locator(`[data-widget-id=${JSON.stringify(widget.id)}]`)
async function selectService(service) {
  const filter = page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: variable.label || variable.name, exact: true })
  await filter.scrollIntoViewIfNeeded()
  await selectGammaOption(page, filter, service)
}
async function assertChart(widget, body) {
  const target = tile(widget)
  await target.getByRole("img", { name: widget.title, exact: true }).waitFor()
  await target.getByRole("button", { name: `Inspect chart data for ${widget.title}`, exact: true }).click()
  const dialog = page.getByRole("dialog", { name: `${widget.title} data`, exact: true })
  await dialog.waitFor()
  for (const [index, series] of body.series.entries()) {
    if (index) await selectGammaOption(page, dialog.getByRole("combobox", { name: "Data series", exact: true }), seriesName(series, index))
    const points = widget.type === "bar" ? finitePoints(series).slice(-1) : series.points.filter(point => Number.isFinite(point.timestamp)).sort((a, b) => a.timestamp - b.timestamp)
    const expected = points.slice(0, 25)
    await until(async () => await dialog.locator("tbody tr").count() === expected.length, `${widget.id} exact-observation count differs from its provider result`)
    for (const [rowIndex, point] of expected.entries()) {
      const row = dialog.locator("tbody tr").nth(rowIndex)
      assert.equal(await row.locator("time").getAttribute("datetime"), new Date(point.timestamp).toISOString())
      assert.equal(await row.locator("td").nth(1).getAttribute("data-metric-value"), typeof point.value === "number" && Number.isFinite(point.value) ? String(point.value) : null)
    }
    assert.match(await dialog.getByRole("status").innerText(), new RegExp(`^${points.length} observations`))
  }
  await dialog.getByRole("button", { name: "Close data", exact: true }).click()
  await dialog.waitFor({ state: "hidden" })
}
async function inspectWidget(widget, service) {
  const target = tile(widget)
  await target.scrollIntoViewIfNeeded()
  await until(() => matchingResponse(widget, service), `${widget.id} did not execute its saved query for ${service}`)
  const response = matchingResponse(widget, service)
  assert.equal(response.status, 200, `${widget.id} query failed for ${service}`)
  const body = response.body, expected = config.expectations?.[service]?.[widget.id] ?? {}
  const nonempty = assertCoverage({ kind: response.request.kind, body, widget, service, expected })
  if (!nonempty) {
    await target.getByText("No data in this time range", { exact: true }).waitFor()
    assert.equal(await target.locator("[data-stat-sparkline], [data-metric-value], tbody tr").count(), 0, "An empty result must clear the preceding service's observations")
    return { widget: widget.id, type: widget.type, service, state: "empty", request: response.request }
  }
  await until(async () => await target.locator('[aria-busy="true"]').count() === 0, `${widget.id} did not finish rendering`)
  assert.equal(await target.getByRole("alert").count(), 0)
  if (response.request.kind === "traces") {
    const traces = body.traces.slice(0, 100)
    await until(async () => await target.locator("tbody tr").count() === traces.length, `${widget.id} did not replace the previous service's trace rows`)
    for (const [index, trace] of traces.entries()) {
      const row = target.locator("tbody tr").nth(index)
      await row.getByRole("button", { name: `Inspect trace ${trace.traceId}`, exact: true }).waitFor()
      assert.ok((await row.locator("td").first().innerText()).includes(trace.service || "Unknown service"))
      if (expected.traceService) assert.equal(trace.service, expected.traceService)
      if (Number.isFinite(trace.startTime)) assert.equal(await row.locator("time").getAttribute("datetime"), new Date(trace.startTime).toISOString())
    }
    return { widget: widget.id, type: widget.type, service, state: "data", traces: traces.length, traceServices: [...new Set(traces.map(trace => trace.service))], request: response.request }
  }
  const series = body.series.find(entry => finitePoints(entry).length), points = finitePoints(series), latest = points.at(-1)
  if (expected.minSamples) assert.ok(points.length >= expected.minSamples)
  if (widget.type === "stat") {
    const value = target.locator("[data-stat-reading] [data-metric-value]")
    await until(async () => await value.getAttribute("data-metric-value").catch(() => null) === String(latest.value), `${widget.id} displayed the wrong service value`)
    const decimals = widget.options?.decimals
    assert.ok(Number.isInteger(decimals), `${widget.id} should specify decimal precision`)
    const formatted = new Intl.NumberFormat("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(latest.value) + (widget.unit ?? "")
    assert.equal(compact(await value.innerText()), compact(formatted))
    if (widget.options?.showSparkline) {
      const plot = target.locator("[data-stat-sparkline]"), timed = series.points.filter(point => Number.isFinite(point.timestamp)).sort((a, b) => a.timestamp - b.timestamp)
      for (const [name, number] of Object.entries({ "data-sample-count": timed.length, "data-history-start": timed[0].timestamp, "data-history-end": timed.at(-1).timestamp, "data-history-min": Math.min(...points.map(point => point.value)), "data-history-max": Math.max(...points.map(point => point.value)), "data-latest-valid-time": latest.timestamp })) assert.equal(Number(await plot.getAttribute(name)), number)
      assert.ok((await plot.locator("[data-stat-trend]").getAttribute("d"))?.length)
    }
  } else await assertChart(widget, body)
  return { widget: widget.id, type: widget.type, service, state: "data", value: latest.value, samples: points.length, missing: series.points.length - points.length, min: Math.min(...points.map(point => point.value)), max: Math.max(...points.map(point => point.value)), request: response.request }
}
async function inspectService(service) {
  const evidence = []
  for (const widget of dashboard.widgets) evidence.push(await inspectWidget(widget, service))
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "The dashboard must not overflow horizontally")
  return evidence
}
async function check(name, action) {
  try { const evidence = await action(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) { reports.push({ name, passed: false, error: error.message }); await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {}); throw error }
}

try {
  await mkdir(output, { recursive: true }); usageBefore = await usage()
  await check("The dashboard and every saved query share the declared service variable and MCP providers", async () => {
    initialDashboard = await api(`dashboards/${config.dashboardId}`); dashboard = initialDashboard.document
    if (config.expectedDocument) assert.deepEqual(dashboard, config.expectedDocument)
    const remote = await tool("get_dashboard", { id: dashboard.id })
    assert.deepEqual(remote.document, dashboard); assert.equal(remote.etag, initialDashboard.etag)
    variable = dashboard.variables.find(item => item.name === variableName)
    assert.ok(variable && services.every(service => variable.options?.includes(service)))
    assert.ok(services.includes(variable.defaultValue))
    assert.ok(dashboard.widgets.length >= 4)
    const providers = (await api("providers")).document.providers
    for (const widget of dashboard.widgets) {
      assert.ok(["stat", "timeseries", "bar", "traces"].includes(widget.type), `Unsupported validation type ${widget.type}`)
      assert.ok(widget.queryRef?.id && widget.queryRef.bindings?.some(binding => binding.source === "variable" && binding.variable === variableName), `${widget.id} must bind to the shared service variable`)
      if (!queries.has(widget.queryRef.id)) {
        const saved = await api(`saved-queries/${widget.queryRef.id}`)
        const expected = config.expectedSavedQueries?.find(item => item.id === widget.queryRef.id)
        if (expected) assert.deepEqual(saved.document, expected)
        queries.set(widget.queryRef.id, saved)
      }
      const provider = providers.find(item => item.id === queries.get(widget.queryRef.id).document.providerId)
      assert.equal(provider?.source, "observability"); assert.equal(provider?.transport, "mcp")
      for (const service of services) resolveWidget(widget, service)
    }
    return { widgets: dashboard.widgets.map(({ id, type, queryRef }) => ({ id, type, savedQuery: queryRef.id })), serviceChoices: variable.options, persistedDefault: variable.defaultValue }
  })
  browser = await chromium.launch({ headless: true })
  for (const width of [1512, 390]) {
    await open(width)
    for (const theme of ["Light", "Dark"]) await check(`${theme} service overview renders all saved bindings at ${width}px`, async () => {
      await page.getByRole("combobox", { name: "Dashboard appearance", exact: true }).scrollIntoViewIfNeeded()
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const evidence = []
      for (const service of services) {
        await selectService(service)
        evidence.push({ service, widgets: await inspectService(service) })
        const screenshotName = `${theme.toLowerCase()}-${width}-${service.replace(/[^a-zA-Z0-9_-]/g, "_")}`
        if (width < 600) for (const [section, widget] of [
          ["trends", dashboard.widgets.find(widget => ["timeseries", "bar"].includes(widget.type))],
          ["traces", dashboard.widgets.find(widget => widget.type === "traces")],
        ]) {
          if (!widget) continue
          await tile(widget).evaluate(element => element.scrollIntoView({ block: "start" }))
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
          await page.screenshot({ path: join(output, `${screenshotName}-${section}.png`), fullPage: false })
        }
        await page.getByRole("heading", { name: dashboard.title, exact: true }).scrollIntoViewIfNeeded()
        await page.screenshot({ path: join(output, `${screenshotName}.png`), fullPage: false })
      }
      return evidence
    })
  }
  await check("Rapid service changes finish with the final service's real observations", async () => {
    await open(1512)
    await selectService(services[0]); await inspectService(services[0])
    await selectService(services[1]); await selectService(services[0])
    const evidence = await inspectService(services[0])
    await until(() => ![...pendingQueries.values()].includes(contextId), "Requests from rapid service changes did not settle")
    await inspectService(services[0])
    return { finalService: services[0], evidence, finalServiceVerifiedAfterRequestsSettled: true }
  })
  await check("Filters and inspection leave all persisted documents unchanged", async () => {
    const current = await api(`dashboards/${dashboard.id}`)
    assert.deepEqual(current, initialDashboard)
    for (const [id, saved] of queries) {
      assert.deepEqual(await api(`saved-queries/${id}`), saved)
      const remote = await tool("get_saved_query", { id })
      assert.deepEqual(remote.document, saved.document); assert.equal(remote.etag, saved.etag)
    }
    assert.deepEqual(writes, [], "The validator must not save or mutate any document")
    usageAfter = await usage()
    const delta = name => (usageAfter.tools.find(item => item.name === name)?.calls ?? 0) - (usageBefore.tools.find(item => item.name === name)?.calls ?? 0)
    for (const name of ["query_metrics", "query_traces"]) assert.ok(delta(name) > 0, `Expected actual ${name} MCP usage`)
    for (const name of ["dashboard_query", "dashboard_explore", "dashboard_list_providers"]) assert.equal(delta(name), 0, "Legacy REST data paths must not execute")
    return { unchangedDocuments: queries.size + 1, defaultService: variable.defaultValue, toolDeltas: { query_metrics: delta("query_metrics"), query_traces: delta("query_traces") }, legacyDataCalls: 0 }
  })
  assert.deepEqual(pageErrors, [])
  console.log(`PASS ${reports.length} read-only service overview scenarios`)
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1 }
finally {
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "report.json"), JSON.stringify({ timestamp: new Date().toISOString(), environment: config.environment ?? "live", dashboardURL, reports, pageErrors, writes, usageBefore, usageAfter, queryRequests: requests, completedRequests, queryResponses: responses.map(({ contextId, status, request, body }) => ({ contextId, status, request, kind: request.kind, series: body.series?.map(series => ({ labels: series.labels, samples: series.points.length, latest: finitePoints(series).at(-1) })), traceCount: body.traces?.length, traceServices: body.traces ? [...new Set(body.traces.map(trace => trace.service))] : undefined })) }, null, 2))
  await context?.close(); await browser?.close()
}
