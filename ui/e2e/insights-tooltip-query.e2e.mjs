import { queryEditorGeometry } from "./query-editor.mjs"
// Run from ui/: INSIGHTS_E2E_URL=http://127.0.0.1:3015 node e2e/insights-tooltip-query.e2e.mjs
// Real Go adapters + deterministic providers. A test-owned same-origin gateway
// forwards the static UI and API, including disconnects; route.fetch would hide
// browser cancellation from the service. Host proxy auth has separate Go tests.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const authoringOnly = process.argv.includes("--authoring")
const output = join(repository, "artifacts/insights/tooltip-query")
const temporary = await mkdtemp(join(tmpdir(), "paprika-tooltip-query-"))
const binary = join(temporary, "insights")
const reports = [], pageErrors = [], providerRequests = [], screenshots = [], placementSettlements = []
const quotedService = 'checkout"blue\\west\n{{text}}'
const observationBindings = [{ variable: "service", label: "service" }, { variable: "observed", field: "value" }, { variable: "at", field: "timestamp" }, { variable: "signal", field: "series" }]
const observationSource = () => ({ type: "query", providerId: "metrics", query: "point_context{service={{service}},signal={{signal}}} @ {{at}} > {{observed}}", bindings: observationBindings })
const initialRange = { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }
const source = (query = "child_requests{service={{service}}}", providerId = "metrics") => ({ type: "query", providerId, query, bindings: [{ variable: "service", label: "service" }] })
let browser, context, page, service, serviceURL, gatewayURL
let serviceOutput = "", scenario = 0
let failChild = true
const pending = []

function json(response, status, body) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)) }
function metricResult(end, value, name = "child_requests") {
  return { status: "success", data: { resultType: "matrix", result: [{ metric: { __name__: name, service: "queried-result" }, values: [[end - 60, String(value - 1)], [end - 30, String(value)], [end, String(value)]] }] } }
}
const upstream = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost")
  const entry = { path: url.pathname, params: Object.fromEntries(url.searchParams), aborted: false, completed: false }
  providerRequests.push(entry)
  response.on("close", () => { entry.completed = response.writableEnded; entry.aborted = !response.writableEnded })
  const query = url.searchParams.get("query") ?? url.searchParams.get("q") ?? ""
  const end = Number(url.searchParams.get("end"))
  if (url.pathname === "/prometheus/api/v1/query_range") {
    if (query === "parent_health") {
      json(response, 200, { status: "success", data: { resultType: "matrix", result: [
        { metric: { __name__: "parent_health", signal: "quoted", service: quotedService, region: "eu-central-1" }, values: [[end - 60, "31"], [end, "32"]] },
        { metric: { __name__: "parent_health", signal: "worker", service: "worker", region: "us-east-1" }, values: [[end - 60, "41"], [end, "42"]] },
        { metric: { __name__: "parent_health", signal: "missing", region: "eu-central-1" }, values: [[end - 60, "51"], [end, "52"]] },
      ] } })
    } else if (query === "parent_observations") {
      json(response, 200, { status: "success", data: { resultType: "matrix", result: [
        { metric: { __name__: "observations", service: quotedService, signal: "historical" }, values: [[end - 120.25, "-7.25"], [end - 60.5, "0"], [end, "32"]] },
        { metric: { __name__: "observations", service: "worker", signal: "worker" }, values: [[end - 120, "41"], [end - 60, "42"], [end, "NaN"]] },
      ] } })
    } else if ((query.startsWith("slow_child") && !query.includes('"worker"')) || (query.startsWith("slow_observation") && query.endsWith(" > -7.25"))) pending.push({ response, entry, end })
    else if (query.startsWith("error_child") && failChild) json(response, 500, { error: "private-upstream-diagnostic" })
    else if (query.startsWith("empty_child")) json(response, 200, { status: "success", data: { resultType: "matrix", result: [] } })
    else json(response, 200, metricResult(end, query.includes('"worker"') ? 222 : 111))
    return
  }
  if (url.pathname === "/tempo/api/search") {
    json(response, 200, { traces: [{ traceID: "abcdef0123456789abcdef0123456789", rootServiceName: "queried-trace-service", rootTraceName: "GET /queried-tooltip", startTimeUnixNano: String(BigInt(end) * 1_000_000_000n), durationMs: 72.25 }] })
    return
  }
  json(response, 404, { error: "unexpected provider path" })
})

const gateway = createServer((request, response) => {
  const incoming = new URL(request.url, "http://localhost")
  const api = incoming.pathname.startsWith("/api/insights/")
  const target = new URL(api ? `${incoming.pathname.replace(/^\/api\/insights/, "/api")}${incoming.search}` : request.url, api ? serviceURL : baseURL)
  const forward = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } }, result => {
    response.writeHead(result.statusCode, result.headers)
    result.pipe(response)
  })
  forward.on("error", () => { if (!response.destroyed && !response.headersSent) json(response, 502, { error: "test gateway upstream unavailable" }); else response.destroy() })
  request.once("aborted", () => forward.destroy())
  response.once("close", () => { if (!response.writableEnded) forward.destroy() })
  request.pipe(forward)
})

async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port }
async function until(predicate, message, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error(message)
}
async function run(command, args) {
  const child = spawn(command, args, { cwd: repository, stdio: ["ignore", "pipe", "pipe"] })
  let logs = ""
  child.stdout.on("data", data => { logs += data }); child.stderr.on("data", data => { logs += data })
  const [code] = await once(child, "exit"); assert.equal(code, 0, logs)
}
async function saved() { const response = await fetch(`${serviceURL}/api/dashboards/tooltip-query`); assert.equal(response.status, 200); return response.json() }
function dashboard(view, hostType = "heatmap", parentQuery) {
  return { schemaVersion: 1, id: "tooltip-query", title: "Tooltip query integration", timeRange: "1h", customTimeRange: initialRange, refreshInterval: 0, widgets: [{
    id: "health", title: "Live signal health", type: hostType, providerId: "metrics", query: parentQuery ?? (hostType === "heatmap" ? "parent_health" : "parent_observations"), unit: "%", layout: { x: 0, y: 0, w: 12, h: 6 },
    options: { ...(view ? { tooltipView: view } : {}), thresholds: [{ value: 0, color: "#4c8466", label: "Healthy" }] },
  }] }
}
async function openScenario(view, width = 1512, hostType = "heatmap", parentQuery) {
  await context?.close()
  const response = await fetch(`${serviceURL}/api/dashboards/tooltip-query`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(dashboard(view, hostType, parentQuery)) })
  assert.equal(response.status, 200, await response.text())
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1050 }, reducedMotion: "reduce", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  page = await context.newPage(); page.setDefaultTimeout(10_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("dialog", dialog => { pageErrors.push(`Unexpected native ${dialog.type()}`); void dialog.dismiss() })
  await page.goto(`${gatewayURL}/dashboard/insights/?dashboard=tooltip-query`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: "Tooltip query integration", exact: true }).waitFor()
  if (hostType === "heatmap") await cells().first().waitFor()
  else if (hostType === "table") await tile().getByRole("button", { name: /^Inspect series / }).first().waitFor()
  else await tile().getByRole("img").first().waitFor()
  return page
}
const tile = () => page.locator('[data-widget-id="health"]')
const cells = () => tile().getByRole("group").getByRole("button")
const tooltip = () => page.getByRole("tooltip")
const panel = () => page.getByRole("region", { name: "Widget editor", exact: true })
const childQueries = () => providerRequests.filter(request => request.params.query && !new Set(["parent_health", "parent_observations"]).has(request.params.query) || request.path === "/tempo/api/search")
async function showCell(index = 0) {
  await tile().scrollIntoViewIfNeeded()
  if (page.viewportSize().width < 600) await cells().nth(index).tap()
  else await cells().nth(index).hover()
  await tooltip().waitFor()
}
async function contained(locator) {
  const initial = await locator.boundingBox()
  const settlement = await locator.evaluate(element => new Promise(resolve => {
    const start = performance.now()
    let previous, frames = 0
    const sample = () => {
      const box = element.getBoundingClientRect(), current = { x: box.x, y: box.y, width: box.width, height: box.height }
      const inside = box.x >= -1 && box.y >= -1 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1
      const stable = previous && Object.keys(current).every(key => Math.abs(current[key] - previous[key]) <= 0.25)
      frames++
      if ((inside && stable) || performance.now() - start >= 2000) resolve({ ...current, inside, stable: !!stable, frames })
      else { previous = current; requestAnimationFrame(sample) }
    }
    requestAnimationFrame(sample)
  }))
  const rect = await locator.boundingBox(), viewport = page.viewportSize()
  if (initial && Object.keys(initial).some(key => Math.abs(initial[key] - settlement[key]) > 0.5)) placementSettlements.push({ initial, settled: settlement, viewport })
  assert.ok(settlement.stable, "Tooltip placement must settle within two seconds after observation/content changes")
  assert.ok(rect, "Floating content must have rendered bounds")
  assert.ok(rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, `Content outside viewport: ${JSON.stringify({ rect, viewport })}`)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No page-level horizontal overflow")
  return rect
}
async function screenshot(name) { const path = join(output, name); await page.screenshot({ path }); screenshots.push(path) }
async function renderedVisualization(type, visualization) {
  await until(async () => (await visualization.getAttribute("aria-busy")) === "false", "Tooltip visualization stayed loading")
  assert.equal(await visualization.getByRole("alert").count(), 0, "A successful visualization must not show a rendering or query error")
  assert.doesNotMatch(await visualization.innerText(), /could not render|unavailable|No data in this time range/i)
  if (type === "timeseries" || type === "bar") {
    const chart = visualization.getByRole("img")
    await chart.waitFor()
    const bounds = await chart.boundingBox()
    assert.ok(bounds.width > 100 && bounds.height > 100, "Chart must have a usable plot area")
    assert.ok(await chart.locator("path[d], rect").count() > 0, "Chart must render data marks")
    const descriptionIDs = (await chart.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean)
    const description = (await Promise.all(descriptionIDs.map(id => page.locator(`[id=${JSON.stringify(id)}]`).textContent()))).join(" ")
    assert.match(description, /111/, "Readonly chart accessibility summary must expose the actual queried value")
    assert.ok(description.includes("%") && description.includes("queried-result"), "Chart description must retain units and result labels")
    assert.ok(description.includes(initialRange.to), "Chart description must expose the exact latest observation timestamp")
  } else if (type === "stat") await visualization.locator('[data-metric-value="111"]').waitFor()
  else if (type === "table") { assert.equal(await visualization.locator("tbody tr").count(), 1); await visualization.locator("tbody").getByText(/111/).first().waitFor() }
  else if (type === "traces") {
    assert.equal(await visualization.locator("tbody tr").count(), 1)
    await visualization.getByText("GET /queried-tooltip", { exact: true }).waitFor()
    await visualization.getByText("72.25 ms", { exact: true }).waitFor()
    const status = visualization.locator("tbody").getByText(/^unknown$/i)
    await status.waitFor()
    const statusLayout = await status.evaluate(element => {
      const range = document.createRange()
      range.selectNodeContents(element)
      return { whiteSpace: getComputedStyle(element).whiteSpace, lines: [...new Set([...range.getClientRects()].map(rect => Math.round(rect.top)))].length }
    })
    assert.equal(statusLayout.whiteSpace, "nowrap", "Trace status must preserve its whole word inside a narrow tooltip")
    assert.equal(statusLayout.lines, 1, "Trace status must render on one line")
  }
  else if (type === "heatmap") { const cell = visualization.getByRole("img"); assert.equal(await cell.count(), 1); assert.match(await cell.getAttribute("aria-label"), /111/); await cell.getByText(/111/).waitFor() }
  else if (type === "plugin") { const meter = visualization.getByRole("meter"); await meter.waitFor(); assert.equal(await meter.getAttribute("aria-valuenow"), "100"); assert.match(await meter.getAttribute("aria-valuetext"), /111/); await visualization.getByText("Tooltip gauge", { exact: true }).waitFor() }
  assert.equal(await visualization.getByRole("button").count(), 0, "Successful embedded views must stay readonly, without nested inspection controls")
}
async function editorGeometry() {
  return panel().evaluate(element => {
    const field = element.querySelector('[role="textbox"][aria-label^="Tooltip "][aria-label$="query"]'), provider = element.querySelector('[aria-label="Tooltip provider"]'), variable = element.querySelector('[aria-label="Tooltip mapping 1 variable"]'), label = element.querySelector('[aria-label="Tooltip mapping 1 hovered label"]'), remove = element.querySelector('[aria-label="Remove tooltip mapping 1"]')
    const rect = node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
    const surface = field.closest("[data-query-code-editor]")?.querySelector(".cm-scroller") ?? field
    return { query: { ...rect(surface), fontSize: getComputedStyle(field).fontSize, resize: getComputedStyle(surface).resize }, provider: rect(provider), variable: rect(variable), label: rect(label), remove: rect(remove), pageWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth }
  })
}
async function check(name, action) {
  if (authoringOnly && !name.startsWith("typed tooltip mappings")) return
  const started = Date.now(); scenario++
  try { const evidence = await action(); reports.push({ name, passed: true, milliseconds: Date.now() - started, evidence }); console.log(`PASS ${name}`) }
  catch (error) { await screenshot(`failure-${scenario}.png`).catch(() => {}); reports.push({ name, passed: false, error: error.message, stack: error.stack }); throw error }
}
async function editTooltip() {
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
  await page.getByRole("button", { name: "Edit Live signal health", exact: true }).click()
  await panel().getByRole("tab", { name: "Tooltips", exact: true }).click()
}
async function applySave() {
  await panel().getByRole("button", { name: "Apply widget", exact: true }).click()
  await panel().getByRole("button", { name: "Close widget editor", exact: true }).click()
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).waitFor()
}

const hostChart = () => tile().locator('svg[role="img"]').first()
const observationSeries = (service = quotedService, signal = "historical") => `observations{service=${JSON.stringify(service)}, signal=${JSON.stringify(signal)}}`
function expectedObservationQuery(value, offset, service = quotedService, signal = "historical", prefix = "point_context") {
  return `${prefix}{service=${JSON.stringify(service)},signal=${JSON.stringify(observationSeries(service, signal))}} @ ${Date.parse(initialRange.to) / 1000 - offset} > ${value}`
}
async function firstPlottedPoint(seriesIndex = 0) {
  await tile().scrollIntoViewIfNeeded()
  const line = hostChart().locator('path[stroke-width="1.8"]').nth(seriesIndex)
  await line.waitFor()
  return line.evaluate(element => {
    const point = element.getPointAtLength(0), transform = element.getScreenCTM()
    if (!transform) throw new Error("Rendered line has no screen transform")
    const screen = new DOMPoint(point.x, point.y).matrixTransform(transform)
    return { x: screen.x, y: screen.y }
  })
}
async function observe(value, offset, service = quotedService, signal = "historical", fields = true) {
  await tooltip().locator(`[data-metric-value=${JSON.stringify(String(value))}]`).waitFor()
  const timestamp = Date.parse(initialRange.to) - offset * 1000
  if (fields) {
    const observation = tooltip().locator("[data-observation-timestamp]")
    assert.equal(await observation.getAttribute("data-observation-value"), String(value))
    assert.equal(Number(await observation.getAttribute("data-observation-timestamp")), timestamp)
    assert.equal(await observation.getAttribute("data-observation-series"), observationSeries(service, signal))
  }
  await tooltip().locator(`time[datetime=${JSON.stringify(new Date(timestamp).toISOString())}]`).waitFor()
  const expected = expectedObservationQuery(value, offset, service, signal)
  await until(() => childQueries().at(-1)?.params.query === expected, `Provider did not receive exact observation query: ${expected}`)
  const expectedChildValue = service === "worker" ? "222" : "111"
  await tooltip().locator(`[data-tooltip-widget="stat"] [data-metric-value=${JSON.stringify(expectedChildValue)}]`).waitFor()
  await contained(tooltip())
  return expected
}
async function historicalHost(width) {
  const before = childQueries().length
  await openScenario({ type: "stat", source: observationSource() }, width, "timeseries")
  assert.equal(childQueries().length, before, "A closed historical-point tooltip must not issue a child query")
  const position = await firstPlottedPoint()
  if (width < 600) await page.touchscreen.tap(position.x, position.y)
  else await page.mouse.move(position.x, position.y)
  const first = await observe(-7.25, 120.25)
  await screenshot(`host-historical-pointer-${width}.png`)
  if (width < 600) { await page.touchscreen.tap(position.x, position.y); await tooltip().waitFor({ state: "hidden" }) }
  else { await page.mouse.click(position.x, position.y); await tooltip().getByText(/Pinned ·/).waitFor(); await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" }) }
  await page.getByRole("heading", { name: "Tooltip query integration", exact: true }).click()
  await hostChart().focus()
  await observe(-7.25, 120.25)
  await page.keyboard.press("ArrowRight"); await observe(41, 120, "worker", "worker")
  await page.keyboard.press("ArrowRight"); const zero = await observe(0, 60.5)
  await page.keyboard.press("Enter"); await tooltip().getByText(/Pinned ·/).waitFor()
  await page.keyboard.press("ArrowRight"); await observe(42, 60, "worker", "worker")
  await tooltip().getByText(/Pinned ·/).waitFor()
  await screenshot(`host-historical-keyboard-${width}.png`)
  await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
  await openScenario({ type: "stat", source: observationSource() }, width, "heatmap", "parent_observations")
  const beforeMissing = childQueries().length
  await showCell(1)
  await tooltip().locator('[data-tooltip-widget="stat"]').getByRole("alert").filter({ hasText: /no finite value/ }).waitFor()
  assert.equal(childQueries().length, beforeMissing, "Latest-null heatmap value must block numeric binding, not revive the previous42")
  await tooltip().getByText("No data", { exact: true }).waitFor()
  await screenshot(`host-null-binding-${width}.png`)
  return { pointerQuery: first, keyboardZeroQuery: zero, exactHistoricalValue: -7.25, fractionalSeconds: true, nullRequests: 0, touch: width < 600 }
}
async function historicalTraceHost(width) {
  const query = "{ resource.service.name = {{service}} && span.observed_value = {{observed}} && span.observed_at = {{at}} && span.signal = {{signal}} }"
  const source = { type: "query", providerId: "traces", query, bindings: observationBindings }
  await openScenario({ type: "traces", source }, width, "timeseries")
  const position = await firstPlottedPoint()
  if (width < 600) await page.touchscreen.tap(position.x, position.y); else await page.mouse.move(position.x, position.y)
  await tooltip().locator('[data-observation-value="-7.25"]').waitFor()
  const exactQuery = `{ resource.service.name = ${JSON.stringify(quotedService)} && span.observed_value = -7.25 && span.observed_at = ${Date.parse(initialRange.to) / 1000 - 120.25} && span.signal = ${JSON.stringify(observationSeries())} }`
  await until(() => childQueries().at(-1)?.params.q === exactQuery, "Tempo did not receive the historical point's exact typed context")
  const result = tooltip().locator('[data-tooltip-widget="traces"]')
  await result.getByText("GET /queried-tooltip", { exact: true }).waitFor()
  await result.getByText("72.25 ms", { exact: true }).waitFor()
  await result.getByText("GET /queried-tooltip", { exact: true }).scrollIntoViewIfNeeded()
  await contained(tooltip()); await screenshot(`host-historical-traces-${width}.png`)
  return { provider: "tempo", historicalValue: -7.25, fractionalUnixSeconds: true, exactProviderQuery: exactQuery, traceOperation: "GET /queried-tooltip" }
}

async function parentContextBeforeChild(expectedTimestamp) {
  const order = await tooltip().evaluate((element, timestamp) => {
    const child = element.querySelector("[data-tooltip-widget]")
    const parent = selector => [...element.querySelectorAll(selector)].find(node => !node.closest("[data-tooltip-widget]"))
    const labels = parent("dl"), time = parent("time[datetime]"), value = parent("[data-metric-value]")
    const before = node => !!node && !!child && !node.contains(child) && !!(node.compareDocumentPosition(child) & Node.DOCUMENT_POSITION_FOLLOWING)
    return { labelsBeforeChild: before(labels), timestampBeforeChild: before(time), valueBeforeChild: before(value), timestamp: time?.getAttribute("datetime"), expectedTimestamp: new Date(timestamp).toISOString() }
  }, expectedTimestamp)
  assert.equal(order.labelsBeforeChild, true, "Parent series labels must precede the embedded widget so their ownership is clear")
  assert.equal(order.timestampBeforeChild, true, "Parent observation time must precede the embedded widget")
  assert.equal(order.valueBeforeChild, true, "Parent observation value must precede the embedded widget")
  assert.equal(order.timestamp, order.expectedTimestamp, "Parent context must retain its exact observation time")
  return order
}
async function latestValidHost(host, width) {
  await openScenario({ type: "stat", source: observationSource() }, width, host)
  if (host === "bar") {
    await tile().scrollIntoViewIfNeeded(); await hostChart().focus(); await observe(32, 0)
    await page.keyboard.press("ArrowRight")
  } else {
    const row = tile().getByRole("button", { name: /^Inspect series / }).nth(1)
    await row.scrollIntoViewIfNeeded()
    if (width < 600) await row.tap(); else await row.focus()
  }
  const query = await observe(42, 60, "worker", "worker", host === "bar")
  const hierarchy = await parentContextBeforeChild(Date.parse(initialRange.to) - 60_000)
  assert.ok(!query.endsWith(" > 41"), "Tooltip must use the row's latest-valid displayed value")
  await screenshot(`host-${host}-selected-${width}.png`)
  await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
  return { host, latestValidValue: 42, ignoredNullTail: true, parentFirstHierarchy: hierarchy, exactProviderQuery: query, keyboard: host === "bar" || width >= 600, touch: host === "table" && width < 600 }
}

function toOpenUI(document) {
  const names = { timeseries: "TimeSeries", bar: "BarChart", stat: "Stat", table: "MetricsTable", traces: "Traces", heatmap: "Heatmap" }
  const args = values => values.map(value => JSON.stringify(value ?? null)).join(", ")
  return `root = Dashboard(${args([document.id, document.title, document.timeRange, document.refreshInterval])}, [${document.widgets.map((_, index) => `widget${index}`).join(", ")}], ${args([document.description, document.folder, document.customTimeRange, document.variables])})\n` + document.widgets.map((item, index) => `widget${index} = ${names[item.type]}(${args([item.id, item.title, item.providerId, item.query, item.unit, item.layout, item.description, item.color, item.options])})`).join("\n")
}
async function saveCurrent() {
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).waitFor()
}
async function typedAuthoring(width) {
  await openScenario(undefined, width)
  await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
  await page.getByRole("button", { name: "Add widget", exact: true }).click()
  await page.getByRole("region", { name: "Widget library", exact: true }).getByRole("button", { name: /^Status heatmap/ }).click()
  await panel().getByLabel("Title", { exact: true }).fill("Discoverable tooltip host")
  await panel().getByRole("textbox", { name: /^PromQL query/ }).fill("parent_health")
  await panel().getByRole("tab", { name: "Style", exact: true }).click()
  await panel().getByRole("button", { name: "Configure tooltips", exact: true }).click()
  assert.equal(await panel().getByRole("tab", { name: "Tooltips", exact: true }).getAttribute("aria-selected"), "true")
  const tabs = await panel().getByRole("tab").evaluateAll(elements => elements.map(element => { const box = element.getBoundingClientRect(); return { label: element.textContent, x: box.x, width: box.width, height: box.height } }))
  assert.ok(["Query", "Style", "Tooltips", "Layout", "Links", "Source"].every(label => tabs.some(tab => tab.label.trim() === label)), "Tooltip settings and source inspection must remain discoverable peers of the other editor tabs")
  if (width < 600) assert.ok(tabs.every(tab => tab.height >= 44), "Editor tabs must retain phone-sized targets")
  const add = panel().getByRole("button", { name: "Add tooltip widget", exact: true })
  await add.scrollIntoViewIfNeeded(); await contained(add)
  await screenshot(`host-add-tooltip-${width}.png`)
  await add.click()
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip visualization", exact: true }), "Single value")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip data source", exact: true }), "Provider query")
  await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip provider", exact: true }), "Query metrics")
  await panel().getByLabel("Tooltip PromQL query", { exact: true }).fill(observationSource().query)
  for (const [index, binding] of observationBindings.entries()) {
    await panel().getByRole("button", { name: "Add query mapping", exact: true }).click()
    await panel().getByLabel(`Tooltip mapping ${index + 1} variable`, { exact: true }).fill(binding.variable)
    const choice = "label" in binding ? "Label" : binding.field[0].toUpperCase() + binding.field.slice(1)
    await selectGammaOption(page, panel().getByRole("combobox", { name: `Tooltip mapping ${index + 1} source`, exact: true }), choice)
    if ("label" in binding) await panel().getByLabel(`Tooltip mapping ${index + 1} hovered label`, { exact: true }).fill(binding.label)
  }
  const lastSource = panel().getByRole("combobox", { name: "Tooltip mapping 4 source", exact: true })
  await lastSource.scrollIntoViewIfNeeded(); await contained(lastSource)
  if (width < 600) assert.ok((await lastSource.boundingBox()).height >= 44, "Typed mapping source must retain a phone-sized target")
  await screenshot(`host-typed-mappings-${width}.png`)
  await lastSource.click(); await contained(page.getByRole("listbox")); await screenshot(`host-source-menu-${width}.png`); await page.keyboard.press("Escape")
  const numericHelp = panel().getByText(/exact numeric value\. Missing values do not run the query\./)
  await numericHelp.scrollIntoViewIfNeeded(); await contained(numericHelp); await screenshot(`host-numeric-help-${width}.png`)
  await applySave()
  let document = await saved()
  const fresh = document.widgets.find(widget => widget.title === "Discoverable tooltip host")
  assert.ok(fresh, "Adding a heatmap must lead to a persistable tooltip editor")
  assert.deepEqual(fresh.options.tooltipView.source, observationSource())
  const sourcePanel = () => page.getByRole("region", { name: "Dashboard source editor", exact: true })
  await page.getByRole("button", { name: "Code", exact: true }).click()
  await sourcePanel().getByRole("button", { name: "JSON", exact: true }).click()
  const json = JSON.parse(await sourcePanel().getByRole("textbox", { name: "Dashboard source", exact: true }).inputValue())
  json.widgets = [{ ...fresh, type: "timeseries", layout: { x: 0, y: 0, w: 12, h: 6 } }]
  await sourcePanel().getByRole("textbox", { name: "Dashboard source", exact: true }).fill(JSON.stringify(json))
  await sourcePanel().getByRole("button", { name: "Apply to canvas", exact: true }).click()
  await sourcePanel().waitFor({ state: "hidden" }); await saveCurrent()
  document = await saved()
  assert.equal(document.widgets[0].type, "timeseries"); assert.deepEqual(document.widgets[0].options.tooltipView.source, observationSource())
  await page.getByRole("button", { name: "Code", exact: true }).click()
  await sourcePanel().getByRole("button", { name: "YAML", exact: true }).click()
  const yamlField = sourcePanel().getByRole("textbox", { name: "Dashboard source", exact: true }), yaml = await yamlField.inputValue()
  assert.match(yaml, /field: timestamp/)
  await yamlField.fill(yaml.replace("type: timeseries", "type: bar"))
  await sourcePanel().getByRole("button", { name: "Apply to canvas", exact: true }).click()
  await sourcePanel().waitFor({ state: "hidden" }); await saveCurrent()
  document = await saved()
  assert.equal(document.widgets[0].type, "bar"); assert.deepEqual(document.widgets[0].options.tooltipView.source, observationSource())
  document.widgets[0].type = "table"
  await page.getByRole("button", { name: "Build with AI", exact: true }).click()
  const ai = page.getByRole("region", { name: "Build with AI", exact: true })
  await ai.getByRole("textbox", { name: "AI-generated definition", exact: true }).fill(toOpenUI(document))
  await ai.getByRole("button", { name: "Review definition", exact: true }).click()
  await ai.getByRole("button", { name: "Apply to canvas", exact: true }).click()
  if (await ai.isVisible()) await ai.getByRole("button", { name: "Close AI builder", exact: true }).click()
  await saveCurrent(); await page.reload({ waitUntil: "networkidle" })
  document = await saved()
  assert.equal(document.widgets[0].type, "table"); assert.deepEqual(document.widgets[0].options.tooltipView.source, observationSource())
  const row = page.locator(`[data-widget-id=${JSON.stringify(fresh.id)}]`).getByRole("button", { name: /^Inspect series / }).first()
  await row.scrollIntoViewIfNeeded()
  if (width < 600) await row.tap(); else await row.focus()
  await tooltip().locator('[data-tooltip-widget="stat"] [data-metric-value="111"]').waitFor()
  const query = childQueries().at(-1).params.query
  assert.ok(query.endsWith(` @ ${Date.parse(initialRange.to) / 1000} > 32`), "Imported table must bind its displayed numeric observation and timestamp")
  assert.ok(query.includes(`service=${JSON.stringify(quotedService)}`), "Typed bindings must preserve legacy quoted labels")
  await contained(tooltip()); await screenshot(`host-formats-result-${width}.png`)
  return { createdFromLibrary: true, visibleTooltipsTab: true, tabGeometry: tabs, formats: ["visual", "JSON", "YAML", "OpenUI"], hosts: ["heatmap", "timeseries", "bar", "table"], mixedBindings: observationBindings, exactProviderQuery: query }
}

try {
  await mkdir(output, { recursive: true })
  const upstreamPort = await listen(upstream), reservation = createServer()
  const servicePort = await listen(reservation); await new Promise(resolve => reservation.close(resolve))
  serviceURL = `http://127.0.0.1:${servicePort}`
  await writeFile(join(temporary, "providers.json"), JSON.stringify({ providers: [
    { id: "metrics", name: "Query metrics", type: "prometheus", url: `http://127.0.0.1:${upstreamPort}/prometheus` },
    { id: "traces", name: "Query traces", type: "tempo", url: `http://127.0.0.1:${upstreamPort}/tempo` },
  ] }))
  await run("rtk", ["proxy", "go", "build", "-o", binary, "./cmd/paprika-insights"])
  service = spawn(binary, ["--dev", `--listen=127.0.0.1:${servicePort}`, `--data-dir=${join(temporary, "data")}`, `--providers=${join(temporary, "providers.json")}`], { cwd: repository, env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "" }, stdio: ["ignore", "pipe", "pipe"] })
  service.stdout.on("data", data => { serviceOutput += data }); service.stderr.on("data", data => { serviceOutput += data })
  await until(async () => { try { return (await fetch(`${serviceURL}/readyz`)).ok } catch { return false } }, `Insights service did not start: ${serviceOutput}`)
  gatewayURL = `http://127.0.0.1:${await listen(gateway)}`
  browser = await chromium.launch({ headless: true })

  for (const width of [1512, 390]) {
    await check(`query tooltips are lazy and preserve quoted hovered labels at ${width}px`, async () => {
      const before = childQueries().length
      await openScenario({ type: "timeseries", title: "Queried history", height: 200, source: source() }, width)
      assert.equal(childQueries().length, before, "Closed tooltip must not issue its query")
      await showCell()
      const history = tooltip().locator('[data-tooltip-widget="timeseries"]')
      await history.waitFor()
      await until(() => childQueries().length === before + 1, "Tooltip query did not reach real provider")
      await history.getByRole("img").waitFor()
      await until(async () => (await history.getAttribute("aria-busy")) === "false", "Queried chart stayed loading")
      await renderedVisualization("timeseries", history)
      const query = childQueries().at(-1)
      assert.equal(query.params.query, `child_requests{service=${JSON.stringify(quotedService)}}`)
      assert.equal(Number(query.params.start), Date.parse(initialRange.from) / 1000)
      assert.equal(Number(query.params.end), Date.parse(initialRange.to) / 1000)
      await contained(tooltip())
      await screenshot(`history-${width}.png`)
      await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
      return { query: query.params.query, realProvider: true, lazy: true, viewport: width }
    })

    await check(`Gamma tooltip authoring persists every visualization and query mapping at ${width}px`, async () => {
      await openScenario(undefined, width)
      const choices = [["timeseries", "Time series"], ["bar", "Bar chart"], ["stat", "Single value"], ["table", "Metrics table"], ["heatmap", "Status heatmap"], ["plugin", "Threshold gauge"], ["traces", "Trace explorer"]]
      let controls
      for (const [type, label] of choices) {
        const queryCount = childQueries().length
        await editTooltip()
        const viewControl = panel().getByRole("button", { name: "Remove tooltip widget", exact: true })
        if (!(await panel().getByRole("combobox", { name: "Tooltip visualization", exact: true }).count())) await panel().getByRole("button", { name: "Add tooltip widget", exact: true }).click()
        await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip visualization", exact: true }), label)
        await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip data source", exact: true }), "Provider query")
        const isTrace = type === "traces"
        if (isTrace) {
          const provider = panel().getByRole("combobox", { name: "Tooltip provider", exact: true })
          await provider.click()
          assert.equal(await page.getByRole("option", { name: "Query metrics", exact: true }).count(), 0, "Trace tooltip provider picker must exclude metrics providers")
          await page.keyboard.press("Escape")
        }
        await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip provider", exact: true }), isTrace ? "Query traces" : "Query metrics")
        const queryField = panel().getByLabel(isTrace ? "Tooltip TraceQL query" : "Tooltip PromQL query", { exact: true })
        await queryField.fill(isTrace ? "{ resource.service.name = {{service}} }" : "child_requests{service={{service}}}")
        assert.ok((await queryEditorGeometry(queryField)).height >= 100, "Tooltip query should retain a multiline editing area")
        if (!(await panel().getByLabel("Tooltip mapping 1 variable", { exact: true }).count())) await panel().getByRole("button", { name: "Add query mapping", exact: true }).click()
        await panel().getByLabel("Tooltip mapping 1 variable", { exact: true }).fill("service")
        await panel().getByLabel("Tooltip mapping 1 hovered label", { exact: true }).fill("service")
        await panel().getByLabel("Tooltip title", { exact: true }).fill(`${label} details`)
        await selectGammaOption(page, panel().getByRole("combobox", { name: "Tooltip chart height", exact: true }), "Tall")
        if (type === "plugin") await panel().getByLabel("Tooltip plugin configuration", { exact: true }).fill('{"label":"Tooltip gauge"}')
        if (type === "timeseries") {
          await viewControl.scrollIntoViewIfNeeded(); await screenshot(`editor-top-${width}.png`)
          const visualizationControl = panel().getByRole("combobox", { name: "Tooltip visualization", exact: true })
          await visualizationControl.click(); await screenshot(`editor-visualization-open-${width}.png`); await page.keyboard.press("Escape")
          const providerControl = panel().getByRole("combobox", { name: "Tooltip provider", exact: true })
          await providerControl.click(); await screenshot(`editor-provider-open-${width}.png`); await page.keyboard.press("Escape")
          const queryCrop = join(output, `editor-query-${width}.png`)
          await queryField.screenshot({ path: queryCrop }); screenshots.push(queryCrop)
        }
        await panel().getByLabel("Tooltip mapping 1 hovered label", { exact: true }).scrollIntoViewIfNeeded()
        await contained(panel().getByLabel("Tooltip mapping 1 hovered label", { exact: true }))
        if (type === "traces") {
          controls = await editorGeometry()
          assert.ok(controls.query.height >= 100 && Number.parseFloat(controls.query.fontSize) >= 12)
          assert.equal(controls.query.resize, "none")
          assert.ok(controls.label.y >= controls.variable.y + controls.variable.height, "Mapping fields must stack without overlap")
          if (width < 600) assert.ok(controls.provider.height >= 44 && controls.remove.height >= 44 && controls.remove.width >= 44)
          await screenshot(`editor-${width}.png`)
        }
        assert.equal(childQueries().length, queryCount, "Editing tooltip fields must not run a provider query")
        await applySave()
        const document = await saved(), view = document.widgets[0].options.tooltipView
        assert.equal(view.type, type); assert.equal(view.height, 320); assert.equal(view.title, `${label} details`)
        assert.deepEqual(view.source.bindings, [{ variable: "service", label: "service" }])
        assert.equal(view.source.providerId, isTrace ? "traces" : "metrics")
        if (type === "plugin") { assert.equal(view.pluginId, "threshold-gauge"); assert.deepEqual(view.config, { label: "Tooltip gauge" }) }
        await page.reload({ waitUntil: "networkidle" }); await cells().first().waitFor()
        await showCell()
        const visualization = tooltip().locator(`[data-tooltip-widget="${type}"]`)
        await visualization.waitFor(); await contained(tooltip())
        await renderedVisualization(type, visualization)
        await parentContextBeforeChild(Date.parse(initialRange.to))
        if (isTrace) assert.equal(childQueries().at(-1).params.q, `{ resource.service.name = ${JSON.stringify(quotedService)} }`)
        await screenshot(`${type}-${width}.png`)
        await cells().first().focus()
        await page.keyboard.press("PageDown")
        const scroll = await tooltip().evaluate(element => ({ top: element.scrollTop, maximum: element.scrollHeight - element.clientHeight }))
        if (scroll.maximum > 1) assert.ok(scroll.top > 0, "Tooltip content must be reachable without pointer hover")
        const visibleData = type === "stat" ? visualization.locator('[data-metric-value="111"]')
          : type === "table" ? visualization.locator("tbody").getByText(/111/).first()
            : type === "traces" ? visualization.getByText("GET /queried-tooltip", { exact: true })
              : type === "plugin" ? visualization.getByText("Tooltip gauge", { exact: true })
                : visualization.getByRole("img").first()
        await visibleData.scrollIntoViewIfNeeded()
        await contained(visibleData)
        await screenshot(`${type}-scrolled-${width}.png`)
        await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
      }
      return { visualizations: choices.map(([type]) => type), durableGoSave: true, viewport: width, controls }
    })

    await check(`missing labels and incompatible providers block tooltip queries at ${width}px`, async () => {
      await openScenario({ type: "stat", source: source() }, width)
      let before = childQueries().length
      await showCell(2)
      await tooltip().getByText(/has no label.*service/).waitFor()
      assert.equal(childQueries().length, before)
      await contained(tooltip())
      await openScenario({ type: "traces", source: source("{}", "metrics") }, width)
      before = childQueries().length
      await showCell(0)
      await tooltip().getByText(/does not support traces/).waitFor()
      assert.equal(childQueries().length, before)
      await contained(tooltip())
      return { missingLabelRequests: 0, capabilityMismatchRequests: 0 }
    })
  }

  for (const width of [1512, 390]) {
    await check(`historical points retain exact pointer, keyboard and touch context at ${width}px`, () => historicalHost(width))
    for (const host of ["bar", "table"]) await check(`${host} tooltips query their displayed latest-valid observation at ${width}px`, () => latestValidHost(host, width))
    await check(`historical points send typed context to Tempo at ${width}px`, () => historicalTraceHost(width))
  }

  for (const width of [1512, 390, 320]) await check(`typed tooltip mappings are discoverable and survive all authoring formats at ${width}px`, () => typedAuthoring(width))

  await check("switching historical points cancels pending provider work and preserves the new observation", async () => {
    const selectedSource = { ...observationSource(), query: observationSource().query.replace("point_context", "slow_observation") }
    await openScenario({ type: "stat", source: selectedSource }, 1512, "timeseries")
    const firstPoint = await firstPlottedPoint()
    await page.mouse.move(firstPoint.x, firstPoint.y)
    await until(() => pending.some(item => !item.entry.aborted), "Delayed historical query did not start")
    const previous = pending.at(-1)
    assert.equal(previous.entry.params.query, expectedObservationQuery(-7.25, 120.25, quotedService, "historical", "slow_observation"))
    const nextPoint = await firstPlottedPoint(1)
    await page.mouse.move(nextPoint.x, nextPoint.y)
    await tooltip().locator('[data-observation-value="41"]').waitFor()
    await tooltip().locator('[data-tooltip-widget="stat"] [data-metric-value="222"]').waitFor()
    await until(() => previous.entry.aborted, "Switching historical points did not cancel at the actual upstream")
    previous.response.end(JSON.stringify(metricResult(previous.end, 999)))
    assert.equal(await tooltip().locator('[data-metric-value="999"]').count(), 0)
    await screenshot("host-historical-cancellation.png")
    return { cancelledAtProvider: true, selectedHistoricalValue: 41, staleResultHidden: true }
  })

  await check("switching hovered signals cancels the real upstream query and cannot show stale data", async () => {
    await openScenario({ type: "stat", source: source("slow_child{service={{service}}}") })
    await showCell(0)
    await until(() => pending.some(item => !item.entry.aborted), "First delayed query did not start")
    const previous = pending.at(-1)
    await cells().nth(1).hover()
    await tooltip().locator('[data-tooltip-widget="stat"]').getByText("222", { exact: false }).waitFor()
    await until(() => previous.entry.aborted, "Superseded query did not cancel at the real provider")
    previous.response.end(JSON.stringify(metricResult(previous.end, 999)))
    assert.ok(!(await tooltip().innerText()).includes("999"), "Old result must not replace the selected signal")
    await screenshot("stale-switch.png")
    return { cancelledAtProvider: true, currentValue: 222 }
  })

  await check("closing a touch tooltip cancels work through the gateway and Go adapter", async () => {
    await openScenario({ type: "stat", source: source("slow_child{service={{service}}}") }, 390)
    await showCell(0)
    await until(() => pending.some(item => !item.entry.aborted), "Delayed touch query did not start")
    const active = pending.at(-1)
    await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
    await until(() => active.entry.aborted, "Closed tooltip did not cancel the real provider request")
    return { cancelledAtProvider: true }
  })

  await check("tooltip queries use the changed dashboard range and refresh generation", async () => {
    await openScenario({ type: "stat", source: source() })
    await selectGammaOption(page, page.getByRole("combobox", { name: "Time range", exact: true }), "Last 6 hours")
    await showCell(1)
    await tooltip().locator('[data-tooltip-widget="stat"]').getByText("222", { exact: false }).waitFor()
    const first = childQueries().at(-1)
    assert.equal(Number(first.params.end) - Number(first.params.start), 6 * 3600)
    await page.keyboard.press("Escape"); await tooltip().waitFor({ state: "hidden" })
    const count = childQueries().length
    await page.getByRole("button", { name: "Refresh data", exact: true }).click()
    await cells().nth(1).waitFor(); await showCell(1)
    await until(() => childQueries().length > count, "Refresh did not invalidate tooltip query results")
    const latest = childQueries().at(-1)
    assert.equal(Number(latest.params.end) - Number(latest.params.start), 6 * 3600)
    assert.ok(Number(latest.params.end) >= Number(first.params.end))
    return { rangeSeconds: 6 * 3600, refreshQueriedProvider: true }
  })

  await check("query errors and empty results stay honest without replacing exact parent details", async () => {
    for (const [query, pattern] of [["error_child", /could not|failed|unavailable/i], ["empty_child", /no data|no observations|no series/i]]) {
      await openScenario({ type: "stat", source: source(`${query}{service={{service}}}`) }, 390)
      await showCell()
      await tooltip().locator('[data-tooltip-widget="stat"]').getByText(pattern).waitFor()
      assert.equal(await tooltip().locator('[data-metric-value="32"]').count(), 1)
      assert.ok(!(await tooltip().innerText()).includes("private-upstream-diagnostic"))
      await screenshot(`${query}.png`)
      if (query === "error_child") {
        const before = childQueries().length
        failChild = false
        await tooltip().getByRole("button", { name: "Retry tooltip query", exact: true }).click()
        await tooltip().locator('[data-tooltip-widget="stat"] [data-metric-value="111"]').waitFor()
        assert.equal(childQueries().length, before + 1, "Retry must reach the real provider again")
      }
    }
    return { privateErrorsHidden: true, parentExactValueRetained: 32 }
  })

  await check("query authoring and an expanded tooltip remain usable at 320px", async () => {
    await openScenario({ type: "table", height: 320, source: source() }, 320)
    await page.setViewportSize({ width: 320, height: 600 })
    await editTooltip()
    const provider = panel().getByRole("combobox", { name: "Tooltip provider", exact: true })
    await provider.scrollIntoViewIfNeeded(); await provider.click()
    const list = page.locator(`[id=${JSON.stringify(await provider.getAttribute("aria-controls"))}]`)
    await contained(list); await screenshot("editor-provider-open-320.png")
    await page.keyboard.press("Escape")
    const field = panel().getByLabel("Tooltip mapping 1 hovered label", { exact: true })
    await field.scrollIntoViewIfNeeded(); await contained(field)
    const controls = await editorGeometry()
    assert.ok(controls.query.height >= 100 && controls.provider.height >= 44 && controls.remove.height >= 44)
    assert.ok(controls.label.y >= controls.variable.y + controls.variable.height)
    await screenshot("editor-320.png")
    await applySave(); await showCell()
    await renderedVisualization("table", tooltip().locator('[data-tooltip-widget="table"]'))
    await contained(tooltip()); await screenshot("table-320.png")
    await page.keyboard.press("End")
    const scrolled = await tooltip().evaluate(element => ({ top: element.scrollTop, maximum: element.scrollHeight - element.clientHeight }))
    if (scrolled.maximum > 0) assert.ok(scrolled.top > 0, "Expanded tooltip content must remain keyboard reachable")
    await screenshot("table-footer-320.png")
    const visibleValue = tooltip().locator('[data-tooltip-widget="table"] tbody').getByText(/111/).first()
    await visibleValue.scrollIntoViewIfNeeded(); await contained(visibleValue)
    await screenshot("table-scrolled-320.png")
    return { controls, scrolled, viewport: { width: 320, height: 600 } }
  })

  await check("library export and import include nested query providers and preserve capability-aware remapping", async () => {
    await openScenario({ type: "traces", source: source("{ resource.service.name = {{service}} }", "traces") })
    await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
    const manager = page.getByRole("region", { name: "Manage dashboards", exact: true })
    const downloaded = page.waitForEvent("download")
    await manager.getByRole("button", { name: "JSON", exact: true }).click()
    const exported = JSON.parse(await readFile(await (await downloaded).path(), "utf8"))
    assert.equal(exported.kind, "PaprikaDashboardLibrary")
    const original = exported.dashboards.find(document => document.id === "tooltip-query")
    assert.equal(original.widgets[0].options.tooltipView.source.providerId, "traces", "Export must retain the nested trace reference even though the parent is metrics")
    const imported = structuredClone(original)
    imported.title = "Imported tooltip trace"
    imported.widgets[0].options.tooltipView.source.providerId = "portable-traces"
    await selectGammaOption(page, manager.getByRole("combobox", { name: "Library import format", exact: true }), "JSON")
    await manager.getByRole("textbox", { name: "Library import source", exact: true }).fill(JSON.stringify(imported))
    await manager.getByRole("button", { name: "Review import", exact: true }).click()
    assert.equal(await manager.getByRole("button", { name: "Import 1 as new", exact: true }).isDisabled(), true)
    const connection = manager.getByRole("combobox", { name: "Connect portable-traces", exact: true })
    await connection.click()
    assert.equal(await page.getByRole("option", { name: "Query metrics", exact: true }).count(), 0)
    await page.keyboard.press("Escape")
    await selectGammaOption(page, connection, "Query traces")
    await manager.getByRole("button", { name: "Import 1 as new", exact: true }).click()
    await manager.getByText(/^1 dashboard decisions? completed\./).waitFor()
    await page.getByRole("navigation", { name: "Dashboard library", exact: true }).getByRole("button", { name: "Imported tooltip trace", exact: true }).click()
    await page.getByRole("heading", { name: "Imported tooltip trace", exact: true }).waitFor()
    const id = new URL(page.url()).searchParams.get("dashboard")
    const response = await fetch(`${serviceURL}/api/dashboards/${id}`), document = await response.json()
    assert.notEqual(id, "tooltip-query")
    assert.equal(document.widgets[0].providerId, "metrics")
    assert.equal(document.widgets[0].options.tooltipView.source.providerId, "traces")
    await showCell()
    await tooltip().getByText("GET /queried-tooltip", { exact: true }).waitFor()
    return { nestedProviderExported: true, nestedProviderRemapped: true, currentQueryReachedTempo: true }
  })
} finally {
  await context?.close().catch(() => {}); await browser?.close().catch(() => {})
  for (const item of pending) item.response.destroy()
  gateway.closeAllConnections(); upstream.closeAllConnections()
  await Promise.all([new Promise(resolve => gateway.close(resolve)), new Promise(resolve => upstream.close(resolve))])
  if (service && service.exitCode === null && service.signalCode === null) {
    const exited = once(service, "exit"); service.kill("SIGTERM")
    const force = setTimeout(() => service.kill("SIGKILL"), 5000)
    await exited; clearTimeout(force)
  }
  await writeFile(join(output, authoringOnly ? "authoring-report.json" : "report.json"), JSON.stringify({ baseURL, reports, pageErrors, providerRequests, screenshots, placementSettlements, harness: "Actual Go service and HTTP adapters through a test-only same-origin abort-propagating gateway." }, null, 2))
  await rm(temporary, { recursive: true, force: true })
}
assert.deepEqual(pageErrors, [])
assert.equal(reports.filter(report => !report.passed).length, 0)
console.log(`${reports.length} real-service tooltip query checks passed.`)
