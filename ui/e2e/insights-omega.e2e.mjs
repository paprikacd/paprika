// Live Omega acceptance. This suite never creates providers or copies credentials.
// It saves a uniquely named demonstration dashboard and its two saved queries.
// Supply INSIGHTS_OMEGA_CONFIG as a private JSON file; tokens are read from files.
// See docs/design/insights/omega-validation.md for its configuration contract.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const configFile = process.env.INSIGHTS_OMEGA_CONFIG
assert.ok(configFile, "Set INSIGHTS_OMEGA_CONFIG to the private live-validation configuration file")
const config = JSON.parse(await readFile(configFile, "utf8"))
function httpURL(value, name) {
  const url = new URL(value)
  assert.ok(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, `${name} must be an HTTP(S) URL without credentials, query or fragment`)
  return url.href.replace(/\/$/, "")
}
const baseURL = httpURL(config.baseURL, "baseURL")
const mcpURL = httpURL(config.mcpURL, "mcpURL")
const token = (await readFile(config.tokenFile, "utf8")).trim()
const mcpToken = (await readFile(config.mcpTokenFile, "utf8")).trim()
assert.ok(token && mcpToken, "Both token files must be nonempty")
assert.ok(typeof config.metricProviderRef === "string" && typeof config.traceProviderRef === "string", "Set the canonical Prometheus and Tempo provider references")
assert.ok(typeof config.metricTemplate === "string" && config.metricTemplate.includes("{{service}}"), "metricTemplate must contain an unquoted {{service}} literal placeholder")
assert.ok(typeof config.traceQuery === "string" && config.traceQuery.trim(), "traceQuery is required")
assert.ok(Array.isArray(config.services) && config.services.length >= 2 && config.services.every(value => typeof value === "string" && value.length <= 1024), "At least two real service values are required")
const services = [...new Set(config.services)]
assert.ok(services.length >= 2, "Service values must be distinct")
const template = config.metricTemplate
const unit = config.unit ?? ""
const runId = config.runId ?? new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
const dashboardId = config.dashboardId ?? `omega-observe-${runId}`
const metricQueryId = config.queryId ?? `omega-service-${runId}`
const traceQueryId = config.traceQueryId ?? `omega-traces-${runId}`
for (const id of [dashboardId, metricQueryId, traceQueryId]) assert.match(id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
const title = config.title ?? `Omega service signals ${runId}`
const output = config.outputDir ? resolve(config.outputDir) : join(repository, "artifacts/insights/omega", runId)
const end = config.range?.to ? Date.parse(config.range.to) : Math.floor(Date.now() / 60_000) * 60_000 - 120_000
const start = config.range?.from ? Date.parse(config.range.from) : end - (config.rangeMinutes ?? 60) * 60_000
assert.ok(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 31 * 86_400_000, "Range must be an increasing interval of at most 31 days")
const fixedRange = { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
const step = Math.max(1, Math.ceil((end - start) / 1000 / 300))
const metricTitle = "Selected service"
const traceTitle = "Recent service traces"
const reports = [], pageErrors = [], queryResponses = []
let browser, context, page, metricProvider, traceProvider, dashboard, dashboardETag
let sessionId, rpcId = 0
const documents = []
const queryFor = service => template.split("{{service}}").join(JSON.stringify(service))
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(predicate, message, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await delay(100) }
  throw new Error(message)
}
async function api(path, { method = "GET", document, headers = {} } = {}) {
  const response = await fetch(`${baseURL}/api/insights/${path}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    ...(document === undefined ? {} : { body: JSON.stringify(document) }), signal: AbortSignal.timeout(45_000),
  })
  assert.ok(response.ok, `Insights ${method} ${path}: HTTP ${response.status}`)
  const text = await response.text()
  return { body: text ? JSON.parse(text) : undefined, etag: response.headers.get("etag") }
}
async function mcp(method, params) {
  const response = await fetch(mcpURL, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${mcpToken}`, "MCP-Protocol-Version": "2025-03-26", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), signal: AbortSignal.timeout(45_000),
  })
  assert.ok(response.ok, `Observe ${method}: HTTP ${response.status}`)
  sessionId = response.headers.get("Mcp-Session-Id") ?? sessionId
  const text = await response.text()
  const data = response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === rpcId) : JSON.parse(text)
  assert.ok(data && !data.error, `Observe ${method} returned a protocol error`)
  return data.result
}
function structured(result) {
  assert.notEqual(result.isError, true, "Observe tool reported an error")
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === "text").text)
}
async function tool(name, args) { return structured(await mcp("tools/call", { name, arguments: args })) }
async function check(name, fn) {
  try { const evidence = await fn(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) {
    reports.push({ name, passed: false, error: error.message })
    await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {})
    throw error
  }
}
function seriesSummary(body) {
  assert.ok(body.series?.length, "Real Prometheus query returned no series")
  const series = body.series.find(item => item.points.some(point => Number.isFinite(point.value)))
  assert.ok(series, "Real Prometheus query returned no finite samples")
  const points = series.points.filter(point => Number.isFinite(point.timestamp)).sort((a, b) => a.timestamp - b.timestamp)
  const finite = points.filter(point => Number.isFinite(point.value))
  assert.ok(finite.length >= 2, "A sparkline requires at least two real samples")
  const latest = finite.at(-1)
  return { series, samples: points.length, start: points[0].timestamp, end: points.at(-1).timestamp, latest: latest.value, latestTime: latest.timestamp, min: Math.min(...finite.map(point => point.value)), max: Math.max(...finite.map(point => point.value)) }
}
function canonicalSeries(series) {
  return series.map(item => ({ labels: Object.fromEntries(Object.entries(item.labels ?? {}).sort(([a], [b]) => a.localeCompare(b))), points: item.points })).sort((a, b) => JSON.stringify(a.labels).localeCompare(JSON.stringify(b.labels)))
}
function nativePrometheus(data) {
  const result = data.data?.result ?? data.result
  assert.ok(Array.isArray(result), "Observe did not return a native Prometheus result")
  return result.map(item => ({ labels: item.metric, points: item.values.map(([timestamp, raw]) => ({ timestamp: timestamp * 1000, value: Number.isFinite(Number(raw)) ? Number(raw) : null })) }))
}
const tile = () => page.locator('[data-widget-id="selected-service"]')
const traceTile = () => page.locator('[data-widget-id="service-traces"]')
async function expectService(service) {
  const query = queryFor(service)
  await until(() => queryResponses.some(item => item.status === 200 && item.request.providerId === metricProvider.id && item.request.query === query), `The dashboard did not execute the selected service query`)
  const response = queryResponses.findLast(item => item.status === 200 && item.request.providerId === metricProvider.id && item.request.query === query)
  const summary = seriesSummary(response.body)
  const reading = tile().locator("[data-metric-value]").first()
  await until(async () => Number(await reading.getAttribute("data-metric-value").catch(() => NaN)) === summary.latest, "The displayed value does not match the provider's latest sample")
  const expected = new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(summary.latest) + unit
  assert.equal((await reading.innerText()).replace(/\s+/g, ""), expected.replace(/\s+/g, ""), "Single value must use exactly two decimal places")
  const plot = tile().locator("[data-stat-sparkline]")
  await plot.waitFor({ state: "visible" })
  for (const [attribute, value] of Object.entries({ "data-sample-count": summary.samples, "data-history-start": summary.start, "data-history-end": summary.end, "data-history-min": summary.min, "data-history-max": summary.max, "data-latest-valid-time": summary.latestTime })) assert.equal(Number(await plot.getAttribute(attribute)), value, `Sparkline ${attribute} must describe the displayed series`)
  const path = await plot.locator("[data-stat-trend]").getAttribute("d")
  assert.ok(path?.length > 2)
  assert.ok((await plot.locator("[data-stat-area]").getAttribute("d"))?.length > 2)
  return { value: summary.latest, displayed: await reading.innerText(), samples: summary.samples, min: summary.min, max: summary.max, path, query }
}
async function open(width) {
  await context?.close()
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 960 }, reducedMotion: "reduce", colorScheme: "light", locale: "en-US", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  await context.addInitScript(value => localStorage.setItem("paprika_id_token", value), token)
  page = await context.newPage(); page.setDefaultTimeout(30_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("response", response => {
    if (new URL(response.url()).pathname !== "/api/insights/query") return
    void response.json().then(body => queryResponses.push({ status: response.status(), request: JSON.parse(response.request().postData() || "{}"), body })).catch(() => {})
  })
  await page.goto(`${baseURL}/dashboard/insights/?dashboard=${encodeURIComponent(dashboardId)}`, { waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: title, exact: true }).waitFor()
  assert.equal(await page.locator("[data-dashboard-shell-content]").count(), 0)
  await expectService(services[0])
}
async function selectService(service) {
  const filter = page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: "Service", exact: true })
  await selectGammaOption(page, filter, service)
  return expectService(service)
}
try {
  await mkdir(output, { recursive: true })
  await check("Live dashboard and Observe discover the same Prometheus and Tempo providers", async () => {
    const providers = (await api("providers")).body.providers
    metricProvider = providers.find(item => item.providerRef === config.metricProviderRef)
    traceProvider = providers.find(item => item.providerRef === config.traceProviderRef)
    assert.equal(metricProvider?.type, "prometheus"); assert.equal(traceProvider?.type, "tempo")
    assert.equal(metricProvider.source, "observability"); assert.equal(traceProvider.source, "observability")
    assert.ok(providers.every(item => !Object.hasOwn(item, "url") && !Object.hasOwn(item, "credentials")))
    await mcp("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paprika-omega-validation", version: "1" } })
    const observed = await tool("list_observability_providers", {})
    for (const provider of [metricProvider, traceProvider]) assert.ok(observed.providers.some(item => item.name === provider.providerRef && item.type === provider.type))
    return { providers: [metricProvider, traceProvider].map(({ id, providerRef, type }) => ({ id, providerRef, type })) }
  })
  await check("Both selected services have real metric history and Observe returns identical samples", async () => {
    const evidence = []
    for (const service of services.slice(0, 2)) {
      const query = queryFor(service)
      const result = (await api("query", { method: "POST", document: { providerId: metricProvider.id, kind: "metrics", query, start: start / 1000, end: end / 1000, step } })).body
      const summary = seriesSummary(result)
      assert.notEqual(result.truncated, true, "Choose a bounded metric query without partial results")
      const observe = await tool("query_metrics", { provider: metricProvider.providerRef, query, start: fixedRange.from, end: fixedRange.to, step_seconds: step })
      assert.equal(observe.state, "OK")
      assert.deepEqual(canonicalSeries(result.series), canonicalSeries(nativePrometheus(observe.data)), "MCP and dashboard samples differ for the same query, range and step")
      evidence.push({ service, samples: summary.samples, latest: summary.latest, min: summary.min, max: summary.max })
    }
    assert.notDeepEqual(evidence[0], evidence[1])
    return { range: fixedRange, step, services: evidence }
  })
  await check("The shared Tempo provider returns actual traces through dashboard and Observe", async () => {
    const result = (await api("query", { method: "POST", document: { providerId: traceProvider.id, kind: "traces", query: config.traceQuery, start: start / 1000, end: end / 1000, step } })).body
    assert.ok(result.traces?.length, "The real Tempo provider returned no traces in the selected range")
    const observe = await tool("query_traces", { provider: traceProvider.providerRef, query: config.traceQuery, start: fixedRange.from, end: fixedRange.to, limit: 100 })
    assert.equal(observe.state, "OK")
    assert.ok(observe.data?.traces?.length, "Observe Tempo query returned no traces")
    assert.ok(observe.data.traces.some(trace => result.traces.some(item => item.traceId === trace.traceID)), "Dashboard and Observe trace searches do not share a trace")
    return { dashboardTraces: result.traces.length, observeTraces: observe.data.traces.length, services: [...new Set(result.traces.map(trace => trace.service))] }
  })
  if (config.metricName && config.metricLabel) await check("Live metric labels and cardinality are available to the query builder", async () => {
    const metadata = (await api(`providers/${metricProvider.id}/metadata?${new URLSearchParams({ kind: "series", metric: config.metricName })}`)).body
    assert.ok(metadata.series?.count > 0)
    const label = metadata.series.labels.find(item => item.name === config.metricLabel)
    assert.ok(label?.cardinality >= 2, "The selected service label must identify at least two real series")
    return { metric: config.metricName, series: metadata.series.count, label: label.name, cardinality: label.cardinality, truncated: Boolean(metadata.series.truncated) }
  })
  await check("Parameterized metric query, Tempo query and dashboard persist through the real API", async () => {
    const metricSaved = { schemaVersion: 1, id: metricQueryId, name: "Omega service metric", description: "Live shared Prometheus query. Select a service on the Omega dashboard.", tags: ["omega", "service", "live-validation"], providerId: metricProvider.id, kind: "metrics", query: template, parameters: [{ name: "service", type: "string", defaultValue: services[0] }] }
    const traceSaved = { schemaVersion: 1, id: traceQueryId, name: "Omega service traces", description: "Live shared Tempo search used by the Omega dashboard.", tags: ["omega", "traces", "live-validation"], providerId: traceProvider.id, kind: "traces", query: config.traceQuery }
    for (const saved of [metricSaved, traceSaved]) {
      await api(`saved-queries/${saved.id}`, { method: "PUT", document: saved, headers: { "If-None-Match": "*" } })
      documents.push({ kind: "saved-query", id: saved.id })
      assert.deepEqual((await api(`saved-queries/${saved.id}`)).body, saved)
    }
    dashboard = { schemaVersion: 1, id: dashboardId, title, description: "Live Omega validation of shared Observe providers, saved queries and service filters.", folder: "Omega/Observability", timeRange: "1h", customTimeRange: fixedRange, refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: services[0], options: services }], widgets: [
      { id: "selected-service", title: metricTitle, type: "stat", providerId: metricProvider.id, query: "saved_query_reference_required", queryRef: { id: metricQueryId, bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, unit, options: { decimals: 2, showSparkline: true }, layout: { x: 0, y: 0, w: 6, h: 4 } },
      { id: "service-traces", title: traceTitle, type: "traces", providerId: traceProvider.id, query: "saved_query_reference_required", queryRef: { id: traceQueryId, bindings: [] }, unit: "ms", options: { decimals: 2 }, layout: { x: 6, y: 0, w: 6, h: 4 } },
    ] }
    const persisted = await api(`dashboards/${dashboardId}`, { method: "PUT", document: dashboard, headers: { "If-None-Match": "*" } })
    dashboardETag = persisted.etag
    documents.push({ kind: "dashboard", id: dashboardId })
    assert.ok(dashboardETag)
    assert.deepEqual((await api(`dashboards/${dashboardId}`)).body, dashboard)
    return { savedQueries: [metricQueryId, traceQueryId], dashboardId, conditionalCreation: true }
  })
  browser = await chromium.launch({ headless: true })
  for (const width of [1512, 390]) {
    await open(width)
    for (const theme of ["Light", "Dark"]) await check(`${theme} live service filter and sparkline render correctly at ${width}px`, async () => {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const before = await selectService(services[0])
      const after = await selectService(services[1])
      assert.notEqual(before.query, after.query)
      assert.ok(before.path !== after.path || before.value !== after.value || before.min !== after.min || before.max !== after.max, "Choose services whose real history differs so the filter demonstration is observable")
      const persisted = await api(`dashboards/${dashboardId}`)
      assert.equal(persisted.etag, dashboardETag, "Filtering must not save a changed default")
      assert.equal(persisted.body.variables[0].defaultValue, services[0])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Dashboard must not overflow horizontally")
      await page.screenshot({ path: join(output, `service-${theme.toLowerCase()}-${width}.png`), fullPage: false })
      return { before: { value: before.value, samples: before.samples, min: before.min, max: before.max }, after: { value: after.value, samples: after.samples, min: after.min, max: after.max }, sparklinePathChanged: before.path !== after.path, persistedDefaultUnchanged: true }
    })
  }
  await open(1512)
  await check("Saved metric and trace references survive a fresh browser context and reload", async () => {
    await expectService(services[0])
    await until(() => queryResponses.some(item => item.status === 200 && item.request.providerId === traceProvider.id && item.request.query === config.traceQuery && item.body.traces?.length), "Tempo widget did not query the real saved trace search")
    await traceTile().getByRole("table", { name: traceTitle, exact: true }).waitFor()
    assert.ok(await traceTile().getByRole("row").count() > 1)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("heading", { name: title, exact: true }).waitFor()
    await expectService(services[0])
    assert.deepEqual((await api(`dashboards/${dashboardId}`)).body, dashboard)
    await page.screenshot({ path: join(output, "persisted-live-dashboard.png"), fullPage: false })
    return { dashboardId, traceRows: await traceTile().getByRole("row").count() - 1, referencesRestored: true }
  })
  assert.deepEqual(pageErrors, [], "No browser runtime errors")
  console.log(`PASS ${reports.length} live Omega scenarios; dashboard ${dashboardId}`)
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "report.json"), JSON.stringify({ timestamp: new Date().toISOString(), dashboardURL: `${baseURL}/dashboard/insights/?dashboard=${encodeURIComponent(dashboardId)}`, range: fixedRange, documents, reports, pageErrors, queries: queryResponses.map(({ status, request, body }) => ({ status, providerId: request.providerId, kind: request.kind, query: request.query, start: request.start, end: request.end, step: request.step, series: body.series?.length, traces: body.traces?.length })) }, null, 2))
  await context?.close(); await browser?.close()
  // Deliberately retain only this run's created demonstration documents.
  // No cleanup path deletes or overwrites someone else's saved dashboard.
}
