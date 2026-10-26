import { queryEditorValue } from "./query-editor.mjs"
// Run from ui/ with a local Next development server already running:
// INSIGHTS_E2E_URL=http://localhost:3015 node e2e/insights-live.e2e.mjs
//
// This starts the actual Go Insights service and deterministic HTTP providers.
// A test-only Playwright bridge routes the static Next dev app's API requests to
// the service. Production proxy authentication is covered by Go integration tests.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const baseURL = process.env.INSIGHTS_E2E_URL || "http://localhost:3015"
const output = join(repository, "artifacts/insights")
const temporary = await mkdtemp(join(tmpdir(), "paprika-insights-live-"))
const dataDirectory = join(temporary, "data")
const binary = join(temporary, "insights")
const reports = []
const pageErrors = []
const providerRequests = []
const bridgedRequests = []
const bridgeErrors = []
const serviceEvents = []
const activeBridgeRequests = new Set()
const providerToken = "synthetic-provider-token-not-for-the-browser"
const providerTenant = "synthetic-provider-tenant-not-for-the-browser"
let browser
let page
let service
let serviceOutput = ""
let serviceURL

function json(response, status, data) {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(data))
}

const providers = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost")
  providerRequests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authenticated: request.headers.authorization === `Bearer ${providerToken}`, tenantPresent: request.headers["x-scope-orgid"] === providerTenant })
  if (url.pathname === "/prometheus/api/v1/query") {
    json(response, 200, { status: "success", data: { resultType: "vector", result: [{ metric: {}, value: [Math.floor(Date.now() / 1000), "1"] }] } })
    return
  }
  const metadata = {
    "/prometheus/api/v1/label/__name__/values": ["live_requests", "live_requests_total", "up"],
    "/prometheus/api/v1/labels": ["service", "instance"],
    "/prometheus/api/v1/label/service/values": ["test-api", "worker"],
  }
  if (metadata[url.pathname]) {
    json(response, 200, { status: "success", data: metadata[url.pathname] })
    return
  }
  if (url.pathname === "/tempo/api/echo") {
    response.writeHead(200, { "content-type": "text/plain" })
    response.end("echo")
    return
  }
  if (url.pathname === "/prometheus/api/v1/query_range") {
    if (url.searchParams.get("query") === "fail_query") {
      json(response, 500, { status: "error", error: "private-provider-detail-that-must-not-leak" })
      return
    }
    const end = Number(url.searchParams.get("end"))
    json(response, 200, {
      status: "success",
      data: { resultType: "matrix", result: [{ metric: { __name__: "live_requests", service: "test-api" }, values: [[end - 60, "40"], [end - 30, "41"], [end, "42.5"]] }] },
    })
    return
  }
  if (url.pathname === "/tempo/api/search") {
    const start = BigInt(url.searchParams.get("end")) * 1_000_000_000n
    json(response, 200, { traces: [{ traceID: "abc0123456789abcdef0123456789abcd", rootServiceName: "live-checkout", rootTraceName: "POST /live/orders", startTimeUnixNano: start.toString(), durationMs: 72.25 }] })
    return
  }
  json(response, 404, { error: "unexpected mock-provider route" })
})

async function listen(server) {
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  return server.address().port
}

async function run(command, args) {
  const child = spawn(command, args, { cwd: repository, stdio: ["ignore", "pipe", "pipe"] })
  let logs = ""
  child.stdout.on("data", (data) => { logs += data })
  child.stderr.on("data", (data) => { logs += data })
  const [code] = await once(child, "exit")
  assert.equal(code, 0, `${command} failed: ${logs}`)
}

async function startService() {
  serviceEvents.push({ event: "start", at: new Date().toISOString() })
  service = spawn(binary, ["--dev", `--listen=${new URL(serviceURL).host}`, `--data-dir=${dataDirectory}`, `--providers=${join(temporary, "providers.json")}`], {
    cwd: repository,
    env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "", PAPRIKA_PROVIDER_E2E_TOKEN: providerToken, PAPRIKA_PROVIDER_E2E_TENANT: providerTenant },
    stdio: ["ignore", "pipe", "pipe"],
  })
  service.stdout.on("data", (data) => { serviceOutput += data })
  service.stderr.on("data", (data) => { serviceOutput += data })
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    assert.equal(service.exitCode, null, `Insights exited during startup: ${serviceOutput}`)
    try { if ((await fetch(`${serviceURL}/readyz`)).ok) { serviceEvents.push({ event: "ready", at: new Date().toISOString() }); return } } catch { /* wait for listener */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Insights did not become ready: ${serviceOutput}`)
}

async function stopService() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return
  serviceEvents.push({ event: "intentional-stop", at: new Date().toISOString(), activeBridgeRequests: activeBridgeRequests.size })
  const stopped = once(service, "exit")
  service.kill("SIGTERM")
  const forced = setTimeout(() => service?.kill("SIGKILL"), 5000)
  await stopped
  clearTimeout(forced)
  serviceEvents.push({ event: "stopped", at: new Date().toISOString(), code: service.exitCode, signal: service.signalCode })
}

async function bridge(route) {
  const request = route.request()
  const url = new URL(request.url())
  const active = { method: request.method(), path: url.pathname }
  activeBridgeRequests.add(active)
  try {
    const response = await route.fetch({ url: `${serviceURL}${url.pathname.replace(/^\/api\/insights/, "/api")}${url.search}`, maxRedirects: 0 })
    const body = await response.text()
    assert.ok(!body.includes(providerToken) && !body.includes(providerTenant), "Resolved provider credentials must never reach the browser")
    bridgedRequests.push({ ...active, status: response.status(), ifMatch: request.headers()["if-match"], ifNoneMatch: request.headers()["if-none-match"] })
    await route.fulfill({ response })
  } catch (error) {
    // Route callbacks run outside check(). Preserve and fail unexpected transport
    // errors instead of allowing an unhandled rejection to bypass final cleanup.
    bridgeErrors.push({ ...active, error: error.message, at: new Date().toISOString(), lastServiceEvent: serviceEvents.at(-1) })
    await route.abort("failed").catch(() => {})
  } finally { activeBridgeRequests.delete(active) }
}

async function drainBridge() {
  serviceEvents.push({ event: "drain-begin", at: new Date().toISOString(), activeBridgeRequests: activeBridgeRequests.size })
  // Stop the page from scheduling queries, then finish every test-side fetch
  // before taking its upstream offline. This is an intentional test restart.
  await page.goto("about:blank")
  await page.unrouteAll({ behavior: "wait" })
  assert.equal(activeBridgeRequests.size, 0)
  assert.deepEqual(bridgeErrors, [], "Unexpected test-bridge errors must not be suppressed by restart handling")
  serviceEvents.push({ event: "drained", at: new Date().toISOString(), activeBridgeRequests: 0 })
}

async function restartAndReload() {
  const currentURL = page.url()
  await drainBridge()
  await stopService()
  await startService()
  await page.route("**/api/insights/**", bridge)
  await page.goto(currentURL, { waitUntil: "networkidle" })
}

async function check(name, action) {
  const started = Date.now()
  try {
    const evidence = await action()
    reports.push({ name, passed: true, milliseconds: Date.now() - started, evidence })
    console.log(`PASS ${name}${evidence ? `: ${JSON.stringify(evidence)}` : ""}`)
  } catch (error) {
    reports.push({ name, passed: false, error: error.message })
    if (page && !page.isClosed()) {
      const panel = await page.getByRole("region", { name: "Data sources", exact: true }).textContent({ timeout: 2000 }).catch(() => undefined)
      if (panel) console.error(`Data-source diagnostic: ${panel.slice(-2200)}`)
    }
    await page?.screenshot({ path: join(output, "live-failure.png"), fullPage: true }).catch(() => {})
    throw error
  }
}

async function getSavedDashboards() {
  const response = await fetch(`${serviceURL}/api/dashboards`)
  assert.equal(response.status, 200)
  return (await response.json()).dashboards
}

try {
  await mkdir(output, { recursive: true })
  await fetch(baseURL)
  const providerPort = await listen(providers)
  const reservation = createServer()
  const servicePort = await listen(reservation)
  await new Promise((resolve) => reservation.close(resolve))
  serviceURL = `http://127.0.0.1:${servicePort}`
  await writeFile(join(temporary, "providers.json"), JSON.stringify({ providers: [
    { id: "live-prometheus", name: "Live Prometheus", type: "prometheus", url: `http://127.0.0.1:${providerPort}/prometheus` },
    { id: "live-tempo", name: "Live Tempo", type: "tempo", url: `http://127.0.0.1:${providerPort}/tempo` },
  ] }))
  await run("rtk", ["proxy", "go", "build", "-o", binary, "./cmd/paprika-insights"])
  await startService()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, reducedMotion: "reduce", timezoneId: "UTC" })
  page = await context.newPage()
  page.setDefaultTimeout(15_000)
  page.on("pageerror", (error) => pageErrors.push(error.message))
  let discardDraftOnReload = false
  page.on("dialog", dialog => {
    // Leaving the document itself uses Chromium's beforeunload UI. In-app
    // navigation/deletion must use the visible Gamma confirmation instead.
    if (dialog.type() === "beforeunload" && discardDraftOnReload) { void dialog.accept(); return }
    pageErrors.push(`Unexpected native ${dialog.type()} dialog: ${dialog.message()}`); void dialog.dismiss()
  })
  await page.route("**/api/insights/**", bridge)

  await check("live provider registry opens an empty server-backed workspace", async () => {
    await page.goto(`${baseURL}/dashboard/insights/`, { waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Untitled dashboard", exact: true }).waitFor()
    await page.getByText("Live providers", { exact: true }).waitFor()
    assert.equal(await page.getByText("Sample data", { exact: true }).count(), 0)
    await page.getByRole("button", { name: /Data sources/ }).click()
    await page.getByText("Live Prometheus", { exact: true }).waitFor()
    await page.getByText("Live Tempo", { exact: true }).waitFor()
    await page.getByRole("button", { name: "Close data sources" }).click()
    assert.deepEqual(await getSavedDashboards(), [])
  })

  await check("visual editing queries actual Prometheus and Tempo adapters", async () => {
    await page.getByRole("button", { name: "New dashboard", exact: true }).click()
    await page.getByRole("textbox", { name: "Dashboard title", exact: true }).fill("Live integration dashboard")
    await page.getByRole("button", { name: "Single value One number, clear context" }).click()
    let editor = page.getByRole("region", { name: "Widget editor" })
    await editor.getByLabel("Title", { exact: true }).fill("Live requests")
    await editor.getByRole("textbox", { name: /^PromQL query/ }).fill("live_requests")
    await editor.getByRole("tab", { name: "Style", exact: true }).click()
    await editor.getByLabel("Unit", { exact: true }).fill("req/s")
    await editor.getByRole("button", { name: "Apply widget", exact: true }).click()
    await editor.getByRole("button", { name: "Close widget editor" }).click()
    await page.getByRole("article", { name: "Live requests", exact: true }).getByText("42.5", { exact: false }).waitFor()

    await page.getByRole("button", { name: "Add widget", exact: true }).click()
    await page.getByRole("button", { name: "Trace explorer Follow requests across services" }).click()
    editor = page.getByRole("region", { name: "Widget editor" })
    await editor.getByLabel("Title", { exact: true }).fill("Live traces")
    await editor.getByRole("textbox", { name: /^TraceQL query/ }).fill('{ resource.service.name = "live-checkout" }')
    await editor.getByRole("button", { name: "Apply widget", exact: true }).click()
    await editor.getByRole("button", { name: "Close widget editor" }).click()
    const traces = page.getByRole("region", { name: "Live traces traces" })
    await traces.getByText("POST /live/orders", { exact: true }).waitFor()
    await traces.getByText("72.25 ms", { exact: true }).waitFor()
    await traces.getByText("unknown", { exact: true }).waitFor()
    assert.ok(providerRequests.some((request) => request.path === "/prometheus/api/v1/query_range" && request.query.query === "live_requests"))
    assert.ok(providerRequests.some((request) => request.path === "/tempo/api/search" && request.query.q === '{ resource.service.name = "live-checkout" }'))
    return { observedValue: 42.5, traceDurationMs: 72.25, realAdapterRequests: providerRequests.length }
  })

  let saved
  await check("save survives service restart and browser reload", async () => {
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByText("Dashboard saved.", { exact: true }).waitFor()
    const documents = await getSavedDashboards()
    assert.equal(documents.length, 1)
    saved = documents[0]
    assert.equal(saved.title, "Live integration dashboard")
    assert.equal(saved.widgets.length, 2)
    assert.equal(saved.widgets.find((widget) => widget.type === "stat").query, "live_requests")
    const files = await readdir(dataDirectory)
    assert.ok(files.includes(`${saved.id}.json`))
    assert.deepEqual(JSON.parse(await readFile(join(dataDirectory, `${saved.id}.json`), "utf8")), saved)
    assert.ok(bridgedRequests.some((request) => request.method === "PUT" && request.ifNoneMatch === "*" && request.status === 200))
    await restartAndReload()
    await page.getByRole("heading", { name: saved.title, exact: true }).waitFor()
    await page.getByRole("article", { name: "Live requests", exact: true }).getByText("42.5", { exact: false }).waitFor()
    assert.deepEqual((await getSavedDashboards())[0], saved)
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika-insights-example-v1")), null, "Live saves must not rely on example browser storage")
    return { id: saved.id, persistedWidgets: saved.widgets.length, restartedService: true }
  })

  await check("provider failures render an honest widget error without stale sample values", async () => {
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit Live requests", exact: true }).click()
    const editor = page.getByRole("region", { name: "Widget editor" })
    await editor.getByRole("textbox", { name: /^PromQL query/ }).fill("fail_query")
    await editor.getByRole("button", { name: "Apply widget", exact: true }).click()
    await editor.getByRole("button", { name: "Close widget editor" }).click()
    const widget = page.getByRole("article", { name: "Live requests", exact: true })
    await widget.getByRole("alert").getByText("Query failed", { exact: true }).waitFor()
    assert.match(await widget.innerText(), /provider query failed/)
    assert.doesNotMatch(await widget.innerText(), /42\.5|private-provider-detail/)
    assert.ok(bridgedRequests.some((request) => request.path.endsWith("/query") && request.status === 502))
    await page.getByRole("button", { name: "Edit Live requests", exact: true }).click()
    await editor.getByRole("textbox", { name: /^PromQL query/ }).fill("live_requests")
    await editor.getByRole("button", { name: "Apply widget", exact: true }).click()
    await editor.getByRole("button", { name: "Close widget editor" }).click()
    await widget.getByText("42.5", { exact: false }).waitFor()
  })

  await check("stale ETag saves are rejected and preserve another editor's dashboard", async () => {
    const original = await fetch(`${serviceURL}/api/dashboards/${saved.id}`)
    const external = { ...await original.json(), title: "Saved by another editor" }
    const changed = await fetch(`${serviceURL}/api/dashboards/${saved.id}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": original.headers.get("etag") }, body: JSON.stringify(external) })
    assert.equal(changed.status, 200)
    await page.getByRole("textbox", { name: "Dashboard title", exact: true }).fill("My stale local edit")
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByRole("alert").getByText(/This dashboard changed on the server/).waitFor()
    assert.equal(await page.getByRole("textbox", { name: "Dashboard title", exact: true }).inputValue(), "My stale local edit", "Conflict should preserve the user's draft")
    assert.equal((await getSavedDashboards())[0].title, external.title)
    assert.ok(bridgedRequests.some((request) => request.method === "PUT" && request.ifMatch && request.status === 412))
    await page.screenshot({ path: join(output, "dashboard-live-conflict.png"), fullPage: true })
    discardDraftOnReload = true
    try { await page.reload({ waitUntil: "networkidle" }) } finally { discardDraftOnReload = false }
    await page.getByRole("heading", { name: external.title, exact: true }).waitFor()
    await page.screenshot({ path: join(output, "dashboard-live.png"), fullPage: true })
  })

  const managedID = "browser-managed"
  await check("administrator adds, tests, edits, and persists a managed provider", async () => {
    await page.getByRole("button", { name: /Data sources/ }).click()
    const panel = page.getByRole("region", { name: "Data sources", exact: true })
    const provisioned = panel.getByRole("article").filter({ has: page.getByText("Live Tempo", { exact: true }) })
    await provisioned.getByRole("button", { name: "Test connection", exact: true }).click()
    await panel.getByRole("status").getByText(/Live Tempo: Connected/).waitFor()
    assert.equal(await provisioned.getByRole("button", { name: "Edit", exact: true }).count(), 0)
    await panel.getByRole("button", { name: "Add data source", exact: true }).click()
    await panel.getByLabel("Provider ID", { exact: true }).fill(managedID)
    await panel.getByLabel("Name", { exact: true }).fill("Browser managed metrics")
    await panel.getByLabel("Endpoint URL", { exact: true }).fill(`http://127.0.0.1:${providerPort}/prometheus`)
    await panel.getByLabel("Bearer token environment variable", { exact: true }).fill("PAPRIKA_PROVIDER_E2E_TOKEN")
    await panel.getByRole("textbox", { name: /^Header environment variables/ }).fill("X-Scope-OrgID: PAPRIKA_PROVIDER_E2E_TENANT")
    await panel.getByRole("button", { name: "Save data source", exact: true }).click()
    await panel.getByRole("status").getByText(/Provider saved/).waitFor()
    let managed = panel.getByRole("article").filter({ has: page.getByText("Browser managed metrics", { exact: true }) })
    await managed.getByRole("button", { name: "Test connection", exact: true }).click()
    await panel.getByRole("status").getByText(/Browser managed metrics: Connected/).waitFor()
    assert.ok(providerRequests.some((item) => item.path === "/prometheus/api/v1/query" && item.query.query === "vector(1)" && item.authenticated && item.tenantPresent))
    assert.ok(providerRequests.some((item) => item.path === "/tempo/api/echo"))
    await managed.getByRole("button", { name: "Edit", exact: true }).click()
    assert.equal(await panel.getByLabel("Provider ID", { exact: true }).isDisabled(), true)
    await panel.getByLabel("Name", { exact: true }).fill("Managed production metrics")
    await panel.getByRole("button", { name: "Save data source", exact: true }).click()
    await panel.getByText("Managed production metrics", { exact: true }).waitFor()
    const publicResponse = await fetch(`${serviceURL}/api/providers`)
    const publicRegistry = await publicResponse.text()
    assert.doesNotMatch(publicRegistry, /127\.0\.0\.1|bearerTokenEnv|headersEnv|PAPRIKA_PROVIDER/)
    const persisted = JSON.parse(await readFile(join(dataDirectory, "providers", `${managedID}.json`), "utf8"))
    assert.equal(persisted.name, "Managed production metrics")
    assert.equal(persisted.bearerTokenEnv, "PAPRIKA_PROVIDER_E2E_TOKEN")
    assert.equal(persisted.headersEnv["X-Scope-OrgID"], "PAPRIKA_PROVIDER_E2E_TENANT")
    assert.ok(bridgedRequests.some((item) => item.path.endsWith(`/provider-configs/${managedID}`) && item.method === "PUT" && item.ifNoneMatch === "*" && item.status === 200))
    assert.ok(bridgedRequests.some((item) => item.path.endsWith(`/provider-configs/${managedID}`) && item.method === "PUT" && item.ifMatch && item.status === 200))
    await restartAndReload()
    await page.getByRole("button", { name: /Data sources/ }).click()
    await panel.getByText("Managed production metrics", { exact: true }).waitFor()
    managed = panel.getByRole("article").filter({ has: page.getByText("Managed production metrics", { exact: true }) })
    await managed.getByRole("button", { name: "Test connection", exact: true }).click()
    await panel.getByRole("status").getByText(/Managed production metrics: Connected/).waitFor()
    await panel.getByRole("button", { name: "Close data sources" }).click()
    return { managedID, restartedService: true, credentialsResolvedOnlyServerSide: true }
  })

  await check("guided builder discovers metrics and labels from the real provider", async () => {
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit Live requests", exact: true }).click()
    const editor = page.getByRole("region", { name: "Widget editor" })
    await editor.getByRole("tab", { name: "Query", exact: true }).click()
    await selectGammaOption(page, editor.getByRole("combobox", { name: /^Data source/ }), "Managed production metrics")
    await editor.getByText("Guided query builder", { exact: true }).click()
    await editor.getByRole("combobox", { name: "Metric", exact: true }).fill("live_requests_total")
    await page.getByRole("option", { name: "live_requests_total", exact: true }).click()
    await editor.getByRole("button", { name: "Add label filter", exact: true }).click()
    await editor.getByRole("combobox", { name: "Filter 1 label", exact: true }).fill("service")
    await page.getByRole("option", { name: "service", exact: true }).click()
    await editor.getByRole("combobox", { name: "Filter 1 value", exact: true }).fill("test-api")
    await page.getByRole("option", { name: "test-api", exact: true }).click()
    await selectGammaOption(page, editor.getByRole("combobox", { name: /^Function/ }), "Rate per second")
    await editor.getByLabel("Rate window", { exact: true }).fill("5m")
    await selectGammaOption(page, editor.getByRole("combobox", { name: /^Aggregation/ }), "sum")
    await editor.getByLabel("Group by labels", { exact: true }).fill("service")
    const query = 'sum by (service) (rate(live_requests_total{service="test-api"}[5m]))'
    assert.equal(await queryEditorValue(editor.getByRole("textbox", { name: /^PromQL query/ })), "live_requests", "Guided construction must preserve the current query until explicitly applied")
    await editor.getByRole("button", { name: "Use generated query", exact: true }).click()
    assert.equal(await queryEditorValue(editor.getByRole("textbox", { name: /^PromQL query/ })), query)
    await editor.getByRole("button", { name: "Run query", exact: true }).click()
    await editor.getByLabel("Query preview", { exact: true }).getByText("42.5", { exact: false }).waitFor()
    await editor.getByRole("button", { name: "Apply widget", exact: true }).click()
    await editor.getByRole("button", { name: "Close widget editor" }).click()
    for (const path of ["/prometheus/api/v1/label/__name__/values", "/prometheus/api/v1/labels", "/prometheus/api/v1/label/service/values"]) {
      assert.ok(providerRequests.some((item) => item.path === path && item.authenticated && item.tenantPresent), `Missing authenticated discovery request: ${path}`)
    }
    assert.ok(providerRequests.some((item) => item.path === "/prometheus/api/v1/label/service/values" && item.query["match[]"] === "live_requests_total"))
    assert.ok(providerRequests.some((item) => item.path === "/prometheus/api/v1/query_range" && item.query.query === query && item.authenticated))
    return { generatedQuery: query, discoveryPathsVerified: 3 }
  })

  await check("custom time range reaches metric and trace adapters and survives reload", async () => {
    const from = "2026-10-20T10:00", to = "2026-10-20T12:00"
    const start = Date.parse(`${from}:00Z`) / 1000, end = Date.parse(`${to}:00Z`) / 1000
    const requestStart = providerRequests.length
    await page.getByRole("button", { name: "Choose custom time range", exact: true }).click()
    await page.getByLabel("Range start", { exact: true }).fill(from)
    await page.getByLabel("Range end", { exact: true }).fill(to)
    await page.getByRole("button", { name: "Apply time range", exact: true }).click()
    const expected = ["/prometheus/api/v1/query_range", "/tempo/api/search"]
    await page.waitForFunction(() => !document.querySelector('[aria-label="Custom time range"]'))
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline && !expected.every((path) => providerRequests.slice(requestStart).some((item) => item.path === path && Number(item.query.start) === start && Number(item.query.end) === end))) {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    for (const path of expected) assert.ok(providerRequests.slice(requestStart).some((item) => item.path === path && Number(item.query.start) === start && Number(item.query.end) === end), `Missing exact custom time range for ${path}`)
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByText("Dashboard saved.", { exact: true }).waitFor()
    const document = (await getSavedDashboards())[0]
    assert.deepEqual(document.customTimeRange, { from: `${from}:00.000Z`, to: `${to}:00.000Z` })
    assert.equal(document.widgets.find((widget) => widget.type === "stat").providerId, managedID)
    await page.reload({ waitUntil: "networkidle" })
    assert.equal(await page.getByRole("combobox", { name: "Time range", exact: true }).innerText(), "Custom range…")
    await page.getByRole("article", { name: "Live requests", exact: true }).getByText("42.5", { exact: false }).waitFor()
    await page.screenshot({ path: join(output, "dashboard-live-rich.png"), fullPage: true })
    return { start, end, persistedCustomRange: true }
  })

  await check("provider edit conflicts preserve local input and deletion persists", async () => {
    await page.getByRole("button", { name: /Data sources/ }).click()
    const panel = page.getByRole("region", { name: "Data sources", exact: true })
    let row = panel.getByRole("article").filter({ has: page.getByText("Managed production metrics", { exact: true }) })
    await row.getByRole("button", { name: "Edit", exact: true }).click()
    const configs = await (await fetch(`${serviceURL}/api/provider-configs`)).json()
    const original = configs.providers.find((item) => item.id === managedID)
    const { managed, etag, ...configuration } = original
    assert.equal(managed, true)
    const changed = await fetch(`${serviceURL}/api/provider-configs/${managedID}`, { method: "PUT", headers: { "content-type": "application/json", "if-match": etag }, body: JSON.stringify({ ...configuration, name: "Saved by provider administrator" }) })
    assert.equal(changed.status, 200)
    await panel.getByLabel("Name", { exact: true }).fill("My stale provider edit")
    const rejectedSave = page.waitForResponse(response => response.url().endsWith(`/provider-configs/${managedID}`) && response.request().method() === "PUT")
    await panel.getByRole("button", { name: "Save data source", exact: true }).click()
    const conflict = await rejectedSave
    assert.equal(conflict.status(), 412)
    assert.match((await conflict.json()).error, /provider.*changed|changed.*provider/i)
    await panel.getByRole("alert").waitFor()
    assert.match(await panel.getByRole("alert").innerText(), /provider.*changed|changed.*provider/i)
    assert.equal(await panel.getByLabel("Name", { exact: true }).inputValue(), "My stale provider edit")
    assert.equal((await (await fetch(`${serviceURL}/api/provider-configs`)).json()).providers.find((item) => item.id === managedID).name, "Saved by provider administrator")
    assert.ok(bridgedRequests.some((item) => item.path.endsWith(`/provider-configs/${managedID}`) && item.method === "PUT" && item.ifMatch && item.status === 412))
    await panel.getByRole("button", { name: "Close data sources" }).click()
    await page.reload({ waitUntil: "networkidle" })
    await page.getByRole("button", { name: /Data sources/ }).click()
    row = panel.getByRole("article").filter({ has: page.getByText("Saved by provider administrator", { exact: true }) })
    await row.getByRole("button", { name: "Remove Saved by provider administrator", exact: true }).click()
    await row.getByRole("button", { name: "Remove provider", exact: true }).click()
    await panel.getByRole("status").getByText(/Provider removed/).waitFor()
    await panel.getByText("Saved by provider administrator", { exact: true }).waitFor({ state: "hidden" })
    assert.equal(await panel.getByText("Saved by provider administrator", { exact: true }).count(), 0)
    assert.ok(bridgedRequests.some((item) => item.path.endsWith(`/provider-configs/${managedID}`) && item.method === "DELETE" && item.ifMatch && item.status === 204))
    // No browser assertions remain. Drain the test-only bridge before taking
    // its upstream service offline for the durable-deletion restart check.
    await drainBridge()
    await stopService()
    await startService()
    assert.ok(!(await (await fetch(`${serviceURL}/api/providers`)).json()).providers.some((item) => item.id === managedID))
    assert.ok(!(await readdir(join(dataDirectory, "providers"))).includes(`${managedID}.json`))
    return { staleEditRejected: true, deleteSurvivesRestart: true }
  })

  assert.deepEqual(pageErrors, [], "Live browser session must not have unhandled errors")
  assert.deepEqual(bridgeErrors, [], "The test-only bridge must complete without unexpected transport errors")
  console.log(`\n${reports.length} live integration checks passed.`)
} finally {
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "live-e2e-report.json"), JSON.stringify({ baseURL, reports, pageErrors, providerRequests, bridgedRequests, bridgeErrors, serviceEvents, serviceOutput }, null, 2))
  await browser?.close()
  await stopService()
  await new Promise((resolve) => providers.close(resolve))
  await rm(temporary, { recursive: true, force: true })
}
