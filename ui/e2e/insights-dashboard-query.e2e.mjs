// MCP -> authenticated Insights -> Observe MCP -> native telemetry, compared to
// the real browser renderer. Only Kubernetes and telemetry are fixtures.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), "paprika-dashboard-query-"))
const output = join(repository, "artifacts/insights/dashboard-query")
const binary = join(temporary, "fixture"), ready = join(temporary, "ready.json")
const services = ["api-gateway", "release-controller"]
const range = { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }
const reports = [], responses = [], pageErrors = [], browserWrites = []
let fixture, child, browser, page, context, rpcID = 0, fixtureLog = "", dashboard, saved, versions

async function until(predicate, message, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 60))
  }
  throw new Error(message)
}
async function api(path, token = fixture.token) {
  const response = await fetch(`${fixture.baseURL}/api/insights/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200)
  return { document: await response.json(), etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") }
}
async function rpc(method, params, token = fixture.mcpViewerToken) {
  const id = ++rpcID
  const response = await fetch(fixture.mcpURL, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200)
  const text = await response.text()
  return response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === id)
    : JSON.parse(text)
}
async function tool(name, args, token) {
  const envelope = await rpc("tools/call", { name, arguments: args }, token)
  assert.equal(envelope.error, undefined, JSON.stringify(envelope.error))
  assert.notEqual(envelope.result?.isError, true, JSON.stringify(envelope.result?.content))
  assert.ok(envelope.result.structuredContent, "Machine reads require structured content")
  return envelope.result
}
async function query(args = {}, token) {
  return tool("query_dashboard", { id: dashboard.id, ...args }, token)
}
async function protocol() {
  const receipt = await (await fetch(`${fixture.baseURL}/__test/requests`)).json()
  return { queries: receipt.queries ?? [], gateway: receipt.gateway ?? [] }
}
function signal(result, widgetID) {
  const widget = result.widgets.find(item => item.id === widgetID)
  assert.ok(widget)
  return result.signals.find(item => item.id === widget.signalId)
}
async function check(name, action) {
  try { const evidence = await action(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) { reports.push({ name, passed: false, error: error.message }); throw error }
}
async function documentVersions() {
  return Promise.all([api(`dashboards/${dashboard.id}`), ...saved.map(q => api(`saved-queries/${q.id}`))])
}
async function showService(service) {
  const filter = page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: "Service", exact: true })
  await selectGammaOption(page, filter, service)
  const expected = service === services[0] ? 101.2345 : 202.3456
  await until(async () => Number(await page.locator('[data-widget-id="rate"] [data-metric-value]').getAttribute("data-metric-value").catch(() => null)) === expected, "The dashboard must render the selected service")
}

try {
  await mkdir(output, { recursive: true })
  const build = spawn("go", ["build", "-o", binary, "./hack/insights-observe-e2e"], { cwd: repository, stdio: "inherit" })
  assert.equal((await once(build, "exit"))[0], 0)
  child = spawn(binary, [`--ready-file=${ready}`, `--ui-dir=${join(repository, "ui/out")}`, `--data-dir=${join(temporary, "data")}`, ...(process.env.INSIGHTS_E2E_URL ? [`--ui-url=${process.env.INSIGHTS_E2E_URL}`] : [])], { cwd: repository, stdio: ["ignore", "pipe", "pipe"] })
  child.stdout.on("data", data => { fixtureLog += data })
  child.stderr.on("data", data => { fixtureLog += data })
  await until(async () => {
    if (child.exitCode !== null) throw new Error("Fixture exited before readiness")
    try { fixture = JSON.parse(await readFile(ready, "utf8")); return true } catch { return false }
  }, "Fixture did not become ready")
  const providers = (await api("providers")).document.providers
  const metric = providers.find(p => p.providerRef === fixture.providerRef), trace = providers.find(p => p.providerRef === fixture.traceProviderRef)
  assert.ok(metric && trace)
  const template = "sum(rate(dense_http_requests_total{service={{service}}}[5m]))"
  const parameters = [{ name: "service", type: "string", defaultValue: services[0] }]
  saved = [
    { schemaVersion: 1, id: "machine-rate", name: "Request rate", providerId: metric.id, kind: "metrics", query: template, parameters },
    { schemaVersion: 1, id: "machine-double", name: "Second signal", providerId: metric.id, kind: "metrics", query: `${template} * 2`, parameters },
    { schemaVersion: 1, id: "machine-traces", name: "Service traces", providerId: trace.id, kind: "traces", query: "{ resource.service.name = {{service}} }", parameters },
  ]
  for (const document of saved) await tool("create_saved_query", { document }, fixture.mcpWriteToken)
  const widget = (id, type, query, index) => ({ id, title: id, type, providerId: query.providerId, query: "dormant_must_not_execute", queryRef: { id: query.id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, unit: type === "traces" ? "ms" : "req/s", options: { decimals: 2, ...(type === "stat" ? { showSparkline: true } : {}) }, layout: { x: (index % 2) * 6, y: Math.floor(index / 2) * 4, w: 6, h: 4 } })
  dashboard = { schemaVersion: 1, id: "machine-dashboard", title: "Machine readable service overview", timeRange: "1h", customTimeRange: range, refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: services[0], options: services }], widgets: [widget("rate", "stat", saved[0], 0), widget("trend", "timeseries", saved[0], 1), widget("second", "stat", saved[1], 2), widget("traces", "traces", saved[2], 3)] }
  await tool("create_dashboard", { document: dashboard }, fixture.mcpWriteToken)
  versions = await documentVersions()

  await check("Read-only MCP advertises and executes the saved dashboard without authoring consent", async () => {
    const listing = await rpc("tools/list", {})
    const listed = listing.result.tools.find(t => t.name === "query_dashboard")
    assert.equal(listed?.annotations.readOnlyHint, true)
    assert.equal(listed.outputSchema.type, "object")
    const before = await protocol()
    const result = (await query()).structuredContent
    const after = await protocol()
    const calls = after.queries.slice(before.queries.length).filter(r => ["/api/v1/query_range", "/api/search"].includes(r.path))
    assert.equal(result.state, "ok")
    assert.equal(result.variables.service, services[0])
    assert.equal(result.signals.length, 3)
    assert.equal(result.widgets.length, 4)
    assert.equal(result.queryCount.executed, 3)
    assert.equal(result.queryCount.deduplicated, 1)
    assert.equal(calls.length, 3, "The stat and graph must share one provider execution")
    assert.equal(signal(result, "rate").id, signal(result, "trend").id)
    assert.equal(result.dashboard.etag, versions[0].etag)
    assert.deepEqual(new Map(result.savedQueries.map(q => [q.id, q.etag])), new Map(saved.map((q, index) => [q.id, versions[index + 1].etag])))
    assert.ok(!JSON.stringify(result).includes("dormant_must_not_execute"))
    return { widgets: result.widgets.length, executed: calls.length, deduplicated: result.queryCount.deduplicated }
  })

  browser = await chromium.launch({ headless: true })
  context = await browser.newContext({ viewport: { width: 1512, height: 1000 }, timezoneId: "UTC", locale: "en-US" })
  await context.addInitScript(token => localStorage.setItem("paprika_id_token", token), fixture.token)
  page = await context.newPage(); page.setDefaultTimeout(30_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("response", response => {
    if (new URL(response.url()).pathname === "/api/insights/query") void response.json().then(body => responses.push({ request: JSON.parse(response.request().postData()), body })).catch(() => {})
  })
  page.on("request", request => {
    if (/^\/api\/insights\/(dashboards|saved-queries)(\/|$)/.test(new URL(request.url()).pathname) && !["GET", "HEAD"].includes(request.method())) browserWrites.push(request.method())
  })
  await page.goto(`${fixture.baseURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "domcontentloaded" })
  await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor()
  await check("Compact machine signals match UI readings, sparklines and traces for both services", async () => {
    const evidence = []
    for (const service of services) {
      await showService(service)
      const toolResult = await query({ variables: { service } }), result = toolResult.structuredContent
      assert.equal(result.variables.service, service)
      let rawBytes = 0
      for (const [id, source] of [["rate", saved[0]], ["second", saved[1]]]) {
        const queryText = source.query.replace("{{service}}", JSON.stringify(service))
        await until(() => responses.some(r => r.request.query === queryText), "Missing UI provider response")
        const raw = responses.findLast(r => r.request.query === queryText).body
        rawBytes += Buffer.byteLength(JSON.stringify(raw))
        const points = raw.series[0].points, summary = signal(result, id).series[0]
        assert.equal(summary.last.value, points.at(-1).value)
        assert.equal(summary.last.timestamp, points.at(-1).timestamp)
        assert.equal(summary.samples, 301)
        assert.equal(summary.valid, 301)
        assert.equal(summary.missing, 0)
        assert.equal(summary.min, Math.min(...points.map(p => p.value)))
        assert.equal(summary.max, Math.max(...points.map(p => p.value)))
        assert.equal(summary.history, undefined, "History must be opt-in")
        const tile = page.locator(`[data-widget-id="${id}"]`)
        assert.equal(Number(await tile.locator("[data-metric-value]").getAttribute("data-metric-value")), summary.last.value)
        assert.equal(Number(await tile.locator("[data-stat-sparkline]").getAttribute("data-sample-count")), summary.samples)
        assert.equal(result.widgets.find(w => w.id === id).decimals, 2)
      }
      const traces = signal(result, "traces").traces
      assert.equal(traces.returned, 1)
      assert.equal(traces.examples[0].service, service)
      assert.equal(traces.statusCounts.unknown, 1)
      const compactBytes = Buffer.byteLength(JSON.stringify(toolResult))
      assert.ok(compactBytes < rawBytes / 2, `Compact envelope ${compactBytes} should be less than half of raw metrics ${rawBytes}`)
      const text = toolResult.content.filter(c => c.type === "text").map(c => c.text).join("\n")
      assert.ok(text.length < JSON.stringify(result).length, "Text must not duplicate the full JSON payload")
      evidence.push({ service, rawMetricBytes: rawBytes, compactMCPBytes: compactBytes, reductionPercent: Math.round(100 * (1 - compactBytes / rawBytes)) })
      await writeFile(join(output, `${service}-snapshot.json`), JSON.stringify(toolResult, null, 2))
    }
    return evidence
  })
  await check("Widget drilldown returns bounded history and explicit time overrides", async () => {
    const args = { widget_ids: ["rate"], history_points: 12, start: "2026-10-20T11:00:00Z", end: "2026-10-20T12:00:00Z" }
    const result = (await query(args)).structuredContent
    assert.equal(result.widgets.length, 1)
    assert.equal(result.queryCount.executed, 1)
    assert.equal(Date.parse(result.range.start), Date.parse(args.start))
    assert.equal(Date.parse(result.range.end), Date.parse(args.end))
    const series = result.signals[0].series[0]
    assert.ok(series.history.length <= 12 && series.history.length >= 2)
    assert.equal(series.history.at(-1)[0], series.last.timestamp)
    assert.equal(Math.min(...series.history.map(p => p[1])), series.min)
    assert.equal(Math.max(...series.history.map(p => p[1])), series.max)
    return { returnedPoints: series.history.length, underlyingSamples: series.samples }
  })
  await check("Missing telemetry, broken references and provider failures remain explicit", async () => {
    const empty = (await query({ variables: { service: "no-telemetry" } })).structuredContent
    assert.ok(empty.signals.every(s => s.state === "empty"))
    const broken = structuredClone(dashboard)
    broken.id = "machine-partial"
    broken.widgets.push({ ...structuredClone(dashboard.widgets[0]), id: "missing", queryRef: { id: "does-not-exist" } })
    const failing = { ...structuredClone(dashboard.widgets[0]), id: "failure", query: "unavailable_fixture_metric" }
    delete failing.queryRef
    broken.widgets.push(failing)
    await tool("create_dashboard", { document: broken }, fixture.mcpWriteToken)
    const result = (await tool("query_dashboard", { id: broken.id }, fixture.mcpViewerToken)).structuredContent
    assert.equal(result.state, "partial")
    assert.ok(result.widgets.find(w => w.id === "missing").error)
    assert.equal(signal(result, "failure").state, "error")
    assert.equal(signal(result, "rate").state, "ok")
    const receipts = await protocol()
    assert.ok(receipts.queries.every(q => !q.query.includes("dormant_must_not_execute")))
    assert.ok(!JSON.stringify(result).includes("simulated upstream unavailable"))
    return { emptySignals: empty.signals.length, partialState: result.state, dormantFallbackExecuted: false }
  })
  await check("Insights and provider RBAC stay independent from dashboard read scope", async () => {
    const denied = await rpc("tools/call", { name: "query_dashboard", arguments: { id: dashboard.id } }, fixture.mcpNoInsightsToken)
    assert.ok(denied.error || denied.result?.isError)
    const providersDenied = (await query({}, fixture.mcpDeniedProviderToken)).structuredContent
    assert.equal(providersDenied.state, "partial")
    assert.ok(providersDenied.signals.every(s => s.state === "error"))
    return { insightsDenied: true, providerDataDenied: true }
  })
  await check("Machine reads and UI filters preserve saved versions and use actual Observe MCP", async () => {
    assert.deepEqual(await documentVersions(), versions)
    assert.deepEqual(browserWrites, [])
    assert.deepEqual(pageErrors, [])
    const receipts = await protocol()
    assert.ok(receipts.gateway.some(r => r.tool === "query_dashboard"))
    for (const name of ["query_metrics", "query_traces"]) assert.ok(receipts.gateway.some(r => r.tool === name))
    assert.ok(!receipts.gateway.some(r => ["/observe/api/query", "/observe/api/providers", "/observe/api/explore"].includes(r.path)))
    return { unchangedDocuments: versions.length, browserWrites: 0, legacyDataCalls: 0 }
  })
  await check("The reusable live validator checks the same read-only contract", async () => {
    const tokenFile = join(temporary, "console.token"), mcpTokenFile = join(temporary, "observe.token"), configFile = join(temporary, "live-config.json")
    await writeFile(tokenFile, fixture.token, { mode: 0o600 })
    await writeFile(mcpTokenFile, fixture.mcpViewerToken, { mode: 0o600 })
    await writeFile(configFile, JSON.stringify({ baseURL: fixture.baseURL, mcpURL: fixture.mcpURL, tokenFile, mcpTokenFile, dashboardId: dashboard.id, services: [...services, "no-telemetry"], outputDir: join(output, "live-validator") }), { mode: 0o600 })
    const validator = spawn(process.execPath, [join(repository, "ui/e2e/insights-dashboard-query-live.e2e.mjs")], { cwd: repository, env: { ...process.env, INSIGHTS_SERVICE_OVERVIEW_CONFIG: configFile }, stdio: "inherit" })
    assert.equal((await once(validator, "exit"))[0], 0)
    return { reusableLiveValidator: "passed" }
  })
  await page.screenshot({ path: join(output, "dashboard.png"), fullPage: false })
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1 }
finally {
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "report.json"), JSON.stringify({ timestamp: new Date().toISOString(), reports, pageErrors, browserWrites }, null, 2))
  await browser?.close()
  if (child && child.exitCode === null) {
    const ended = once(child, "exit"); child.kill("SIGTERM")
    const force = setTimeout(() => child.kill("SIGKILL"), 5000); await ended; clearTimeout(force)
  }
  if (process.exitCode) await writeFile(join(output, "fixture.log"), fixtureLog)
  await rm(temporary, { recursive: true, force: true })
}
