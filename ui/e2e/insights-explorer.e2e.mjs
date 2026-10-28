import { serveAnonymousAuthConfiguration } from "./anonymous-auth-fixture.mjs"
import { queryEditorGeometry, queryEditorValue } from "./query-editor.mjs"
import { verifyProviderEditor } from "./query-editor-scenarios.mjs"
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
import { selectGammaOption, respondToGammaConfirmation } from "./gamma-controls.mjs"
import { connectionQuery, verifyConnections } from "./query-connections-scenarios.mjs"
import { precisionFixtures, verifyPrecision } from "./precision-scenarios.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = join(repository, "artifacts/insights/explorer")
const scenarioFilter = process.env.INSIGHTS_EXPLORER_FILTER ? new RegExp(process.env.INSIGHTS_EXPLORER_FILTER) : undefined
const temporary = await mkdtemp(join(tmpdir(), "paprika-explorer-"))
const binary = join(temporary, "insights")
const reports = [], providerRequests = [], pageErrors = [], screenshots = [], pending = []
const specialLabel = 'checkout"blue\\west\n{{text}}'
const enteredService = 'checkout"blue\\west{{text}}'
const fixedRange = { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }
let browser, context, page, service, serviceURL, servicePort, gatewayURL, scenario = 0
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
  if (serveAnonymousAuthConfiguration(request, response)) return
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
async function putQuery(document) {
  const response = await fetch(`${serviceURL}/api/saved-queries/${document.id}`)
  return api(`saved-queries/${document.id}`, "PUT", document, response.ok ? { "If-Match": response.headers.get("etag") } : { "If-None-Match": "*" })
}
function board(widgets = [], variables = []) {
  return { schemaVersion: 1, id: "explorer-board", title: "Explorer integration", timeRange: "1h", customTimeRange: fixedRange, refreshInterval: 0, variables, widgets }
}
function host(source = { type: "widget" }, type = "table") {
  return { id: "host", title: "Parent health", type: "heatmap", providerId: "metrics", query: "parent_health", unit: "%", layout: { x: 0, y: 0, w: 12, h: 6 }, options: { tooltipView: { type, height: 320, source } } }
}
function childQuery(id = "tooltip-library", prefix = "child_saved") {
  return { schemaVersion: 1, id, name: "Contextual child", providerId: "metrics", kind: "metrics", query: `${prefix}{service={{service}},tenant={{tenant}}} @{{at}} > {{observed}}`, parameters: [
    { name: "service", type: "string" }, { name: "tenant", type: "string", defaultValue: "default-tenant" }, { name: "at", type: "number" }, { name: "observed", type: "number", defaultValue: 0 },
  ] }
}
const childBindings = [{ parameter: "service", source: "label", label: "service" }, { parameter: "tenant", source: "variable", variable: "tenant" }, { parameter: "at", source: "field", field: "timestamp" }, { parameter: "observed", source: "field", field: "value" }]
const explorer = () => page.getByRole("region", { name: "Data source explorer", exact: true }).last()
const results = () => page.getByRole("region", { name: "Explore query results", exact: true })
const panel = () => page.getByRole("region", { name: "Widget editor", exact: true })
const tooltip = () => page.getByRole("tooltip")
const tile = () => page.locator('[data-widget-id="host"]')
const cells = () => tile().getByRole("group").getByRole("button")
const queryRequests = () => providerRequests.filter(entry => entry.path.endsWith("query_range") || entry.path === "/tempo/api/search")
const childRequests = () => queryRequests().filter(entry => (entry.params.query ?? "").startsWith("child_saved") || (entry.params.query ?? "").startsWith("slow_saved"))
async function frames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function openScenario(document = board(), width = 1512, height = width < 600 ? 844 : 1050) {
  await context?.close()
  await api(`dashboards/${document.id}`, "PUT", document)
  context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  page = await context.newPage(); page.setDefaultTimeout(12_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("dialog", dialog => { pageErrors.push(`Unexpected native ${dialog.type()}`); void dialog.dismiss() })
  await page.goto(`${gatewayURL}/dashboard/insights/?dashboard=${document.id}`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: document.title, exact: true }).waitFor()
}
async function openExplorer() {
  const nav = page.locator("#insights-navigation")
  if (!await nav.isVisible()) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
  await nav.getByRole("button", { name: /^Explore\b/ }).click()
  await explorer().getByRole("heading", { name: "Explore", exact: true }).waitFor()
}
async function queryMode(name) {
  const tab = explorer().getByRole("tab", { name, exact: true })
  await tab.click()
  assert.equal(await tab.getAttribute("aria-selected"), "true")
}
async function openSaved(name) {
  await selectGammaOption(page, explorer().getByRole("combobox", { name: "Open saved query", exact: true }), new RegExp(name))
}
async function detailsMode(name) {
  const tab = explorer().getByRole("tab", { name: name === "Parameters" ? /^Parameters\b/ : name, exact: name !== "Parameters" })
  await tab.click()
  assert.equal(await tab.getAttribute("aria-selected"), "true")
}
// Native viewport captures preserve IntersectionObserver-driven query visibility.
async function shot(name) { await frames(); const path = join(output, name); await page.screenshot({ path, fullPage: false }); screenshots.push(path) }
async function contained(locator) {
  const geometry = await locator.evaluate(element => new Promise(resolve => {
    // Long lists scroll within the floating panel; measure that visible viewport,
    // not the unbounded list of options inside it.
    const surface = element.getAttribute("role") === "listbox" ? element.closest('[data-gamma-portal="select"]') ?? element : element
    let last, samples = 0; const start = performance.now()
    function measure() {
      const b = surface.getBoundingClientRect(), current = { x: b.x, y: b.y, width: b.width, height: b.height }
      const inside = b.x >= -1 && b.y >= -1 && b.right <= innerWidth + 1 && b.bottom <= innerHeight + 1
      const stable = last && Object.keys(current).every(key => Math.abs(current[key] - last[key]) < .5)
      if ((inside && stable) || performance.now() - start > 2000) resolve({ ...current, inside, stable: !!stable, samples })
      else { last = current; samples++; requestAnimationFrame(measure) }
    }
    requestAnimationFrame(measure)
  }))
  assert.ok(geometry.inside && geometry.stable, `Floating/control bounds must settle inside viewport: ${JSON.stringify(geometry)}`)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No document overflow")
  return geometry
}
async function check(name, action) {
  if (scenarioFilter && !scenarioFilter.test(name)) return
  const started = Date.now(); scenario++
  try { const evidence = await action(); reports.push({ name, passed: true, milliseconds: Date.now() - started, evidence }); console.log(`PASS ${name}`) }
  catch (error) { await shot(`failure-${scenario}.png`).catch(() => {}); reports.push({ name, passed: false, error: error.message, stack: error.stack }); throw error }
}
async function applySave() {
  await panel().getByRole("button", { name: "Apply widget", exact: true }).click()
  await panel().getByRole("button", { name: "Close widget editor", exact: true }).click()
  await saveBoard()
}
async function saveBoard() {
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).waitFor()
}
async function showCell(index = 0) {
  await tile().scrollIntoViewIfNeeded()
  if (page.viewportSize().width < 600) await cells().nth(index).tap(); else await cells().nth(index).hover()
  await tooltip().waitFor()
}
async function editHost() {
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
  await page.getByRole("button", { name: "Edit Parent health", exact: true }).click()
  await panel().getByRole("tab", { name: "Tooltips", exact: true }).click()
}

async function centerTooltipChild(child) {
  await child.evaluate(element => {
    const popup = element.closest('[role="tooltip"]'), bounds = element.getBoundingClientRect(), popupBounds = popup.getBoundingClientRect()
    popup.scrollTop += bounds.top - popupBounds.top - Math.max(12, (popup.clientHeight - bounds.height) / 2)
  })
  await frames(); await contained(tooltip())
  const visible = await child.evaluate(element => {
    const child = element.getBoundingClientRect(), popup = element.closest('[role="tooltip"]').getBoundingClientRect()
    return { top: child.top, bottom: child.bottom, popupTop: popup.top, popupBottom: popup.bottom }
  })
  assert.ok(visible.top >= visible.popupTop - 1 && visible.bottom <= visible.popupBottom + 1, `The captured tooltip child must be fully visible: ${JSON.stringify(visible)}`)
}

async function assertSparkline(scope) {
  const graphic = scope.locator("svg[data-stat-sparkline]")
  await graphic.waitFor()
  const attributes = await graphic.evaluate(element => Object.fromEntries([...element.attributes].map(attribute => [attribute.name, attribute.value])))
  const end = Date.parse(fixedRange.to)
  assert.equal(attributes["data-sample-count"], "5")
  assert.ok(Number(attributes["data-rendered-samples"]) <= 240)
  assert.equal(Number(attributes["data-history-start"]), end - 240_000)
  assert.equal(Number(attributes["data-history-end"]), end)
  assert.equal(Number(attributes["data-history-min"]), -7.25)
  assert.equal(Number(attributes["data-history-max"]), 1234.5678)
  assert.equal(Number(attributes["data-latest-valid-time"]), end - 60_000)
  assert.equal(await graphic.locator("text").count(), 0, "A sparkline must not add axes or labels")
  assert.ok(await graphic.locator("path[data-stat-trend]").count() > 0, "History needs an actual plotted finite segment")
  assert.ok(await graphic.locator("path[data-stat-area]").count() > 0, "Background history needs a shaded area with the same null gaps")
  const marker = graphic.locator('[data-stat-point][data-sample-value="-7.25"]')
  assert.equal(await marker.count(), 1, "The isolated negative point before the null gap must remain visible")
  assert.equal(await marker.getAttribute("vector-effect"), "non-scaling-stroke", "History marks must remain circular and small when the background stretches")
  assert.equal(await marker.getAttribute("stroke-width"), "4")
  assert.match(await graphic.getAttribute("aria-label") || await graphic.locator("title").textContent(), /History for/)
  const geometry = await scope.evaluate(element => {
    const reading = element.querySelector('[data-metric-value="1234.5678"]'), plot = element.querySelector("svg[data-stat-sparkline]")
    const range = document.createRange(); range.selectNodeContents(reading.firstChild)
    const numberRects = [...range.getClientRects()].map(rect => rect.toJSON())
    const valueBox = reading.getBoundingClientRect(), plotBox = plot.getBoundingClientRect(), stat = plot.parentElement.parentElement
    return { numberRects, value: valueBox.toJSON(), reading: element.querySelector("[data-stat-reading]").getBoundingClientRect().toJSON(), plot: plotBox.toJSON(), valueText: reading.textContent, fontSize: getComputedStyle(reading).fontSize,
      valueLayer: getComputedStyle(element.querySelector("[data-stat-reading]")).zIndex, plotLayer: getComputedStyle(plot).zIndex,
      plotPointerEvents: getComputedStyle(plot).pointerEvents, plotMask: getComputedStyle(plot).maskImage, lineOpacity: plot.querySelector("[data-stat-trend]").getAttribute("stroke-opacity"),
      container: stat.getBoundingClientRect().toJSON(), clientHeight: stat.clientHeight, scrollHeight: stat.scrollHeight }
  })
  assert.equal(geometry.numberRects.length, 1, `Stat digits must stay on one readable line: ${JSON.stringify(geometry)}`)
  const digits = geometry.numberRects[0]
  assert.ok(digits.x >= geometry.container.x - 1 && digits.right <= geometry.container.right + 1 && digits.top >= geometry.container.top - 1 && digits.bottom <= geometry.container.bottom + 1, `The readable value must remain inside the stat: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.plot.x >= geometry.container.x - 1 && geometry.plot.right <= geometry.container.right + 1 && geometry.plot.top >= geometry.container.top - 1 && geometry.plot.bottom <= geometry.container.bottom + 1, `History must stay inside the stat: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.reading.bottom > geometry.plot.top && geometry.reading.top < geometry.plot.bottom && geometry.reading.right > geometry.plot.x && geometry.reading.x < geometry.plot.right, `The lower history backdrop must overlap the reading block: ${JSON.stringify(geometry)}`)
  assert.ok(Number(geometry.valueLayer) > Number(geometry.plotLayer) && geometry.plotPointerEvents === "none", "The number and its inspection interaction must stay above the non-interactive history")
  assert.ok(Number(geometry.lineOpacity) > 0 && Number(geometry.lineOpacity) < 1, "Background trend must remain translucent")
  assert.ok(geometry.plotMask && geometry.plotMask !== "none", "The history mask must reduce visual interference behind the reading")
  assert.ok(geometry.value.x >= geometry.container.x - 1 && geometry.value.right <= geometry.container.right + 1, `The complete value and unit must stay within the stat: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.scrollHeight <= geometry.clientHeight + 1 && geometry.plot.bottom <= geometry.container.bottom + 1, `A single-series compact stat must show its value and history without internal clipping: ${JSON.stringify(geometry)}`)
  return { sampleCount: Number(attributes["data-sample-count"]), renderedSamples: Number(attributes["data-rendered-samples"]), start: end - 240_000, end, minimum: -7.25, maximum: 1234.5678, latestValidTime: end - 60_000, geometry }
}

async function freshSavedTooltip(width) {
  const sparklineRequestsBefore = queryRequests().filter(request => request.params.query === "sparkline_saved").length
  const first = host(); delete first.options
  await openScenario(board([first]), width)
  await cells().first().waitFor()
  await editHost()
  const shortcut = panel().getByRole("button", { name: "Use saved query", exact: true })
  await shortcut.scrollIntoViewIfNeeded(); await shot(`sparkline-direct-shortcut-${width}.png`); await shortcut.click()
  assert.equal(await panel().getByRole("combobox", { name: "Tooltip data source", exact: true }).innerText(), "Saved query", "The direct saved-query shortcut must enter a selectable saved source")
  await panel().getByRole("button", { name: "Remove tooltip widget", exact: true }).click()
  await panel().getByRole("button", { name: "Add tooltip widget", exact: true }).click()
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip data source", exact: true }), "Saved query")
  const beforeCreate = queryRequests().length
  const create = panel().getByRole("button", { name: "Create saved query", exact: true })
  await create.scrollIntoViewIfNeeded(); await shot(`sparkline-first-saved-query-${width}.png`)
  await create.click()
  await explorer().waitFor()
  const name = `Response history ${width}`
  await explorer().getByLabel("Query name", { exact: true }).fill(name)
  await queryMode("Code")
  await explorer().getByRole("textbox", { name: /^PromQL query/ }).fill("sparkline_saved")
  await explorer().getByRole("button", { name: "Save query", exact: true }).click()
  await explorer().getByRole("status").filter({ hasText: /Query saved/ }).waitFor()
  const saved = (await api("saved-queries")).document.queries.find(query => query.name === name)
  assert.ok(saved?.id && saved?.etag)
  assert.equal(queryRequests().length, beforeCreate, "Creating a tooltip saved query must not run it")
  await explorer().getByRole("button", { name: "Dashboard", exact: true }).click()
  await panel().waitFor()
  assert.equal(await panel().getByRole("tab", { name: "Tooltips", exact: true }).getAttribute("aria-selected"), "true", "Explore return must preserve the original Tooltips draft")
  assert.equal(await panel().getByRole("combobox", { name: "Tooltip data source", exact: true }).innerText(), "Saved query")
  const picker = panel().getByRole("combobox", { name: "Tooltip saved query", exact: true })
  await picker.click()
  const menu = page.getByRole("listbox"), search = page.getByRole("combobox", { name: "Search tooltip saved query", exact: true })
  await search.fill(saved.id)
  await menu.getByRole("option", { name: new RegExp(`^${name}`) }).waitFor()
  await contained(menu); await shot(`sparkline-saved-query-id-menu-${width}.png`)
  if (width === 390) {
    await page.setViewportSize({ width: 320, height: 844 }); await contained(menu); await shot("sparkline-saved-query-id-menu-320.png")
    await page.setViewportSize({ width, height: 844 })
  }
  await menu.getByRole("option", { name: new RegExp(`^${name}`) }).click()
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip visualization", exact: true }), "Single value")
  await panel().getByLabel("Tooltip unit", { exact: true }).fill("ms")
  await panel().getByLabel("Tooltip decimal places", { exact: true }).fill("4")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip chart height", exact: true }), /^Compact/)
  const toggle = panel().getByRole("switch", { name: "Show sparkline", exact: true })
  assert.equal(await toggle.isChecked(), false, "New Single value should preserve the no-sparkline default")
  await toggle.click(); await toggle.scrollIntoViewIfNeeded()
  const target = await contained(toggle.locator("xpath=ancestor::label")); if (width < 600) assert.ok(target.height >= 44)
  await shot(`sparkline-tooltip-control-${width}.png`)
  await applySave()
  const document = (await api("dashboards/explorer-board")).document
  assert.equal(document.widgets[0].options.tooltipView.showSparkline, true)
  assert.deepEqual(document.widgets[0].options.tooltipView.source, { type: "saved", ref: { id: saved.id } })
  assert.equal(queryRequests().filter(request => request.params.query === "sparkline_saved").length, sparklineRequestsBefore, "Saved tooltip remains lazy after saving")
  await page.reload({ waitUntil: "networkidle" })
  await showCell()
  const child = tooltip().locator('[data-tooltip-widget="stat"]')
  await child.locator('[data-metric-value="1234.5678"]').waitFor()
  if (width >= 600) await cells().first().click()
  await centerTooltipChild(child); await shot(`sparkline-saved-tooltip-${width}.png`)
  const history = await assertSparkline(child)
  let narrowHistory
  if (width === 390) {
    await page.setViewportSize({ width: 320, height: 844 }); await centerTooltipChild(child); narrowHistory = await assertSparkline(child); await shot("sparkline-saved-tooltip-320.png")
    await page.setViewportSize({ width, height: 844 })
  }
  assert.equal(queryRequests().filter(request => request.params.query === "sparkline_saved").length, sparklineRequestsBefore + 1, "One lazy saved query supplies both number and history")
  await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
  await editHost(); await panel().getByRole("switch", { name: "Show sparkline", exact: true }).click(); await applySave()
  assert.equal((await api("dashboards/explorer-board")).document.widgets[0].options.tooltipView.showSparkline, false)
  await page.reload({ waitUntil: "networkidle" }); await showCell(); await child.locator('[data-metric-value="1234.5678"]').waitFor()
  assert.equal(await child.locator("svg[data-stat-sparkline]").count(), 0, "Explicit false survives reload and keeps the single value")
  const hostEvidence = []
  for (const type of ["timeseries", "bar", "table"]) {
    const hostDocument = structuredClone(document); hostDocument.widgets[0].type = type
    await openScenario(hostDocument, width)
    const hostChild = tooltip().locator('[data-tooltip-widget="stat"]')
    const beforeOpen = queryRequests().filter(request => request.params.query === "sparkline_saved").length
    if (type === "table") {
      const row = tile().getByRole("button", { name: /^Inspect series / }).first()
      await row.waitFor(); if (width < 600) await row.tap(); else await row.focus()
    } else {
      const chart = tile().locator('svg[role="img"]').first()
      await chart.waitFor(); await chart.focus()
      // Equal-time line points are ordered by screen y: the topmost51 sample
      // receives initial focus; its latest value would be52.
      const observation = tooltip().locator(`[data-observation-value="${type === "timeseries" ? 51 : 32}"]`)
      await observation.waitFor()
      assert.equal(Number(await observation.getAttribute("data-observation-timestamp")), Date.parse(fixedRange.to) - (type === "timeseries" ? 60_000 : 250))
    }
    await hostChild.locator('[data-metric-value="1234.5678"]').waitFor()
    const history = await assertSparkline(hostChild)
    assert.equal(queryRequests().filter(request => request.params.query === "sparkline_saved").length, beforeOpen + 1, `The ${type} saved tooltip should run once when opened`)
    await centerTooltipChild(hostChild); await shot(`sparkline-saved-${type}-${width}.png`)
    hostEvidence.push({ type, contextValue: type === "timeseries" ? 51 : 32, history })
  }
  await context.close(); context = undefined
  // Each first-time journey owns a fresh, genuinely empty fixture library.
  await api("dashboards/explorer-board", "PUT", board())
  const current = await api(`saved-queries/${saved.id}`)
  await api(`saved-queries/${saved.id}`, "DELETE", undefined, { "If-Match": current.etag }, 204)
  return { width, createdQueryId: saved.id, preservedTooltipDraft: true, searchableById: true, enabledAndDisabledPersisted: true, history, narrowHistory, additionalHosts: hostEvidence, switchTarget: target }
}

async function reusedStatSparkline(width) {
  const parent = host({ type: "widget" }, "stat"); parent.query = "sparkline_saved"
  const summary = { id: "summary", title: "Current response", type: "stat", providerId: "metrics", query: "sparkline_saved", unit: "%", layout: { x: 0, y: 6, w: 12, h: 4 } }
  await openScenario(board([parent, summary]), width)
  const main = page.locator('[data-widget-id="summary"]')
  await main.locator('[data-metric-value="1234.5678"]').waitFor()
  assert.equal(await main.locator("svg[data-stat-sparkline]").count(), 0)
  const before = queryRequests().length
  await showCell()
  const child = tooltip().locator('[data-tooltip-widget="stat"]')
  await child.locator('[data-metric-value="1234.5678"]').waitFor()
  assert.equal(await child.locator("svg[data-stat-sparkline]").count(), 0)
  await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
  await editHost(); await panel().getByRole("switch", { name: "Show sparkline", exact: true }).click(); await applySave()
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
  await page.getByRole("button", { name: "Edit Current response", exact: true }).click()
  await panel().getByRole("tab", { name: "Style", exact: true }).click()
  await panel().getByRole("switch", { name: "Show sparkline", exact: true }).click(); await applySave()
  const mainHistory = await assertSparkline(main)
  await page.mouse.move(0, 0); await page.keyboard.press("Escape")
  await tooltip().waitFor({ state: "hidden" })
  await main.locator('[data-metric-value="1234.5678"]').scrollIntoViewIfNeeded(); await shot(`sparkline-main-stat-${width}.png`)
  const mainDetail = join(output, `sparkline-main-stat-detail-${width}.png`)
  await main.screenshot({ path: mainDetail }); screenshots.push(mainDetail)
  await showCell(); await child.locator('[data-metric-value="1234.5678"]').waitFor()
  const childHistory = await assertSparkline(child)
  if (width >= 600) await cells().first().click()
  await centerTooltipChild(child); await shot(`sparkline-reused-tooltip-${width}.png`)
  const tooltipDetail = join(output, `sparkline-tooltip-detail-${width}.png`)
  await child.screenshot({ path: tooltipDetail }); screenshots.push(tooltipDetail)
  await frames(); assert.equal(queryRequests().length, before, "Changing sparkline display and reusing full widget results must not request more data")
  await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
  const document = (await api("dashboards/explorer-board")).document
  assert.equal(document.widgets[0].options.tooltipView.showSparkline, true)
  assert.equal(document.widgets[1].options.showSparkline, true)
  await context.close(); context = undefined; await stopService(); await startService()
  assert.deepEqual((await api("dashboards/explorer-board")).document, document, "Both display settings must survive an actual service restart")
  return { width, mainHistory, childHistory, latestValidValue: 1234.5678, nullGapsPreserved: true, noAdditionalProviderRequests: true, serviceRestartPersisted: true }
}

async function fullyVisible(locator, label) {
  const geometry = await locator.evaluate(element => {
    const box = element.getBoundingClientRect()
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect()
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, rect.left + parent.clientLeft); right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth) }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) { top = Math.max(top, rect.top + parent.clientTop); bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight) }
    }
    return { box: box.toJSON(), clip: { left, top, right, bottom }, visible: box.width > 0 && box.height > 0 && box.left >= left - 1 && box.top >= top - 1 && box.right <= right + 1 && box.bottom <= bottom + 1 }
  })
  assert.ok(geometry.visible, `${label} must be fully visible without scrolling: ${JSON.stringify(geometry)}`)
  return geometry
}
async function controlContrast(locator) {
  return locator.evaluate(element => {
    const canvas = document.createElement("canvas"), context = canvas.getContext("2d", { willReadFrequently: true })
    canvas.width = canvas.height = 1
    const rgba = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data] }
    const blend = (background, color) => background.map((value, index) => color[index] * color[3] / 255 + value * (1 - color[3] / 255))
    const styles = []
    for (let current = element; current; current = current.parentElement) styles.push(getComputedStyle(current))
    const background = [...styles].reverse().reduce((color, style) => blend(color, rgba(style.backgroundColor)), [255, 255, 255])
    const foreground = blend(background, rgba(styles[0].color))
    const luminance = color => color.map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    const [lighter, darker] = [luminance(background), luminance(foreground)].sort((a, b) => b - a)
    return { ratio: (lighter + .05) / (darker + .05), foreground, background }
  })
}
async function visiblePlot(locator) {
  const geometry = await locator.evaluate(element => {
    const clipRect = element.querySelector("clipPath rect"), matrix = clipRect?.getScreenCTM()
    if (!clipRect || !matrix) throw new Error("Expected the rendered SVG plot clipping rectangle")
    const start = new DOMPoint(clipRect.x.baseVal.value, clipRect.y.baseVal.value).matrixTransform(matrix)
    const end = new DOMPoint(clipRect.x.baseVal.value + clipRect.width.baseVal.value, clipRect.y.baseVal.value + clipRect.height.baseVal.value).matrixTransform(matrix)
    const plot = { left: start.x, top: start.y, right: end.x, bottom: end.y, width: end.x - start.x, height: end.y - start.y }
    let left = 0, top = 0, right = innerWidth, bottom = innerHeight
    const clippingAncestors = []
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent), rect = parent.getBoundingClientRect()
      if (/auto|scroll|hidden|clip/.test(style.overflowX)) { left = Math.max(left, rect.left + parent.clientLeft); right = Math.min(right, rect.left + parent.clientLeft + parent.clientWidth) }
      if (/auto|scroll|hidden|clip/.test(style.overflowY)) {
        top = Math.max(top, rect.top + parent.clientTop); bottom = Math.min(bottom, rect.top + parent.clientTop + parent.clientHeight)
        clippingAncestors.push({ overflowY: style.overflowY, top: rect.top, bottom: rect.bottom, scrollTop: parent.scrollTop })
      }
    }
    return { svg: element.getBoundingClientRect().toJSON(), plot, clip: { left, top, right, bottom }, visibleHeight: Math.max(0, Math.min(plot.bottom, bottom) - Math.max(plot.top, top)), visibleWidth: Math.max(0, Math.min(plot.right, right) - Math.max(plot.left, left)), clippingAncestors }
  })
  assert.ok(geometry.visibleHeight >= 100, `At least 100px of the actual data plot, excluding axes, must be visible: ${JSON.stringify(geometry)}`)
  assert.ok(geometry.visibleWidth >= geometry.plot.width * .8, `The plotted series must remain horizontally visible: ${JSON.stringify(geometry)}`)
  return geometry
}
async function selectedControl(locator) {
  const read = () => locator.evaluate(element => {
    const style = getComputedStyle(element)
    return { current: element.getAttribute("aria-current"), background: style.backgroundColor, color: style.color, marker: style.boxShadow }
  })
  const resting = await read()
  assert.ok(["page", "true"].includes(resting.current), "The selected control must expose its current state")
  assert.doesNotMatch(resting.background, /rgba\([^)]*,\s*0\)|transparent/, "Selected navigation needs a persistent filled background")
  await locator.hover()
  const hovered = await read()
  assert.doesNotMatch(hovered.background, /rgba\([^)]*,\s*0\)|transparent/, "Selected navigation keeps its visible selection on hover")
  return { resting, hovered }
}
async function compactWorkspace(width, height, theme) {
  await openScenario(board(), width, height)
  await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
  await page.locator(`[data-insights-theme="${theme.toLowerCase()}"]`).waitFor()
  await openExplorer()
  const source = explorer().getByRole("combobox", { name: "Explore data source", exact: true })
  assert.equal(await source.locator('[data-provider-type="prometheus"]').count(), 1, "The provider identity icon remains visible in the compact selector")
  await source.click()
  const menuGeometry = await contained(page.getByRole("listbox"))
  assert.equal(await page.getByRole("option", { name: "Library metrics", exact: true }).locator('[data-provider-type="prometheus"]').count(), 1)
  await shot(`compact-provider-menu-${theme.toLowerCase()}-${width}x${height}.png`)
  await page.keyboard.press("Escape")
  const requestCount = queryRequests().length
  await queryMode("Builder")
  const name = `Request rate ${width} ${theme}`, expression = 'sum by (service) (rate(http_requests_total{service="api"}[5m]))'
  const metric = explorer().getByRole("combobox", { name: "Metric", exact: true })
  await metric.fill("http_requests_total")
  await page.getByRole("option", { name: "http_requests_total", exact: true }).click()
  await explorer().getByRole("button", { name: "Add label filter", exact: true }).click()
  const label = explorer().getByRole("combobox", { name: "Filter 1 label", exact: true })
  await label.fill("service"); await page.getByRole("option", { name: "service", exact: true }).click()
  const value = explorer().getByRole("combobox", { name: "Filter 1 value", exact: true })
  await value.fill("api"); await page.getByRole("option", { name: "api", exact: true }).click()
  await selectGammaOption(page, explorer().getByRole("combobox", { name: "Function", exact: true }), "Rate per second")
  await selectGammaOption(page, explorer().getByRole("combobox", { name: "Aggregation", exact: true }), "sum")
  await explorer().getByLabel("Group by labels", { exact: true }).fill("service")
  await explorer().getByRole("button", { name: "Use generated query", exact: true }).click()
  assert.equal(await explorer().getByRole("tab", { name: "Builder", exact: true }).getAttribute("aria-selected"), "true", "Applying the generated query keeps the builder active")
  await queryMode("Code")
  assert.equal(await queryEditorValue(explorer().getByRole("textbox", { name: /^PromQL query/ })), expression)
  await queryMode("Builder")
  assert.equal(await metric.inputValue(), "http_requests_total", "Switching tabs retains the guided metric")
  assert.equal(await value.inputValue(), "api", "Switching tabs retains the guided filter")
  assert.equal(await explorer().getByLabel("Group by labels", { exact: true }).inputValue(), "service")
  await explorer().getByLabel("Query name", { exact: true }).fill(name)
  const description = "Total request rate per service over time.\nUse the service parameter to focus on one application.\nOwned by the platform team."
  await explorer().getByLabel("Query description", { exact: true }).fill(description)
  assert.ok((await explorer().getByLabel("Query description", { exact: true }).boundingBox()).height >= 100, "Description should provide a comfortable multiline editing area")
  await explorer().getByRole("textbox", { name: "New tag", exact: true }).fill("service-overview")
  await explorer().getByRole("button", { name: "Add tag", exact: true }).click()
  await explorer().getByRole("button", { name: "Save query", exact: true }).click()
  await explorer().getByRole("status").filter({ hasText: /Query saved/ }).waitFor()
  assert.equal(queryRequests().length, requestCount, "Composing and saving a query must not execute it before explicit Run")
  await explorer().getByRole("button", { name: "Run query", exact: true }).click()
  const chart = results().getByRole("img", { name, exact: true })
  await chart.waitFor()
  assert.equal(queryRequests().at(-1)?.params.query, expression)
  const library = (await api("saved-queries?providerId=metrics")).document.queries
  assert.ok(library.some(query => query.name === name && query.query === expression && query.description === description && query.tags?.includes("service-overview")), "The details panel must persist the full expression, multiline description and tags")
  const contrast = {}
  for (const [label, locator] of [
    ["Provider", source],
    ["Query name", explorer().getByLabel("Query name", { exact: true })],
    ["Description", explorer().getByLabel("Query description", { exact: true })],
    ["Save query", explorer().getByRole("button", { name: "Save query", exact: true })],
    ["Run query", explorer().getByRole("button", { name: "Run query", exact: true })],
  ]) {
    contrast[label] = await controlContrast(locator)
    assert.ok(contrast[label].ratio >= 4.5, `${label} text must have readable ${theme} contrast: ${contrast[label].ratio}`)
  }
  await frames()
  const documentGeometry = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, scrollY }))
  assert.ok(documentGeometry.scrollWidth <= width, `No horizontal overflow: ${JSON.stringify(documentGeometry)}`)
  const geometry = {}
  const selection = {}
  if (width >= 1000) {
    selection.navigation = await selectedControl(page.locator("#insights-navigation").getByRole("button", { name: /^Explore\b/ }))
    selection.savedQuery = await fullyVisible(explorer().getByRole("combobox", { name: "Open saved query", exact: true }), "Selected saved query")
    await page.mouse.move(0, 0)
    assert.ok(documentGeometry.scrollHeight <= height + 1, `Desktop workspace must fit one screen: ${JSON.stringify(documentGeometry)}`)
    for (const [label, locator] of [
      ["Builder panel", explorer().getByRole("region", { name: "Query workbench", exact: true })],
      ["Save panel", explorer().getByRole("region", { name: "Save query", exact: true })],
      ["Results panel", results()], ["Result chart", chart], ["Metric", metric], ["Filter value", value],
      ["Function", explorer().getByRole("combobox", { name: "Function", exact: true })],
      ["Group by", explorer().getByLabel("Group by labels", { exact: true })],
      ["Apply generated query", explorer().getByRole("button", { name: "Use generated query", exact: true })],
      ["Query name", explorer().getByLabel("Query name", { exact: true })],
      ["Description", explorer().getByLabel("Query description", { exact: true })],
      ["Tags", explorer().getByRole("textbox", { name: "New tag", exact: true })],
      ["Save query", explorer().getByRole("button", { name: "Save query", exact: true })],
      ["Run query", explorer().getByRole("button", { name: "Run query", exact: true })],
    ]) geometry[label] = await fullyVisible(locator, label)
  } else {
    await chart.scrollIntoViewIfNeeded(); await contained(chart)
    await explorer().getByRole("button", { name: "Save query", exact: true }).scrollIntoViewIfNeeded()
    await contained(explorer().getByRole("button", { name: "Save query", exact: true }))
  }
  await shot(`compact-workspace-${theme.toLowerCase()}-${width}x${height}.png`)
  if (width < 1000) {
    await chart.scrollIntoViewIfNeeded()
    await contained(chart)
    await shot(`compact-workspace-results-${theme.toLowerCase()}-${width}x${height}.png`)
  }

  // A parameter-free chart can fit while required test values push the real
  // plotted series below the results scroller. Exercise the actual saved flow.
  const template = expression.replace('service="api"', "service={{service}}"), resolved = expression.replace('service="api"', 'service="worker"')
  const beforeParameter = queryRequests().length
  await queryMode("Code")
  await explorer().getByRole("textbox", { name: /^PromQL query/ }).fill(template)
  await detailsMode("Parameters")
  await explorer().getByRole("button", { name: "Add parameter", exact: true }).click()
  await explorer().getByLabel("Parameter 1 name", { exact: true }).fill("service")
  await explorer().getByLabel("Parameter 1 label", { exact: true }).fill("Service")
  if (width >= 1000) {
    await fullyVisible(explorer().getByLabel("Parameter 1 name", { exact: true }), "Parameter name")
    await fullyVisible(explorer().getByLabel("Parameter 1 label", { exact: true }), "Parameter label")
    await fullyVisible(explorer().getByRole("combobox", { name: "Parameter 1 type", exact: true }), "Parameter type")
    await fullyVisible(explorer().getByRole("button", { name: "Add parameter", exact: true }), "Add parameter")
    await fullyVisible(explorer().getByRole("textbox", { name: /^PromQL query/ }), "Query while editing parameters")
    const queryScroll = await explorer().getByRole("textbox", { name: /^PromQL query/ }).evaluate(element => {
      const area = element.closest("fieldset")
      return { height: area.clientHeight, contentHeight: area.scrollHeight, top: area.scrollTop }
    })
    assert.ok(queryScroll.contentHeight <= queryScroll.height + 1 && queryScroll.top === 0, `A short code query and syntax footer should not create an outer editor scrollbar: ${JSON.stringify(queryScroll)}`)
  }
  await explorer().getByRole("button", { name: "Save query", exact: true }).click()
  await explorer().getByRole("status").filter({ hasText: /Query saved/ }).waitFor()
  const parameterized = (await api("saved-queries?providerId=metrics")).document.queries.find(query => query.name === name)
  assert.equal(parameterized.query, template)
  assert.deepEqual(parameterized.parameters, [{ name: "service", label: "Service", type: "string" }])
  const selectedRow = () => explorer().getByRole("combobox", { name: "Open saved query", exact: true })
  const selectedAfterSave = width >= 1000 ? await fullyVisible(selectedRow(), "Selected saved query after save") : undefined
  await results().getByLabel("Test value for service", { exact: true }).fill("worker")
  assert.equal(queryRequests().length, beforeParameter, "Adding a required parameter, saving and typing its test value must still require Run")
  await explorer().getByRole("button", { name: "Run query", exact: true }).click()
  await until(() => queryRequests().at(-1)?.params.query === resolved, "Required service test value did not reach the real provider")
  await results().getByText(/Inputs changed\. Showing the previous result/).waitFor({ state: "hidden" })
  await chart.waitFor(); await frames()
  if (width < 1000) await chart.scrollIntoViewIfNeeded()
  const parameterPlot = await visiblePlot(chart)
  if (width >= 1000) {
    assert.ok(parameterPlot.clippingAncestors.every(parent => parent.scrollTop === 0), "Parameterized desktop results must show their plot without scrolling the body")
    await fullyVisible(results().getByLabel("Test value for service", { exact: true }), "Required service test value")
    await fullyVisible(explorer().getByRole("button", { name: "Run query", exact: true }), "Run parameterized query")
    await fullyVisible(explorer().getByRole("button", { name: "Save query", exact: true }), "Save parameterized query")
  }
  await shot(`compact-parameterized-${theme.toLowerCase()}-${width}x${height}.png`)
  const persisted = await api(`saved-queries/${parameterized.id}`)
  await page.reload({ waitUntil: "networkidle" }); await openExplorer(); await openSaved(name)
  const selectedAfterReload = width >= 1000 ? await fullyVisible(selectedRow(), "Selected saved query after reload") : undefined
  await detailsMode("Overview")
  assert.equal(await explorer().getByLabel("Query description", { exact: true }).inputValue(), description)
  await explorer().getByRole("button", { name: "Remove tag service-overview", exact: true }).waitFor()
  await queryMode("Code")
  assert.equal(await queryEditorValue(explorer().getByRole("textbox", { name: /^PromQL query/ })), template)
  assert.equal(await results().getByLabel("Test value for service", { exact: true }).inputValue(), "", "Preview values must not become saved defaults")
  await results().getByLabel("Test value for service", { exact: true }).fill("worker")
  await explorer().getByRole("button", { name: "Run query", exact: true }).click()
  await chart.waitFor(); await frames()
  if (width < 1000) await chart.scrollIntoViewIfNeeded()
  const reloadedPlot = await visiblePlot(chart), afterPreview = await api(`saved-queries/${parameterized.id}`)
  assert.equal(afterPreview.etag, persisted.etag)
  assert.deepEqual(afterPreview.document, persisted.document)
  await shot(`compact-parameterized-reloaded-${theme.toLowerCase()}-${width}x${height}.png`)
  return { width, height, theme, expression, saved: true, ran: true, explicitRun: true, providerMenu: menuGeometry, contrast, selection, draftRetainedAcrossTabs: true, documentGeometry, geometry, requiredParameter: { template, resolved, parameterPlot, reloadedPlot, selectedAfterSave, selectedAfterReload, previewDidNotChangeDefaults: true } }
}

async function authorAndLink(width) {
  await openScenario(board([], [{ name: "service", label: "Service", defaultValue: "original" }, { name: "selected_service", label: "Selected service", defaultValue: "dashboard-api" }, { name: "minimum", label: "Minimum", defaultValue: "-7.25" }]), width)
  await openExplorer()
  const start = queryRequests().length
  await queryMode("Builder")
  await shot(`query-workspace-${width}.png`)
  const metric = explorer().getByRole("combobox", { name: "Metric", exact: true })
  await metric.fill("up"); await page.getByRole("option", { name: "up", exact: true }).click()
  await explorer().getByRole("button", { name: "Use generated query", exact: true }).click()
  await shot(`query-workspace-composed-${width}.png`)
  assert.ok(providerRequests.some(entry => entry.path === "/prometheus/api/v1/label/__name__/values"), "Metric catalogue must come from the real Prometheus adapter")
  const template = "library_requests{service={{service}}} > {{minimum}}", name = `Reusable requests ${width}`
  await explorer().getByLabel("Query name", { exact: true }).fill(name)
  await explorer().getByLabel("Query description", { exact: true }).fill("A shared query with a text filter and numeric threshold")
  await queryMode("Code")
  await explorer().getByRole("textbox", { name: /^PromQL query/ }).fill(template)
  for (const [index, parameter] of [{ name: "service", label: "Service", type: "Text", value: "api" }, { name: "minimum", label: "Minimum", type: "Number", value: "-7.25" }].entries()) {
    await detailsMode("Parameters")
    await explorer().getByRole("button", { name: "Add parameter", exact: true }).click()
    await explorer().getByLabel(`Parameter ${index + 1} name`, { exact: true }).fill(parameter.name)
    await explorer().getByLabel(`Parameter ${index + 1} label`, { exact: true }).fill(parameter.label)
    await selectGammaOption(page, explorer().getByRole("combobox", { name: `Parameter ${index + 1} type`, exact: true }), parameter.type)
    await explorer().getByRole("switch", { name: new RegExp(`^Default for parameter ${index + 1}\\b`) }).click()
    await explorer().getByLabel(`Parameter ${index + 1} default`, { exact: true }).fill(parameter.value)
  }
  await frames(); assert.equal(queryRequests().length, start, "Authoring parameters/templates must not execute a provider query")
  const field = explorer().getByRole("textbox", { name: /^PromQL query/ })
  const queryGeometry = await queryEditorGeometry(field)
  assert.ok(queryGeometry.height >= 100); assert.equal(queryGeometry.resize, "none")
  await explorer().getByLabel("Parameter 2 name", { exact: true }).scrollIntoViewIfNeeded(); await shot(`parameters-${width}.png`)
  await explorer().getByRole("button", { name: "Save query", exact: true }).click()
  await explorer().getByRole("status").filter({ hasText: /Query saved/ }).waitFor()
  const { document: library } = await api("saved-queries?providerId=metrics")
  const saved = library.queries.find(query => query.name === name)
  assert.ok(saved?.etag); assert.equal(saved.parameters[1].defaultValue, -7.25)
  assert.equal(queryRequests().length, start, "Saving must not execute the query")
  await explorer().getByLabel("Test value for service", { exact: true }).fill(enteredService)
  await explorer().getByRole("button", { name: "Run query", exact: true }).click()
  const exact = `library_requests{service=${JSON.stringify(enteredService)}} > -7.25`
  await until(() => queryRequests().at(-1)?.params.query === exact, "Explorer did not send exactly escaped text and numeric default")
  await selectGammaOption(page, results().getByRole("combobox", { name: "Explore result visualization", exact: true }), "Single value")
  await results().locator('[data-metric-value="123.5"]').waitFor()
  await results().locator('[data-metric-value="123.5"]').scrollIntoViewIfNeeded()
  await contained(results().locator('[data-metric-value="123.5"]'))
  const resultDetails = await page.getByRole("tooltip").evaluateAll(elements => elements.map(element => ({ text: element.innerText, bounds: element.getBoundingClientRect().toJSON() })))
  if (resultDetails.length) {
    assert.ok(resultDetails.every(detail => detail.text.includes("123.5")), "Any visible result tooltip must paint its exact observation")
    await shot(`result-with-details-${width}.png`)
    await page.keyboard.press("Escape"); await page.mouse.move(0, 0)
    await page.getByRole("tooltip").waitFor({ state: "hidden" })
  }
  await shot(`result-${width}.png`)
  const beforeChange = queryRequests().length
  await explorer().getByLabel("Test value for minimum", { exact: true }).fill("-2.5")
  await results().getByText(/Inputs changed\. Showing the previous result/).waitFor()
  await frames(); assert.equal(queryRequests().length, beforeChange, "Test-value typing must require explicit Run")
  await explorer().getByRole("button", { name: "Run query", exact: true }).click()
  await until(() => queryRequests().at(-1)?.params.query === `library_requests{service=${JSON.stringify(enteredService)}} > -2.5`, "Explicit run did not use changed numeric test value")
  const persisted = (await api(`saved-queries/${saved.id}`)).document
  assert.equal(persisted.parameters[1].defaultValue, -7.25, "Local test input must not overwrite shared defaults")

  await explorer().getByRole("button", { name: "Use in dashboard", exact: true }).click()
  await panel().waitFor()
  assert.equal(await panel().getByRole("combobox", { name: "Widget query source", exact: true }).innerText(), "Saved query")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Dashboard variable for service", exact: true }), /Selected service/)
  await applySave()
  let document = (await api("dashboards/explorer-board")).document
  const widget = document.widgets.find(widget => widget.title === name)
  assert.equal(widget.queryRef.id, saved.id)
  assert.deepEqual(widget.queryRef.bindings.find(binding => binding.parameter === "service"), { parameter: "service", source: "variable", variable: "selected_service" })
  const widgetId = widget.id, customDraft = widget.query
  await until(() => queryRequests().some(entry => entry.params.query === 'library_requests{service="dashboard-api"} > -7.25'), "Linked widget did not use remapped variable and numeric variable")
  const variables = page.getByRole("form", { name: "Dashboard variables", exact: true })
  const beforeTyping = queryRequests().length
  await variables.getByLabel("Selected service", { exact: true }).fill(enteredService)
  await frames(); assert.equal(queryRequests().length, beforeTyping, "Dashboard variable typing must not query before Apply")
  await variables.getByRole("button", { name: "Apply values", exact: true }).click()
  await until(() => queryRequests().at(-1)?.params.query === exact, "Apply values did not update the live query reference")
  await shot(`linked-dashboard-${width}.png`)

  await openExplorer()
  await openSaved(name)
  await queryMode("Code")
  await explorer().getByRole("textbox", { name: /^PromQL query/ }).fill(`${template} + 1`)
  await explorer().getByRole("button", { name: "Save query", exact: true }).click()
  await explorer().getByRole("status").filter({ hasText: /Query saved/ }).waitFor()
  await explorer().getByRole("button", { name: "Dashboard", exact: true }).click()
  await until(() => queryRequests().at(-1)?.params.query === `${exact} + 1`, "A saved definition edit did not update the linked dashboard query")
  document = (await api("dashboards/explorer-board")).document
  assert.equal(document.widgets.find(widget => widget.id === widgetId).query, customDraft, "Live reference edits must not replace the retained custom draft")
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
  await page.getByRole("button", { name: `Edit ${name}`, exact: true }).click()
  await panel().getByRole("button", { name: "Use custom query", exact: true }).click()
  assert.equal(await queryEditorValue(panel().getByRole("textbox", { name: /^PromQL query/ })), customDraft)
  await panel().getByRole("textbox", { name: /^PromQL query/ }).fill("custom_retained")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Widget query source", exact: true }), "Saved query")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Saved query", exact: true }), new RegExp(name))
  await applySave()
  document = (await api("dashboards/explorer-board")).document
  assert.equal(document.widgets.find(widget => widget.id === widgetId).query, "custom_retained")
  assert.equal(document.widgets.find(widget => widget.id === widgetId).queryRef.id, saved.id)
  return { savedId: saved.id, queryGeometry, resultDetails, exactExplorerQuery: exact, explicitRunAndApply: true, linkedVariable: "selected_service", liveDefinitionUpdate: true, retainedCustomDraft: "custom_retained" }
}

async function savedTooltip(width) {
  await putQuery(childQuery())
  await openScenario(board([host()], [{ name: "tenant", label: "Tenant", defaultValue: 'team"west\\{{text}}' }]), width)
  await cells().first().waitFor()
  const before = queryRequests().length
  await showCell()
  const full = tooltip().locator('[data-tooltip-widget="table"]')
  await full.locator("tbody tr").first().waitFor()
  assert.equal(await full.locator("tbody tr").count(), 3, "Existing widget data must include all parent series, not just the hovered one")
  assert.equal(queryRequests().length, before, "Existing widget results must not issue another provider request")
  await full.getByText(/42/).first().scrollIntoViewIfNeeded(); await contained(tooltip()); await shot(`existing-widget-results-${width}.png`)
  await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
  await editHost()
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip visualization", exact: true }), "Single value")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip data source", exact: true }), "Saved query")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip saved query", exact: true }), /Contextual child/)
  for (const [parameter, source] of [["service", "Observation label"], ["tenant", "Dashboard variable"], ["at", "Observation timestamp"], ["observed", "Observation value"]]) {
    await selectGammaOption(page, panel().getByRole("combobox", { name: `Value for ${parameter} from`, exact: true }), source)
  }
  await panel().getByLabel("Observation label for service", { exact: true }).fill("service")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Dashboard variable for tenant", exact: true }), /Tenant/)
  const sourceControl = panel().getByRole("combobox", { name: "Value for observed from", exact: true })
  const bindingGeometry = await panel().getByRole("combobox", { name: /^Value for / }).evaluateAll(elements => elements.map(element => {
    const text = element.querySelector("span"), box = element.getBoundingClientRect()
    return { label: element.getAttribute("aria-label"), value: text?.textContent, width: box.width, height: box.height, textWidth: text?.scrollWidth, visibleTextWidth: text?.clientWidth }
  }))
  assert.ok(bindingGeometry.every(control => control.textWidth <= control.visibleTextWidth + 1), "Saved binding sources must show their selected mode without truncation")
  await sourceControl.scrollIntoViewIfNeeded(); await contained(sourceControl); await shot(`tooltip-bindings-${width}.png`)
  await sourceControl.click(); await contained(page.getByRole("listbox")); await shot(`tooltip-binding-menu-${width}.png`); await page.keyboard.press("Escape")
  const beforeApply = childRequests().length
  await applySave(); await frames()
  assert.equal(childRequests().length, beforeApply, "A closed saved-query tooltip must remain lazy")
  const document = (await api("dashboards/explorer-board")).document
  const savedSource = document.widgets[0].options.tooltipView.source
  assert.equal(savedSource.type, "saved"); assert.equal(savedSource.ref.id, "tooltip-library")
  assert.deepEqual(Object.fromEntries(savedSource.ref.bindings.map(binding => [binding.parameter, binding])), Object.fromEntries(childBindings.map(binding => [binding.parameter, binding])), "All unique parameter bindings must persist exactly; editing a binding may reorder its row")
  await showCell()
  await tooltip().locator('[data-tooltip-widget="stat"] [data-metric-value="111"]').waitFor()
  const exact = `child_saved{service=${JSON.stringify(specialLabel)},tenant=${JSON.stringify('team"west\\{{text}}')}} @${Date.parse(fixedRange.to) / 1000 - .25} > 32`
  assert.equal(childRequests().at(-1)?.params.query, exact, "Saved tooltip must escape quote, slash, newline, braces once and retain numeric point/time literals")
  await tooltip().locator('[data-tooltip-widget="stat"]').scrollIntoViewIfNeeded(); await contained(tooltip()); await shot(`saved-tooltip-${width}.png`)
  await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
  const missingBefore = childRequests().length
  await showCell(2)
  await tooltip().getByRole("alert").getByText(/no label|missing label/i).waitFor()
  assert.equal(childRequests().length, missingBefore, "Missing observation labels must fail locally")
  return { fullParentSeries: 3, reusedExistingRequest: true, bindingGeometry, savedSource: document.widgets[0].options.tooltipView.source, exactUpstreamQuery: exact, missingLabelNoRequest: true }
}

function openUI(document) {
  const names = { timeseries: "TimeSeries", bar: "BarChart", stat: "Stat", table: "MetricsTable", traces: "Traces", heatmap: "Heatmap" }
  const args = values => values.map(value => JSON.stringify(value ?? null)).join(", ")
  return `root = Dashboard(${args([document.id, document.title, document.timeRange, document.refreshInterval])}, [${document.widgets.map((_, index) => `widget${index}`).join(", ")}], ${args([document.description, document.folder, document.customTimeRange, document.variables])})\n` + document.widgets.map((widget, index) => `widget${index} = ${names[widget.type]}(${args([widget.id, widget.title, widget.providerId, widget.query, widget.unit, widget.layout, widget.description, widget.color, widget.options, widget.pluginId, widget.dataKind, widget.config, widget.drilldowns, widget.queryRef])})`).join("\n")
}

try {
  await mkdir(output, { recursive: true })
  const upstreamPort = await listen(upstream), reservation = createServer()
  servicePort = await listen(reservation); await new Promise(resolve => reservation.close(resolve)); serviceURL = `http://127.0.0.1:${servicePort}`
  await writeFile(join(temporary, "providers.json"), JSON.stringify({ providers: [
    { id: "metrics", name: "Library metrics", type: "prometheus", url: `http://127.0.0.1:${upstreamPort}/prometheus` },
    { id: "traces", name: "Library traces", type: "tempo", url: `http://127.0.0.1:${upstreamPort}/tempo` },
  ] }))
  await run("rtk", ["proxy", "go", "build", "-o", binary, "./cmd/paprika-insights"])
  await startService(); gatewayURL = `http://127.0.0.1:${await listen(gateway)}`
  browser = await chromium.launch({ headless: true })

  for (const width of [1512, 390]) {
    await check(`First-time saved tooltip creation, ID selection and optional sparkline persistence at ${width}px`, () => freshSavedTooltip(width))
    await check(`Stat and reused widget-result sparklines preserve null gaps without extra queries at ${width}px`, () => reusedStatSparkline(width))
  }

  for (const width of [1512, 390]) {
    await check(`Explorer discovery, typed saving, live dashboard references and variable remapping at ${width}px`, () => authorAndLink(width))
    await check(`Existing widget results and saved tooltip observation/dashboard bindings at ${width}px`, () => savedTooltip(width))
  }

  await check("Saved query library survives restart and reports ETag conflicts and in-use deletion without losing edits", async () => {
    const query = { schemaVersion: 1, id: "lifecycle", name: "Lifecycle query", providerId: "metrics", kind: "metrics", query: "up" }
    await putQuery(query)
    const widget = { ...host(), queryRef: { id: query.id } }; delete widget.options
    await openScenario(board([widget]))
    await openExplorer(); await openSaved(query.name)
    await stopService(); await startService()
    await page.reload({ waitUntil: "networkidle" }); await openExplorer(); await openSaved(query.name)
    assert.equal(await explorer().getByLabel("Query name", { exact: true }).inputValue(), query.name)
    const previous = await api("saved-queries/lifecycle")
    await api("saved-queries/lifecycle", "PUT", { ...previous.document, name: "Remote lifecycle edit" }, { "If-Match": previous.etag })
    await explorer().getByLabel("Query name", { exact: true }).fill("Local unsaved edit")
    await explorer().getByRole("button", { name: "Save query", exact: true }).click()
    await explorer().getByRole("alert").getByText(/changed|reload|conflict/i).first().waitFor()
    assert.equal(await explorer().getByLabel("Query name", { exact: true }).inputValue(), "Local unsaved edit")
    assert.equal(await explorer().getByRole("alert").getByRole("button", { name: "Load latest saved version", exact: true }).count(), 1, "ETag conflicts should offer save recovery")
    await shot("etag-conflict-1512.png")
    await explorer().getByRole("button", { name: "Load latest saved version", exact: true }).click()
    await respondToGammaConfirmation(page, "Discard changes")
    await until(async () => await explorer().getByLabel("Query name", { exact: true }).inputValue() === "Remote lifecycle edit", "Reload latest did not recover remote version")
    await explorer().getByRole("button", { name: "Delete query", exact: true }).click()
    await respondToGammaConfirmation(page, "Delete saved query")
    await explorer().getByRole("alert").getByText(/in use|persisted dashboard|used by the current dashboard/i).waitFor()
    assert.equal(await explorer().getByRole("alert").getByRole("button", { name: /Load latest saved version|Save as new query/ }).count(), 0, "In-use deletion errors must not offer unrelated save recovery actions")
    assert.equal((await api("saved-queries/lifecycle")).document.name, "Remote lifecycle edit")
    const remote = await api("saved-queries/lifecycle")
    await api("saved-queries/lifecycle", "DELETE", undefined, { "If-Match": remote.etag }, 409)
    await shot("query-in-use-1512.png")
    await api("dashboards/explorer-board", "PUT", board())
    await page.reload({ waitUntil: "networkidle" }); await openExplorer(); await openSaved("Remote lifecycle edit")
    await explorer().getByRole("button", { name: "Delete query", exact: true }).click()
    await respondToGammaConfirmation(page, "Delete saved query")
    await explorer().getByText("Saved query deleted.", { exact: true }).waitFor()
    await api("saved-queries/lifecycle", "GET", undefined, {}, 404)
    await stopService(); await startService()
    await api("saved-queries/lifecycle", "GET", undefined, {}, 404)
    return { restartPersisted: true, deletedStatePersisted: true, staleEditKept: true, referencedDeleteBlocked: true }
  })

  await check("Explorer cancellation, stale-result suppression and closing/reopening preserve the query draft", async () => {
    await openScenario(); await openExplorer()
    await queryMode("Code")
    const field = explorer().getByRole("textbox", { name: /^PromQL query/ })
    await explorer().getByLabel("Query name", { exact: true }).fill("Retained draft")
    await field.fill("slow_probe")
    await explorer().getByRole("button", { name: "Run query", exact: true }).click()
    await until(() => pending.some(item => item.entry.params.query === "slow_probe" && !item.entry.aborted), "Slow Explorer query did not start")
    const first = pending.findLast(item => item.entry.params.query === "slow_probe")
    await explorer().getByRole("button", { name: "Cancel query", exact: true }).click()
    await until(() => first.entry.aborted, "Cancel did not reach the actual Prometheus request")
    await explorer().getByRole("button", { name: "Run query", exact: true }).click()
    await until(() => pending.filter(item => item.entry.params.query === "slow_probe").length >= 2, "Second slow request did not start")
    const second = pending.findLast(item => item.entry.params.query === "slow_probe")
    await explorer().getByRole("button", { name: "Dashboard", exact: true }).click()
    await until(() => second.entry.aborted, "Hiding Explorer must cancel its running query")
    await openExplorer()
    assert.equal(await explorer().getByLabel("Query name", { exact: true }).inputValue(), "Retained draft")
    assert.equal(await queryEditorValue(field), "slow_probe")
    await field.fill("fast_probe")
    await explorer().getByRole("button", { name: "Run query", exact: true }).click()
    await selectGammaOption(page, results().getByRole("combobox", { name: "Explore result visualization", exact: true }), "Single value")
    await results().locator('[data-metric-value="222"]').waitFor()
    for (const item of [first, second]) if (!item.response.destroyed) json(item.response, 200, matrix(item.end, 999))
    await frames(); assert.equal(await results().locator('[data-metric-value="999"]').count(), 0)
    assert.equal(await results().getByRole("alert").count(), 0)
    await shot("cancelled-and-recovered-1512.png")
    return { cancelledAtProvider: true, closeCancelled: true, unsavedDraftPreserved: true, staleValueNotRendered: 999, freshValue: 222 }
  })

  await check("Explorer reports provider errors and empty results honestly", async () => {
    await openScenario(board(), 390); await openExplorer()
    await queryMode("Code")
    const field = explorer().getByRole("textbox", { name: /^PromQL query/ })
    await field.fill("error_probe"); await explorer().getByRole("button", { name: "Run query", exact: true }).click()
    await results().getByRole("alert").waitFor()
    assert.doesNotMatch(await results().innerText(), /private-upstream-diagnostic/)
    assert.equal(await results().locator("svg[role=img]").count(), 0)
    await field.fill("empty_probe"); await explorer().getByRole("button", { name: "Run query", exact: true }).click()
    await results().getByText(/No data in this time range|No data|No observations/i).first().waitFor()
    assert.equal(await results().getByRole("alert").count(), 0)
    await shot("empty-result-390.png")
    return { upstreamDetailsHidden: true, emptyResultNotFabricated: true }
  })

  await check("Trace saved queries stay scoped to their provider and use exact typed literals", async () => {
    await openScenario(); await openExplorer()
    await selectGammaOption(page, explorer().getByRole("combobox", { name: "Explore data source", exact: true }), /Library traces/)
    await explorer().getByLabel("Query name", { exact: true }).fill("Reusable trace search")
    await explorer().getByRole("textbox", { name: /^TraceQL query/ }).fill("{ resource.service.name = {{service}} }")
    await detailsMode("Parameters")
    await explorer().getByRole("button", { name: "Add parameter", exact: true }).click()
    await explorer().getByLabel("Parameter 1 name", { exact: true }).fill("service")
    await explorer().getByLabel("Test value for service", { exact: true }).fill(enteredService)
    await explorer().getByRole("button", { name: "Run query", exact: true }).click()
    await results().getByText("GET /saved-query", { exact: true }).waitFor()
    const request = queryRequests().at(-1)
    assert.equal(request.path, "/tempo/api/search")
    assert.equal(request.params.q, `{ resource.service.name = ${JSON.stringify(enteredService)} }`)
    await explorer().getByRole("button", { name: "Save query", exact: true }).click()
    await explorer().getByRole("status").filter({ hasText: /Query saved/ }).waitFor()
    const { document } = await api("saved-queries?providerId=traces")
    assert.ok(document.queries.some(query => query.name === "Reusable trace search" && query.kind === "traces"))
    await shot("trace-library-1512.png")
    return { providerScoped: true, exactTraceQL: request.params.q, operation: "GET /saved-query" }
  })

  await check("Missing library references and incompatible saved-query capabilities never fall back or query", async () => {
    const trace = { schemaVersion: 1, id: "trace-only", name: "Trace-only library", providerId: "traces", kind: "traces", query: "{}" }
    await putQuery(trace)
    for (const id of ["unavailable-library", "trace-only"]) {
      const widget = { ...host(), type: "stat", queryRef: { id } }; delete widget.options
      const before = queryRequests().length
      await openScenario(board([widget]))
      await tile().getByText(/unavailable|does not provide metrics|compatible query/i).first().waitFor()
      assert.equal(queryRequests().length, before, "Missing/incompatible ref must not execute retained parent_health fallback")
      assert.doesNotMatch(await tile().innerText(), /Provider.*not configured/, "A valid configured provider must not mask the saved-reference error")
      await shot(`reference-error-${id}-1512.png`)
    }
    const before = childRequests().length
    await openScenario(board([host({ type: "saved", ref: { id: "unavailable-library" } }, "stat")]))
    await showCell(); await tooltip().getByRole("alert").getByText(/unavailable/i).waitFor()
    assert.equal(childRequests().length, before)
    return { missingAndWrongKindBlocked: true, noCustomFallback: true }
  })

  await check("Saved tooltip switching cancels the old real provider request and keeps the new context", async () => {
    await putQuery(childQuery("slow-tooltip", "slow_saved"))
    await openScenario(board([host({ type: "saved", ref: { id: "slow-tooltip", bindings: childBindings } }, "stat")], [{ name: "tenant", defaultValue: "ops" }]))
    await showCell()
    await until(() => pending.some(item => item.entry.params.query?.startsWith("slow_saved") && !item.entry.aborted), "Saved tooltip did not start its query")
    const first = pending.findLast(item => item.entry.params.query?.startsWith("slow_saved"))
    await cells().nth(1).hover()
    await tooltip().locator('[data-tooltip-widget="stat"] [data-metric-value="222"]').waitFor()
    await until(() => first.entry.aborted, "Switching observation did not cancel saved tooltip query")
    if (!first.response.destroyed) json(first.response, 200, matrix(first.end, 999))
    await frames(); assert.equal(await tooltip().locator('[data-metric-value="999"]').count(), 0)
    assert.ok(childRequests().at(-1).params.query.includes('service="worker"'))
    return { oldRequestAborted: true, newContext: "worker", staleResultBlocked: true }
  })

  await check("Saved widget and tooltip references round-trip through JSON, YAML and OpenUI", async () => {
    await putQuery({ schemaVersion: 1, id: "portable-parent", name: "Portable parent", providerId: "metrics", kind: "metrics", query: "parent_health" })
    await putQuery(childQuery())
    const widget = host({ type: "saved", ref: { id: "tooltip-library", bindings: childBindings } }, "stat")
    widget.queryRef = { id: "portable-parent", bindings: [] }
    widget.options.tooltipView.showSparkline = true
    const summary = { ...widget, id: "portable-summary", title: "Portable summary", type: "stat", layout: { x: 0, y: 6, w: 12, h: 4 }, options: { showSparkline: false } }
    const original = board([widget, summary], [{ name: "tenant", defaultValue: "portable" }])
    await openScenario(original, 390)
    const sourcePanel = () => page.getByRole("region", { name: "Dashboard source editor", exact: true })
    for (const format of ["JSON", "YAML"]) {
      await page.getByRole("button", { name: "Code", exact: true }).click()
      await sourcePanel().getByRole("button", { name: format, exact: true }).click()
      const field = sourcePanel().getByRole("textbox", { name: "Dashboard source", exact: true }), text = await field.inputValue()
      assert.match(text, /queryRef/); assert.match(text, /tooltip-library/)
      await field.fill(text.replace("Explorer integration", `Explorer integration ${format}`))
      await sourcePanel().getByRole("button", { name: "Apply to canvas", exact: true }).click()
      await sourcePanel().waitFor({ state: "hidden" }); await saveBoard()
      const saved = (await api("dashboards/explorer-board")).document
      assert.deepEqual(saved.widgets[0].queryRef, widget.queryRef); assert.deepEqual(saved.widgets[0].options.tooltipView.source, widget.options.tooltipView.source)
      assert.equal(saved.widgets[0].options.tooltipView.showSparkline, true); assert.equal(saved.widgets[1].options.showSparkline, false)
    }
    let document = (await api("dashboards/explorer-board")).document
    document.title = "Explorer integration OpenUI"
    await page.getByRole("button", { name: "Build with AI", exact: true }).click()
    const ai = page.getByRole("region", { name: "Build with AI", exact: true })
    await ai.getByRole("textbox", { name: "AI-generated definition", exact: true }).fill(openUI(document))
    await ai.getByRole("button", { name: "Review definition", exact: true }).click()
    await ai.getByRole("button", { name: "Apply to canvas", exact: true }).click()
    if (await ai.isVisible()) await ai.getByRole("button", { name: "Close AI builder", exact: true }).click()
    await saveBoard(); await page.reload({ waitUntil: "networkidle" })
    document = (await api("dashboards/explorer-board")).document
    assert.deepEqual(document.widgets[0].queryRef, widget.queryRef); assert.deepEqual(document.widgets[0].options.tooltipView.source, widget.options.tooltipView.source)
    assert.equal(document.widgets[0].options.tooltipView.showSparkline, true); assert.equal(document.widgets[1].options.showSparkline, false)
    await showCell(); await tooltip().locator('[data-tooltip-widget="stat"] [data-metric-value="111"]').waitFor()
    await tooltip().locator('[data-tooltip-widget="stat"] svg[data-stat-sparkline]').waitFor()
    await contained(tooltip()); await shot("portable-references-390.png")
    return { formats: ["JSON", "YAML", "OpenUI"], exactParentReference: widget.queryRef, exactTooltipReference: widget.options.tooltipView.source, tooltipSparkline: true, topLevelSparkline: false, usableAfterReload: true }
  })

  await check("Explorer and saved-query menus remain usable at320px", async () => {
    await openScenario(board(), 320); await openExplorer()
    const provider = explorer().getByRole("combobox", { name: "Explore data source", exact: true })
    await provider.scrollIntoViewIfNeeded(); await provider.click()
    const menu = page.getByRole("listbox")
    const bounds = await contained(menu); await shot("source-menu-320.png"); await page.keyboard.press("Escape")
    await selectGammaOption(page, explorer().getByRole("combobox", { name: "Open saved query", exact: true }), /Reusable requests 390/)
    const select = explorer().getByRole("combobox", { name: "Open saved query", exact: true })
    await select.scrollIntoViewIfNeeded(); await select.click(); await contained(page.getByRole("listbox")); await shot("query-menu-320.png"); await page.keyboard.press("Escape")
    await detailsMode("Parameters")
    const type = explorer().getByRole("combobox", { name: "Parameter 2 type", exact: true })
    await type.scrollIntoViewIfNeeded(); const control = await contained(type)
    assert.ok(control.height >= 44); await shot("parameter-controls-320.png")
    await queryMode("Code")
    const input = explorer().getByRole("textbox", { name: /^PromQL query/ })
    const geometry = await queryEditorGeometry(input)
    assert.ok(geometry.height >= 100); assert.equal(geometry.resize, "none")
    await detailsMode("Overview")
    await explorer().getByLabel("Query name", { exact: true }).scrollIntoViewIfNeeded(); await shot("workspace-320.png")
    return { viewport: 320, sourceMenu: bounds, parameterTarget: control, textarea: geometry }
  })
  for (const width of [1272, 390]) {
    for (const theme of ["Light", "Dark"]) {
      await check(`Provider language editor completes validates and runs in ${theme} at ${width}px`, async () => {
        await openScenario(board(), width, width < 600 ? 844 : 720)
        await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
        await openExplorer()
        return verifyProviderEditor({ page, width, theme, explorer, results, api, queryMode, detailsMode, queryRequests, providerRequests, until, shot, contained, fullyVisible })
      })
    }
  }
  for (const [width, height] of [[1512, 982], [1366, 900], [1272, 720], [390, 844]]) {
    for (const theme of ["Light", "Dark"]) {
      await check(`Compact query workspace fits and saves/runs in ${theme} at ${width}x${height}`, () => compactWorkspace(width, height, theme))
    }
  }

  for (const width of [1512, 390]) {
    await check(`Smart parameter connections use loaded graph labels and dashboard variables at ${width}px`, async () => {
      const query = connectionQuery(width)
      await putQuery(query)
      await openScenario(board([host({ type: "widget" }, "stat")], [{ name: "tenant", defaultValue: "ops" }]), width, width === 390 ? 844 : 982)
      return verifyConnections({ page, width, query, api, panel, editHost, saveBoard, showCell, tooltip, queryRequests, until, shot, specialLabel })
    })
  }

  // Numeric precision uses real persisted settings at desktop and touch sizes.
  for (const width of [1512, 390]) {
    await check(`Numeric precision applies 0 2 4 places to values and tooltip details at ${width}px`, async () => {
      const fixtures = precisionFixtures(width)
      await putQuery(fixtures.query)
      await openScenario(board(fixtures.widgets), width, width === 390 ? 844 : 982)
      return verifyPrecision({ page, width, api, panel, tooltip, showCell, saveBoard, shot, contained, centerTooltipChild })
    })
  }

  for (const width of [1512, 390]) {
    for (const theme of ["Light", "Dark"]) {
    await check(`Rich saved queries persist and render in library and widget menus in ${theme} at ${width}px`, async () => {
      await openScenario(board([host()]), width, width === 390 ? 844 : 982)
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      await openExplorer()
      const source = explorer().getByRole("combobox", { name: "Explore data source", exact: true })
      assert.equal(await source.locator('[data-provider-type="prometheus"]').count(), 1)
      await source.click(); assert.equal(await page.getByRole("option", { name: "Library metrics", exact: true }).locator('[data-provider-type="prometheus"]').count(), 1); await page.keyboard.press("Escape")
      await queryMode("Code")
      await explorer().getByRole("textbox", { name: /^PromQL query/ }).fill("http_requests_total")
      const name = `Service requests ${width} ${theme}`
      await explorer().getByLabel("Query name", { exact: true }).fill(name)
      await explorer().getByLabel("Query description", { exact: true }).fill("Request volume across the platform")
      await explorer().getByRole("textbox", { name: "New tag", exact: true }).fill("production")
      await explorer().getByRole("button", { name: "Add tag", exact: true }).click()
      await detailsMode("Metadata")
      await explorer().getByLabel("Cover image", { exact: true }).fill("/query-cover.svg")
      await explorer().getByRole("textbox", { name: "New metadata key", exact: true }).fill("team")
      await explorer().getByRole("textbox", { name: "New metadata value", exact: true }).fill("platform")
      await explorer().getByRole("button", { name: "Add field", exact: true }).click()
      await explorer().getByRole("button", { name: "Save query", exact: true }).click()
      await explorer().getByText("Query saved.", { exact: true }).waitFor()
      const saved = (await api("saved-queries")).document.queries.find(query => query.name === name)
      assert.equal(saved.imageUrl, "/query-cover.svg"); assert.deepEqual(saved.tags, ["production"]); assert.deepEqual(saved.metadata, { team: "platform" })
      await page.reload({ waitUntil: "networkidle" }); await openExplorer()
      const libraryPicker = explorer().getByRole("combobox", { name: "Open saved query", exact: true })
      await libraryPicker.click()
      await page.getByRole("combobox", { name: "Search open saved query", exact: true }).fill("platform")
      const row = page.getByRole("option", { name, exact: true })
      await row.scrollIntoViewIfNeeded()
      await fullyVisible(row, "Rich saved query option")
      assert.match(await row.innerText(), /production/); assert.match(await row.innerText(), /team platform/)
      await until(() => row.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), "Saved query artwork did not load after scrolling into view")
      await contained(page.getByRole("listbox")); await shot(`rich-query-library-${theme.toLowerCase()}-${width}.png`)
      await row.click()
      await libraryPicker.getByText("production", { exact: true }).waitFor()
      await explorer().getByRole("button", { name: "Dashboard", exact: true }).click()
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await page.getByRole("button", { name: "Edit Parent health", exact: true }).click()
      const tabGeometry = await panel().evaluate(element => {
        const container = element.getBoundingClientRect()
        return [...element.querySelectorAll('[role="tablist"] [role="tab"]')].map(tab => {
          const box = tab.getBoundingClientRect()
          return { label: tab.textContent, left: box.left, right: box.right, inside: box.width > 0 && box.left >= container.left && box.right <= container.right }
        })
      })
      assert.ok(tabGeometry.length >= 5 && tabGeometry.every(tab => tab.inside), `Every settings tab stays inside the panel: ${JSON.stringify(tabGeometry)}`)
      await selectGammaOption(page, panel().getByRole("combobox", { name: "Widget query source", exact: true }), "Saved query")
      await panel().getByRole("combobox", { name: "Saved query", exact: true }).click()
      await page.getByRole("combobox", { name: "Search saved query", exact: true }).fill("platform")
      const option = page.getByRole("option", { name, exact: true })
      assert.match(await option.innerText(), /Request volume/); assert.match(await option.innerText(), /production/); assert.match(await option.innerText(), /team platform/)
      await contained(page.getByRole("listbox")); await shot(`rich-query-picker-${theme.toLowerCase()}-${width}.png`)
      await option.click()
      assert.equal(await panel().getByRole("combobox", { name: "Saved query", exact: true }).locator('img').count(), 1)
      await panel().getByRole("combobox", { name: "Saved query", exact: true }).getByText("production", { exact: true }).waitFor()
      return { width, theme, image: saved.imageUrl, tags: saved.tags, metadata: saved.metadata, reload: true, richPicker: true, tabGeometry }
    })
    }

    await check(`Metric labels and cardinality inspect and create a filter at ${width}px`, async () => {
      await openScenario(board(), width, width === 390 ? 844 : 982); await openExplorer()
      await explorer().getByRole("combobox", { name: "Metric", exact: true }).fill("http_requests_total")
      await page.getByRole("option", { name: "http_requests_total", exact: true }).click()
      await explorer().getByRole("button", { name: "Inspect metric", exact: true }).click()
      const inspector = page.getByRole("dialog", { name: "http_requests_total", exact: true })
      await inspector.getByText("Stored series · last 24h", { exact: true }).waitFor()
      await until(async () => /3\s+Stored series/.test(await inspector.innerText()), "Series count missing")
      assert.match(await inspector.innerText(), /service\s+2/); assert.match(await inspector.innerText(), /status\s+2/)
      await contained(inspector); await shot(`metric-inspection-${width}.png`)
      await inspector.locator("summary").filter({ hasText: "service" }).click()
      await inspector.getByRole("button", { name: 'Filter service = "api"', exact: true }).click()
      await inspector.waitFor({ state: "hidden" })
      assert.equal(await explorer().getByRole("combobox", { name: "Filter 1 label", exact: true }).inputValue(), "service")
      await explorer().getByRole("button", { name: "Use generated query", exact: true }).click()
      await queryMode("Code")
      assert.match(await queryEditorValue(explorer().getByRole("textbox", { name: /^PromQL query/ })), /http_requests_total\{service="api"\}/)
      return { width, storedSeries: 3, labelCardinality: { service: 2, status: 2 }, filter: 'service="api"' }
    })
  }

} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {})
  for (const item of pending) item.response.destroy()
  gateway.closeAllConnections(); upstream.closeAllConnections()
  await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))])
  await stopService()
  await writeFile(join(output, "report.json"), JSON.stringify({ baseURL, buildId: process.env.INSIGHTS_BUILD_ID, scenarioFilter: process.env.INSIGHTS_EXPLORER_FILTER, reports, pageErrors, providerRequests, screenshots, harness: "Actual Go service/persistent files and Prometheus/Tempo adapters via a test-only abort-propagating gateway. Chromium touch/mobile emulation, not physical devices." }, null, 2))
  await rm(temporary, { recursive: true, force: true })
}
assert.deepEqual(pageErrors, [])
assert.equal(reports.filter(report => !report.passed).length, 0)
console.log(`${reports.length} real-service Explorer scenarios passed.`)
