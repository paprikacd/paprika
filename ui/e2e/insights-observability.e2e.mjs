// Exercises the authenticated API -> Insights -> Observe MCP tools ->
// real connector path. Only the Kubernetes client and upstream telemetry are
// deterministic fixtures; HTTP auth, saved storage, MCP and the UI are real.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { assertMetricCall, assertObserveMCP, readObserveProtocol } from "./observe-protocol.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), "paprika-observe-e2e-"))
const output = join(repository, "artifacts/insights/observability")
const reports = [], pageErrors = [], responses = []
const services = ["api-gateway", "release-controller"]
const readings = [101.2345, 202.3456]
const template = "sum(rate(http_requests_total{service={{service}}}[5m]))"
const fixedRange = { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }
let fixture, processHandle, browser, context, page, outputLog = "", metricProvider, traceProvider
let sessionId, rpcId = 0, protocol
async function until(predicate, message, timeout = 20000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)) }
  throw new Error(message)
}
async function request(path, { method = "GET", document, token = fixture.token, headers = {} } = {}) {
  return fetch(`${fixture.baseURL}/api/insights/${path}`, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers }, ...(document === undefined ? {} : { body: JSON.stringify(document) }) })
}
async function api(path, options) {
  const response = await request(path, options), text = await response.text()
  assert.ok(response.ok, `${path}: ${response.status} ${text}`)
  return { document: text ? JSON.parse(text) : undefined, etag: response.headers.get("etag") }
}
async function rpc(method, params, token = fixture.mcpToken) {
  const response = await fetch(fixture.mcpURL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-03-26", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) })
  assert.ok(response.ok, `MCP ${method}: ${response.status}`)
  sessionId = response.headers.get("Mcp-Session-Id") ?? sessionId
  const text = await response.text()
  const body = response.headers.get("content-type")?.includes("text/event-stream") ? JSON.parse(text.split("\n").find(line => line.startsWith("data: ")).slice(6)) : JSON.parse(text)
  assert.equal(body.error, undefined, `MCP ${method}: ${JSON.stringify(body.error)}`)
  return body.result
}
async function check(name, fn) {
  try { const evidence = await fn(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) { reports.push({ name, passed: false, error: error.message, stack: error.stack }); await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {}); throw error }
}
const explorer = () => page.getByRole("region", { name: "Data source explorer", exact: true })
const results = () => page.getByRole("region", { name: "Explore query results", exact: true })
const tile = () => page.locator('[data-widget-id="selected-service"]')
async function openNavigation() {
  const nav = page.locator("#insights-navigation")
  if (!await nav.isVisible()) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
  return nav
}
async function openExplorer() {
  const nav = await openNavigation()
  await nav.getByRole("button", { name: /^Explore\b/ }).click()
  await explorer().getByRole("heading", { name: "Explore", exact: true }).waitFor()
}
async function showService(service) {
  const value = readings[services.indexOf(service)]
  await until(async () => await tile().locator("[data-metric-value]").getAttribute("data-metric-value").catch(() => null) === String(value), `Service ${service} did not render ${value}`)
  const displayed = (await tile().locator("[data-metric-value]").innerText()).replace(/\s+/g, "")
  assert.equal(displayed, `${value.toFixed(2)}req/s`)
  const sparkline = tile().locator("[data-stat-sparkline]")
  assert.equal(await sparkline.getAttribute("data-sample-count"), "4")
  assert.equal(await sparkline.locator("[data-stat-trend]").count(), 1)
  assert.ok(await sparkline.locator("[data-stat-area]").count() > 0)
  return { displayed, path: await sparkline.locator("[data-stat-trend]").getAttribute("d") }
}
async function showServiceTooltip(service, width, theme) {
  const health = page.locator('[data-widget-id="service-health"]')
  const cell = health.getByRole("group").getByRole("button").first()
  await health.scrollIntoViewIfNeeded()
  if (width < 600) await cell.tap(); else await cell.hover()
  const tooltip = page.getByRole("tooltip")
  await tooltip.waitFor()
  const expected = readings[services.indexOf(service)] * 2
  const value = tooltip.locator('[data-tooltip-widget="stat"] [data-metric-value]')
  await until(async () => Number(await value.getAttribute("data-metric-value").catch(() => NaN)) === expected, "Hovered service label did not resolve through the saved tooltip query")
  assert.equal((await value.innerText()).replace(/\s+/g, ""), `${expected.toFixed(2)}req/s`)
  assert.equal(await tooltip.locator("[data-stat-sparkline]").getAttribute("data-sample-count"), "4")
  const calls = assertObserveMCP(await readObserveProtocol(fixture.baseURL), ["query_metrics"])
  const query = `${template.replace("{{service}}", JSON.stringify(service))} * 2`
  const args = assertMetricCall(calls, { provider: fixture.providerRef, query, from: fixedRange.from, to: fixedRange.to, step: 12 })
  await page.screenshot({ path: join(output, `tooltip-${theme.toLowerCase()}-${width}.png`), fullPage: false })
  await page.keyboard.press("Escape"); await tooltip.waitFor({ state: "hidden" })
  return { value: expected, samples: 4, hoveredService: service, mcpArguments: args }
}
async function open(width) {
  await context?.close()
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 960 }, reducedMotion: "reduce", colorScheme: "light", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  await context.addInitScript(token => localStorage.setItem("paprika_id_token", token), fixture.token)
  page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("response", response => { if (/\/api\/insights\/query$/.test(response.url())) void response.json().then(body => responses.push({ status: response.status(), request: JSON.parse(response.request().postData() || "{}"), body })).catch(() => {}) })
  await page.goto(`${fixture.baseURL}/dashboard/insights/?dashboard=observe-flow`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: "Shared observability flow", exact: true }).waitFor()
  assert.equal(await page.locator("[data-dashboard-shell-content]").count(), 0, "The dedicated workspace must not be nested in a second dashboard shell")
  await showService(services[0])
}
async function complete(field, prefix, name) {
  await field.fill(prefix); await field.press("End"); await field.press("Control+Space")
  const popup = page.locator(".cm-tooltip-autocomplete")
  await popup.getByRole("option").filter({ has: page.locator(".cm-completionLabel").filter({ hasText: name }) }).first().waitFor()
  const count = await popup.getByRole("option").count()
  for (let i = 0; i <= count; i++) {
    const selected = popup.getByRole("option", { selected: true })
    if (await selected.count() && name.test(await selected.locator(".cm-completionLabel").innerText())) break
    await field.press("ArrowDown")
  }
  await field.press("Enter"); await popup.waitFor({ state: "hidden" })
}
try {
  await mkdir(output, { recursive: true })
  if (process.env.INSIGHTS_OBSERVE_FIXTURE) fixture = JSON.parse(await readFile(process.env.INSIGHTS_OBSERVE_FIXTURE, "utf8"))
  else {
    const binary = join(temporary, "observe-e2e"), ready = join(temporary, "ready.json")
    const build = spawn("rtk", ["proxy", "go", "build", "-o", binary, "./hack/insights-observe-e2e"], { cwd: repository, stdio: "inherit" })
    assert.equal((await once(build, "exit"))[0], 0, "Integration harness must build")
    processHandle = spawn(binary, [`--ready-file=${ready}`, `--ui-dir=${join(repository, "ui/out")}`, `--data-dir=${join(temporary, "data")}`, ...(process.env.INSIGHTS_E2E_URL ? [`--ui-url=${process.env.INSIGHTS_E2E_URL}`] : [])], { cwd: repository, stdio: ["ignore", "pipe", "pipe"] })
    processHandle.stdout.on("data", data => { outputLog += data }); processHandle.stderr.on("data", data => { outputLog += data })
    await until(async () => { try { fixture = JSON.parse(await readFile(ready, "utf8")); return true } catch { return false } }, `Harness did not become ready: ${outputLog}`, 30000)
  }
  await check("Authorized provider discovery shares the MCP registry without local connection configuration", async () => {
    assert.ok(fixture.viewerToken, "Connection discovery must also be tested as an Insights read-only caller")
    const connection = (await api("observe-connection", { token: fixture.viewerToken })).document
    assert.equal(connection.configured, true); assert.equal(connection.connected, true)
    assert.equal(connection.transport, "mcp"); assert.equal(connection.providerCount, 2)
    for (const name of ["list_observability_providers", "query_metrics", "query_traces", "list_metric_series"]) assert.ok(connection.tools.some(tool => tool.name === name))
    const connectionReceipts = await readObserveProtocol(fixture.baseURL)
    assert.ok(connectionReceipts.gateway.some(item => ["initialize", "server/discover"].includes(item.method)), "Connection discovery must negotiate the MCP protocol")
    assert.ok(connectionReceipts.gateway.some(item => item.method === "tools/list"), "Connection discovery must enumerate actual MCP tools")
    const providers = (await api("providers")).document.providers
    metricProvider = providers.find(item => item.providerRef === fixture.providerRef)
    traceProvider = providers.find(item => item.providerRef === fixture.traceProviderRef)
    assert.ok(metricProvider && traceProvider, JSON.stringify(providers))
    assert.equal(metricProvider.source, "observability"); assert.equal(traceProvider.source, "observability")
    assert.equal(metricProvider.type, "prometheus"); assert.equal(traceProvider.type, "tempo")
    assert.match(metricProvider.id, /^observe-[a-f0-9]{64}$/)
    assert.deepEqual(providers.map(item => item.providerRef).sort(), [fixture.providerRef, fixture.traceProviderRef].sort(), "Namespace-scoped discovery must hide restricted providers")
    assert.deepEqual((await api("provider-configs")).document.providers, [])
    assert.ok(providers.every(item => !Object.hasOwn(item, "url") && !Object.hasOwn(item, "credentials")))
    assertObserveMCP(await readObserveProtocol(fixture.baseURL), ["list_observability_providers"])
    return { providers: providers.map(({ id, providerRef, type }) => ({ id, providerRef, type })), connection: { transport: connection.transport, providerCount: connection.providerCount, toolCount: connection.tools.length, readOnlyCaller: true } }
  })
  const saved = { schemaVersion: 1, id: "observe-service-rate", name: "Shared service request rate", description: "One saved query for dashboards and service filters.", tags: ["service", "request-rate"], providerId: metricProvider.id, kind: "metrics", query: template, parameters: [{ name: "service", type: "string", defaultValue: services[0] }] }
  const tooltipQuery = { ...saved, id: "observe-service-tooltip", name: "Hovered service detail", query: `${template} * 2` }
  const dashboard = { schemaVersion: 1, id: "observe-flow", title: "Shared observability flow", timeRange: "1h", customTimeRange: fixedRange, refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: services[0], options: services }], widgets: [
    { id: "selected-service", title: "Selected service request rate", type: "stat", providerId: metricProvider.id, query: "must_not_execute", queryRef: { id: saved.id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, unit: "req/s", options: { decimals: 2, showSparkline: true }, layout: { x: 0, y: 0, w: 6, h: 3 } },
    { id: "service-health", title: "Service detail", type: "heatmap", providerId: metricProvider.id, query: "must_not_execute", queryRef: { id: saved.id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, unit: "req/s", options: { showTooltip: true, decimals: 2, tooltipView: { type: "stat", title: "Hovered service detail", unit: "req/s", decimals: 2, showSparkline: true, source: { type: "saved", ref: { id: tooltipQuery.id, bindings: [{ parameter: "service", source: "label", label: "service" }] } } } }, layout: { x: 6, y: 0, w: 6, h: 3 } },
  ] }
  await api(`saved-queries/${saved.id}`, { method: "PUT", document: saved, headers: { "If-None-Match": "*" } })
  await api(`saved-queries/${tooltipQuery.id}`, { method: "PUT", document: tooltipQuery, headers: { "If-None-Match": "*" } })
  const persisted = await api(`dashboards/${dashboard.id}`, { method: "PUT", document: dashboard, headers: { "If-None-Match": "*" } })
  await check("Namespace denial cannot discover or execute the shared provider", async () => {
    const before = ((await (await fetch(`${fixture.baseURL}/__test/requests`)).json()).queries ?? []).length
    const providers = await request("providers", { token: fixture.deniedToken })
    if (providers.ok) assert.equal((await providers.json()).providers.some(item => item.id === metricProvider.id), false)
    else assert.equal(providers.status, 403)
    const response = await request("query", { method: "POST", token: fixture.deniedToken, document: { providerId: metricProvider.id, kind: "metrics", query: "up", start: Date.parse(fixedRange.from) / 1000, end: Date.parse(fixedRange.to) / 1000, step: 60 } })
    assert.ok([403, 404].includes(response.status), `Unauthorized query returned ${response.status}`)
    const after = ((await (await fetch(`${fixture.baseURL}/__test/requests`)).json()).queries ?? []).length
    assert.equal(after, before, "Denied requests must never contact an upstream provider")
    return { queryStatus: response.status, upstreamRequests: after - before }
  })
  browser = await chromium.launch({ headless: true })
  for (const width of [1512, 390]) {
    await open(width)
    for (const theme of ["Light", "Dark"]) {
      await check(`${theme} service filter updates saved query, two-decimal value and sparkline at ${width}px`, async () => {
        await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
        const filter = page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: "Service", exact: true })
        await selectGammaOption(page, filter, services[0]); const before = await showService(services[0])
        await selectGammaOption(page, filter, services[1]); const after = await showService(services[1])
        assert.notEqual(before.path, after.path, "Service selection must change the plotted history")
        assert.equal((await api(`dashboards/${dashboard.id}`)).etag, persisted.etag, "Filtering must not persist dashboard defaults")
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
        await page.screenshot({ path: join(output, `service-${theme.toLowerCase()}-${width}.png`), fullPage: false })
        const tooltip = await showServiceTooltip(services[1], width, theme)
        return { before, after, tooltip, savedDefaultUnchanged: true }
      })
    }
  }
  await open(1512)
  await check("The MCP connection exposes discovered tools and opens a shared provider in Explore", async () => {
    const nav = await openNavigation(); await nav.getByRole("button", { name: /^Data sources\b/ }).click()
    const panel = page.getByRole("region", { name: "Data sources", exact: true })
    const card = panel.getByRole("article").filter({ hasText: fixture.providerRef })
    const connection = panel.getByRole("region", { name: "Paprika Observe MCP", exact: true })
    await connection.getByRole("status").filter({ hasText: /^Connected\b/ }).waitFor()
    await connection.getByRole("button", { name: "Refresh connection and providers", exact: true }).click()
    await connection.getByRole("status").filter({ hasText: /^Connected\b/ }).waitFor()
    await connection.getByRole("button", { name: /Discovered MCP tools/ }).click()
    for (const name of ["list_observability_providers", "query_metrics", "query_traces", "list_metric_series"]) await connection.getByText(name, { exact: true }).waitFor()
    assert.equal(await card.getByRole("button", { name: "Edit", exact: true }).count(), 0)
    assert.equal(await card.getByRole("button", { name: /^Remove/ }).count(), 0)
    assert.match(await card.getByRole("link", { name: "Manage in Observability" }).getAttribute("href"), /\/dashboard\/observability\/?$/)
    await card.getByRole("button", { name: "Test connection", exact: true }).click()
    await panel.getByRole("status").filter({ hasText: /Connected|succeeded|available/i }).waitFor()
    await page.screenshot({ path: join(output, "shared-data-sources.png"), fullPage: false })
    await card.getByRole("button", { name: `Explore ${metricProvider.name}`, exact: true }).click()
    await explorer().getByRole("heading", { name: "Explore", exact: true }).waitFor()
    await explorer().getByText("Paprika Observe MCP", { exact: true }).waitFor()
    await explorer().getByText("query_metrics", { exact: true }).waitFor()
    return { credentialsCopied: false, editControls: false, connected: true, discoveredTools: true, exploredProvider: metricProvider.providerRef }
  })
  await check("PromQL completion and saved-query execution use shared provider metadata", async () => {
    await openExplorer()
    await selectGammaOption(page, explorer().getByRole("combobox", { name: "Open saved query", exact: true }), /Shared service request rate/)
    await explorer().getByRole("tab", { name: "Code", exact: true }).click()
    const field = explorer().getByRole("textbox", { name: /^PromQL query/ })
    const before = responses.length
    await complete(field, "http_", /^http_requests_total\b/)
    await complete(field, "http_requests_total{ser", /^service\b/)
    await complete(field, 'http_requests_total{service="api', /^api-gateway\b/)
    assert.equal(responses.length, before, "Metadata completion must not execute a query")
    await field.fill(template)
    await results().getByLabel("Test value for service", { exact: true }).fill(services[1])
    await explorer().getByRole("button", { name: "Run query", exact: true }).click()
    const exact = template.replace("{{service}}", JSON.stringify(services[1]))
    await until(() => responses.some(item => item.status === 200 && item.request.providerId === metricProvider.id && item.request.query === exact), "Shared PromQL execution did not resolve the service parameter")
    await results().getByRole("img", { name: saved.name, exact: true }).waitFor()
    const metadata = (await api(`providers/${metricProvider.id}/metadata?kind=series&metric=http_requests_total`)).document
    assert.ok(metadata.series.count >= 2)
    assert.ok(metadata.series.labels.some(label => label.name === "service" && label.cardinality >= 2))
    await page.screenshot({ path: join(output, "shared-promql-editor.png"), fullPage: false })
    const calls = assertObserveMCP(await readObserveProtocol(fixture.baseURL), ["list_metric_names", "list_label_names", "list_label_values", "list_metric_series"])
    const seriesCall = calls.findLast(item => item.tool === "list_metric_series" && item.arguments?.provider === fixture.providerRef && item.arguments.metric === "http_requests_total")
    assert.ok(seriesCall && Date.parse(seriesCall.arguments.start) < Date.parse(seriesCall.arguments.end))
    assert.equal(seriesCall.arguments.limit, 1000)
    return { resolved: exact, series: metadata.series.count, mcpSeriesArguments: seriesCall.arguments }
  })
  await check("Metric inspection shows shared series cardinality and creates a label filter", async () => {
    await explorer().getByRole("tab", { name: "Builder", exact: true }).click()
    await explorer().getByRole("combobox", { name: "Metric", exact: true }).fill("http_requests_total")
    await page.getByRole("option", { name: "http_requests_total", exact: true }).click()
    await explorer().getByRole("button", { name: "Inspect metric", exact: true }).click()
    const inspector = page.getByRole("dialog", { name: "http_requests_total", exact: true })
    await until(async () => /2\s+Stored series/.test(await inspector.innerText()), "Stored series count did not arrive from Observe")
    assert.match(await inspector.innerText(), /service\s+2/)
    assert.equal(await inspector.getByText(/Cardinality unavailable/).count(), 0)
    await inspector.locator("summary").filter({ hasText: "service" }).click()
    await page.screenshot({ path: join(output, "shared-metric-cardinality.png"), fullPage: false })
    await inspector.getByRole("button", { name: 'Filter service = "api-gateway"', exact: true }).click()
    await inspector.waitFor({ state: "hidden" })
    assert.equal(await explorer().getByRole("combobox", { name: "Filter 1 label", exact: true }).inputValue(), "service")
    // The generated draft remains unapplied so changing provider does not modify
    // the existing saved template during this inspection.
    await explorer().getByRole("tab", { name: "Code", exact: true }).click()
    return { storedSeries: 2, serviceCardinality: 2, filter: services[0] }
  })
  await check("TraceQL completion and search use the shared Tempo connector", async () => {
    await selectGammaOption(page, explorer().getByRole("combobox", { name: "Explore data source", exact: true }), traceProvider.name)
    const field = explorer().getByRole("textbox", { name: /^TraceQL query/ })
    await field.waitFor()
    await complete(field, "{ resource.ser", /^resource\.service\.name\b/)
    const query = '{ resource.service.name = "api-gateway" }'
    await field.fill(query)
    await explorer().getByRole("button", { name: "Run query", exact: true }).click()
    await results().getByText("GET /api/orders", { exact: true }).waitFor()
    assert.ok(responses.some(item => item.status === 200 && item.request.providerId === traceProvider.id && item.request.query === query && item.body.traces?.some(trace => trace.service === "api-gateway")))
    await page.screenshot({ path: join(output, "shared-traceql-editor.png"), fullPage: false })
    const calls = assertObserveMCP(await readObserveProtocol(fixture.baseURL), ["query_traces"])
    const queryCall = calls.findLast(item => item.tool === "query_traces" && item.arguments?.provider === fixture.traceProviderRef && item.arguments.query === query)
    assert.ok(queryCall && Date.parse(queryCall.arguments.start) < Date.parse(queryCall.arguments.end))
    return { provider: traceProvider.providerRef, query, mcpArguments: queryCall.arguments }
  })
  await check("MCP and dashboard queries return the same samples for the same provider, range and step", async () => {
    await rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "paprika-insights-e2e", version: "1" } })
    const listed = await rpc("tools/call", { name: "list_observability_providers", arguments: {} })
    assert.notEqual(listed.isError, true)
    const registry = listed.structuredContent ?? JSON.parse(listed.content.find(item => item.type === "text").text)
    assert.deepEqual(registry.providers.map(provider => provider.name).sort(), [fixture.providerRef, fixture.traceProviderRef].sort(), "MCP and dashboard discovery must enforce the same namespace visibility")
    const query = template.replace("{{service}}", JSON.stringify(services[1]))
    const start = Date.parse(fixedRange.from) / 1000, end = Date.parse(fixedRange.to) / 1000
    const dashboardResult = (await api("query", { method: "POST", document: { providerId: metricProvider.id, kind: "metrics", query, start, end, step: 60 } })).document
    const uiCalls = assertObserveMCP(await readObserveProtocol(fixture.baseURL), ["query_metrics"])
    assertMetricCall(uiCalls, { provider: fixture.providerRef, query, from: fixedRange.from, to: fixedRange.to, step: 60 })
    const call = await rpc("tools/call", { name: "query_metrics", arguments: { provider: fixture.providerRef, query, start: fixedRange.from, end: fixedRange.to, step_seconds: 60 } })
    assert.notEqual(call.isError, true)
    const structured = call.structuredContent ?? JSON.parse(call.content.find(item => item.type === "text").text)
    const native = structured.data?.data?.result ?? structured.data?.result
    assert.ok(native?.length, JSON.stringify(structured))
    assert.deepEqual(dashboardResult.series[0].points, native[0].values.map(([timestamp, value]) => ({ timestamp: timestamp * 1000, value: Number(value) })))
    return { samples: dashboardResult.series[0].points.length, sharedProvider: fixture.providerRef }
  })
  assert.deepEqual(pageErrors, [], "No browser runtime errors")
  protocol = await readObserveProtocol(fixture.baseURL)
  assertObserveMCP(protocol, ["list_observability_providers", "query_metrics", "query_traces", "list_metric_names", "list_label_names", "list_label_values", "list_metric_series"])
  console.log(`PASS ${reports.length} observability integration scenarios`)
} catch (error) { console.error(error); if (outputLog) console.error(outputLog); process.exitCode = 1 }
finally {
  if (fixture?.baseURL) protocol = await readObserveProtocol(fixture.baseURL).catch(() => protocol)
  await writeFile(join(output, "report.json"), JSON.stringify({ reports, pageErrors, protocol, queries: responses.map(({ status, request }) => ({ status, request })) }, null, 2)).catch(() => {})
  await context?.close(); await browser?.close()
  if (processHandle && processHandle.exitCode === null && processHandle.signalCode === null) {
    const exited = once(processHandle, "exit"); processHandle.kill("SIGTERM")
    const timer = setTimeout(() => processHandle.kill("SIGKILL"), 5000); await exited; clearTimeout(timer)
  }
  await rm(temporary, { recursive: true, force: true })
}
