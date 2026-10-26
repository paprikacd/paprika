// Live MCP authoring acceptance. Configuration and tokens stay outside the repo.
// Creates unique demonstration documents and retains them; never overwrites a
// pre-existing dashboard/query. Set INSIGHTS_OMEGA_AUTHORING_CONFIG to private JSON.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { assertObserveMCP, readObserveProtocol } from "./observe-protocol.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
assert.ok(process.env.INSIGHTS_OMEGA_AUTHORING_CONFIG, "Set INSIGHTS_OMEGA_AUTHORING_CONFIG to a private JSON file")
const config = JSON.parse(await readFile(process.env.INSIGHTS_OMEGA_AUTHORING_CONFIG, "utf8"))
function origin(value) {
  const url = new URL(value)
  assert.ok(["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash)
  return url.href.replace(/\/$/, "")
}
const baseURL = origin(config.baseURL), mcpURL = origin(config.mcpURL)
const token = (await readFile(config.tokenFile, "utf8")).trim()
const readToken = (await readFile(config.mcpTokenFile, "utf8")).trim()
const writeToken = (await readFile(config.mcpWriteTokenFile, "utf8")).trim()
assert.ok(token && readToken && writeToken)
assert.ok(config.metricTemplate?.includes("{{service}}"))
assert.ok(Array.isArray(config.services) && config.services.length >= 2)
const services = [...new Set(config.services)]
assert.ok(services.length >= 2 && services.every(value => typeof value === "string"))
assert.ok(config.metricProviderRef && config.traceProviderRef && config.traceQuery)
const runId = config.runId ?? new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)
const queryId = `omega-mcp-metric-${runId}`, traceId = `omega-mcp-traces-${runId}`, dashboardId = `omega-mcp-dashboard-${runId}`
for (const id of [queryId, traceId, dashboardId]) assert.match(id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
const output = config.outputDir ? resolve(config.outputDir) : join(repository, "artifacts/insights/omega-authoring", runId)
const end = config.range?.to ? Date.parse(config.range.to) : Math.floor(Date.now() / 60_000) * 60_000 - 120_000
const start = config.range?.from ? Date.parse(config.range.from) : end - (config.rangeMinutes ?? 60) * 60_000
assert.ok(Number.isFinite(start) && Number.isFinite(end) && end > start && end - start <= 31 * 86_400_000)
const fixedRange = { from: new Date(start).toISOString(), to: new Date(end).toISOString() }
const step = Math.max(1, Math.ceil((end - start) / 1000 / 300))
const unit = config.unit ?? "", template = config.metricTemplate
const title = config.title ?? `Omega MCP authoring ${runId}`
const reports = [], pageErrors = [], responses = [], documents = [], versions = []
let browser, context, page, rpcId = 0, metricProvider, traceProvider, queryEntry, dashboardEntry, toolUsageBefore, toolUsageAfter, protocol
const expression = (service, query = template) => query.split("{{service}}").join(JSON.stringify(service))

async function until(predicate, message, timeout = 45_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 80)) }
  throw new Error(message)
}
async function api(path) {
  const response = await fetch(`${baseURL}/api/insights/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, `GET ${path}: HTTP${response.status}`)
  const httpETag = response.headers.get("etag"), documentETag = response.headers.get("x-paprika-document-etag")
  if (documentETag) assert.match(documentETag, /^"[a-f0-9]{64}"$/)
  if (httpETag?.startsWith("W/")) {
    assert.ok(documentETag, "A transformed response must retain its exact document version")
    assert.equal(httpETag, `W/${documentETag}`)
  }
  versions.push({ client: "node", path, httpETag, documentETag, encoding: response.headers.get("content-encoding") })
  return { document: await response.json(), etag: documentETag ?? httpETag }
}
async function usageSnapshot() {
  // This is the gateway's operational counter endpoint, never a provider data
  // source. The script itself does not call query_metrics/query_traces.
  const response = await fetch(new URL("/observe/api/usage", mcpURL), { headers: { Authorization: `Bearer ${readToken}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, "Observe tool usage must be available to verify the actual data transport")
  const snapshot = await response.json()
  assert.ok(Array.isArray(snapshot.tools))
  return snapshot
}
function usageDelta(before, after, name) {
  return (after.tools.find(item => item.name === name)?.calls ?? 0) - (before.tools.find(item => item.name === name)?.calls ?? 0)
}
async function rpc(method, params, credential = writeToken) {
  const id = ++rpcId
  const response = await fetch(mcpURL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${credential}`, "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(45_000) })
  assert.equal(response.status, 200, `MCP ${method}: HTTP${response.status}`)
  const text = await response.text()
  return response.headers.get("content-type")?.includes("text/event-stream") ? text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === id) : JSON.parse(text)
}
function structured(result) { return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === "text").text) }
async function tool(name, args, credential = writeToken) {
  const response = await rpc("tools/call", { name, arguments: args }, credential)
  assert.equal(response.error, undefined, `${name}: ${response.error?.message}`)
  assert.notEqual(response.result?.isError, true, `${name}: ${JSON.stringify(response.result?.content)}`)
  return structured(response.result)
}
async function conflict(name, args) {
  const response = await rpc("tools/call", { name, arguments: args })
  assert.equal(response.error, undefined, "Conflicts must be actionable tool results")
  assert.equal(response.result?.isError, true)
  const message = response.result.content.filter(item => item.type === "text").map(item => item.text).join("\n")
  assert.match(message, /get the latest document and ETag/)
  return { rejected: true, actionable: true }
}
function persisted(result, document) {
  assert.deepEqual(result.document, document)
  assert.match(result.etag, /^"[a-f0-9]{64}"$/)
  assert.equal(new URL(result.uiUrl).origin, new URL(baseURL).origin)
  return result
}
async function check(name, action) {
  try { const evidence = await action(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) { reports.push({ name, passed: false, error: error.message }); await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {}); throw error }
}
const tile = () => page.locator('[data-widget-id="selected-service"]')
async function reading(service, query = template) {
  const resolved = expression(service, query)
  const matches = item => item.status === 200 && item.request.providerId === metricProvider.id && item.request.query === resolved && item.request.start === start / 1000 && item.request.end === end / 1000 && item.request.step === step
  await until(() => responses.some(matches), "The widget did not execute the expected saved-query binding and exact dashboard time range")
  const response = responses.findLast(matches)
  const series = response.body.series?.find(item => item.points.some(point => Number.isFinite(point.value)))
  assert.ok(series, "The real provider returned no finite metric samples")
  const points = [...series.points].sort((a, b) => a.timestamp - b.timestamp), finite = points.filter(point => Number.isFinite(point.value))
  assert.ok(finite.length >= 2, "A sparkline requires real history")
  const latest = finite.at(-1), value = tile().locator("[data-metric-value]").first()
  await until(async () => Number(await value.getAttribute("data-metric-value").catch(() => NaN)) === latest.value, "The value did not update to the actual provider sample")
  const formatted = new Intl.NumberFormat("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(latest.value) + unit
  assert.equal((await value.innerText()).replace(/\s+/g, ""), formatted.replace(/\s+/g, ""))
  const plot = tile().locator("[data-stat-sparkline]")
  const min = Math.min(...finite.map(point => point.value)), max = Math.max(...finite.map(point => point.value))
  for (const [attribute, expected] of Object.entries({ "data-sample-count": points.length, "data-history-start": points[0].timestamp, "data-history-end": points.at(-1).timestamp, "data-history-min": min, "data-history-max": max, "data-latest-valid-time": latest.timestamp })) assert.equal(Number(await plot.getAttribute(attribute)), expected)
  const path = await plot.locator("[data-stat-trend]").getAttribute("d")
  assert.ok(path?.length > 2); assert.ok((await plot.locator("[data-stat-area]").getAttribute("d"))?.length > 2)
  return { value: latest.value, samples: points.length, min, max, path }
}
async function open(width = 1512, id) {
  await context?.close()
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 960 }, reducedMotion: "reduce", colorScheme: "light", locale: "en-US", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  await context.addInitScript(value => localStorage.setItem("paprika_id_token", value), token)
  page = await context.newPage(); page.setDefaultTimeout(45_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/api/insights/query") void response.json().then(body => responses.push({ status: response.status(), request: JSON.parse(response.request().postData() || "{}"), body })).catch(() => {})
    if (new URL(response.url()).pathname === `/api/insights/dashboards/${dashboardId}`) versions.push({ client: "browser", method: response.request().method(), status: response.status(), httpETag: response.headers().etag, documentETag: response.headers()["x-paprika-document-etag"], encoding: response.headers()["content-encoding"], ifMatch: response.request().headers()["if-match"] })
  })
  await page.goto(`${baseURL}/dashboard/insights/${id ? `?dashboard=${id}` : ""}`, { waitUntil: "networkidle" })
  await page.getByText("Live providers", { exact: true }).waitFor()
  await page.getByRole("region", { name: "Dashboard workspace", exact: true }).getByRole("heading", { level: 1 }).waitFor()
  await page.bringToFront()
}
async function service(value, query) {
  await selectGammaOption(page, page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: "Service", exact: true }), value)
  return reading(value, query)
}

try {
  await mkdir(output, { recursive: true })
  toolUsageBefore = await usageSnapshot()
  await check("The deployed MCP exposes authorized Insights providers and authoring tools", async () => {
    const initialized = await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paprika-omega-authoring-validation", version: "1" } })
    assert.equal(initialized.error, undefined)
    if (config.expectedCommit) assert.ok(initialized.result.serverInfo.version.includes(config.expectedCommit))
    const providers = (await tool("list_insights_providers", {}, readToken)).providers
    metricProvider = providers.find(item => item.providerRef === config.metricProviderRef)
    traceProvider = providers.find(item => item.providerRef === config.traceProviderRef)
    assert.equal(metricProvider?.type, "prometheus"); assert.equal(traceProvider?.type, "tempo")
    assert.equal(metricProvider.source, "observability"); assert.equal(traceProvider.source, "observability")
    assert.equal(metricProvider.transport, "mcp"); assert.equal(traceProvider.transport, "mcp")
    assert.ok(providers.every(item => !Object.hasOwn(item, "url") && !Object.hasOwn(item, "credentials")))
    const listed = await rpc("tools/list", {}, readToken)
    for (const name of ["create_saved_query", "update_saved_query", "create_dashboard", "update_dashboard"]) assert.equal(listed.result.tools.find(item => item.name === name)?.annotations.readOnlyHint, false)
    const connection = (await api("observe-connection")).document
    assert.equal(connection.connected, true); assert.equal(connection.transport, "mcp")
    for (const name of ["query_metrics", "query_traces", "list_metric_series"]) assert.ok(connection.tools.some(tool => tool.name === name))
    return { serverVersion: initialized.result.serverInfo.version, providers: [metricProvider.providerRef, traceProvider.providerRef], connection: { transport: connection.transport, providerCount: connection.providerCount, tools: connection.tools.map(tool => tool.name) } }
  })
  const saved = { schemaVersion: 1, id: queryId, name: `MCP Omega service metric ${runId}`, description: "Created through Paprika Observe MCP using the shared real Prometheus provider.", tags: ["omega", "mcp", "service"], providerId: metricProvider.id, kind: "metrics", query: template, parameters: [{ name: "service", type: "string", defaultValue: services[0] }] }
  const traces = { schemaVersion: 1, id: traceId, name: `MCP Omega service traces ${runId}`, description: "Created through Observe MCP using the real Tempo provider.", tags: ["omega", "mcp", "traces"], providerId: traceProvider.id, kind: "traces", query: config.traceQuery }
  await check("An existing read-only Observe token cannot create saved documents", async () => {
    const result = await rpc("tools/call", { name: "create_saved_query", arguments: { document: saved } }, readToken)
    assert.equal(result.error?.code, -32001); assert.match(result.error.message, /paprika:insights:write/)
    return { deniedWithRequiredWriteScope: true }
  })
  browser = await chromium.launch({ headless: true })
  await open()
  await check("MCP creates real Prometheus and Tempo saved queries and a dashboard visible in the open UI", async () => {
    queryEntry = persisted(await tool("create_saved_query", { document: saved }), saved); documents.push({ kind: "saved-query", id: queryId })
    persisted(await tool("create_saved_query", { document: traces }), traces); documents.push({ kind: "saved-query", id: traceId })
    const document = { schemaVersion: 1, id: dashboardId, title, description: "Created through Observe MCP. The Service filter binds to the shared Prometheus saved query; Tempo retains its own service query.", folder: "Omega/MCP authoring", timeRange: "1h", customTimeRange: fixedRange, refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: services[0], options: services }], widgets: [
      { id: "selected-service", title: "Selected service", type: "stat", providerId: metricProvider.id, query: "saved_query_reference_required", queryRef: { id: queryId, bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, unit, options: { decimals: 2, showSparkline: true }, layout: { x: 0, y: 0, w: 6, h: 4 } },
      { id: "service-traces", title: "Recent service traces", type: "traces", providerId: traceProvider.id, query: "saved_query_reference_required", queryRef: { id: traceId, bindings: [] }, unit: "ms", options: { decimals: 2 }, layout: { x: 6, y: 0, w: 6, h: 4 } },
    ] }
    dashboardEntry = persisted(await tool("create_dashboard", { document }), document); documents.push({ kind: "dashboard", id: dashboardId })
    const entry = page.locator("#insights-navigation").getByRole("button", { name: title, exact: true })
    await entry.waitFor(); await entry.click()
    await page.getByRole("heading", { name: title, exact: true }).waitFor()
    const summary = await reading(services[0])
    await until(() => responses.some(item => item.status === 200 && item.request.providerId === traceProvider.id && item.request.query === config.traceQuery && item.request.start === start / 1000 && item.request.end === end / 1000 && item.body.traces?.length), "The MCP-authored Tempo reference did not return real traces for the dashboard time range")
    await page.locator('[data-widget-id="service-traces"]').getByRole("table").waitFor()
    assert.deepEqual((await api(`saved-queries/${queryId}`)).document, saved)
    assert.deepEqual((await api(`dashboards/${dashboardId}`)).document, document)
    await page.screenshot({ path: join(output, "mcp-created-live-dashboard.png"), fullPage: false })
    return { documents: [...documents], samples: summary.samples, latest: summary.value, traceRows: await page.locator('[data-widget-id="service-traces"]').getByRole("row").count() - 1 }
  })
  await check("MCP query and dashboard updates reach the existing UI without reload", async () => {
    const before = await reading(services[0]), previous = queryEntry
    const document = { ...queryEntry.document, name: `MCP Omega service metric updated ${runId}`, description: "Updated through MCP. This demonstration doubles CPU samples to make the change visible.", tags: ["omega", "mcp-live-edit", "service"], query: `(${template}) * 2` }
    queryEntry = persisted(await tool("update_saved_query", { document, etag: previous.etag }), document)
    const after = await reading(services[0], document.query)
    for (const key of ["value", "min", "max"]) assert.ok(Math.abs(after[key] - before[key] * 2) < Math.max(1e-9, Math.abs(before[key]) * 1e-9), `Updated ${key} must represent the doubled real provider history`)
    const previousDashboard = dashboardEntry
    const next = { ...dashboardEntry.document, title: `${title} — updated`, description: "Updated via Observe MCP while this dashboard was open. The stat intentionally shows twice the CPU percentage to demonstrate a saved-query edit." }
    dashboardEntry = persisted(await tool("update_dashboard", { document: next, etag: previousDashboard.etag }), next)
    await page.getByRole("heading", { name: next.title, exact: true }).waitFor()
    await page.getByText(next.description, { exact: true }).waitFor()
    await conflict("update_saved_query", { document: saved, etag: previous.etag })
    await conflict("update_dashboard", { document: previousDashboard.document, etag: previousDashboard.etag })
    assert.deepEqual((await api(`saved-queries/${queryId}`)).document, document)
    assert.deepEqual((await api(`dashboards/${dashboardId}`)).document, next)
    return { before, after, refreshedWithoutReload: true, staleWritesRejected: true }
  })
  await check("The query editor shows metadata written through MCP", async () => {
    await page.locator("#insights-navigation").getByRole("button", { name: /^Data sources\b/ }).click()
    const panel = page.getByRole("region", { name: "Data sources", exact: true })
    const connection = panel.getByRole("region", { name: "Paprika Observe MCP", exact: true })
    await connection.getByRole("status").filter({ hasText: /^Connected\b/ }).waitFor()
    await connection.getByRole("button", { name: /Discovered MCP tools/ }).click()
    await connection.getByText("query_metrics", { exact: true }).waitFor()
    for (const theme of ["Light", "Dark"]) {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      await page.screenshot({ path: join(output, `mcp-connection-${theme.toLowerCase()}.png`), fullPage: false })
    }
    const card = panel.getByRole("article").filter({ hasText: metricProvider.providerRef })
    await card.getByRole("button", { name: `Explore ${metricProvider.name}`, exact: true }).click()
    const editor = page.getByRole("region", { name: "Data source explorer", exact: true }).last()
    await editor.getByText("query_metrics", { exact: true }).waitFor()
    await selectGammaOption(page, editor.getByRole("combobox", { name: "Open saved query", exact: true }), new RegExp(queryEntry.document.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    assert.equal(await editor.getByRole("textbox", { name: "Query description", exact: true }).inputValue(), queryEntry.document.description)
    const metric = config.metricName ?? template.match(/([a-zA-Z_:][a-zA-Z0-9_:]*)\s*\{/)?.[1]
    assert.ok(metric, "Set metricName when metricTemplate has no literal metric selector")
    const metadata = async (kind, extra = {}) => (await api(`providers/${metricProvider.id}/metadata?${new URLSearchParams({ kind, ...extra })}`)).document
    const metrics = await metadata("metrics"), labels = await metadata("labels", { metric }), values = await metadata("values", { metric, label: "service" }), series = await metadata("series", { metric })
    assert.ok(metrics.values.includes(metric)); assert.ok(labels.values.includes("service")); assert.ok(services.every(service => values.values.includes(service)))
    assert.ok(series.series.count >= 2 && series.series.labels.some(label => label.name === "service" && label.cardinality >= 2))
    for (const theme of ["Light", "Dark"]) {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      await page.screenshot({ path: join(output, `mcp-query-details-${theme.toLowerCase()}.png`), fullPage: false })
    }
    await editor.getByRole("button", { name: "Dashboard", exact: true }).click()
    return { name: queryEntry.document.name, descriptionVisible: true, tags: queryEntry.document.tags, metric, storedSeries: series.series.count, serviceCardinality: series.series.labels.find(label => label.name === "service").cardinality }
  })
  for (const width of [1512, 390]) {
    await open(width, dashboardId)
    await page.getByRole("heading", { name: dashboardEntry.document.title, exact: true }).waitFor()
    for (const theme of ["Light", "Dark"]) await check(`${theme} MCP-authored service filters and sparklines render at ${width}px`, async () => {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const before = await service(services[0], queryEntry.document.query), after = await service(services[1], queryEntry.document.query)
      assert.ok(before.path !== after.path || before.value !== after.value || before.min !== after.min || before.max !== after.max)
      assert.equal((await api(`dashboards/${dashboardId}`)).etag, dashboardEntry.etag)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: join(output, `mcp-${theme.toLowerCase()}-${width}.png`), fullPage: false })
      return { before: { value: before.value, samples: before.samples }, after: { value: after.value, samples: after.samples }, persistedDefaultUnchanged: true }
    })
  }
  await check("MCP-authored references survive reload and a UI save returns the exact new version through MCP", async () => {
    await open(1512, dashboardId)
    await page.getByRole("heading", { name: dashboardEntry.document.title, exact: true }).waitFor()
    await reading(services[0], queryEntry.document.query)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("heading", { name: dashboardEntry.document.title, exact: true }).waitFor()
    await reading(services[0], queryEntry.document.query)
    const query = await tool("get_saved_query", { id: queryId }, readToken), board = await tool("get_dashboard", { id: dashboardId }, readToken)
    assert.deepEqual(query.document, queryEntry.document); assert.equal(query.etag, queryEntry.etag)
    assert.deepEqual(board.document, dashboardEntry.document); assert.equal(board.etag, dashboardEntry.etag)
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    const updatedTitle = `${title} — MCP and UI verified`
    await page.getByRole("textbox", { name: "Dashboard title", exact: true }).fill(updatedTitle)
    const saved = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/insights/dashboards/${dashboardId}`)
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    const response = await saved
    assert.equal(response.status(), 200, "The UI must save through the public compressed transport")
    assert.equal(response.request().headers()["if-match"], board.etag, "UI compare-and-swap must send the exact application version")
    await page.getByRole("heading", { name: updatedTitle, exact: true }).waitFor()
    dashboardEntry = await tool("get_dashboard", { id: dashboardId }, readToken)
    assert.deepEqual(dashboardEntry.document, JSON.parse(response.request().postData()))
    assert.equal(dashboardEntry.document.title, updatedTitle)
    assert.notEqual(dashboardEntry.etag, board.etag)
    assert.equal(dashboardEntry.etag, response.headers()["x-paprika-document-etag"] ?? response.headers().etag)
    assert.equal((await api(`dashboards/${dashboardId}`)).etag, dashboardEntry.etag)
    await reading(services[0], queryEntry.document.query)
    await page.screenshot({ path: join(output, "mcp-ui-roundtrip.png"), fullPage: false })
    toolUsageAfter = await usageSnapshot()
    const usedTools = ["list_observability_providers", "query_metrics", "query_traces", "list_metric_names", "list_label_names", "list_label_values", "list_metric_series"]
    const toolDeltas = Object.fromEntries(usedTools.map(name => [name, usageDelta(toolUsageBefore, toolUsageAfter, name)]))
    for (const [name, delta] of Object.entries(toolDeltas)) assert.ok(delta > 0, `Dashboard traffic must increment the actual ${name} MCP tool counter`)
    for (const name of ["dashboard_list_providers", "dashboard_query", "dashboard_explore"]) assert.equal(usageDelta(toolUsageBefore, toolUsageAfter, name), 0, "No legacy Observe REST data fallback may execute")
    if (config.environment === "fixture") { protocol = await readObserveProtocol(baseURL); assertObserveMCP(protocol, usedTools) }
    return { restoredReferences: true, uiSaveStatus: response.status(), exactVersionSent: true, uiChangeVisibleThroughMCP: true, transformedResponsesPreservedVersions: versions.filter(item => item.httpETag?.startsWith("W/") && item.documentETag).length, toolDeltas, legacyDataCalls: 0 }
  })
  assert.deepEqual(pageErrors, [], "No browser runtime errors")
  console.log(`PASS ${reports.length} ${config.environment ?? "live"} MCP authoring scenarios; dashboard ${dashboardId}`)
} catch (error) {
  console.error(error.stack ?? error.message); process.exitCode = 1
} finally {
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "report.json"), JSON.stringify({ timestamp: new Date().toISOString(), environment: config.environment ?? "live", dashboardURL: `${baseURL}/dashboard/insights/?dashboard=${dashboardId}`, range: fixedRange, documents, reports, pageErrors, versions, toolUsageBefore, toolUsageAfter, protocol, queries: responses.map(({ status, request, body }) => ({ status, providerId: request.providerId, kind: request.kind, query: request.query, start: request.start, end: request.end, step: request.step, series: body.series?.length, samples: body.series?.[0]?.points?.length, latest: body.series?.[0]?.points?.at(-1), traces: body.traces?.length })) }, null, 2))
  await context?.close(); await browser?.close()
}
