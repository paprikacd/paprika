// Real MCP -> authenticated API proxy -> Insights storage, followed by the real
// browser workspace. Only Kubernetes and telemetry are deterministic fixtures.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption, respondToGammaConfirmation } from "./gamma-controls.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), "paprika-observe-authoring-"))
const output = join(repository, "artifacts/insights/observe-authoring")
const binary = join(temporary, "observe-e2e"), ready = join(temporary, "ready.json")
const reports = [], pageErrors = [], queryResponses = [], writes = [], documentReads = []
const services = ["api-gateway", "release-controller"]
const readings = [101.2345, 202.3456]
const template = "sum(rate(http_requests_total{service={{service}}}[5m]))"
const fixedRange = { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }
let fixture, processHandle, browser, context, page, outputLog = "", metricProvider
let rpcId = 0, queryEntry, dashboardEntry

async function until(predicate, message, timeout = 25_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(message)
}
async function startFixture() {
  await rm(ready, { force: true })
  processHandle = spawn(binary, [`--ready-file=${ready}`, `--ui-dir=${join(repository, "ui/out")}`, `--data-dir=${join(temporary, "data")}`, ...(process.env.INSIGHTS_E2E_URL ? [`--ui-url=${process.env.INSIGHTS_E2E_URL}`] : [])], { cwd: repository, stdio: ["ignore", "pipe", "pipe"] })
  processHandle.stdout.on("data", data => { outputLog += data })
  processHandle.stderr.on("data", data => { outputLog += data })
  await until(async () => {
    if (processHandle.exitCode !== null) throw new Error(`Harness exited: ${outputLog}`)
    try { fixture = JSON.parse(await readFile(ready, "utf8")); return true } catch { return false }
  }, "Observe authoring harness did not become ready", 30_000)
}
async function stopFixture() {
  if (!processHandle || processHandle.exitCode !== null || processHandle.signalCode !== null) return
  const ended = once(processHandle, "exit")
  processHandle.kill("SIGTERM")
  const force = setTimeout(() => processHandle.kill("SIGKILL"), 5000)
  await ended; clearTimeout(force)
}
async function http(path, options = {}) {
  return fetch(`${fixture.baseURL}/api/insights/${path}`, { headers: { Authorization: `Bearer ${fixture.token}` }, signal: AbortSignal.timeout(20_000), ...options })
}
async function api(path) {
  const response = await http(path), text = await response.text()
  assert.equal(response.status, 200, `GET ${path}: ${response.status} ${text}`)
  return { document: JSON.parse(text), etag: response.headers.get("etag") }
}
async function rpc(method, params, token = fixture.mcpWriteToken) {
  const id = ++rpcId
  const response = await fetch(fixture.mcpURL, {
    method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }), signal: AbortSignal.timeout(30_000),
  })
  assert.equal(response.status, 200, `MCP ${method}: HTTP ${response.status}`)
  const text = await response.text()
  return response.headers.get("content-type")?.includes("text/event-stream")
    ? text.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === id)
    : JSON.parse(text)
}
function structured(result) {
  return result.structuredContent ?? JSON.parse(result.content.find(item => item.type === "text").text)
}
async function tool(name, args, token) {
  const response = await rpc("tools/call", { name, arguments: args }, token)
  assert.equal(response.error, undefined, `${name}: ${JSON.stringify(response.error)}`)
  assert.notEqual(response.result?.isError, true, `${name}: ${JSON.stringify(response.result?.content)}`)
  return structured(response.result)
}
async function rejectedTool(name, args, token, expected) {
  const response = await rpc("tools/call", { name, arguments: args }, token)
  assert.ok(response.error || response.result?.isError, `${name} unexpectedly succeeded`)
  const message = response.error?.message ?? response.result.content.filter(item => item.type === "text").map(item => item.text).join("\n")
  if (expected) assert.match(message, expected)
  return { rejected: true, code: response.error?.code, message }
}
async function rejectedConflict(name, args) {
  const response = await rpc("tools/call", { name, arguments: args })
  assert.equal(response.error, undefined, "A stale document is an actionable tool result, not an internal protocol error")
  assert.equal(response.result?.isError, true)
  const message = response.result.content.filter(item => item.type === "text").map(item => item.text).join("\n")
  assert.match(message, /get the latest document and ETag/)
  return { rejected: true, actionable: true, message }
}
function verifyDocumentResult(result, document) {
  assert.deepEqual(result.document, document)
  assert.match(result.etag, /^"[a-f0-9]{64}"$/)
  const url = new URL(result.uiUrl)
  assert.equal(url.origin, fixture.baseURL)
  assert.equal(url.pathname, "/dashboard/insights/")
  return result
}
async function check(name, action) {
  try { const evidence = await action(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) {
    reports.push({ name, passed: false, error: error.message })
    await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {})
    throw error
  }
}
const tile = () => page.locator('[data-widget-id="selected-service"]')
const explorer = () => page.getByRole("region", { name: "Data source explorer", exact: true }).last()
async function showReading(service, factor = 1) {
  const value = readings[services.indexOf(service)] * factor
  const reading = tile().locator("[data-metric-value]")
  await until(async () => Number(await reading.getAttribute("data-metric-value").catch(() => NaN)) === value, `Expected ${service} latest value ${value}`)
  assert.equal((await reading.innerText()).replace(/\s+/g, ""), `${value.toFixed(2)}req/s`)
  const sparkline = tile().locator("[data-stat-sparkline]")
  assert.equal(Number(await sparkline.getAttribute("data-sample-count")), 4)
  assert.ok((await sparkline.locator("[data-stat-trend]").getAttribute("d"))?.length > 2)
  assert.ok((await sparkline.locator("[data-stat-area]").getAttribute("d"))?.length > 2)
  return { value, samples: 4, min: Number(await sparkline.getAttribute("data-history-min")), max: Number(await sparkline.getAttribute("data-history-max")), path: await sparkline.locator("[data-stat-trend]").getAttribute("d") }
}
async function openBrowser(width = 1512, dashboardId) {
  await context?.close()
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 960 }, reducedMotion: "reduce", colorScheme: "light", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  await context.addInitScript(token => localStorage.setItem("paprika_id_token", token), fixture.token)
  page = await context.newPage(); page.setDefaultTimeout(25_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("dialog", dialog => { if (dialog.type() === "beforeunload") void dialog.accept(); else { pageErrors.push(`Unexpected ${dialog.type()}`); void dialog.dismiss() } })
  page.on("response", response => {
    const path = new URL(response.url()).pathname
    if (path === "/api/insights/query") void response.json().then(body => queryResponses.push({ status: response.status(), request: JSON.parse(response.request().postData() || "{}"), body })).catch(() => {})
    if (response.request().method() === "PUT" && path.startsWith("/api/insights/")) writes.push({ path, status: response.status() })
    if (response.request().method() === "GET" && path.startsWith("/api/insights/dashboards/")) documentReads.push({ path, status: response.status(), etag: response.headers().etag })
  })
  await page.goto(`${fixture.baseURL}/dashboard/insights/${dashboardId ? `?dashboard=${dashboardId}` : ""}`, { waitUntil: "domcontentloaded" })
  await page.getByText("Live providers", { exact: true }).waitFor()
  if (!dashboardId) await page.getByRole("heading", { name: "Untitled dashboard", exact: true }).waitFor()
  await page.bringToFront()
}
async function openExplorer() {
  const navigation = page.locator("#insights-navigation")
  if (!await navigation.isVisible()) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
  await navigation.getByRole("button", { name: /^Explore\b/ }).click()
  await explorer().getByRole("heading", { name: "Explore", exact: true }).waitFor()
}
async function discardDialog() {
  await respondToGammaConfirmation(page, "Discard changes")
}

try {
  await mkdir(output, { recursive: true })
  const build = spawn("rtk", ["proxy", "go", "build", "-o", binary, "./hack/insights-observe-e2e"], { cwd: repository, stdio: "inherit" })
  assert.equal((await once(build, "exit"))[0], 0, "Authoring integration fixture must build")
  await startFixture()
  browser = await chromium.launch({ headless: true })
  await openBrowser()

  await check("Observe advertises authoring tools separately from provider reads", async () => {
    const listed = await rpc("tools/list", {}, fixture.mcpToken)
    assert.equal(listed.error, undefined)
    for (const name of ["create_saved_query", "update_saved_query", "create_dashboard", "update_dashboard"]) {
      const entry = listed.result.tools.find(tool => tool.name === name)
      assert.ok(entry, `${name} must be discoverable`)
      assert.equal(entry.annotations.readOnlyHint, false)
    }
    const providers = (await tool("list_insights_providers", {}, fixture.mcpToken)).providers
    metricProvider = providers.find(provider => provider.providerRef === fixture.providerRef)
    assert.equal(metricProvider?.type, "prometheus")
    assert.deepEqual(providers.map(provider => provider.providerRef).sort(), [fixture.providerRef, fixture.traceProviderRef].sort())
    assert.ok(providers.every(provider => !Object.hasOwn(provider, "url") && !Object.hasOwn(provider, "credentials")))
    assert.deepEqual((await tool("list_saved_queries", {}, fixture.mcpToken)).queries, [])
    assert.deepEqual((await tool("list_dashboards", {}, fixture.mcpToken)).dashboards, [])
    return { authoringTools: 4, provider: metricProvider.providerRef, credentialsExposed: false }
  })
  const saved = { schemaVersion: 1, id: "mcp-service-rate", name: "MCP service request rate", description: "Created through Observe MCP.", tags: ["mcp", "service"], providerId: metricProvider.id, kind: "metrics", query: template, parameters: [{ name: "service", type: "string", defaultValue: services[0] }] }
  const dashboard = { schemaVersion: 1, id: "mcp-authoring-flow", title: "MCP authored dashboard", description: "Shared documents, created without a UI write.", timeRange: "1h", customTimeRange: fixedRange, refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: services[0], options: services }], widgets: [{ id: "selected-service", title: "Selected service request rate", type: "stat", providerId: metricProvider.id, query: "must_not_execute", queryRef: { id: saved.id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, unit: "req/s", options: { decimals: 2, showSparkline: true }, layout: { x: 0, y: 0, w: 6, h: 4 } }] }
  await check("OAuth scope and Insights RBAC independently reject writes", async () => {
    const scope = await rejectedTool("create_saved_query", { document: saved }, fixture.mcpToken, /paprika:insights:write/)
    const rbac = await rejectedTool("create_saved_query", { document: saved }, fixture.mcpDeniedWriteToken, /permission|forbidden|denied/i)
    assert.equal((await http(`saved-queries/${saved.id}`)).status, 404)
    return { scope, rbac, documentCreated: false }
  })
  await check("MCP creates saved queries and dashboards that appear in the already-open UI", async () => {
    queryEntry = verifyDocumentResult(await tool("create_saved_query", { document: saved }), saved)
    dashboardEntry = verifyDocumentResult(await tool("create_dashboard", { document: dashboard }), dashboard)
    const treeEntry = page.locator("#insights-navigation").getByRole("button", { name: dashboard.title, exact: true })
    await treeEntry.waitFor(); await treeEntry.click()
    await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor()
    const reading = await showReading(services[0])
    assert.deepEqual((await api(`saved-queries/${saved.id}`)).document, saved)
    assert.deepEqual((await api(`dashboards/${dashboard.id}`)).document, dashboard)
    assert.equal(writes.length, 0, "The browser must not create the MCP-authored documents")
    await page.screenshot({ path: join(output, "mcp-created-dashboard.png"), fullPage: false })
    return { queryId: saved.id, dashboardId: dashboard.id, reading, browserWrites: 0 }
  })
  await check("Create conflicts, invalid documents and inaccessible providers cannot overwrite storage", async () => {
    const queryConflict = await rejectedConflict("create_saved_query", { document: { ...saved, name: "Should not replace query" } })
    const dashboardConflict = await rejectedConflict("create_dashboard", { document: { ...dashboard, title: "Should not replace dashboard" } })
    await rejectedTool("create_dashboard", { document: { ...dashboard, id: "invalid-dashboard", title: "" } })
    const hiddenProvider = `observe-${createHash("sha256").update("restricted/prometheus").digest("hex")}`
    await rejectedTool("create_saved_query", { document: { ...saved, id: "hidden-provider-query", providerId: hiddenProvider } })
    await rejectedTool("create_saved_query", { document: { ...saved, id: "denied-provider-query" } }, fixture.mcpDeniedProviderToken)
    for (const etag of ["", "*", `W/${queryEntry.etag}`]) await rejectedTool("update_saved_query", { document: saved, etag })
    assert.deepEqual(await api(`saved-queries/${saved.id}`), { document: saved, etag: queryEntry.etag })
    assert.deepEqual(await api(`dashboards/${dashboard.id}`), { document: dashboard, etag: dashboardEntry.etag })
    for (const path of ["dashboards/invalid-dashboard", "saved-queries/hidden-provider-query", "saved-queries/denied-provider-query"]) assert.equal((await http(path)).status, 404)
    return { queryConflict, dashboardConflict, weakOrUnconditionalUpdatesRejected: true, restrictedProviderRejected: true }
  })
  await check("MCP query updates immediately refresh the open single value and sparkline history", async () => {
    const before = await showReading(services[0]), previous = queryEntry
    const document = { ...saved, name: "MCP rate doubled", description: "Updated through Observe MCP; every history sample is doubled.", tags: ["mcp", "service", "updated"], query: `${template} * 2` }
    queryEntry = verifyDocumentResult(await tool("update_saved_query", { document, etag: previous.etag }), document)
    const after = await showReading(services[0], 2)
    assert.equal(after.min, before.min * 2); assert.equal(after.max, before.max * 2)
    assert.equal((await api(`dashboards/${dashboard.id}`)).etag, dashboardEntry.etag, "A live query reference must not rewrite its dashboard")
    await rejectedConflict("update_saved_query", { document: { ...saved, name: "Stale writer" }, etag: previous.etag })
    assert.deepEqual((await api(`saved-queries/${saved.id}`)).document, document)
    await page.screenshot({ path: join(output, "mcp-query-update.png"), fullPage: false })
    return { before, after, dashboardUnchanged: true, staleQueryWriteRejected: true }
  })
  await check("MCP dashboard updates refresh the open dashboard and reject stale versions", async () => {
    const previous = dashboardEntry
    const document = { ...previous.document, title: "Dashboard updated through MCP", description: "The existing browser received this remote update." }
    dashboardEntry = verifyDocumentResult(await tool("update_dashboard", { document, etag: previous.etag }), document)
    await page.getByRole("heading", { name: document.title, exact: true }).waitFor()
    await page.getByText(document.description, { exact: true }).waitFor()
    await rejectedConflict("update_dashboard", { document: { ...document, title: "Stale dashboard writer" }, etag: previous.etag })
    assert.deepEqual((await api(`dashboards/${dashboard.id}`)).document, document)
    return { refreshedWithoutReload: true, staleDashboardWriteRejected: true }
  })
  await check("A same-content MCP revision refreshes the UI version before its next save", async () => {
    const previous = dashboardEntry
    // Property order changes the stored byte ETag, but not the canonical dashboard.
    const document = { title: previous.document.title, ...previous.document }
    assert.deepEqual(document, previous.document)
    assert.notEqual(JSON.stringify(document), JSON.stringify(previous.document))
    const beforeReads = documentReads.length
    dashboardEntry = verifyDocumentResult(await tool("update_dashboard", { document, etag: previous.etag }), document)
    assert.notEqual(dashboardEntry.etag, previous.etag)
    await until(() => documentReads.slice(beforeReads).some(item => item.path.endsWith(`/dashboards/${dashboard.id}`) && item.status === 200 && item.etag === dashboardEntry.etag), "The open UI did not refresh its ETag for a same-content remote revision")
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByRole("textbox", { name: "Dashboard title", exact: true }).fill("Dashboard updated from the UI")
    const beforeWrites = writes.length
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await until(() => writes.slice(beforeWrites).some(item => item.path.endsWith(`/dashboards/${dashboard.id}`) && item.status === 200), "The UI must save against the latest same-content ETag")
    await page.getByRole("heading", { name: "Dashboard updated from the UI", exact: true }).waitFor()
    dashboardEntry = await tool("get_dashboard", { id: dashboard.id }, fixture.mcpToken)
    assert.equal(dashboardEntry.document.title, "Dashboard updated from the UI")
    return { changedETagWithoutSemanticChanges: true, uiSaveStatus: 200, uiChangeVisibleThroughMCP: true }
  })
  await check("An MCP dashboard update preserves an unsaved UI draft and its conflict boundary", async () => {
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    const title = page.getByRole("textbox", { name: "Dashboard title", exact: true })
    await title.fill("Local dashboard draft")
    const document = { ...dashboardEntry.document, title: "New remote dashboard revision" }
    dashboardEntry = verifyDocumentResult(await tool("update_dashboard", { document, etag: dashboardEntry.etag }), document)
    await page.getByText("The saved dashboard changed elsewhere. Your draft is preserved.", { exact: true }).waitFor()
    assert.equal(await title.inputValue(), "Local dashboard draft")
    const before = writes.length
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await until(() => writes.slice(before).some(item => item.path.endsWith(`/dashboards/${dashboard.id}`) && item.status === 412), "Saving a stale UI dashboard must receive HTTP412")
    assert.equal(await title.inputValue(), "Local dashboard draft")
    assert.deepEqual((await api(`dashboards/${dashboard.id}`)).document, document)
    await page.screenshot({ path: join(output, "dashboard-draft-conflict.png"), fullPage: false })
    await page.getByRole("button", { name: "Load latest dashboard", exact: true }).click()
    await discardDialog()
    await page.getByRole("heading", { name: document.title, exact: true }).waitFor()
    return { draftPreserved: true, staleSaveStatus: 412, explicitReloadRestoredRemote: true }
  })
  await check("An MCP saved-query update preserves an unsaved query description until explicit reload", async () => {
    await openExplorer()
    await selectGammaOption(page, explorer().getByRole("combobox", { name: "Open saved query", exact: true }), /MCP rate doubled/)
    const description = explorer().getByRole("textbox", { name: "Query description", exact: true })
    assert.equal(await description.inputValue(), queryEntry.document.description)
    await description.fill("Local query description draft")
    const document = { ...queryEntry.document, description: "A newer query description written through MCP.", tags: ["mcp", "reviewed"] }
    queryEntry = verifyDocumentResult(await tool("update_saved_query", { document, etag: queryEntry.etag }), document)
    await explorer().getByText(/The saved query changed or was removed elsewhere\. Your draft is preserved\./).waitFor()
    assert.equal(await description.inputValue(), "Local query description draft")
    const before = writes.length
    await explorer().getByRole("button", { name: "Save query", exact: true }).click()
    await until(() => writes.slice(before).some(item => item.path.endsWith(`/saved-queries/${saved.id}`) && item.status === 412), "Saving a stale query draft must receive HTTP412")
    assert.equal(await description.inputValue(), "Local query description draft")
    assert.deepEqual((await api(`saved-queries/${saved.id}`)).document, document)
    await explorer().getByRole("button", { name: "Load latest saved version", exact: true }).click()
    await discardDialog()
    await until(async () => await description.inputValue() === document.description, "Explicit query reload did not show MCP metadata")
    await page.screenshot({ path: join(output, "mcp-query-description.png"), fullPage: false })
    return { draftPreserved: true, staleSaveStatus: 412, remoteDescriptionVisible: true }
  })
  await check("MCP read tools expose the UI's canonical documents, current versions and metadata", async () => {
    const query = await tool("get_saved_query", { id: saved.id }, fixture.mcpToken)
    const board = await tool("get_dashboard", { id: dashboard.id }, fixture.mcpToken)
    verifyDocumentResult(query, queryEntry.document); verifyDocumentResult(board, dashboardEntry.document)
    assert.equal(query.etag, queryEntry.etag); assert.equal(board.etag, dashboardEntry.etag)
    const queries = (await tool("list_saved_queries", { provider_id: metricProvider.id }, fixture.mcpToken)).queries
    assert.equal(queries.length, 1)
    assert.equal(queries[0].description, queryEntry.document.description)
    assert.deepEqual(queries[0].tags, ["mcp", "reviewed"])
    assert.equal(queries[0].etag, queryEntry.etag)
    const boards = (await tool("list_dashboards", {}, fixture.mcpToken)).dashboards
    assert.equal(boards.length, 1); assert.equal(boards[0].title, dashboardEntry.document.title); assert.equal(boards[0].widgetCount, 1)
    return { queryETagMatchesUI: true, dashboardETagMatchesUI: true, metadataVisible: true }
  })
  for (const width of [1512, 390]) {
    await openBrowser(width, dashboard.id)
    await page.getByRole("heading", { name: dashboardEntry.document.title, exact: true }).waitFor()
    for (const theme of ["Light", "Dark"]) await check(`MCP-authored service filters and sparklines work in ${theme} at ${width}px`, async () => {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const filter = page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: "Service", exact: true })
      await selectGammaOption(page, filter, services[0]); const before = await showReading(services[0], 2)
      await selectGammaOption(page, filter, services[1]); const after = await showReading(services[1], 2)
      assert.notEqual(before.path, after.path)
      assert.equal((await api(`dashboards/${dashboard.id}`)).etag, dashboardEntry.etag)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await page.screenshot({ path: join(output, `authoring-${theme.toLowerCase()}-${width}.png`), fullPage: false })
      return { before, after, savedDefaultUnchanged: true }
    })
  }
  await check("MCP-authored documents persist across a real service restart and browser reload", async () => {
    await context.close(); context = undefined
    const previous = { query: queryEntry, dashboard: dashboardEntry }
    await stopFixture(); await startFixture()
    queryEntry = await tool("get_saved_query", { id: saved.id })
    dashboardEntry = await tool("get_dashboard", { id: dashboard.id })
    assert.deepEqual(queryEntry.document, previous.query.document); assert.equal(queryEntry.etag, previous.query.etag)
    assert.deepEqual(dashboardEntry.document, previous.dashboard.document); assert.equal(dashboardEntry.etag, previous.dashboard.etag)
    await openBrowser(1512, dashboard.id)
    await page.getByRole("heading", { name: dashboardEntry.document.title, exact: true }).waitFor()
    await showReading(services[0], 2)
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.getByRole("heading", { name: dashboardEntry.document.title, exact: true }).waitFor()
    await showReading(services[0], 2)
    await page.screenshot({ path: join(output, "persisted-mcp-dashboard.png"), fullPage: false })
    return { freshService: true, sameDocuments: true, sameETags: true, savedReferencesRestored: true }
  })
  assert.deepEqual(pageErrors, [], "No browser runtime errors")
  console.log(`PASS ${reports.length} MCP authoring scenarios`)
} catch (error) {
  console.error(error.stack ?? error.message)
  process.exitCode = 1
} finally {
  await context?.close(); await browser?.close(); await stopFixture()
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "report.json"), JSON.stringify({ timestamp: new Date().toISOString(), reports, pageErrors, browserWrites: writes, documentReads, queryRequests: queryResponses.map(({ status, request, body }) => ({ status, providerId: request.providerId, query: request.query, series: body.series?.length })) }, null, 2))
  for (const value of Object.values(fixture ?? {})) if (typeof value === "string" && value.split(".").length === 3 && value.startsWith("eyJ")) outputLog = outputLog.replaceAll(value, "[redacted token]")
  await writeFile(join(output, "fixture.log"), outputLog)
  await rm(temporary, { recursive: true, force: true })
}
