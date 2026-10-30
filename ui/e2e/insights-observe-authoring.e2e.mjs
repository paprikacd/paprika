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
import { assertObserveMCP, readObserveProtocol } from "./observe-protocol.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), "paprika-observe-authoring-"))
const output = join(repository, "artifacts/insights/observe-authoring")
const binary = join(temporary, "observe-e2e"), ready = join(temporary, "ready.json")
const reports = [], pageErrors = [], queryResponses = [], writes = [], documentReads = []
const protocolHistory = []
const schemas = {}
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
  if (fixture?.baseURL) {
    const protocol = await readObserveProtocol(fixture.baseURL).catch(() => undefined)
    if (protocol) protocolHistory.push(protocol)
  }
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
  return { document: JSON.parse(text), etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") }
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
function schemaNode(root, node = root) {
  while (node?.$ref) {
    assert.ok(node.$ref.startsWith("#/"), "Schema references must resolve within the advertised document")
    node = node.$ref.slice(2).split("/").reduce((value, key) => value[key.replaceAll("~1", "/").replaceAll("~0", "~")], root)
  }
  return node
}
function schemaProperty(root, ...names) {
  return names.reduce((node, name) => schemaNode(root, schemaNode(root, node).properties[name]), root)
}
async function unchanged(collection, entry) {
  assert.deepEqual(await api(`${collection}/${entry.document.id}`), { document: entry.document, etag: entry.etag })
}
async function assertQueryCall(query, fromIndex = 0) {
  await until(() => queryResponses.slice(fromIndex).some(({ status, request }) => status === 200 && request.providerId === metricProvider.id && request.query === query && request.start === Date.parse(fixedRange.from) / 1000 && request.end === Date.parse(fixedRange.to) / 1000 && request.step === 12), "The live widget did not execute the exact patched query and dashboard time range")
  const protocol = await readObserveProtocol(fixture.baseURL)
  const calls = assertObserveMCP(protocol, ["query_metrics"])
  assert.ok(calls.some(call => call.tool === "query_metrics" && call.arguments.provider === fixture.providerRef && call.arguments.query === query && Date.parse(call.arguments.start) === Date.parse(fixedRange.from) && Date.parse(call.arguments.end) === Date.parse(fixedRange.to) && call.arguments.step_seconds === 12))
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
async function showReading(service, factor = 1, decimals = 2) {
  const value = readings[services.indexOf(service)] * factor
  const reading = tile().locator("[data-stat-reading] [data-metric-value]")
  await until(async () => Number(await reading.getAttribute("data-metric-value").catch(() => NaN)) === value, `Expected ${service} latest value ${value}`)
  await until(async () => (await reading.innerText()).replace(/\s+/g, "") === `${value.toFixed(decimals)}req/s`, `Expected ${decimals} decimal places in the live stat`)
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
  const build = spawn("go", ["build", "-o", binary, "./hack/insights-observe-e2e"], { cwd: repository, stdio: "inherit" })
  assert.equal((await once(build, "exit"))[0], 0, "Authoring integration fixture must build")
  await startFixture()
  browser = await chromium.launch({ headless: true })
  await openBrowser()

  await check("Observe advertises authoring tools separately from provider reads", async () => {
    const listed = await rpc("tools/list", {}, fixture.mcpToken)
    assert.equal(listed.error, undefined)
    for (const name of ["create_saved_query", "update_saved_query", "patch_saved_query", "create_dashboard", "update_dashboard", "patch_dashboard"]) {
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
    assert.equal(listed.result.tools.find(tool => tool.name === "get_insights_schema")?.annotations.readOnlyHint, true)
    return { authoringTools: 6, provider: metricProvider.providerRef, credentialsExposed: false }
  })
  await check("Read-only MCP schema discovery describes complete authoring documents and usable examples", async () => {
    for (const kind of ["dashboard", "widget", "saved_query"]) {
      const result = await tool("get_insights_schema", { kind }, fixture.mcpViewerToken)
      assert.equal(result.schemaVersion, 1); assert.equal(result.kind, kind)
      assert.equal(schemaNode(result.schema).type, "object")
      assert.equal(schemaNode(result.schema).additionalProperties, false)
      assert.ok(result.examples.length && result.notes.length)
      assert.ok(result.examples.every(example => example && typeof example === "object" && !Array.isArray(example)))
      schemas[kind] = result
      assert.deepEqual((await api(`schemas/${kind}`)).document, result)
    }
    const widget = schemas.widget.schema, query = schemas.saved_query.schema, board = schemas.dashboard.schema
    assert.equal(schemaProperty(widget, "options", "decimals").maximum, 8)
    assert.equal(schemaProperty(widget, "options", "showSparkline").type, "boolean")
    assert.equal(schemaProperty(widget, "layout", "w").maximum, 12)
    for (const name of ["queryRef", "drilldowns", "options", "layout"]) assert.ok(schemaProperty(widget, name))
    for (const name of ["description", "imageUrl", "tags", "metadata", "parameters"]) assert.ok(schemaProperty(query, name))
    assert.equal(schemaProperty(query, "tags").maxItems, 12)
    assert.equal(schemaProperty(board, "widgets").maxItems, 48)
    assert.ok(schemaProperty(board, "variables")); assert.ok(schemaProperty(board, "customTimeRange"))
    const notes = schemas.widget.notes.join("\n")
    for (const term of ["display=status-badge", "barColorMode=gradient|value", "colorField?:string,colorMin?:number,colorMax?:number", "options.staleAfterSeconds"]) assert.ok(notes.includes(term), `Missing chart authoring contract: ${term}`)
    assert.ok(schemas.widget.examples.find(example => example.id === "service-capacity"))
    assert.ok(schemas.widget.examples.find(example => example.id === "market-composition"))
    await rejectedTool("get_insights_schema", { kind: "unknown" }, fixture.mcpToken)
    await rejectedTool("get_insights_schema", { kind: "dashboard" }, fixture.mcpNoInsightsToken, /permission|forbidden|denied/i)
    return { kinds: Object.keys(schemas), completeNestedSchemas: true, readOnlyViewerAllowed: true, noInsightsCallerDenied: true }
  })
  await check("Discovered record chart examples survive conditional MCP edits", async () => {
    // The local fixture exposes a metrics provider; these examples exercise
    // document authoring only, so their illustrative records queries are not run.
    const examples = ["service-capacity", "market-composition"].map(id => ({ ...schemas.widget.examples.find(widget => widget.id === id), providerId: metricProvider.id }))
    const document = { schemaVersion: 1, id: "mcp-record-chart-examples", title: "Record chart examples", timeRange: "1h", refreshInterval: 0, widgets: examples }
    const created = verifyDocumentResult(await tool("create_dashboard", { document }), document)
    try {
      const patch = { id: document.id, etag: created.etag, widget_edits: [{ op: "update", id: "market-composition", patch: { config: { colorMax: 30 } } }] }
      const updated = await tool("patch_dashboard", patch)
      assert.notEqual(updated.etag, created.etag)
      assert.equal(updated.document.widgets[1].config.colorMax, 30)
      assert.equal(updated.document.widgets[1].config.group, "sector")
      assert.equal(updated.document.widgets[0].config.cellStyles[1].display, "status-badge")
      await rejectedConflict("patch_dashboard", patch)
      const saved = await api(`dashboards/${document.id}`)
      assert.equal(saved.etag, updated.etag)
      assert.deepEqual(saved.document, updated.document)
      return { chartConfigsRetained: true, staleWriteRejected: true }
    } finally {
      const saved = await api(`dashboards/${document.id}`)
      const deleted = await http(`dashboards/${document.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${fixture.token}`, "If-Match": saved.etag } })
      assert.ok(deleted.ok, `Clean up isolated authoring fixture: ${deleted.status}`)
    }
  })
  // Use the advertised canonical examples as the starting point, binding their
  // illustrative provider and document IDs to this authenticated workspace.
  const saved = { ...schemas.saved_query.examples[0], schemaVersion: 1, id: "mcp-service-rate", name: "MCP service request rate", description: "Created through Observe MCP.", imageUrl: "/brand/paprika-mark.png", tags: ["mcp", "service"], metadata: { owner: "platform", tier: "critical", temporary: "remove with null" }, providerId: metricProvider.id, kind: "metrics", query: template, parameters: [{ name: "service", type: "string", defaultValue: services[0] }] }
  const dashboard = { ...schemas.dashboard.examples[0], schemaVersion: 1, id: "mcp-authoring-flow", title: "MCP authored dashboard", description: "Shared documents, created without a UI write.", timeRange: "1h", customTimeRange: fixedRange, refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: services[0], options: services }], widgets: [{ ...schemas.widget.examples[0], id: "selected-service", title: "Selected service request rate", type: "stat", providerId: metricProvider.id, query: "must_not_execute", queryRef: { id: saved.id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, unit: "req/s", color: "#557EAA", options: { decimals: 2, showSparkline: true, showTooltip: true, tooltipView: { type: "stat", decimals: 2, showSparkline: true, source: { type: "widget" } } }, layout: { x: 0, y: 0, w: 6, h: 4 } }] }
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
  await check("Targeted saved-query metadata merges preserve execution fields and remove optional fields with null", async () => {
    const before = queryEntry
    const patch = { description: "Metadata patched through Observe MCP.", tags: ["mcp", "patched"], imageUrl: null, metadata: { owner: "observability", temporary: null } }
    const document = { ...before.document, description: patch.description, tags: patch.tags, metadata: { owner: "observability", tier: "critical" } }
    delete document.imageUrl
    queryEntry = verifyDocumentResult(await tool("patch_saved_query", { id: saved.id, etag: before.etag, patch }), document)
    assert.notEqual(queryEntry.etag, before.etag)
    await unchanged("dashboards", dashboardEntry)
    await openExplorer()
    const picker = explorer().getByRole("combobox", { name: "Open saved query", exact: true })
    await picker.click()
    const option = page.getByRole("option").filter({ hasText: queryEntry.document.name })
    await option.getByText("patched", { exact: true }).waitFor()
    await option.click()
    await until(async () => await explorer().getByRole("textbox", { name: "Query description", exact: true }).inputValue() === patch.description, "Patched saved-query metadata did not appear in the query editor")
    await page.screenshot({ path: join(output, "patched-query-metadata.png"), fullPage: false })
    await page.locator("#insights-navigation").getByRole("button", { name: dashboardEntry.document.title, exact: true }).click()
    await page.getByRole("heading", { name: dashboardEntry.document.title, exact: true }).waitFor()
    await showReading(services[0], 2)
    return { preserved: ["id", "providerId", "kind", "query", "parameters", "metadata.tier"], removed: ["imageUrl", "metadata.temporary"], tagsReplaced: true, dropdownAndEditorRefreshed: true }
  })
  await check("Targeted expression patches requery the real provider and refresh values and full sparkline history", async () => {
    const original = queryEntry, before = await showReading(services[0], 2), firstResponse = queryResponses.length
    const document = { ...original.document, query: template }
    queryEntry = verifyDocumentResult(await tool("patch_saved_query", { id: saved.id, etag: original.etag, patch: { query: template } }), document)
    const after = await showReading(services[0])
    assert.equal(after.min * 2, before.min); assert.equal(after.max * 2, before.max)
    await assertQueryCall(template.replace("{{service}}", JSON.stringify(services[0])), firstResponse)
    await rejectedConflict("patch_saved_query", { id: saved.id, etag: original.etag, patch: { description: "Stale targeted writer" } })
    await unchanged("saved-queries", queryEntry); await unchanged("dashboards", dashboardEntry)
    const restoreResponse = queryResponses.length
    queryEntry = verifyDocumentResult(await tool("patch_saved_query", { id: saved.id, etag: queryEntry.etag, patch: { query: original.document.query } }), original.document)
    await showReading(services[0], 2)
    await assertQueryCall(original.document.query.replace("{{service}}", JSON.stringify(services[0])), restoreResponse)
    return { before, after, exactMCPProviderCalls: true, unchangedMetadataAndParameters: true, dashboardUnchanged: true, stalePatchRejected: true }
  })
  await check("Targeted dashboard metadata and widget edits refresh the UI while preserving sibling fields", async () => {
    const before = dashboardEntry
    const sibling = { ...structuredClone(before.document.widgets[0]), id: "untouched-sibling", title: "Unchanged sibling", description: "This widget must survive targeted edits intact.", queryRef: { id: saved.id, bindings: [{ parameter: "service", source: "constant", value: services[1] }] }, layout: { x: 6, y: 0, w: 6, h: 4 } }
    const added = { ...before.document, description: "Targeted dashboard description.", folder: "MCP/Targeted edits", widgets: [...before.document.widgets, sibling] }
    dashboardEntry = verifyDocumentResult(await tool("patch_dashboard", { id: dashboard.id, etag: before.etag, patch: { description: added.description, folder: added.folder }, widget_edits: [{ op: "add", widget: sibling }] }), added)
    await page.getByText(added.description, { exact: true }).waitFor()
    const siblingTile = page.locator('[data-widget-id="untouched-sibling"]')
    await siblingTile.waitFor()
    await until(async () => Number(await siblingTile.locator("[data-stat-reading] [data-metric-value]").getAttribute("data-metric-value").catch(() => NaN)) === readings[1] * 2, "Added saved-query widget did not execute its constant binding")
    const initialHeight = (await tile().boundingBox()).height
    const widget = { ...added.widgets[0], title: "Patched service request rate", options: { ...added.widgets[0].options, decimals: 3 }, layout: { ...added.widgets[0].layout, h: 3 } }
    const document = { ...added, widgets: [widget, sibling] }
    dashboardEntry = verifyDocumentResult(await tool("patch_dashboard", { id: dashboard.id, etag: dashboardEntry.etag, widget_edits: [{ op: "update", id: widget.id, patch: { title: widget.title, options: { decimals: 3 }, layout: { h: 3 } } }] }), document)
    await tile().getByText(widget.title, { exact: true }).waitFor()
    const reading = await showReading(services[0], 2, 3)
    await until(async () => (await tile().boundingBox()).height < initialHeight, "The live widget layout did not adopt the targeted height")
    await unchanged("saved-queries", queryEntry)
    await page.screenshot({ path: join(output, "patched-widget-layout.png"), fullPage: false })
    return { addedWidgetExecuted: true, nestedOptionsAndLayoutMerged: true, siblingUnchanged: true, preserved: ["queryRef", "options.tooltipView", "color", "variables", "customTimeRange"], reading }
  })
  await check("Targeted binding replacement updates one widget without changing the shared service default", async () => {
    const before = dashboardEntry, previousWidget = before.document.widgets[0]
    const bindings = [{ parameter: "service", source: "constant", value: services[1] }]
    const widget = { ...previousWidget, options: { ...previousWidget.options, decimals: 2 }, queryRef: { ...previousWidget.queryRef, bindings } }
    const document = { ...before.document, widgets: [widget, ...before.document.widgets.slice(1)] }
    dashboardEntry = verifyDocumentResult(await tool("patch_dashboard", { id: dashboard.id, etag: before.etag, widget_edits: [{ op: "update", id: widget.id, patch: { queryRef: { bindings }, options: { decimals: 2 } } }] }), document)
    await showReading(services[1], 2)
    assert.equal(dashboardEntry.document.variables[0].defaultValue, services[0])
    await unchanged("saved-queries", queryEntry)
    const restored = { ...document, widgets: [{ ...widget, queryRef: previousWidget.queryRef }, ...document.widgets.slice(1)] }
    dashboardEntry = verifyDocumentResult(await tool("patch_dashboard", { id: dashboard.id, etag: dashboardEntry.etag, widget_edits: [{ op: "update", id: widget.id, patch: { queryRef: { bindings: previousWidget.queryRef.bindings } } }] }), restored)
    await showReading(services[0], 2)
    return { bindingsArrayReplaced: true, savedDefaultUnchanged: true, savedQueryUnchanged: true, variableBindingRestored: true, twoDecimalSparklineRestored: true }
  })
  await check("Targeted edits enforce scopes, exact versions, immutable identities and atomic validation", async () => {
    const board = dashboardEntry, query = queryEntry
    for (const token of [fixture.mcpToken, fixture.mcpDeniedWriteToken]) {
      await rejectedTool("patch_dashboard", { id: dashboard.id, etag: board.etag, patch: { title: "Unauthorized dashboard" } }, token)
      await rejectedTool("patch_saved_query", { id: saved.id, etag: query.etag, patch: { name: "Unauthorized query" } }, token)
    }
    for (const etag of [undefined, "", "*", `W/${board.etag}`]) await rejectedTool("patch_dashboard", { id: dashboard.id, etag, patch: { title: "Missing exact version" } })
    for (const etag of [undefined, "", "*", `W/${query.etag}`]) await rejectedTool("patch_saved_query", { id: saved.id, etag, patch: { name: "Missing exact version" } })
    for (const patch of [{ id: "changed-id" }, { schemaVersion: 2 }, { widgets: [] }, { title: null }, {}, { description: board.document.description }, { unknownField: "invalid" }]) {
      await rejectedTool("patch_dashboard", { id: dashboard.id, etag: board.etag, patch })
      await unchanged("dashboards", board)
    }
    for (const patch of [{ id: "changed-id" }, { schemaVersion: 2 }, { providerId: "changed-provider" }, { kind: "traces" }, { query: null }, {}, { imageUrl: null }, { name: query.document.name }, { tags: ["same", "same"] }]) {
      await rejectedTool("patch_saved_query", { id: saved.id, etag: query.etag, patch })
      await unchanged("saved-queries", query)
    }
    const firstID = board.document.widgets[0].id
    const invalidEdits = [
      [{ op: "update", id: firstID, patch: { id: "renamed-widget" } }],
      [{ op: "update", id: firstID, patch: { options: { decimals: 9 } } }],
      [{ op: "update", id: firstID, patch: { layout: { x: 11, w: 2 } } }],
      [{ op: "update", id: firstID, patch: { title: "Must roll back" } }, { op: "remove", id: "missing-widget" }],
      [{ op: "add", widget: { ...board.document.widgets[0], id: "must-not-be-added" } }, { op: "update", id: firstID, patch: { options: { min: 10, max: 1 } } }],
      [{ op: "update", id: firstID, patch: { title: "First edit" } }, { op: "remove", id: firstID }],
      [{ op: "add", widget: board.document.widgets[0] }],
      Array.from({ length: 49 }, (_, index) => ({ op: "remove", id: `missing-${index}` })),
    ]
    for (const widget_edits of invalidEdits) {
      await rejectedTool("patch_dashboard", { id: dashboard.id, etag: board.etag, patch: { description: "Must also roll back" }, widget_edits })
      await unchanged("dashboards", board)
    }
    await unchanged("saved-queries", query)
    return { scopeAndRBACEnforced: true, exactStrongETagRequired: true, immutableIdentities: true, noOpsRejected: true, invalidBatches: invalidEdits.length, noPartialMutation: true }
  })
  await check("Concurrent targeted edits commit one revision and preserve the actionable conflict boundary", async () => {
    const before = dashboardEntry
    const patches = [{ description: "Concurrent writer A" }, { description: "Concurrent writer B" }]
    const results = await Promise.all(patches.map(patch => rpc("tools/call", { name: "patch_dashboard", arguments: { id: dashboard.id, etag: before.etag, patch } })))
    assert.ok(results.every(result => result.error === undefined))
    const successes = results.filter(result => !result.result.isError)
    const conflicts = results.filter(result => result.result.isError)
    assert.equal(successes.length, 1); assert.equal(conflicts.length, 1)
    assert.match(conflicts[0].result.content.filter(item => item.type === "text").map(item => item.text).join("\n"), /get the latest document and ETag/)
    const winningIndex = results.indexOf(successes[0]), document = { ...before.document, ...patches[winningIndex] }
    dashboardEntry = verifyDocumentResult(structured(successes[0].result), document)
    await unchanged("dashboards", dashboardEntry)
    await page.getByText(document.description, { exact: true }).waitFor()
    await rejectedConflict("patch_dashboard", { id: dashboard.id, etag: before.etag, patch: { title: "Stale patch writer" } })
    return { successfulWriters: 1, actionableConflicts: 1, unrelatedWidgetFieldsPreserved: true }
  })
  await check("Targeted removal deletes only the named widget and optional dashboard field", async () => {
    const before = dashboardEntry, document = { ...before.document, widgets: before.document.widgets.filter(widget => widget.id !== "untouched-sibling") }
    delete document.description
    dashboardEntry = verifyDocumentResult(await tool("patch_dashboard", { id: dashboard.id, etag: before.etag, patch: { description: null }, widget_edits: [{ op: "remove", id: "untouched-sibling" }] }), document)
    await page.locator('[data-widget-id="untouched-sibling"]').waitFor({ state: "detached" })
    await showReading(services[0], 2)
    await unchanged("saved-queries", queryEntry)
    return { remainingWidgets: document.widgets.length, optionalFieldRemoved: true, remainingWidgetUnchanged: true, noCascadeToSavedQuery: true }
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
    dashboardEntry = verifyDocumentResult(await tool("patch_dashboard", { id: dashboard.id, etag: dashboardEntry.etag, patch: { title: document.title } }), document)
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
    queryEntry = verifyDocumentResult(await tool("patch_saved_query", { id: saved.id, etag: queryEntry.etag, patch: { description: document.description, tags: document.tags } }), document)
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
  const currentProtocol = await readObserveProtocol(fixture.baseURL)
  assertObserveMCP({ gateway: [...protocolHistory.flatMap(receipt => receipt.gateway), ...currentProtocol.gateway] }, ["list_observability_providers", "query_metrics", "get_insights_schema", "create_saved_query", "update_saved_query", "patch_saved_query", "create_dashboard", "update_dashboard", "patch_dashboard"])
  console.log(`PASS ${reports.length} MCP authoring scenarios`)
} catch (error) {
  console.error(error.stack ?? error.message)
  process.exitCode = 1
} finally {
  await context?.close(); await browser?.close(); await stopFixture()
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "report.json"), JSON.stringify({ timestamp: new Date().toISOString(), reports, pageErrors, protocolHistory, browserWrites: writes, documentReads, queryRequests: queryResponses.map(({ status, request, body }) => ({ status, providerId: request.providerId, query: request.query, series: body.series?.length })) }, null, 2))
  for (const value of Object.values(fixture ?? {})) if (typeof value === "string" && value.split(".").length === 3 && value.startsWith("eyJ")) outputLog = outputLog.replaceAll(value, "[redacted token]")
  await writeFile(join(output, "fixture.log"), outputLog)
  await rm(temporary, { recursive: true, force: true })
}
