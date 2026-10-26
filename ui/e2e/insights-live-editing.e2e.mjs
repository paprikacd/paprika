// Real Go storage/adapters + deterministic Prometheus/Tempo providers. The local
// gateway serves the final static UI and forwards API disconnects; production
// proxy auth/RBAC is verified independently by Go integration tests.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { parse as parseYaml } from "yaml"
import { selectGammaOption } from "./gamma-controls.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = join(repository, "artifacts/insights/live-editing")
const temporary = await mkdtemp(join(tmpdir(), "paprika-live-editing-"))
const binary = join(temporary, "insights")
const reports = [], providerRequests = [], pageErrors = [], screenshots = [], pending = []
const specialLabel = 'checkout"blue\\west\n{{text}}'
const fixedRange = { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }
let browser, context, page, service, serviceURL, servicePort, gatewayURL
let serviceOutput = ""

function json(response, status, body) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)) }
function matrix(end, value, name = "library_result") {
  return { status: "success", data: { resultType: "matrix", result: [{ metric: { __name__: name, service: "query-result" }, values: [[end - 60, String(value - 1)], [end, String(value)]] }] } }
}
const upstream = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost")
  const entry = { path: url.pathname, params: Object.fromEntries(url.searchParams), aborted: false, completed: false }
  providerRequests.push(entry)
  response.on("close", () => { entry.completed = response.writableEnded; entry.aborted = !response.writableEnded })
  const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? "", end = Number(url.searchParams.get("end"))
  if (url.pathname === "/prometheus/api/v1/query_range") {
    if (query === "parent_health" || query === "custom_retained") json(response, 200, { status: "success", data: { resultType: "matrix", result: [
      { metric: { __name__: "parent_health", signal: "quoted", service: specialLabel }, values: [[end - 60, "31"], [end - 0.25, "32"]] },
      { metric: { __name__: "parent_health", signal: "worker", service: "worker" }, values: [[end - 60, "41"], [end, "42"]] },
      { metric: { __name__: "parent_health", signal: "missing" }, values: [[end - 60, "51"], [end, "52"]] },
    ] } })
    else if (query === "sparkline_saved") json(response, 200, { status: "success", data: { resultType: "matrix", result: [
      { metric: { __name__: "sparkline_history", service: "api" }, values: [[end - 240, "-7.25"], [end - 180, "NaN"], [end - 120, "0"], [end - 60, "1234.5678"], [end, "NaN"]] },
    ] } })
    else if (query.startsWith("slow_probe") || (query.startsWith("slow_saved") && !query.includes('"worker"'))) pending.push({ response, entry, end })
    else if (query === "error_probe") json(response, 503, { error: "private-upstream-diagnostic" })
    else if (query === "empty_probe") json(response, 200, { status: "success", data: { resultType: "matrix", result: [] } })
    else json(response, 200, matrix(end, query.includes('"worker"') || query === "fast_probe" ? 222 : query.endsWith(" + 1") ? 124.5 : query.startsWith("child_saved") ? 111 : 123.5))
    return
  }
  if (url.pathname === "/prometheus/api/v1/label/__name__/values") return json(response, 200, { status: "success", data: ["up", "http_requests_total"] })
  if (url.pathname === "/prometheus/api/v1/labels") return json(response, 200, { status: "success", data: ["service", "job"] })
  if (url.pathname === "/prometheus/api/v1/series") return json(response, 200, { status: "success", data: [
    { __name__: "http_requests_total", service: "api", status: "200" },
    { __name__: "http_requests_total", service: "api", status: "500" },
    { __name__: "http_requests_total", service: "worker", status: "200" },
  ] })
  if (url.pathname === "/prometheus/api/v1/label/service/values") return json(response, 200, { status: "success", data: ["api", "worker"] })
  if (url.pathname === "/prometheus/api/v1/query") return json(response, 200, { status: "success", data: { resultType: "vector", result: [] } })
  if (url.pathname === "/tempo/api/search") return json(response, 200, { traces: [{ traceID: "abcdef0123456789abcdef0123456789", rootServiceName: "saved-trace-service", rootTraceName: "GET /saved-query", startTimeUnixNano: String(BigInt(end) * 1_000_000_000n), durationMs: 72.25 }] })
  if (url.pathname === "/tempo/api/search/tags") return json(response, 200, { tagNames: ["service.name"] })
  if (url.pathname === "/tempo/api/search/tag/service.name/values") return json(response, 200, { tagValues: ["api", "worker"] })
  if (url.pathname === "/tempo/api/echo") { response.end("echo"); return }
  json(response, 404, { error: "unexpected fixture path" })
})
const gateway = createServer((request, response) => {
  if (request.url === "/query-cover.svg") {
    response.writeHead(200, { "content-type": "image/svg+xml" }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#bd512d"/><path d="M10 40L24 22L38 34L54 12" stroke="#fff" fill="none" stroke-width="5"/></svg>'); return
  }
  const incoming = new URL(request.url, "http://localhost"), api = incoming.pathname.startsWith("/api/insights/")
  const target = new URL(api ? `${incoming.pathname.replace(/^\/api\/insights/, "/api")}${incoming.search}` : request.url, api ? serviceURL : baseURL)
  const forward = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
  forward.on("error", () => { if (!response.destroyed && !response.headersSent) json(response, 502, { error: "test gateway upstream unavailable" }); else response.destroy() })
  request.once("aborted", () => forward.destroy())
  response.once("close", () => { if (!response.writableEnded) forward.destroy() })
  request.pipe(forward)
})
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port }
async function until(predicate, message, timeout = 10_000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error(message)
}
async function run(command, args) {
  const child = spawn(command, args, { cwd: repository, stdio: ["ignore", "pipe", "pipe"] })
  let logs = ""; child.stdout.on("data", data => { logs += data }); child.stderr.on("data", data => { logs += data })
  const [code] = await once(child, "exit"); assert.equal(code, 0, logs)
}
async function stopService() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return
  const ended = once(service, "exit"); service.kill("SIGTERM")
  const force = setTimeout(() => service.kill("SIGKILL"), 5000)
  await ended; clearTimeout(force)
}
async function startService() {
  service = spawn(binary, ["--dev", `--listen=127.0.0.1:${servicePort}`, `--data-dir=${join(temporary, "data")}`, `--providers=${join(temporary, "providers.json")}`], { cwd: repository, env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "" }, stdio: ["ignore", "pipe", "pipe"] })
  service.stdout.on("data", data => { serviceOutput += data }); service.stderr.on("data", data => { serviceOutput += data })
  await until(async () => { try { return (await fetch(`${serviceURL}/readyz`)).ok } catch { return false } }, `Service did not start: ${serviceOutput}`)
}
async function api(path, method = "GET", document, headers = {}, status = 200) {
  const response = await fetch(`${serviceURL}/api/${path}`, { method, headers: { "content-type": "application/json", ...headers }, ...(document === undefined ? {} : { body: JSON.stringify(document) }) })
  const text = await response.text(); assert.equal(response.status, status, `${method} ${path}: ${text}`)
  return { document: text ? JSON.parse(text) : undefined, etag: response.headers.get("etag") }
}

const original = {
  schemaVersion: 1, id: "editing-board", title: "Live editing integration", timeRange: "1h", customTimeRange: fixedRange, refreshInterval: 0,
  widgets: [{ id: "preview", title: "Original widget", type: "stat", providerId: "metrics", query: "up", unit: "%", layout: { x: 0, y: 0, w: 6, h: 4 } }],
}
const panel = () => page.getByRole("region", { name: "Widget editor", exact: true })
const tile = () => page.locator('[data-widget-id="preview"]')
const queries = () => providerRequests.filter(entry => entry.path.endsWith("query_range"))
async function openScenario(width = 1512) {
  await context?.close()
  await api("dashboards/editing-board", "PUT", structuredClone(original))
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 982 }, reducedMotion: "reduce", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  page = await context.newPage(); page.setDefaultTimeout(12_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("dialog", dialog => { if (dialog.type() === "beforeunload") void dialog.accept(); else { pageErrors.push(`Unexpected ${dialog.type()}`); void dialog.dismiss() } })
  await page.goto(`${gatewayURL}/dashboard/insights/?dashboard=editing-board`, { waitUntil: "networkidle" })
  await tile().locator('[data-metric-value="123.5"]').waitFor()
}
async function edit(title = "Original widget") {
  if (await page.getByRole("button", { name: "Edit dashboard", exact: true }).isVisible()) await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
  await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click()
  await panel().waitFor()
}
async function source(format = "JSON") {
  await panel().getByRole("tab", { name: "Source", exact: true }).click()
  if (format === "YAML") await selectGammaOption(page, panel().getByRole("combobox", { name: "Widget source format", exact: true }), "YAML")
  const field = panel().getByRole("textbox", { name: `Widget ${format}`, exact: true })
  assert.equal(await field.getAttribute("readonly"), "")
  const text = await field.inputValue()
  return format === "JSON" ? JSON.parse(text) : parseYaml(text)
}
async function shot(name) { const path = join(output, name); await page.screenshot({ path, fullPage: false }); screenshots.push(path) }
async function check(name, action) {
  try { const evidence = await action(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) { await shot("failure.png").catch(() => {}); reports.push({ name, passed: false, error: error.stack }); throw error }
}
try {
  await mkdir(output, { recursive: true })
  const upstreamPort = await listen(upstream), reservation = createServer()
  servicePort = await listen(reservation); await new Promise(resolve => reservation.close(resolve)); serviceURL = `http://127.0.0.1:${servicePort}`
  await writeFile(join(temporary, "providers.json"), JSON.stringify({ providers: [{ id: "metrics", name: "Library metrics", type: "prometheus", url: `http://127.0.0.1:${upstreamPort}/prometheus` }] }))
  await run("rtk", ["proxy", "go", "build", "-o", binary, "./cmd/paprika-insights"])
  await startService(); gatewayURL = `http://127.0.0.1:${await listen(gateway)}`
  browser = await chromium.launch({ headless: true })

  for (const width of [1512, 390]) await check(`Live previews and JSON/YAML inspect without persistence at ${width}px`, async () => {
    await openScenario(width); await edit()
    const before = queries().length
    await panel().getByRole("textbox", { name: "Title", exact: true }).fill("Unsaved live preview")
    await tile().getByRole("heading", { name: "Unsaved live preview", exact: true }).waitFor()
    await panel().getByRole("tab", { name: "Style", exact: true }).click()
    await panel().getByLabel("Unit", { exact: true }).fill("rpm")
    await panel().getByRole("switch", { name: "Show sparkline", exact: true }).check()
    await tile().locator("svg[data-stat-sparkline]").waitFor()
    await panel().getByRole("tab", { name: "Layout", exact: true }).click()
    await selectGammaOption(page, panel().getByRole("combobox", { name: "Width", exact: true }), "8 columns")
    const json = await source()
    assert.equal(json.title, "Unsaved live preview"); assert.equal(json.unit, "rpm"); assert.equal(json.options.showSparkline, true); assert.equal(json.layout.w, 8)
    assert.deepEqual(await source("YAML"), json)
    assert.deepEqual((await api("dashboards/editing-board")).document, original, "Live previews must not persist")
    assert.equal(queries().length, before, "Title, styles and size must not refetch")
    await shot(`source-${width}.png`)
    await panel().getByRole("button", { name: "Close widget editor", exact: true }).click()
    await tile().getByRole("heading", { name: "Unsaved live preview", exact: true }).waitFor()
    await page.reload({ waitUntil: "networkidle" })
    await tile().getByRole("heading", { name: "Original widget", exact: true }).waitFor()
    assert.equal(await tile().locator("svg[data-stat-sparkline]").count(), 0)
    return { liveTitleStyleLayout: true, sourceFormats: ["JSON", "YAML"], storageUnchanged: true, reloadDiscardsUnsaved: true, unchangedQueryRequests: before }
  })

  await check("Query typing coalesces, obsolete live queries abort and current results replace them", async () => {
    await openScenario(); await edit()
    const query = panel().getByRole("textbox", { name: "PromQL query", exact: true })
    await query.fill("slow_probe_editing")
    await until(() => queries().some(entry => entry.params.query === "slow_probe_editing"), "Slow preview did not begin")
    const slow = queries().find(entry => entry.params.query === "slow_probe_editing")
    assert.equal(await tile().locator('[data-metric-value="123.5"]').count(), 0, "Previous observations must not masquerade as the new query")
    await query.fill("")
    await query.pressSequentially("fast_probe", { delay: 15 })
    await tile().locator('[data-metric-value="222"]').waitFor()
    await until(() => slow.aborted, "Obsolete provider request did not abort")
    const requested = queries().map(entry => entry.params.query)
    assert.equal(requested.filter(value => value === "fast_probe").length, 1)
    assert.equal(requested.filter(value => value && "fast_probe".startsWith(value) && value !== "fast_probe").length, 0)
    assert.deepEqual((await api("dashboards/editing-board")).document, original)
    await shot("query-preview-1512.png")
    return { obsoleteAborted: slow.aborted, noPartialQueries: true, currentValue: 222 }
  })

  await check("Dashboard Save persists the immediate live draft and reload restores it", async () => {
    await panel().getByRole("textbox", { name: "Title", exact: true }).fill("Saved live preview")
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).waitFor()
    const persisted = (await api("dashboards/editing-board")).document
    assert.equal(persisted.widgets[0].title, "Saved live preview"); assert.equal(persisted.widgets[0].query, "fast_probe")
    await page.reload({ waitUntil: "networkidle" })
    await tile().getByRole("heading", { name: "Saved live preview", exact: true }).waitFor()
    await tile().locator('[data-metric-value="222"]').waitFor()
    return { title: persisted.widgets[0].title, query: persisted.widgets[0].query, persistedThroughRealService: true }
  })

  await check("Invalid plugin settings retain the valid preview and prevent Save until corrected", async () => {
    await openScenario(); await edit()
    await selectGammaOption(page, panel().getByRole("combobox", { name: "Visualization", exact: true }), /^Threshold gauge/)
    const field = panel().getByRole("textbox", { name: "Plugin configuration", exact: true })
    await field.fill('{"label":')
    await until(() => page.getByRole("button", { name: "Save dashboard", exact: true }).isDisabled(), "Invalid widget draft did not disable Save")
    await panel().getByRole("alert").waitFor()
    const inspected = await source()
    assert.equal(inspected.type, "plugin"); assert.deepEqual(inspected.config, {})
    assert.deepEqual((await api("dashboards/editing-board")).document, original)
    await panel().getByRole("tab", { name: "Query", exact: true }).click()
    await field.fill('{"label":"Live gauge"}')
    await until(() => page.getByRole("button", { name: "Save dashboard", exact: true }).isEnabled(), "Corrected widget draft did not enable Save")
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).waitFor()
    assert.deepEqual((await api("dashboards/editing-board")).document.widgets[0].config, { label: "Live gauge" })
    return { rejectedInvalidJSON: true, validConfigPersisted: true }
  })

  await check("Incomplete guided changes block Save until fixed, replaced in code or closed", async () => {
    await openScenario(); await edit()
    await panel().getByText("Guided query builder", { exact: true }).click()
    await selectGammaOption(page, panel().getByRole("combobox", { name: "Function", exact: true }), "Rate per second")
    await panel().getByLabel("Rate window", { exact: true }).fill("0m")
    await until(() => page.getByRole("button", { name: "Save dashboard", exact: true }).isDisabled(), "Invalid widget draft did not disable Save")
    assert.deepEqual((await api("dashboards/editing-board")).document, original)
    await panel().getByRole("textbox", { name: "PromQL query", exact: true }).fill("fast_probe")
    await until(() => page.getByRole("button", { name: "Save dashboard", exact: true }).isEnabled(), "Corrected widget draft did not enable Save")
    await panel().getByLabel("Rate window", { exact: true }).fill("-1")
    await until(() => page.getByRole("button", { name: "Save dashboard", exact: true }).isDisabled(), "Invalid widget draft did not disable Save")
    await panel().getByText("Guided query builder", { exact: true }).click()
    await until(() => page.getByRole("button", { name: "Save dashboard", exact: true }).isEnabled(), "Corrected widget draft did not enable Save")
    return { incompleteGuidedDraftBlocked: true, explicitCodeOrCloseRecovers: true, storageUnchanged: true }
  })

  for (const width of [1512, 320]) await check(`All inspector tabs and saved-query tags remain visible at ${width}px`, async () => {
    const tagged = { schemaVersion: 1, id: `tagged-${width}`, name: `Tagged requests ${width}`, providerId: "metrics", kind: "metrics", query: "up", description: "Production request health", tags: ["production", "critical", "request-volume", "platform"], metadata: { team: "observability" } }
    await api(`saved-queries/${tagged.id}`, "PUT", tagged, { "If-None-Match": "*" })
    await openScenario(width); await edit()
    await selectGammaOption(page, panel().getByRole("combobox", { name: "Visualization", exact: true }), /^Status heatmap/)
    const tabs = panel().getByRole("tablist", { name: "Widget settings", exact: true })
    const geometry = await tabs.evaluate(list => {
      const bounds = list.getBoundingClientRect()
      return { width: bounds.width, height: bounds.height, tabs: [...list.querySelectorAll('[role="tab"]')].map(tab => { const rect = tab.getBoundingClientRect(); return { name: tab.textContent, inside: rect.left >= bounds.left && rect.right <= bounds.right && rect.top >= bounds.top && rect.bottom <= bounds.bottom, complete: tab.scrollWidth <= tab.clientWidth } }), pageOverflow: document.documentElement.scrollWidth - innerWidth }
    })
    assert.equal(geometry.tabs.length, 6)
    assert.ok(geometry.tabs.every(tab => tab.inside && tab.complete), JSON.stringify(geometry))
    assert.ok(geometry.pageOverflow <= 1, JSON.stringify(geometry))
    await tabs.getByRole("tab", { name: "Query", exact: true }).focus()
    await page.keyboard.press("End")
    assert.equal(await tabs.getByRole("tab", { name: "Source", exact: true }).evaluate(tab => document.activeElement === tab && tab.getAttribute("aria-selected") === "true"), true)
    await page.keyboard.press("Home")
    assert.equal(await tabs.getByRole("tab", { name: "Query", exact: true }).evaluate(tab => document.activeElement === tab), true)
    await shot(`inspector-tabs-${width}.png`)
    await selectGammaOption(page, panel().getByRole("combobox", { name: "Widget query source", exact: true }), "Saved query")
    const picker = panel().getByRole("combobox", { name: "Saved query", exact: true })
    await picker.click()
    const option = page.getByRole("option", { name: tagged.name, exact: true })
    await option.getByText("production", { exact: true }).waitFor()
    await option.getByText("critical", { exact: true }).waitFor()
    const tagsInside = await option.locator('[data-query-tags]').evaluate(tags => { const box = tags.getBoundingClientRect(), list = tags.closest('[role="listbox"]').getBoundingClientRect(); return box.width > 0 && box.height > 0 && box.left >= list.left && box.right <= list.right })
    assert.equal(tagsInside, true)
    await shot(`tagged-query-options-${width}.png`)
    await option.click()
    await picker.getByText("production", { exact: true }).waitFor()
    await picker.getByText("critical", { exact: true }).waitFor()
    assert.equal(await picker.getByText("+2", { exact: true }).count(), 1)
    await shot(`selected-query-tags-${width}.png`)
    await panel().getByRole("button", { name: "Close widget editor", exact: true }).click()
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).waitFor()
    await page.reload({ waitUntil: "networkidle" }); await edit()
    await panel().getByRole("combobox", { name: "Saved query", exact: true }).getByText("production", { exact: true }).waitFor()
    assert.deepEqual((await api(`saved-queries/${tagged.id}`)).document.tags, tagged.tags)
    return { width, geometry, optionTagsVisible: true, selectedTagsVisible: true, persistedAfterReload: true }
  })
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {})
  for (const item of pending) item.response.destroy()
  gateway.closeAllConnections(); upstream.closeAllConnections()
  await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))])
  await stopService()
  await writeFile(join(output, "report.json"), JSON.stringify({ reports, pageErrors, providerRequests, screenshots, harness: "Actual Go service and persistent files, deterministic Prometheus provider, abort-propagating local gateway. Chromium desktop/mobile emulation." }, null, 2))
  await rm(temporary, { recursive: true, force: true })
}
assert.deepEqual(pageErrors, [])
console.log(`${reports.length} live editing integration scenarios passed.`)
