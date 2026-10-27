// Real authenticated Insights -> Observe MCP -> application connectors. Shorted
// and Uptime use local HTTP sources; PostgreSQL uses a disposable real database.
// Optional live Uptime reads use the existing source E2E password login only.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { assertObserveMCP, readObserveProtocol } from "./observe-protocol.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const temporary = await mkdtemp(join(tmpdir(), "paprika-application-records-"))
const output = join(repository, "artifacts/insights/application-records")
const binary = join(temporary, "observe-e2e"), ready = join(temporary, "ready.json")
const container = process.env.PAPRIKA_POSTGRES_CONTAINER || "paprika-postgresql-connector-test"
const port = Number(process.env.PAPRIKA_POSTGRES_PORT || 61811)
const unique = Date.now(), schema = `paprika_records_${unique}`, role = `paprika_records_reader_${unique}`
const password = randomUUID()
const services = ["ab64147d-1ffb-4850-916a-56b5146cb7ad", "ab64147d-1ffb-4850-916a-56b5146cb7ae"]
const reports = [], pageErrors = []
let child, browser, page, fixture, rpcID = 0, databaseCreated = false

async function command(name, args, input) {
  const process = spawn(name, args, { cwd: repository, stdio: ["pipe", "pipe", "pipe"] })
  let stdout = ""
  process.stdout.on("data", data => { stdout += data })
  process.stderr.resume() // Setup diagnostics may include ephemeral credentials.
  process.stdin.end(input)
  const [code] = await once(process, "exit")
  if (code !== 0) throw new Error(`${name} failed (${code}); captured diagnostics are withheld because setup may contain ephemeral credentials`)
  return stdout
}
async function sql(statement) {
  return command("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"], statement)
}
async function until(check, message, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)) }
  throw new Error(message)
}
async function check(name, run) {
  const evidence = await run()
  reports.push({ name, passed: true, evidence })
  console.log(`PASS ${name}`)
}
async function preparePostgres() {
  assert.ok(Number.isInteger(port) && port > 0 && port <= 65535)
  databaseCreated = true
  await sql(`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE SCHEMA ${schema};
CREATE TABLE ${schema}.signals(service text, uptime double precision, observed_at timestamptz);
INSERT INTO ${schema}.signals VALUES ('${services[0]}',99.97,'2026-10-27T01:00:00Z'),('${services[1]}',98.21,'2026-10-27T01:00:00Z');
GRANT USAGE ON SCHEMA ${schema} TO ${role};
GRANT SELECT ON ${schema}.signals TO ${role};`)
  return { name: "warehouse", type: "postgresql", config: { host: "127.0.0.1", port, database: "postgres", sslmode: "disable" }, credentials: { username: role, password } }
}
async function optionalLiveUptime() {
  if (!process.env.UPTIME_E2E_ENV_FILE) return undefined
  const fields = {}
  for (const line of (await readFile(process.env.UPTIME_E2E_ENV_FILE, "utf8")).split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    fields[match[1]] = value
  }
  const endpoint = process.env.UPTIME_E2E_API_URL || "https://api.telesis.dev"
  const url = new URL(endpoint)
  assert.ok(url.origin === "https://api.telesis.dev" || ["127.0.0.1", "localhost"].includes(url.hostname), "Live credentials may only reach the source-declared production API or loopback")
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(fields.NEXT_PUBLIC_FIREBASE_API_KEY)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ email: fields.E2E_TEST_USER_EMAIL, password: fields.E2E_TEST_USER_PASSWORD, returnSecureToken: true }),
  })
  assert.equal(response.status, 200, `Existing Uptime account login failed: HTTP ${response.status}`)
  const session = await response.json()
  assert.equal(typeof session.idToken, "string")
  assert.equal(typeof session.refreshToken, "string")
  return { name: "uptime-live", type: "uptime", config: { endpoint, orgId: fields.E2E_ORG_ID }, credentials: { apiKey: fields.NEXT_PUBLIC_FIREBASE_API_KEY, refreshToken: session.refreshToken } }
}
async function startFixture(providers) {
  await command("go", ["build", "-o", binary, "./hack/insights-observe-e2e"])
  child = spawn(binary, [`--ready-file=${ready}`, `--data-dir=${join(temporary, "data")}`, `--ui-dir=${join(repository, "ui/out")}`, "--application-fixtures", "--application-providers-stdin", ...(process.env.INSIGHTS_E2E_URL ? [`--ui-url=${process.env.INSIGHTS_E2E_URL}`] : [])], { cwd: repository, stdio: ["pipe", "ignore", "ignore"] })
  child.stdin.end(JSON.stringify(providers))
  await until(async () => { if (child.exitCode !== null) throw new Error("Application fixture exited"); try { fixture = JSON.parse(await readFile(ready, "utf8")); return true } catch { return false } }, "Application fixture did not start")
}
async function rpc(name, args, token = fixture.mcpWriteToken) {
  const id = ++rpcID
  const response = await fetch(fixture.mcpURL, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }), signal: AbortSignal.timeout(30_000) })
  assert.equal(response.status, 200, `${name} HTTP status`)
  const body = await response.text()
  return response.headers.get("content-type")?.includes("text/event-stream") ? body.split("\n").filter(line => line.startsWith("data: ")).map(line => JSON.parse(line.slice(6))).find(item => item.id === id) : JSON.parse(body)
}
async function tool(name, args, token) {
  const response = await rpc(name, args, token)
  assert.equal(response.error, undefined, `${name} protocol failure`)
  assert.notEqual(response.result?.isError, true, `${name} tool failure: ${JSON.stringify(response.result?.content)}`)
  return response.result.structuredContent ?? JSON.parse(response.result.content.find(item => item.type === "text").text)
}
async function api(path) {
  const response = await fetch(`${fixture.baseURL}/api/insights/${path}`, { headers: { Authorization: `Bearer ${fixture.token}` }, signal: AbortSignal.timeout(20_000) })
  assert.equal(response.status, 200)
  return { document: await response.json(), etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") }
}
function ref(id) { return { id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] } }
function recordWidget(id, providerId, queryRef, x, y) {
  return { id, title: id, type: "plugin", pluginId: "record-table", dataKind: "records", providerId, query: "dormant_query_must_not_execute", queryRef, unit: "", options: {}, layout: { x, y, w: 6, h: 4 } }
}
function recordValue(bundle, id, column) {
  const widget = bundle.widgets.find(widget => widget.id === id)
  assert.ok(widget.signalId)
  const records = bundle.signals.find(signal => signal.id === widget.signalId).records
  const index = records.columns.findIndex(item => item.key === column)
  assert.ok(index >= 0)
  return records.rows.map(row => row[index])
}

try {
  await mkdir(output, { recursive: true })
  const providers = [await preparePostgres()]
  const live = await optionalLiveUptime()
  if (live) providers.push(live)
  await startFixture(providers)
  const discovered = (await tool("list_insights_providers", {})).providers
  const byType = type => { const provider = discovered.find(item => item.providerRef === `observability/${type}`); assert.ok(provider, `${type} discovered`); return provider.id }
  const uptime = byType("uptime"), shorted = byType("shorted"), postgres = byType("warehouse")
  const params = [{ name: "service", type: "string", defaultValue: services[0] }]
  const base = { schemaVersion: 1, parameters: params, tags: ["application-e2e"], metadata: { fixture: "read-only" } }
  const queries = [
    { ...base, id: "uptime-records", name: "Uptime SLO records", providerId: uptime, kind: "records", query: '{"operation":"slo","args":{"serviceId":{{service}},"windowDays":30}}' },
    { ...base, id: "uptime-stat", name: "Uptime current SLO", providerId: uptime, kind: "metrics", query: '{"operation":"slo","args":{"serviceId":{{service}},"windowDays":30},"projection":{"value":"uptime","labels":["serviceId"]}}' },
    { ...base, parameters: [], id: "shorted-records", name: "Shorted positions", providerId: shorted, kind: "records", query: '{"operation":"top_shorts"}' },
    { ...base, id: "postgres-records", name: "Database service SLO", providerId: postgres, kind: "records", query: `{"sql":"SELECT service, uptime, observed_at FROM ${schema}.signals WHERE service=$1","parameters":[{{service}}]}` },
  ]
  const entries = new Map()
  await check("Saved application queries are authored via MCP and visible through the UI API", async () => {
    for (const query of queries) { const entry = await tool("create_saved_query", { document: query }); entries.set(query.id, entry); assert.deepEqual(await api(`saved-queries/${query.id}`), { document: query, etag: entry.etag }) }
    return { queries: queries.length, types: ["uptime", "shorted", "postgresql"], exactETags: true }
  })
  const dashboard = { schemaVersion: 1, id: "application-records-flow", title: "Application records integration", timeRange: "1h", refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: services[0], options: services }], widgets: [
    { id: "uptime-stat", title: "Selected service uptime", type: "stat", providerId: uptime, query: "dormant_query_must_not_execute", queryRef: ref("uptime-stat"), unit: "%", options: { decimals: 2, showSparkline: true }, layout: { x: 0, y: 0, w: 6, h: 3 } },
    recordWidget("uptime-table", uptime, ref("uptime-records"), 6, 0),
    recordWidget("shorted-table", shorted, { id: "shorted-records", bindings: [] }, 0, 4),
    recordWidget("postgres-table", postgres, ref("postgres-records"), 6, 4),
  ] }
  let board = await tool("create_dashboard", { document: dashboard })
  const range = { start: "2026-10-27T00:30:00Z", end: "2026-10-27T01:30:00Z" }
  await check("Shared service bindings query real PostgreSQL and application sources through Observe MCP", async () => {
    for (const [index, service] of services.entries()) {
      const bundle = await tool("query_dashboard", { id: dashboard.id, variables: { service }, ...range })
      assert.equal(bundle.state, "ok")
      assert.deepEqual(recordValue(bundle, "uptime-table", "serviceId"), [service])
      assert.deepEqual(recordValue(bundle, "postgres-table", "service"), [service])
      assert.deepEqual(recordValue(bundle, "postgres-table", "uptime"), [index ? 98.21 : 99.97])
      assert.deepEqual(recordValue(bundle, "shorted-table", "product_code"), ["CBA", "BHP"])
      assert.equal(bundle.dashboard.etag, board.etag)
    }
    return { serviceSelections: 2, queriesPerSelection: 4, postgres: "real disposable PostgreSQL", sources: "read-only HTTP fixtures" }
  })
  await check("Targeted query and dashboard patches preserve ETags and unrelated fields", async () => {
    const before = entries.get("uptime-records")
    const patched = await tool("patch_saved_query", { id: before.document.id, etag: before.etag, patch: { query: before.document.query.replace('"windowDays":30', '"windowDays":7'), description: "Patched over MCP" } })
    assert.notEqual(patched.etag, before.etag)
    assert.deepEqual(patched.document.metadata, before.document.metadata)
    assert.deepEqual(await api(`saved-queries/${before.document.id}`), { document: patched.document, etag: patched.etag })
    const stale = await rpc("patch_saved_query", { id: before.document.id, etag: before.etag, patch: { name: "must not win" } })
    assert.equal(stale.result.isError, true)
    const previous = board
    board = await tool("patch_dashboard", { id: dashboard.id, etag: board.etag, widget_edits: [{ op: "update", id: "uptime-table", patch: { title: "Uptime source rows" } }] })
    assert.deepEqual(board.document.widgets[3], previous.document.widgets[3])
    assert.deepEqual(await api(`dashboards/${dashboard.id}`), { document: board.document, etag: board.etag })
    const bundle = await tool("query_dashboard", { id: dashboard.id, ...range })
    assert.equal(bundle.savedQueries.find(item => item.id === before.document.id).etag, patched.etag)
    assert.equal(recordValue(bundle, "uptime-table", "windowDays")[0], 7)
    return { staleWriteRejected: true, unrelatedWidgetPreserved: true, patchedSourceWindow: 7 }
  })
  await check("SQL bindings remain data and source rows survive a hostile service parameter", async () => {
    const hostile = `x'); DELETE FROM ${schema}.signals; -- {{service}}`
    const result = await tool("query_records", { provider: "observability/warehouse", query: JSON.stringify({ sql: `SELECT service FROM ${schema}.signals WHERE service=$1`, parameters: [hostile] }) })
    assert.equal(result.state, "OK"); assert.equal(result.data.rows.length, 0)
    assert.equal((await sql(`SELECT count(*) FROM ${schema}.signals;`)).trim(), "2")
    return { emptyMatch: true, sourceRows: 2 }
  })
  if (live) await check("Existing Uptime account reads the real organization through the connector and MCP", async () => {
    const counts = {}
    for (const operation of ["services", "slo", "reliability_summary"]) {
      const result = await tool("query_records", { provider: "observability/uptime-live", query: JSON.stringify({ operation, args: { limit: 3 } }), limit: 3 })
      assert.equal(result.state, "OK"); assert.ok(Array.isArray(result.data.columns)); assert.ok(Array.isArray(result.data.rows))
      counts[operation] = { rows: result.data.rows.length, truncated: !!result.data.truncated }
    }
    return { authentication: "existing Firebase account login followed by connector refresh-token exchange", operations: counts, mutations: 0 }
  })
  if (!process.env.INSIGHTS_SKIP_BROWSER) await check("Record tables, stat filters and MCP updates render in light and dark mode", async () => {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({ viewport: { width: 1512, height: 1080 }, reducedMotion: "reduce" })
    await context.addInitScript(({ origin, token }) => { if (location.origin === origin) localStorage.setItem("paprika_id_token", token) }, { origin: fixture.baseURL, token: fixture.token })
    page = await context.newPage(); page.on("pageerror", error => pageErrors.push(error.message))
    await page.goto(`${fixture.baseURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "domcontentloaded" })
    const reading = page.locator('[data-widget-id="uptime-stat"] [data-metric-value]')
    await until(async () => await reading.getAttribute("data-metric-value").catch(() => null) === "99.97", "Uptime metric did not render")
    await page.locator('[data-widget-id="shorted-table"]').getByText("CBA", { exact: true }).waitFor()
    for (const theme of ["Light", "Dark"]) {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      await selectGammaOption(page, page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: "Service", exact: true }), services[1])
      await until(async () => await reading.getAttribute("data-metric-value").catch(() => null) === "98.21", "Service filter did not update Uptime")
      await page.locator('[data-widget-id="postgres-table"]').getByText(services[1], { exact: true }).waitFor()
      await page.screenshot({ path: join(output, `records-${theme.toLowerCase()}.png`), fullPage: false })
    }
    board = await tool("patch_dashboard", { id: dashboard.id, etag: board.etag, widget_edits: [{ op: "update", id: "uptime-table", patch: { title: "MCP synchronized records" } }] })
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")) })
    await page.getByText("MCP synchronized records", { exact: true }).waitFor({ timeout: 30_000 })
    assert.deepEqual(pageErrors, [])
    return { themes: ["light", "dark"], serviceFilter: true, recordRows: true, MCPRefresh: true, pageErrors: 0 }
  })
  if (!process.env.INSIGHTS_SKIP_BROWSER) await check("Native SQL and application JSON editors bind parameters, save and add record widgets", async () => {
    const explorer = () => page.getByRole("region", { name: "Data source explorer", exact: true })
    const results = () => page.getByRole("region", { name: "Explore query results", exact: true })
    async function openExplorer() {
      const navigation = page.locator("#insights-navigation")
      if (!await navigation.isVisible()) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
      await navigation.getByRole("button", { name: /^Explore\b/ }).click()
      await explorer().getByRole("heading", { name: "Explore", exact: true }).waitFor()
    }
    async function selectQuery(providerId, name) {
      await selectGammaOption(page, explorer().getByRole("combobox", { name: "Explore data source", exact: true }), discovered.find(provider => provider.id === providerId).name)
      await selectGammaOption(page, explorer().getByRole("combobox", { name: "Open saved query", exact: true }), name)
      await explorer().getByRole("textbox", { name: "Query name", exact: true }).waitFor()
    }
    async function runRecords(providerId, queryText) {
      const response = page.waitForResponse(response => {
        if (!response.url().endsWith("/api/insights/query") || response.request().method() !== "POST") return false
        const body = response.request().postDataJSON()
        return body.providerId === providerId && body.kind === "records" && body.query === queryText
      })
      await explorer().getByRole("button", { name: "Run query", exact: true }).click()
      const received = await response
      assert.equal(received.status(), 200)
      return received.json()
    }
    await openExplorer()
    await selectQuery(postgres, /Database service SLO/)
    const sqlEditor = explorer().getByRole("textbox", { name: "SQL query", exact: true })
    const bindings = explorer().getByRole("textbox", { name: "SQL parameters", exact: true })
    assert.equal(await bindings.innerText(), "[{{service}}]")
    assert.equal(await explorer().getByRole("textbox", { name: "SQL metric projection", exact: true }).count(), 0)
    assert.equal(await explorer().getByRole("textbox", { name: "PromQL query", exact: true }).count(), 0)
    await explorer().getByText("query_records", { exact: true }).waitFor()
    const sqlBody = `SELECT service, uptime + 0.01 AS uptime, observed_at FROM ${schema}.signals WHERE service=$1`
    await sqlEditor.fill("SELECT {{service}}")
    assert.ok(await explorer().getByRole("button", { name: "Run query", exact: true }).isDisabled())
    assert.ok(await explorer().getByRole("button", { name: "Save query", exact: true }).isDisabled())
    await sqlEditor.fill(sqlBody)
    await explorer().getByRole("textbox", { name: "Test value for service", exact: true }).fill(services[0])
    const queryDocument = await tool("get_saved_query", { id: "postgres-records" })
    // Editor whitespace is intentionally preserved by the document contract.
    const nativeTemplate = `{\n  "sql": ${JSON.stringify(sqlBody)},\n  "parameters": [{{service}}]\n}`
    const expectedSQLQuery = nativeTemplate.replace("{{service}}", JSON.stringify(services[0]))
    const recordResult = await runRecords(postgres, expectedSQLQuery)
    assert.deepEqual(recordResult.records.columns.map(column => column.key), ["service", "uptime", "observed_at"])
    assert.equal(recordResult.records.rows[0][0], services[0])
    assert.ok(Math.abs(recordResult.records.rows[0][1] - 99.98) < 1e-9)
    await results().getByText("99.98", { exact: true }).waitFor()
    await explorer().getByRole("textbox", { name: "Query description", exact: true }).fill("Native SQL edited with a separate typed service binding")
    await explorer().getByRole("button", { name: "Save query", exact: true }).click()
    await explorer().getByText("Query saved.", { exact: true }).waitFor()
    const savedSQL = await tool("get_saved_query", { id: "postgres-records" })
    assert.notEqual(savedSQL.etag, queryDocument.etag)
    assert.equal(savedSQL.document.query, nativeTemplate)
    assert.deepEqual(savedSQL.document.parameters, params)
    for (const theme of ["Light", "Dark"]) {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const expectedInk = theme === "Light" ? "rgb(28, 36, 48)" : "rgb(242, 244, 247)"
      await until(async () => await sqlEditor.evaluate(element => getComputedStyle(element.querySelector('.cm-line')).color) === expectedInk, `SQL theme did not settle in ${theme}`)
      const geometry = await bindings.evaluate(element => {
        const editor = element.closest('[data-query-code-editor]')
        const card = editor.closest('section')
        const line = document.querySelector('[data-language="sql"] .cm-line')
        return { bindingBottom: editor.getBoundingClientRect().bottom, cardBottom: card.getBoundingClientRect().bottom, color: getComputedStyle(line).color, ink: getComputedStyle(line).getPropertyValue('--gamma-ink').trim() }
      })
      assert.ok(geometry.bindingBottom <= geometry.cardBottom, `SQL bindings must remain visible in ${theme}`)
      assert.equal(geometry.color, expectedInk, "SQL identifiers use readable theme ink")
      await page.screenshot({ path: join(output, `sql-editor-${theme.toLowerCase()}.png`), fullPage: false })
    }
    await page.setViewportSize({ width: 390, height: 844 })
    for (const theme of ["Light", "Dark"]) {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      await until(async () => await sqlEditor.evaluate(element => getComputedStyle(element.querySelector('.cm-line')).color) === (theme === "Light" ? "rgb(28, 36, 48)" : "rgb(242, 244, 247)"), `Mobile SQL theme did not settle in ${theme}`)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "SQL workspace must not overflow horizontally on mobile")
      await sqlEditor.scrollIntoViewIfNeeded()
      await page.screenshot({ path: join(output, `sql-editor-mobile-${theme.toLowerCase()}.png`), fullPage: true })
    }
    await page.setViewportSize({ width: 1512, height: 1080 })
    await explorer().getByRole("button", { name: "Use in dashboard", exact: true }).click()
    await page.getByRole("heading", { name: "Widget settings", exact: true }).waitFor()
    await page.getByRole("button", { name: "Apply widget", exact: true }).click()
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await until(async () => (await tool("get_dashboard", { id: dashboard.id })).document.widgets.length === 5, "Saved records query was not added to the dashboard")
    board = await tool("get_dashboard", { id: dashboard.id })
    const added = board.document.widgets.find(widget => widget.queryRef?.id === "postgres-records" && widget.id !== "postgres-table")
    assert.ok(added)
    assert.equal(added.type, "plugin"); assert.equal(added.pluginId, "record-table"); assert.equal(added.dataKind, "records")
    assert.deepEqual(added.queryRef.bindings, [{ parameter: "service", source: "variable", variable: "service" }])
    await page.locator(`[data-widget-id="${added.id}"]`).getByText(services[1], { exact: true }).waitFor()
    await openExplorer()
    await selectQuery(uptime, /Uptime SLO records/)
    const jsonEditor = explorer().getByRole("textbox", { name: "JSON query", exact: true })
    assert.equal(await explorer().getByRole("tab", { name: "Builder", exact: true }).count(), 0)
    const jsonTemplate = '{"operation":"slo","args":{"serviceId":{{service}},"windowDays":14}}'
    await jsonEditor.fill(jsonTemplate)
    await explorer().getByRole("textbox", { name: "Test value for service", exact: true }).fill(services[0])
    const applicationResult = await runRecords(uptime, jsonTemplate.replace("{{service}}", JSON.stringify(services[0])))
    const windowIndex = applicationResult.records.columns.findIndex(column => column.key === "windowDays")
    assert.equal(applicationResult.records.rows[0][windowIndex], 14)
    await selectGammaOption(page, results().getByRole("combobox", { name: "Explore record visualization", exact: true }), "Record bar chart")
    await selectGammaOption(page, results().getByRole("combobox", { name: "Preview x column", exact: true }), "serviceId")
    await selectGammaOption(page, results().getByRole("combobox", { name: "Preview value column", exact: true }), "uptime")
    await results().locator("svg[role=group]").waitFor()
    await explorer().getByRole("button", { name: "Save query", exact: true }).click()
    await explorer().getByText("Query saved.", { exact: true }).waitFor()
    assert.equal((await tool("get_saved_query", { id: "uptime-records" })).document.query, jsonTemplate)
    for (const theme of ["Light", "Dark"]) {
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      await page.screenshot({ path: join(output, `application-editor-${theme.toLowerCase()}.png`), fullPage: false })
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    }
    assert.deepEqual(pageErrors, [])
    return { nativeSQL: true, typedBindings: true, unsafeTemplateBlocked: true, SQLRows: recordResult.records.rows.length, SQLValue: recordResult.records.rows[0][1], addedWidgetKind: added.dataKind, applicationWindowDays: 14, recordColumnMapping: true, themes: ["light", "dark"] }
  })
  const protocol = await readObserveProtocol(fixture.baseURL)
  assertObserveMCP(protocol, ["query_records", "query_metrics", "create_saved_query", "patch_saved_query", "create_dashboard", "patch_dashboard", "query_dashboard"])
  assert.ok(protocol.queries.some(item => item.path === "/uptimeapi.v1.ServiceService/GetSLODashboard"))
  assert.ok(protocol.queries.some(item => item.path === "/shorts.v1alpha1.MarketService/GetTopShorts"))
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: true, reports, liveUptime: !!live, browser: !process.env.INSIGHTS_SKIP_BROWSER, providerQueryMutations: 0 }, null, 2))
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {})
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: false, reports, error: error.message, pageErrors }, null, 2))
  throw error
} finally {
  await browser?.close()
  if (child && child.exitCode === null) {
    const ended = once(child, "exit"); child.kill("SIGTERM")
    const force = setTimeout(() => child.kill("SIGKILL"), 5000)
    await ended; clearTimeout(force)
  }
  let cleanupComplete = true
  if (databaseCreated) await sql(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP ROLE IF EXISTS ${role};`).catch(() => { cleanupComplete = false })
  await rm(temporary, { recursive: true, force: true })
  const reportPath = join(output, "report.json")
  const receipt = JSON.parse(await readFile(reportPath, "utf8"))
  receipt.cleanupComplete = cleanupComplete
  receipt.passed = receipt.passed && cleanupComplete
  await writeFile(reportPath, JSON.stringify(receipt, null, 2))
  if (!cleanupComplete) throw new Error("Ephemeral database fixture cleanup failed")
}
