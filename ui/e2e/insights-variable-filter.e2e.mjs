// Real Go storage and Prometheus adapter, with an isolated deterministic provider.
// Does not touch the user's browser-local example workspace or app theme preference.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption, toggleGammaOptions } from "./gamma-controls.mjs"
import { proxyWebSocketUpgrades } from "./gateway-websocket.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = join(repository, "artifacts/insights/variable-filter")
const temporary = await mkdtemp(join(tmpdir(), "paprika-variable-filter-"))
const binary = join(temporary, "insights")
const reports = [], requests = [], pending = [], pageErrors = [], queryResponses = [], browserFailures = []
const services = ["api-gateway", "release-controller", "repo-server", "worker-east", "worker-west", "auth-service", 'quoted"service\\west{{service}}', "slow-service"]
const readings = [101.2345, 202.3456, 303.4567, 404.5678, 0, 606.789, 707.8912, 999.1234]
const fixedRange = { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }
const queryTemplate = "sum(rate(http_requests_total{service={{service}}}[5m]))"
const savedQuery = { schemaVersion: 1, id: "service-rate", name: "Service request rate", providerId: "metrics", kind: "metrics", query: queryTemplate, parameters: [{ name: "service", type: "string" }] }
const dashboard = {
  schemaVersion: 1, id: "service-filter", title: "Service filter integration", timeRange: "1h", customTimeRange: fixedRange, refreshInterval: 0,
  variables: [{ name: "service", label: "Service", defaultValue: services[0], options: services }],
  widgets: [{ id: "selected-service", title: "Selected service request rate", type: "stat", providerId: "metrics", query: "dormant_query_must_not_run", queryRef: { id: savedQuery.id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, unit: "req/s", options: { decimals: 2, showSparkline: true }, layout: { x: 0, y: 0, w: 6, h: 3 } }],
}
const elsewhere = { ...dashboard, id: "another-board", title: "Another dashboard", widgets: [], variables: [] }
// Several values and All: a raw widget query and a saved query with a parameter of several values read one variable.
// "eu.central-3" checks that each value is regex-escaped before it is joined.
const clusters = ["omega-east-1", "delta-west-2", "eu.central-3"]
const clusterTemplate = "sum(rate(http_requests_total{cluster=~{{cluster}}}[5m]))"
const zoneTemplate = "sum by (cluster) (rate(http_requests_total{cluster=~{{zones}}}[5m]))"
const zoneQuery = { schemaVersion: 1, id: "zone-rate", name: "Zone request rate", providerId: "metrics", kind: "metrics", query: zoneTemplate, parameters: [{ name: "zones", type: "string", multi: true }] }
const clusterBoard = {
  schemaVersion: 1, id: "cluster-filter", title: "Cluster filter integration", timeRange: "1h", customTimeRange: fixedRange, refreshInterval: 0,
  variables: [{ name: "cluster", label: "Cluster", multi: true, allowAll: true, defaultValue: [clusters[0]], options: clusters }],
  widgets: [
    { id: "cluster-rate", title: "Cluster request rate", type: "stat", providerId: "metrics", query: clusterTemplate, unit: "req/s", options: { decimals: 2 }, layout: { x: 0, y: 0, w: 6, h: 3 } },
    { id: "zone-rate", title: "Zone request rate", type: "stat", providerId: "metrics", query: "dormant_query_must_not_run", queryRef: { id: zoneQuery.id, bindings: [{ parameter: "zones", source: "variable", variable: "cluster" }] }, unit: "req/s", options: { decimals: 2 }, layout: { x: 6, y: 0, w: 6, h: 3 } },
  ],
}
// The provider answers by the regex it received, so each choice shows its own reading.
const clusterReadings = { [clusters[0]]: 11.5, [`${clusters[0]}|${clusters[1]}`]: 22.75, ".+": 33.25, [`${clusters[0]}|${clusters[1]}|eu\\.central-3`]: 44.5, [`${clusters[1]}|${clusters[0]}`]: 55.25, [clusters[2].replace(".", "\\.")]: 66.5 }
const regexFor = (picked) => picked.length === 0 ? ".+" : picked.map(item => item.replace(/[\\.+*?()|[\]{}^$]/g, "\\$&")).join("|")
const clusterQueries = (picked) => [clusterTemplate.replace("{{cluster}}", JSON.stringify(regexFor(picked))), zoneTemplate.replace("{{zones}}", JSON.stringify(regexFor(picked)))]
let browser, context, page, service, serviceURL, gatewayURL, failure, serviceOutput = ""
function json(response, status, body) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)) }
function exactQuery(value) { return queryTemplate.replace("{{service}}", JSON.stringify(value)) }
function history(value) {
  const index = services.indexOf(value), last = index < 0 ? 88.4455 : readings[index]
  return index % 2 === 0 ? [last + 8.5, last - 4.25, last + 1.75, last] : [last - 9.25, last + 12.5, last - 3.75, last]
}
function result(value, end) {
  return { status: "success", data: { resultType: "matrix", result: [{ metric: { service: value }, values: history(value).map((reading, index) => [end - (3 - index) * 60, String(reading)]) }] } }
}
const upstream = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost")
  const entry = { path: url.pathname, query: url.searchParams.get("query"), aborted: false, completed: false }
  requests.push(entry)
  response.on("close", () => { entry.completed = response.writableEnded; entry.aborted = !response.writableEnded })
  if (url.pathname !== "/api/v1/query_range") return json(response, 404, { error: "Unexpected fixture endpoint" })
  // A several-value variable arrives as one regex matcher: an escaped alternation, or .+ for All.
  const matcher = entry.query?.match(/cluster=~("(?:\\.|[^"\\])*")/)
  if (matcher) {
    const pattern = JSON.parse(matcher[1]), reading = clusterReadings[pattern], end = Number(url.searchParams.get("end"))
    if (reading === undefined) return json(response, 400, { error: `Unexpected cluster regex ${pattern}` })
    const values = [reading + 1, reading - 1, reading + 0.5, reading]
    return json(response, 200, { status: "success", data: { resultType: "matrix", result: [{ metric: { cluster: pattern }, values: values.map((value, index) => [end - (3 - index) * 60, String(value)]) }] } })
  }
  const literal = entry.query?.match(/service=("(?:\\.|[^"\\])*")/)
  if (!literal) return json(response, 400, { error: "Expected an exact service matcher" })
  const value = JSON.parse(literal[1]), end = Number(url.searchParams.get("end"))
  if (value === "slow-service") pending.push({ response, entry, value, end })
  else json(response, 200, result(value, end))
})
const gateway = createServer((request, response) => {
  const incoming = new URL(request.url, "http://localhost"), api = incoming.pathname.startsWith("/api/insights/")
  // The loopback --dev service is anonymous; the static/dev asset server has no
  // console auth routes, so this test host owns its session-discovery contract.
  if (incoming.pathname === "/auth/config") {
    response.setHeader("Cache-Control", "no-store")
    json(response, 200, { oidc: { enabled: false, provider: "oidc", label: "Single sign-on" }, basic: { enabled: false }, session: { refreshEnabled: false } })
    return
  }
  const target = new URL(api ? `${incoming.pathname.replace(/^\/api\/insights/, "/api")}${incoming.search}` : request.url, api ? serviceURL : baseURL)
  const forward = httpRequest(target, { method: request.method, headers: { ...request.headers, host: target.host } }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response) })
  forward.on("error", () => { if (!response.destroyed && !response.headersSent) json(response, 502, { error: "Fixture upstream unavailable" }); else response.destroy() })
  request.once("aborted", () => forward.destroy())
  response.once("close", () => { if (!response.writableEnded) forward.destroy() })
  request.pipe(forward)
})
// Next's development debug channel uses WebSockets to complete hydration.
proxyWebSocketUpgrades(gateway, baseURL)
async function listen(server) { server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port }
async function until(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  throw new Error(message)
}
async function api(path, method = "GET", document) {
  const response = await fetch(`${serviceURL}/api/${path}`, { method, headers: { "content-type": "application/json" }, ...(document === undefined ? {} : { body: JSON.stringify(document) }) })
  const body = await response.text(); assert.ok(response.ok, `${method} ${path}: ${body}`)
  return { document: body ? JSON.parse(body) : undefined, etag: response.headers.get("etag") }
}
async function stopService() {
  if (!service || service.exitCode !== null || service.signalCode !== null) return
  const ended = once(service, "exit"); service.kill("SIGTERM")
  const timer = setTimeout(() => service.kill("SIGKILL"), 5000)
  await ended; clearTimeout(timer)
}
async function check(name, run) {
  try { const evidence = await run(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) {
    reports.push({ name, passed: false, error: error.message, widget: await tile().boundingBox().catch(() => null), visible: await tile().innerText().catch(() => "") })
    await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {}); throw error
  }
}
// On phones the variables live in a native-dialog sheet opened from the "Dashboard variables" chip; the sheet is modal, so the rest of the page is inert while it is open.
const phone = () => (page.viewportSize()?.width ?? 1512) < 600
const variableBar = () => phone() ? page.locator("dialog form") : page.getByRole("form", { name: "Dashboard variables", exact: true })
const serviceSelect = () => variableBar().getByRole("combobox", { name: "Service", exact: true })
async function openVariables() {
  if (!phone() || await page.locator("dialog[open]").count()) return
  await page.getByRole("button", { name: /^Dashboard variables:/ }).click()
  await page.locator("dialog[open]").waitFor()
}
async function closeVariables() {
  if (!phone() || await page.locator("dialog[open]").count() === 0) return
  await page.locator("dialog[open]").getByRole("button", { name: "Done", exact: true }).click()
  await page.waitForSelector("dialog[open]", { state: "detached" })
}
const chooseService = async (option) => { await openVariables(); await selectGammaOption(page, serviceSelect(), option) }
const chooseTheme = async (theme) => { await closeVariables(); await selectGammaOption(page, appearance(), theme) }
const appearance = () => page.getByRole("combobox", { name: "Dashboard appearance", exact: true })
const tile = () => page.locator('[data-widget-id="selected-service"]')
const displayed = () => tile().locator("[data-metric-value]")
async function expectService(value) {
  const expected = history(value).at(-1)
  await until(async () => await displayed().getAttribute("data-metric-value").catch(() => null) === String(expected), `Selected service ${value} never rendered ${expected}`)
  assert.equal((await displayed().innerText()).replace(/\s+/g, ""), `${expected.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}req/s`)
  const plot = tile().locator("[data-stat-sparkline]")
  assert.equal(await plot.count(), 1)
  assert.equal(await plot.getAttribute("data-sample-count"), "4")
  assert.equal(Number(await plot.getAttribute("data-history-min")), Math.min(...history(value)))
  assert.equal(Number(await plot.getAttribute("data-history-max")), Math.max(...history(value)))
  assert.ok(requests.some(entry => entry.query === exactQuery(value)), `Provider did not receive ${exactQuery(value)}`)
  return { value: expected, displayed: await displayed().innerText(), history: await plot.locator("[data-stat-trend]").getAttribute("d") }
}
async function contrast(locator) {
  return locator.evaluate(element => {
    const rgb = value => { const match = value.match(/^rgba?\(([^)]+)\)$/); if (!match) throw new Error(`Unsupported computed color ${value}`); return match[1].split(/[,\s/]+/).filter(Boolean).map(Number) }
    const fg = rgb(getComputedStyle(element).color)
    let bg = [255, 255, 255], current = element, backgroundFound = false
    const transitions = []
    while (current) {
      const color = rgb(getComputedStyle(current).backgroundColor)
      if (!backgroundFound && (color.length === 3 || color[3] === 1)) { bg = color; backgroundFound = true }
      for (const animation of current.getAnimations()) {
        if (animation instanceof CSSTransition && (animation.pending || animation.playState === "running") && /color|background/.test(animation.transitionProperty)) {
          transitions.push({ element: current.tagName, property: animation.transitionProperty, state: animation.playState, pending: animation.pending })
        }
      }
      current = current.parentElement
    }
    const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0)
    const colors = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
    return { ratio: (colors[0] + .05) / (colors[1] + .05), foreground: fg, background: bg, theme: element.closest("[data-insights-theme]")?.getAttribute("data-insights-theme"), reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, transitions }
  })
}
// Capture native viewports: full-page capture can resize the browser's scroll
// surface and leave visibility-driven query deferral in a non-user state.
async function screenshot(name) { await page.screenshot({ path: join(output, name), fullPage: false }) }
async function expectNoOverflow() { assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "Dashboard must not horizontally overflow") }
async function open(width) {
  await fresh(width)
  await page.goto(`${gatewayURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor()
  await expectService(services[0])
}
const clusterSelect = () => variableBar().getByRole("combobox", { name: "Cluster", exact: true })
const clusterValue = (id) => page.locator(`[data-widget-id="${id}"] [data-metric-value]`)
// The query texts the console posted to /api/insights/query. The server's shared result cache may answer a repeat
// without a provider request, so the console's own requests are the evidence of what a choice sent.
const browserQueries = []
function postedQueries(body) {
  const found = []
  const walk = value => {
    if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { if (key === "query" && typeof item === "string") found.push(item); else walk(item) }
  }
  try { walk(JSON.parse(body)) } catch { /* not JSON */ }
  return found
}
// Both widgets show the reading for the regex the provider answered, and the console sent both exact query texts.
async function expectClusters(picked) {
  const reading = clusterReadings[regexFor(picked)]
  for (const id of ["cluster-rate", "zone-rate"])
    await until(async () => await clusterValue(id).getAttribute("data-metric-value").catch(() => null) === String(reading), `${id} never rendered ${reading} for ${JSON.stringify(picked)}`)
  for (const query of clusterQueries(picked))
    assert.ok(browserQueries.includes(query) || requests.some(entry => entry.query === query), `Neither the console nor the provider saw ${query}`)
  return { picked, reading, queries: clusterQueries(picked) }
}
const clusterVars = () => JSON.parse(new URL(page.url()).searchParams.get("vars") ?? "{}")
async function openClusters(width) {
  await fresh(width)
  await page.goto(`${gatewayURL}/dashboard/insights/?dashboard=${clusterBoard.id}`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: clusterBoard.title, exact: true }).waitFor()
  await expectClusters([clusters[0]])
}
// The trigger, its field and the page stay inside their boxes: a summary never clips or widens the bar or the sheet.
async function clusterGeometry() {
  return clusterSelect().evaluate(trigger => {
    const label = trigger.querySelector("[title]") ?? trigger.querySelector("span span span")
    const box = trigger.getBoundingClientRect(), field = trigger.closest("label, div")?.getBoundingClientRect(), form = trigger.closest("form").getBoundingClientRect()
    return {
      text: trigger.innerText.trim(), title: label?.getAttribute("title") ?? null,
      labelFits: label ? label.scrollWidth <= label.clientWidth + 1 : true,
      insideForm: box.left >= form.left - 1 && box.right <= form.right + 1,
      insideField: !field || (box.left >= field.left - 1 && box.right <= field.right + 1),
      insideViewport: box.left >= 0 && box.right <= innerWidth + 1,
      pageFits: document.documentElement.scrollWidth <= innerWidth,
      height: box.height,
    }
  })
}
async function fresh(width) {
  await context?.close()
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1000 }, reducedMotion: "reduce", colorScheme: "light", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  page = await context.newPage(); page.setDefaultTimeout(12000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("requestfailed", request => browserFailures.push({ url: request.url(), error: request.failure()?.errorText }))
  page.on("response", response => { if (response.status() >= 400) browserFailures.push({ url: response.url(), status: response.status() }) })
  page.on("response", response => { if (/\/api\/insights\/query(?:\?|$)/.test(response.url())) void response.text().then(body => queryResponses.push({ status: response.status(), request: response.request().postData(), body })).catch(() => {}) })
  page.on("dialog", dialog => { pageErrors.push(`Unexpected native dialog: ${dialog.message()}`); void dialog.dismiss() })
  page.on("request", request => { if (/\/api\/insights\/query(?:\?|$)/.test(request.url())) browserQueries.push(...postedQueries(request.postData() ?? "")) })
}

try {
  await mkdir(output, { recursive: true })
  const providerPort = await listen(upstream), reservation = createServer(), servicePort = await listen(reservation)
  await new Promise(resolve => reservation.close(resolve)); serviceURL = `http://127.0.0.1:${servicePort}`
  const build = spawn("go", ["build", "-o", binary, "./cmd/paprika-insights"], { cwd: repository, stdio: "inherit" })
  assert.equal((await once(build, "exit"))[0], 0)
  await writeFile(join(temporary, "providers.json"), JSON.stringify({ providers: [{ id: "metrics", name: "Prometheus fixture", type: "prometheus", url: `http://127.0.0.1:${providerPort}` }] }))
  service = spawn(binary, ["--dev", `--listen=127.0.0.1:${servicePort}`, `--data-dir=${join(temporary, "data")}`, `--providers=${join(temporary, "providers.json")}`], { cwd: repository, env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "" }, stdio: ["ignore", "pipe", "pipe"] })
  service.stdout.on("data", data => { serviceOutput += data }); service.stderr.on("data", data => { serviceOutput += data })
  await until(async () => { try { return (await fetch(`${serviceURL}/readyz`)).ok } catch { return false } }, `Service startup failed: ${serviceOutput}`)
  await api(`saved-queries/${savedQuery.id}`, "PUT", savedQuery)
  await api(`saved-queries/${zoneQuery.id}`, "PUT", zoneQuery)
  for (const document of [dashboard, elsewhere, clusterBoard]) await api(`dashboards/${document.id}`, "PUT", document)
  assert.deepEqual((await api(`dashboards/${clusterBoard.id}`)).document.variables, clusterBoard.variables, "A list default is stored as a list")
  const persisted = await api(`dashboards/${dashboard.id}`)
  assert.deepEqual(persisted.document.variables, dashboard.variables)
  gatewayURL = `http://127.0.0.1:${await listen(gateway)}`
  browser = await chromium.launch({ headless: true })
  for (const width of [1512, 390]) {
    await open(width)
    for (const theme of ["Light", "Dark"]) {
      await check(`${theme} service dropdown immediately updates saved-query value and history at ${width}px`, async () => {
        await chooseTheme(theme)
        await until(async () => await page.locator(`[data-insights-theme="${theme.toLowerCase()}"]`).count() > 0, "Theme did not resolve")
        await chooseService(services[0])
        const before = await expectService(services[0])
        await chooseService(services[1])
        const after = await expectService(services[1])
        assert.notEqual(after.history, before.history, "Changing services must update the sparkline history as well as the number")
        assert.deepEqual(JSON.parse(new URL(page.url()).searchParams.get("vars")), { service: services[1] })
        assert.equal(await page.getByRole("button", { name: "Save dashboard", exact: true }).count(), 0)
        const current = await api(`dashboards/${dashboard.id}`)
        assert.equal(current.etag, persisted.etag, "Viewing a filter must not persist a different dashboard default")
        assert.deepEqual(current.document.variables, dashboard.variables)
        const valueContrast = await contrast(displayed()), fieldContrast = await contrast(serviceSelect())
        assert.ok(valueContrast.ratio >= 4.5, `Value contrast ${valueContrast.ratio} in ${theme}`)
        assert.ok(fieldContrast.ratio >= 4.5, `Filter contrast ${fieldContrast.ratio} in ${theme}`)
        await expectNoOverflow()
        const filterBounds = await serviceSelect().boundingBox(), timeBounds = await page.getByRole("combobox", { name: "Time range", exact: true }).boundingBox(), cardBounds = await tile().boundingBox()
        if (width >= 1000) {
          // The attention strip is the first dashboard reading below the toolbar; the canvas follows it directly.
          const stripBounds = await page.locator("[data-attention-strip]").boundingBox()
          assert.ok(stripBounds, `The attention strip must render at ${width}px before the canvas`)
          assert.ok(stripBounds.y <= 230, `Header budget: the attention strip top must be within 230px, got ${stripBounds.y}: ${JSON.stringify({ stripBounds, cardBounds })}`)
          assert.ok(stripBounds.height <= 40, `Attention strip must be one line at ${width}px, got height ${stripBounds.height}: ${JSON.stringify(stripBounds)}`)
          assert.ok(cardBounds.y <= stripBounds.y + stripBounds.height + 16, `Canvas must follow the attention strip within 16px, card top ${cardBounds.y} vs strip bottom ${stripBounds.y + stripBounds.height}`)
          assert.ok(filterBounds.y < timeBounds.y + timeBounds.height && timeBounds.y < filterBounds.y + filterBounds.height, "Service and time controls must share the compact toolbar")
        }
        await screenshot(`filter-${theme.toLowerCase()}-${width}.png`)
        await openVariables()
        await serviceSelect().click()
        const options = page.getByRole("listbox", { name: "Service options", exact: true })
        await options.waitFor()
        const portal = page.locator('[data-gamma-portal="select"]')
        const bounds = await portal.boundingBox(), viewport = page.viewportSize()
        assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1)
        const optionContrast = await contrast(options.getByRole("option", { name: services[1], exact: true }))
        assert.ok(optionContrast.ratio >= 4.5, `Selected option contrast ${optionContrast.ratio} in ${theme}`)
        await screenshot(`filter-options-${theme.toLowerCase()}-${width}.png`)
        await page.keyboard.press("Escape")
        assert.equal(await serviceSelect().evaluate(element => element === document.activeElement), true)
        return { before, after, exactProviderQuery: exactQuery(services[1]), valueContrast, fieldContrast, optionContrast, viewport: bounds, compactGeometry: { filter: filterBounds, time: timeBounds, card: cardBounds }, persistedDefaultUnchanged: true }
      })
    }
    await check(`Back steps to the previous filter value at ${width}px`, async () => {
      // Each dropdown change is a history step: Back from B returns to A, not to the previous page.
      await chooseService(services[2]); await expectService(services[2])
      await chooseService(services[3]); await expectService(services[3])
      await page.goBack({ waitUntil: "networkidle" })
      await expectService(services[2])
      assert.deepEqual(JSON.parse(new URL(page.url()).searchParams.get("vars")), { service: services[2] })
      return { backTo: services[2] }
    })
    await check(`Filter values, precision and theme survive reload and navigation at ${width}px`, async () => {
      await chooseService(services[4]); await expectService(services[4])
      await page.reload({ waitUntil: "networkidle" }); await expectService(services[4])
      await openVariables(); assert.match(await serviceSelect().innerText(), /worker-west/)
      assert.equal(await page.locator('[data-insights-theme="dark"]').count() > 0, true)
      await page.goto(`${gatewayURL}/dashboard/insights/?dashboard=${elsewhere.id}`, { waitUntil: "networkidle" })
      await page.getByRole("heading", { name: elsewhere.title, exact: true }).waitFor()
      await page.goBack({ waitUntil: "networkidle" }); await expectService(services[4])
      assert.equal((await api(`dashboards/${dashboard.id}`)).etag, persisted.etag)
      return { zeroDisplayed: await displayed().innerText(), currentService: services[4], defaultService: persisted.document.variables[0].defaultValue }
    })
    await check(`Escaped service choices and link overrides remain exact at ${width}px`, async () => {
      await chooseService(services[6]); await expectService(services[6])
      const target = new URL(`${gatewayURL}/dashboard/insights/`)
      target.searchParams.set("dashboard", dashboard.id); target.searchParams.set("vars", JSON.stringify({ service: "from-link" }))
      await page.goto(target.href, { waitUntil: "networkidle" }); await expectService("from-link")
      await openVariables(); assert.match(await serviceSelect().innerText(), /from-link/)
      assert.deepEqual((await api(`dashboards/${dashboard.id}`)).document.variables[0].options, services)
      return { quotedProviderQuery: exactQuery(services[6]), linkedValueVisible: true, authoredOptionsUnchanged: true }
    })
    await check(`A delayed old service cannot replace the latest dropdown selection at ${width}px`, async () => {
      const start = requests.length
      await chooseService("slow-service")
      await until(() => requests.slice(start).some(entry => entry.query === exactQuery("slow-service")), "Slow service request was not issued")
      assert.equal(await displayed().count(), 0, "Old service value must clear while a new service loads")
      await chooseService(services[5]); const current = await expectService(services[5])
      for (const item of pending.splice(0)) if (!item.response.destroyed) json(item.response, 200, result(item.value, item.end))
      await page.waitForTimeout(150)
      assert.equal(await displayed().getAttribute("data-metric-value"), String(readings[5]))
      assert.equal((await api(`dashboards/${dashboard.id}`)).etag, persisted.etag)
      return { current, oldValueNeverRendered: true, obsoleteRequestAborted: requests.slice(start).some(entry => entry.query === exactQuery("slow-service") && entry.aborted) }
    })
    await check(`System appearance responds to color scheme changes at ${width}px`, async () => {
      await chooseTheme("System")
      const appearances = []
      for (const colorScheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme })
        await until(async () => await page.locator(`[data-insights-theme="${colorScheme}"]`).count() > 0, `System appearance did not follow ${colorScheme}`)
        const samples = []
        await until(async () => {
          const sample = await contrast(displayed()); samples.push(sample)
          if (samples.length > 8) samples.shift()
          return sample.theme === colorScheme && sample.transitions.length === 0 && sample.ratio >= 4.5
        }, `System ${colorScheme} appearance did not settle at readable contrast`).catch(error => {
          throw new Error(`${error.message}; recent computed colors: ${JSON.stringify(samples)}`, { cause: error })
        })
        const settled = samples.at(-1)
        assert.equal(settled.theme, colorScheme)
        assert.ok(settled.ratio >= 4.5, `Value contrast ${settled.ratio} in system ${colorScheme}: ${JSON.stringify(samples)}`)
        appearances.push({ colorScheme, samples })
      }
      return { followsSystem: true, appearances }
    })
  }
  await check("query_dashboard sends a list as an escaped alternation and All as .+", async () => {
    const start = requests.length
    const picked = await api("query-dashboard", "POST", { id: clusterBoard.id, variables: { cluster: [clusters[0], clusters[1]] } })
    assert.deepEqual(picked.document.variables, { cluster: [clusters[0], clusters[1]] })
    for (const query of clusterQueries([clusters[0], clusters[1]])) assert.ok(requests.slice(start).some(entry => entry.query === query), `query_dashboard did not send ${query}`)
    const all = await api("query-dashboard", "POST", { id: clusterBoard.id, variables: { cluster: [] } })
    assert.deepEqual(all.document.variables, { cluster: [] })
    for (const query of clusterQueries([])) assert.ok(requests.slice(start).some(entry => entry.query === query), `query_dashboard did not send ${query}`)
    // A string for a multi variable is one value; a list for a single variable is refused.
    const one = await api("query-dashboard", "POST", { id: clusterBoard.id, variables: { cluster: clusters[2] } })
    assert.deepEqual(one.document.variables, { cluster: [clusters[2]] })
    const refused = await fetch(`${serviceURL}/api/query-dashboard`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: dashboard.id, variables: { service: ["a"] } }) })
    assert.equal(refused.status, 400)
    return { variables: picked.document.variables, all: all.document.variables }
  })
  // The several-value picker is checked at every supported width: the toolbar at 1512, 1024 and 768, the sheet at 390.
  for (const width of [1512, 1024, 768, 390]) {
    await openClusters(width)
    for (const theme of ["Light", "Dark"]) {
      await check(`Several clusters commit once, as one escaped alternation, in ${theme} at ${width}px`, async () => {
        // Each theme starts from the saved default, one cluster.
        await page.goto(`${gatewayURL}/dashboard/insights/?dashboard=${clusterBoard.id}`, { waitUntil: "networkidle" })
        await page.getByRole("heading", { name: clusterBoard.title, exact: true }).waitFor()
        await chooseTheme(theme)
        await until(async () => await page.locator(`[data-insights-theme="${theme.toLowerCase()}"]`).count() > 0, "Theme did not resolve")
        await openVariables()
        assert.equal((await clusterGeometry()).text, clusters[0])
        const trigger = clusterSelect()
        await trigger.click()
        const list = page.locator(`[id=${JSON.stringify(await trigger.getAttribute("aria-controls"))}]`)
        assert.equal(await list.getAttribute("aria-multiselectable"), "true")
        assert.equal(await list.getByRole("option", { name: "All", exact: true }).getAttribute("aria-selected"), "false")
        const before = browserQueries.length, providerBefore = requests.length, url = page.url()
        // Toggle delta on, eu on, then eu off: only the final pick may be queried.
        await list.getByRole("option", { name: clusters[1], exact: true }).click()
        await list.getByRole("option", { name: clusters[2], exact: true }).click()
        await list.getByRole("option", { name: clusters[2], exact: true }).click()
        // The panel stays open and nothing is queried until it closes.
        await page.waitForTimeout(400)
        assert.equal(await list.isVisible(), true, "The panel stays open after a toggle")
        assert.equal(browserQueries.length, before, "A toggle inside the open panel must not query")
        assert.equal(requests.length, providerBefore, "A toggle inside the open panel must not reach the provider")
        assert.equal(page.url(), url, "A toggle inside the open panel must not change the URL")
        assert.equal(await list.getByRole("option", { name: clusters[1], exact: true }).getAttribute("aria-selected"), "true")
        assert.equal(await list.getByRole("option", { name: clusters[2], exact: true }).getAttribute("aria-selected"), "false")
        await screenshot(`cluster-options-${theme.toLowerCase()}-${width}.png`)
        await trigger.press("Escape")
        await list.waitFor({ state: "hidden" })
        if (phone()) assert.equal(await page.locator("dialog[open]").count(), 1, "Escape closes the panel, not the variables sheet")
        const two = await expectClusters([clusters[0], clusters[1]])
        assert.deepEqual(clusterVars(), { cluster: [clusters[0], clusters[1]] })
        const issued = browserQueries.slice(before).filter(query => /cluster=~/.test(query))
        assert.deepEqual([...new Set(issued)].sort(), clusterQueries([clusters[0], clusters[1]]).sort(), `One commit queries only the final pick: ${JSON.stringify(issued)}`)
        const geometry = await clusterGeometry()
        assert.equal(geometry.text, `${clusters[0]}, ${clusters[1]}`.length <= 24 ? `${clusters[0]}, ${clusters[1]}` : "2 selected")
        assert.ok(geometry.labelFits && geometry.insideForm && geometry.insideField && geometry.insideViewport && geometry.pageFits, `Two clusters must fit: ${JSON.stringify(geometry)}`)
        assert.equal((await api(`dashboards/${clusterBoard.id}`)).document.variables[0].defaultValue.length, 1, "Viewing a filter must not persist a different default")
        await screenshot(`cluster-two-${theme.toLowerCase()}-${width}.png`)
        return { two, geometry }
      })
    }
    await check(`Three clusters read as a count that never overflows at ${width}px`, async () => {
      await openVariables()
      await toggleGammaOptions(page, clusterSelect(), [clusters[2]])
      const three = await expectClusters(clusters)
      assert.deepEqual(clusterVars(), { cluster: clusters })
      const geometry = await clusterGeometry()
      assert.equal(geometry.text, "3 selected")
      assert.equal(geometry.title, clusters.join(", "), "The full list stays available as a title")
      assert.ok(geometry.labelFits && geometry.insideForm && geometry.insideField && geometry.insideViewport && geometry.pageFits, `The count must fit: ${JSON.stringify(geometry)}`)
      await screenshot(`cluster-three-${width}.png`)
      await closeVariables()
      if (phone()) {
        const chip = page.getByRole("button", { name: /^Dashboard variables:/ })
        assert.match(await chip.innerText(), /3 selected/)
        const chipFits = await chip.evaluate(element => element.getBoundingClientRect().right <= innerWidth + 1 && document.documentElement.scrollWidth <= innerWidth)
        assert.ok(chipFits, "The phone chip summary must fit the viewport")
        await screenshot(`cluster-three-chip-${width}.png`)
      }
      await expectNoOverflow()
      return { three, geometry }
    })
    await check(`All sends .+, survives reload, and Back returns to the previous list at ${width}px`, async () => {
      await openVariables()
      await toggleGammaOptions(page, clusterSelect(), ["All"])
      const all = await expectClusters([])
      assert.deepEqual(clusterVars(), { cluster: [] })
      assert.equal((await clusterGeometry()).text, "All")
      await page.reload({ waitUntil: "networkidle" })
      await expectClusters([])
      await openVariables()
      assert.equal((await clusterGeometry()).text, "All", "All persists across a reload")
      await closeVariables()
      await page.goBack({ waitUntil: "networkidle" })
      await expectClusters(clusters)
      assert.deepEqual(clusterVars(), { cluster: clusters })
      await page.goForward({ waitUntil: "networkidle" })
      await expectClusters([])
      assert.deepEqual(clusterVars(), { cluster: [] })
      await screenshot(`cluster-all-${width}.png`)
      return { all }
    })
    await check(`A link with a list opens on that list, and a string is one value at ${width}px`, async () => {
      const target = new URL(`${gatewayURL}/dashboard/insights/`)
      target.searchParams.set("dashboard", clusterBoard.id); target.searchParams.set("vars", JSON.stringify({ cluster: [clusters[1], clusters[0]] }))
      await page.goto(target.href, { waitUntil: "networkidle" })
      // A linked list keeps its own order, so its query text is the link's.
      const linked = await expectClusters([clusters[1], clusters[0]])
      target.searchParams.set("vars", JSON.stringify({ cluster: clusters[0] }))
      await page.goto(target.href, { waitUntil: "networkidle" })
      await expectClusters([clusters[0]])
      await openVariables()
      assert.equal((await clusterGeometry()).text, clusters[0])
      await closeVariables()
      return { linked }
    })
  }
  assert.equal(requests.some(entry => entry.query?.includes("dormant_query_must_not_run")), false)
  assert.deepEqual(pageErrors, [])
  console.log(`${reports.length} real-service variable filter scenarios passed.`)
} catch (error) {
  failure = { error: error.stack ?? error.message, url: page?.url(), visible: (await page?.locator("body").innerText().catch(() => ""))?.slice(0, 2000) }
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {})
  console.error(error, failure.visible?.slice(0, 2000), browserFailures); process.exitCode = 1
}
finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ baseURL, reports, pageErrors, requests, queryResponses, browserFailures, failure }, null, 2))
  await browser?.close()
  for (const item of pending) item.response.destroy()
  await stopService()
  await Promise.all([gateway, upstream].map(server => new Promise(resolve => server.close(resolve))))
  await rm(temporary, { recursive: true, force: true })
}
