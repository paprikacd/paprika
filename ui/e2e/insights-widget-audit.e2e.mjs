// Renderer/editor audit using deterministic normalized API responses. Real Go
// adapters and durable persistence are exercised by the separate live suites.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption, respondToGammaConfirmation } from "./gamma-controls.mjs"

const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/widget-audit")
const inspectOnly = process.argv.includes("--inspect")
const detailsOnly = process.argv.includes("--details")
const reports = [], pageErrors = [], requests = [], screenshots = []
const kinds = ["timeseries", "bar", "stat", "table", "traces", "heatmap", "gauge"]
const titles = { timeseries: "Audit time series", bar: "Audit categories", stat: "Audit latest value", table: "Audit metrics table", traces: "Audit traces", heatmap: "Audit service health", gauge: "Audit threshold gauge" }
const providers = [
  { id: "audit-metrics", name: "Private metrics connection", type: "prometheus", capabilities: ["metrics"] },
  { id: "audit-traces", name: "Private trace connection", type: "tempo", capabilities: ["traces"] },
]
const stamp = Date.parse("2026-10-20T12:30:00.000Z")
const range = { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }
const longName = "production-eu-central-1-critical-payments-service-with-a-long-human-readable-observation-name"
const layouts = {
  stat: { x: 0, y: 0, w: 4, h: 3 }, gauge: { x: 4, y: 0, w: 4, h: 3 }, heatmap: { x: 8, y: 0, w: 4, h: 5 },
  timeseries: { x: 0, y: 5, w: 6, h: 5 }, bar: { x: 6, y: 5, w: 6, h: 5 },
  table: { x: 0, y: 10, w: 6, h: 5 }, traces: { x: 6, y: 10, w: 6, h: 5 },
}
const thresholds = [
  { value: -100, color: "#bd5745", label: "Below target" },
  { value: 0, color: "#b28d39", label: "At zero" },
  { value: 1, color: "#4c8466", label: "Healthy" },
]
function colorContrast(foreground, background) {
  const luminance = value => (value.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
  const a = luminance(foreground), b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}
async function axisContrast(tile) {
  const samples = await tile.locator('svg[role="img"] text').evaluateAll(elements => elements.filter(element => element.textContent.trim()).map(element => {
    const channels = color => (color.match(/[\d.]+/g) ?? []).map(Number)
    const chain = []
    for (let parent = element; parent; parent = parent.parentElement) chain.push(getComputedStyle(parent))
    // Composite transparent CSS ancestors over the browser's white canvas, then
    // include SVG fill-opacity and ancestor opacity in the rendered foreground.
    let background = [255, 255, 255]
    for (const style of [...chain].reverse()) {
      const color = channels(style.backgroundColor), alpha = color[3] ?? 1
      if (color.length >= 3) background = background.map((value, index) => color[index] * alpha + value * (1 - alpha))
    }
    const style = chain[0], fill = channels(style.fill)
    const opacity = Number(style.fillOpacity) * (fill[3] ?? 1) * chain.reduce((value, style) => value * Number(style.opacity), 1)
    const foreground = background.map((value, index) => fill[index] * opacity + value * (1 - opacity))
    return { text: element.textContent, fill: style.fill, fillOpacity: style.fillOpacity, opacity, foreground: `rgb(${foreground.join(",")})`, background: `rgb(${background.join(",")})` }
  }))
  assert.ok(samples.length > 0, "Charts must display readable axis ticks")
  for (const sample of samples) {
    sample.ratio = colorContrast(sample.foreground, sample.background)
    assert.ok(sample.opacity >= 0.99, `Axis text must preserve its configured contrast: ${JSON.stringify(sample)}`)
    assert.ok(sample.ratio >= 4.5, `Axis text must meet 4.5:1 effective contrast: ${JSON.stringify(sample)}`)
  }
  return { minimumContrast: Math.min(...samples.map(sample => sample.ratio)), samples }
}
function fixture(state = "normal", links = false) {
  return {
    schemaVersion: 1, id: "audit", title: "Every widget audit", timeRange: "1h", refreshInterval: 0, customTimeRange: range,
    widgets: kinds.map(kind => ({
      id: kind, title: titles[kind], type: kind === "gauge" ? "plugin" : kind,
      providerId: kind === "traces" ? "audit-traces" : "audit-metrics",
      query: kind === "traces" ? `{ name = "audit_${kind}_${state}" }` : `audit_${kind}_${state}`,
      unit: kind === "traces" ? "" : "req/s", layout: layouts[kind],
      options: { decimals: 2, ...(kind === "heatmap" || kind === "gauge" ? { thresholds } : {}), ...(kind === "gauge" ? { min: -100, max: 100 } : {}) },
      ...(kind === "gauge" ? { pluginId: "threshold-gauge", dataKind: "metrics", config: { label: "Worker capacity" } } : {}),
      ...(links ? { drilldowns: [{ id: `inspect-${kind}`, title: "Inspect selected signal", dashboardId: "audit-target", carryTimeRange: true,
        bindings: [{ variable: "service", source: "label", value: "service" }, { variable: "value", source: "value" }] }] } : {}),
    })),
  }
}
function metricData(state) {
  if (state === "empty") return { series: [] }
  const count = state === "bounded" ? 120 : 3
  return { ...(state === "bounded" ? { truncated: true } : {}), series: Array.from({ length: count }, (_, index) => {
    const name = state === "long" ? `${longName}-${index + 1}` : ["api-east", "worker-west", "queue-zero"][index] ?? `service-${index}`
    const value = state === "zero" ? 0 : state === "negative" ? -12.5 - index : state === "null" ? null : [42.56789, -12.5, 0][index % 3]
    return { name, labels: { service: name, instance: `pod-${index}`, region: "eu-central-1", ...(state === "long" ? { description: "A full label value that should stay inspectable without expanding the page or obscuring another control." } : {}) }, points: state === "history" ? Array.from({ length: 60 }, (_, point) => ({ timestamp: stamp - (59 - point) * 60000, value: point === 29 ? null : point + index + 0.123456789 })) : [
      { timestamp: stamp - 120000, value: state === "null" ? null : state === "zero" ? 0 : state === "negative" ? -20 : 20 + index },
      { timestamp: stamp - 60000, value: state === "normal" ? null : value },
      { timestamp: stamp, value: state === "tail-null" ? null : value },
    ] }
  }) }
}
function traceData(state) {
  if (["empty", "null"].includes(state)) return { traces: [] }
  return { ...(state === "bounded" ? { truncated: true } : {}), traces: Array.from({ length: state === "bounded" ? 120 : 3 }, (_, index) => ({
    traceId: `${index}`.padStart(32, "a"), service: state === "long" ? `${longName}-${index + 1}` : ["api-east", "worker-west", "queue-zero"][index] ?? `service-${index}`,
    operation: state === "long" ? "POST /api/payments/very-long-route/with-customer-context/and-observability-details" : ["GET /checkout", "POST /jobs", "GET /ready"][index % 3],
    durationMs: state === "zero" ? 0 : [72.25, 1200.1234, 0][index % 3], startTime: stamp - index * 1000, status: index % 3 === 1 ? "error" : "ok",
  })) }
}
async function check(name, run, metadata = {}) {
  const started = Date.now()
  try { const evidence = await run(); reports.push({ name, passed: true, ...metadata, milliseconds: Date.now() - started, evidence }); console.log(`PASS ${name}`); return true }
  catch (error) {
    const evidence = resolve(output, `failure-${reports.length + 1}.png`)
    const diagnostics = await active?.page.evaluate(() => ({
      viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY, documentWidth: document.documentElement.scrollWidth },
      tooltips: [...document.querySelectorAll('[role="tooltip"]')].map(element => ({
        textContent: element.textContent, innerText: element.innerText,
        bounds: element.getBoundingClientRect().toJSON(),
      })),
    })).catch(() => null)
    const viewportEvidence = resolve(output, `failure-${reports.length + 1}-viewport.png`)
    await active?.page.screenshot({ path: viewportEvidence }).catch(() => {})
    await active?.page.screenshot({ path: evidence, fullPage: true }).catch(() => {})
    reports.push({ name, passed: false, ...metadata, error: error.message, stack: error.stack, diagnostics, viewportScreenshot: viewportEvidence, screenshot: evidence })
    console.error(`FAIL ${name}: ${error.message}`); return false
  }
}
async function stable(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    let previous = "", unchanged = 0
    const deadline = performance.now() + 6000
    function frame() {
      const next = JSON.stringify([document.documentElement.scrollWidth, ...[...document.querySelectorAll('[data-widget-id], [data-widget-id] svg[role="img"]')].map(element => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })])
      unchanged = next === previous ? unchanged + 1 : 0; previous = next
      if (unchanged >= 4) resolve(null)
      else if (performance.now() > deadline) reject(new Error("Widget geometry did not settle"))
      else requestAnimationFrame(frame)
    }
    requestAnimationFrame(frame)
  }))
}
const browser = await chromium.launch({ headless: true })
let active
async function openFixture(state, width = 1512, links = false, extra = {}, transform = document => document) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1050 }, reducedMotion: "reduce", timezoneId: "UTC", ...extra })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  page.on("pageerror", error => pageErrors.push({ state, width, message: error.message }))
  page.on("dialog", dialog => { pageErrors.push({ state, width, message: `Unexpected native dialog: ${dialog.message()}` }); void dialog.dismiss() })
  const source = transform(fixture(state, links))
  const target = { ...source, id: "audit-target", title: "Audit destination", variables: [{ name: "service", defaultValue: "unset" }, { name: "value", defaultValue: "unset" }], widgets: [{ ...source.widgets[2], id: "target-stat", query: "audit_target{service={{service}},value={{value}}}", drilldowns: undefined }] }
  const documents = new Map([[source.id, source], [target.id, target]])
  let version = 1
  await page.route("**/api/insights/**", async route => {
    const request = route.request(), url = new URL(request.url())
    let body, status = 200
    if (url.pathname === "/api/insights/providers") body = { providers }
    else if (url.pathname === "/api/insights/dashboards") body = { dashboards: [...documents.values()] }
    else if (url.pathname === "/api/insights/saved-queries") body = { queries: [] }
    else if (url.pathname.startsWith("/api/insights/dashboards/")) {
      const id = url.pathname.split("/").at(-1)
      if (request.method() === "DELETE") { documents.delete(id); body = { deleted: true }; version++ }
      else if (request.method() === "PUT") { body = request.postDataJSON(); documents.set(id, body); version++ }
      else body = documents.get(id)
      if (!body) { status = 404; body = { error: "Dashboard unavailable" } }
    } else if (url.pathname.endsWith("/metadata")) body = { values: ["audit_requests", "service", "api-east", "worker-west"] }
    else if (url.pathname === "/api/insights/query") {
      const query = request.postDataJSON()
      requests.push({ state, width, ...query })
      if (state === "error" || query.query.includes("audit_failure")) { status = 502; body = { error: "Audit backend failed. Retry this query." } }
      else body = query.kind === "traces" ? traceData(state) : metricData(query.query.includes("edited") ? "negative" : state)
    } else { status = 404; body = { error: `Unexpected audit route: ${url.pathname}` } }
    await route.fulfill({ status, contentType: "application/json", headers: { ETag: `"audit-${version}"` }, body: JSON.stringify(body) })
  })
  await page.goto(`${baseURL}/dashboard/insights/?dashboard=audit`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: source.title, exact: true }).waitFor()
  for (const kind of kinds) {
    const tile = page.locator(`[data-widget-id="${kind}"]`)
    await tile.scrollIntoViewIfNeeded()
    await page.waitForFunction(id => {
      const tile = document.querySelector(`[data-widget-id="${id}"]`)
      return tile && !tile.querySelector('[aria-label="Loading widget"]')
    }, kind)
  }
  await page.evaluate(() => window.scrollTo(0, 0)); await stable(page)
  active = { page, context, documents, source, state, width }
  return active
}
async function screenshot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0)); await stable(page)
  const path = resolve(output, name)
  await page.screenshot({ path, fullPage: true }); screenshots.push(path)
}
async function geometry(page, width) {
  const result = await page.evaluate(() => {
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
    return { overflow: document.documentElement.scrollWidth - innerWidth, tiles: [...document.querySelectorAll("[data-widget-id]")].map(tile => ({
      id: tile.dataset.widgetId, ...rect(tile), overflow: tile.scrollWidth - tile.clientWidth,
      charts: [...tile.querySelectorAll('svg[role="img"]')].map(rect),
    })) }
  })
  assert.ok(result.overflow <= 1, `Page overflow ${result.overflow}px`)
  assert.equal(result.tiles.length, 7)
  for (const tile of result.tiles) {
    assert.ok(tile.width >= 240 && tile.height >= 120, `${tile.id} collapsed to ${tile.width}×${tile.height}`)
    assert.ok(tile.x >= -1 && tile.x + tile.width <= width + 1, `${tile.id} escapes viewport`)
    assert.ok(tile.overflow <= 1, `${tile.id} overflows its tile by ${tile.overflow}px`)
    for (const chart of tile.charts) assert.ok(chart.width > 50 && chart.height > 40, `${tile.id} plot collapsed`)
  }
  for (let i = 0; i < result.tiles.length; i++) for (let j = i + 1; j < result.tiles.length; j++) {
    const a = result.tiles[i], b = result.tiles[j]
    assert.ok(Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) <= 1 || Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) <= 1, `${a.id} overlaps ${b.id}`)
  }
  const canvas = await page.locator('[data-testid="dashboard-canvas"]').innerText()
  for (const provider of providers) assert.ok(!canvas.includes(provider.name) && !canvas.includes(provider.id), "Connection metadata leaked onto canvas")
  return result
}
async function stateAssertions(page, state) {
  for (const kind of kinds) {
    const tile = page.locator(`[data-widget-id="${kind}"]`)
    if (kind === "traces" && ["negative", "tail-null"].includes(state)) {
      reports.push({ name: `${state} ${page.viewportSize().width}px: traces`, status: "not-applicable", passed: true, widget: kind, state, viewport: page.viewportSize().width, reason: "Trace durations are nonnegative finite values; missing traces are covered by empty responses." })
      continue
    }
    await check(`${state} ${page.viewportSize().width}px: ${kind} renders honest data`, async () => {
      const text = await tile.innerText()
      let axes
      assert.doesNotMatch(text, /NaN|Infinity|Invalid Date/)
      if (state === "error") {
        assert.match(await tile.getByRole("alert").innerText(), /Query failed[\s\S]*Audit backend failed/)
        assert.equal(await tile.locator('svg[role="img"],table,[role="meter"]').count(), 0)
      } else if (state === "empty" || (state === "null" && !["heatmap", "gauge", "table"].includes(kind))) {
        assert.match(text, /No data in this time range/)
      } else if (kind === "timeseries" || kind === "bar") {
        assert.equal(await tile.locator('svg[role="img"]').count(), 1)
        assert.equal(await tile.locator('svg[role="img"]').getAttribute("aria-label"), titles[kind])
        if (state === "normal") axes = await axisContrast(tile)
        if (kind === "timeseries" && state === "normal") assert.ok(await tile.locator('[data-ts-key$=":dot"]').count() >= 6, "Isolated valid observations on either side of null gaps must remain visible")
        if (state === "negative") assert.match(text, /−|-/)
      } else if (kind === "stat") {
        assert.match(text, state === "zero" ? /0\.00/ : state === "negative" ? /-12\.50/ : /42\.57/)
        assert.match(text, /Latest valid sample/)
        const caption = await tile.getByText(/Latest valid sample/).boundingBox()
        assert.ok(caption && caption.height >= 12, "Latest valid sample caption must not collapse when inspection controls are present")
      } else if (kind === "gauge") {
        const meter = tile.getByRole("meter")
        if (["null", "tail-null"].includes(state)) {
          assert.match(text, /No data|Unknown/)
          assert.equal(await tile.locator('[role="meter"][aria-valuenow]').count(), 0, "A missing latest sample must not retain a healthy numeric meter")
        } else assert.equal(await meter.getAttribute("aria-valuenow"), String(state === "zero" ? 0 : state === "negative" ? -12.5 : 42.56789))
      } else if (kind === "table") {
        assert.equal(await tile.locator("tbody tr").count(), state === "bounded" ? 100 : 3)
        if (state === "null") {
          assert.equal(await tile.locator("tbody tr").first().locator("td").allTextContents().then(cells => cells.slice(1).every(value => value.trim() === "—")), true)
          assert.match(await tile.locator("tbody tr").first().innerText(), /api-east/)
        }
        if (state === "zero") assert.match(await tile.locator("tbody tr").first().innerText(), /0\.00 req\/s/)
        if (state === "negative") assert.match(await tile.locator("tbody tr").first().innerText(), /-12\.50 req\/s/)
      } else if (kind === "traces") {
        assert.equal(await tile.locator("tbody tr").count(), state === "bounded" ? 100 : 3)
        assert.match(text, state === "zero" ? /0\.00 ms/ : /72\.25 ms/)
        assert.match(text, /error/)
        const first = tile.locator("tbody tr").first()
        const service = await first.getByText(state === "long" ? `${longName}-1` : "api-east", { exact: true }).boundingBox()
        const operation = await first.getByText(state === "long" ? "POST /api/payments/very-long-route/with-customer-context/and-observability-details" : "GET /checkout", { exact: true }).boundingBox()
        assert.ok(operation && service && operation.y >= service.y + service.height - 1, "Trace service and operation must occupy distinct readable lines")
      } else if (kind === "heatmap") {
        const cells = tile.getByRole("group").getByRole("button")
        assert.equal(await cells.count(), state === "bounded" ? 100 : 3)
        if (["normal", "long", "zero", "negative"].includes(state)) {
          const colors = await cells.evaluateAll(elements => elements.map(element => ({ foreground: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor })))
          for (const colorset of colors) assert.ok(colorContrast(colorset.foreground, colorset.background) >= 4.5, `Automatic heatmap label color must meet 4.5:1 contrast: ${JSON.stringify(colorset)}`)
        }
        if (["null", "tail-null"].includes(state)) assert.match(await cells.first().getAttribute("aria-label"), /No data/)
        if (state === "zero") assert.match(await cells.first().getAttribute("aria-label"), /0\.00 req\/s.*At zero/)
        if (state === "negative") assert.match(await cells.first().getAttribute("aria-label"), /-12\.50 req\/s.*Below target/)
      }
      if (state === "bounded") assert.match(text, /limit|First 12|Showing 100/)
      return { state, widget: kind, ...(axes ? { axes } : {}) }
    }, { widget: kind, state, viewport: page.viewportSize().width })
  }
}

async function withinViewport(page, locator) {
  const bounds = await locator.boundingBox(), viewport = page.viewportSize()
  assert.ok(bounds && viewport, `Floating content has no measurable bounds or viewport: ${JSON.stringify({ bounds, viewport })}`)
  assert.ok(bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1,
    `Floating content outside ${viewport.width}×${viewport.height}: ${JSON.stringify(bounds)}`)
  const geometry = await page.evaluate(() => ({ documentWidth: document.documentElement.scrollWidth, viewportWidth: innerWidth, scrollX, visualViewport: visualViewport ? { width: visualViewport.width, offsetLeft: visualViewport.offsetLeft } : null }))
  assert.ok(geometry.documentWidth <= geometry.viewportWidth, `Floating details widened the page: ${JSON.stringify(geometry)}`)
  return bounds
}
const editor = page => page.getByRole("region", { name: "Widget editor", exact: true })
async function closeEditor(page) {
  await editor(page).getByRole("button", { name: "Close widget editor", exact: true }).click()
  await stable(page)
}
async function editWidget(page, kind) {
  const edit = page.getByRole("button", { name: "Edit dashboard", exact: true })
  if (await edit.isVisible()) await edit.click()
  await page.getByRole("button", { name: `Edit ${titles[kind]}`, exact: true }).click()
  await editor(page).waitFor()
  await stable(page)
}
async function editingAudit() {
  const { page, context, documents } = await openFixture("normal", 1512)
  for (const kind of kinds) await check(`${kind}: mobile query/style controls apply and persist without cosmetic refetch`, async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await editWidget(page, kind)
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert.equal(await page.locator("select").count(), 0)
    await editor(page).getByRole("tab", { name: "Style", exact: true }).click()
    await editor(page).getByLabel("Decimal places", { exact: true }).fill("3")
    await editor(page).getByLabel("Background", { exact: true }).fill("#eef3eb")
    await editor(page).getByLabel("Text color", { exact: true }).fill("#24392c")
    if (kind !== "traces") await editor(page).getByLabel("Unit", { exact: true }).fill("jobs/s")
    else {
      assert.equal(await editor(page).getByLabel("Unit", { exact: true }).count(), 0)
      await editor(page).getByText("Trace duration is displayed in milliseconds.", { exact: true }).waitFor()
    }
    if (kind === "timeseries") {
      assert.equal(await editor(page).getByLabel("Fill opacity", { exact: true }).count(), 0)
      await selectGammaOption(page, editor(page).getByRole("combobox", { name: "Display", exact: true }), "Area")
      await selectGammaOption(page, editor(page).getByRole("combobox", { name: "Curve", exact: true }), "Step")
      await editor(page).getByLabel("Line width", { exact: true }).fill("3")
      await editor(page).getByLabel("Fill opacity", { exact: true }).fill("0.25")
    }
    if (["timeseries", "bar"].includes(kind)) {
      await editor(page).getByLabel("X axis label", { exact: true }).fill("Observation")
      await editor(page).getByLabel("Y axis label", { exact: true }).fill("Work rate")
      await editor(page).getByRole("switch", { name: "Show grid", exact: true }).uncheck()
    }
    if (kind === "heatmap") {
      await editor(page).getByRole("switch", { name: "Show labels", exact: true }).uncheck()
      assert.equal(await editor(page).getByRole("switch", { name: "Show values", exact: true }).isChecked(), true)
    }
    if (kind === "gauge") {
      await editor(page).getByLabel("Minimum", { exact: true }).fill("-50")
      await editor(page).getByLabel("Maximum", { exact: true }).fill("150")
      await editor(page).getByRole("switch", { name: "Show legend", exact: true }).uncheck()
      await editor(page).getByLabel("Threshold 3 color", { exact: true }).fill("#507e6b")
    }
    const apply = editor(page).getByRole("button", { name: "Apply widget", exact: true })
    await apply.scrollIntoViewIfNeeded(); await page.waitForLoadState("networkidle")
    const originalQuery = documents.get("audit").widgets.find(widget => widget.id === kind).query
    const beforeStyle = requests.filter(request => request.query === originalQuery).length
    await apply.click()
    await page.waitForLoadState("networkidle")
    assert.equal(requests.filter(request => request.query === originalQuery).length, beforeStyle, "Cosmetic edits must reuse existing query data")
    await screenshot(page, `editor-${kind}-390.png`)
    await editor(page).getByRole("tab", { name: "Query", exact: true }).click()
    const query = editor(page).getByRole("textbox", { name: kind === "traces" ? /^TraceQL query/ : /^PromQL query/ })
    assert.equal(await query.evaluate(element => getComputedStyle(element).resize), "none", "Gamma query textareas must retain their responsive layout")
    const edited = kind === "traces" ? '{ name = "audit_traces_edited" }' : `audit_${kind}_edited`
    const beforeDraft = requests.filter(request => request.query === edited).length
    await query.fill(edited)
    await page.waitForLoadState("networkidle")
    assert.equal(requests.filter(request => request.query === edited).length, beforeDraft, "Query drafts must wait for explicit Run query or Apply")
    if (kind === "gauge") await editor(page).getByLabel(/^Plugin configuration/).fill('{"label":"Edited capacity"}')
    const previewRequest = page.waitForRequest(request => request.url().endsWith("/api/insights/query") && request.postDataJSON()?.query === edited)
    await editor(page).getByRole("button", { name: "Run query", exact: true }).click()
    await previewRequest
    await editor(page).locator('[aria-label="Query preview"]').waitFor()
    await editor(page).getByRole("button", { name: "Apply widget", exact: true }).click()
    await closeEditor(page)
    const tile = page.locator(`[data-widget-id="${kind}"]`)
    assert.equal(await tile.evaluate(element => getComputedStyle(element).backgroundColor), "rgb(238, 243, 235)")
    if (["timeseries", "bar"].includes(kind)) { await tile.getByText("Observation", { exact: true }).waitFor(); await tile.getByText("Work rate", { exact: true }).waitFor() }
    const axes = ["timeseries", "bar"].includes(kind) ? await axisContrast(tile) : undefined
    if (kind === "gauge") { assert.equal(await tile.getByRole("meter").getAttribute("aria-valuemin"), "-50"); assert.equal(await tile.getByRole("meter").getAttribute("aria-valuemax"), "150"); await tile.getByText("Edited capacity", { exact: true }).waitFor() }
    if (kind === "heatmap") { const cell = tile.getByRole("group").getByRole("button").first(); assert.ok(!(await cell.innerText()).includes("api-east")); assert.match(await cell.getAttribute("aria-label"), /api-east/) }
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByText("All changes saved", { exact: true }).waitFor()
    const saved = documents.get("audit").widgets.find(widget => widget.id === kind)
    assert.equal(saved.query, edited); assert.equal(saved.options.decimals, 3); assert.equal(saved.options.background, "#eef3eb")
    return { query: edited, persistedOptions: saved.options, draftRequests: 0, cosmeticRequests: 0, viewport: 390, ...(axes ? { axes } : {}) }
  }, { widget: kind, category: "editor" })
  await check("all widget edits survive reload and responsive reflow preserves desktop layouts", async () => {
    await page.reload({ waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Every widget audit", exact: true }).waitFor()
    for (const width of [1512, 768, 390, 320, 1512]) { await page.setViewportSize({ width, height: 1050 }); await stable(page); await geometry(page, width) }
    for (const widget of documents.get("audit").widgets) {
      assert.equal(widget.options.decimals, 3); assert.match(widget.query, /edited/)
      assert.deepEqual(widget.layout, layouts[widget.id], "Viewport changes must not mutate saved desktop layouts")
    }
    return { viewports: [1512, 768, 390, 320, 1512], persistedWidgetCount: 7 }
  }, { category: "persistence" })
  await context.close()
}

async function drilldownAudit(width, kind) {
  const { page, context, documents } = await openFixture("normal", width, true)
  await check(`${kind}: ${width}px keyboard drilldown carries the selected observation`, async () => {
    const tile = page.locator(`[data-widget-id="${kind}"]`)
    await tile.scrollIntoViewIfNeeded()
    let service = "worker-west", value = kind === "traces" ? "1200.1234" : "-12.5"
    if (kind === "heatmap") {
      const cell = tile.getByRole("group").getByRole("button", { name: /^worker-west:/ })
      await cell.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Escape")
    } else if (["table", "traces"].includes(kind)) {
      const row = tile.locator("tbody tr").nth(1)
      await row.focus(); await page.keyboard.press("Enter")
      assert.equal(await row.getAttribute("aria-selected"), "true")
    } else if (kind === "gauge") {
      service = "api-east"; value = "42.56789"
      const trigger = tile.getByRole("button", { name: /^Select signal for/ })
      await trigger.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Escape")
    } else {
      await selectGammaOption(page, tile.getByRole("combobox", { name: `Series for ${titles[kind]}`, exact: true }), /^worker-west/)
    }
    await tile.getByRole("button", { name: `Open related dashboard from ${titles[kind]}`, exact: true }).click()
    const item = page.getByRole("menuitem", { name: /^Inspect selected signal/ })
    const expectedQuery = `audit_target{service=${JSON.stringify(service)},value=${JSON.stringify(value)}}`
    const queryRequest = page.waitForRequest(request => request.url().endsWith("/api/insights/query") && request.postDataJSON()?.query === expectedQuery).catch(() => undefined)
    await item.focus(); await page.keyboard.press("Enter")
    await page.getByRole("heading", { name: "Audit destination", exact: true }).waitFor()
    assert.equal(await page.getByLabel("service", { exact: true }).inputValue(), service)
    assert.equal(await page.getByLabel("value", { exact: true }).inputValue(), value)
    await page.locator('[data-widget-id="target-stat"]').scrollIntoViewIfNeeded()
    const observed = await queryRequest
    assert.ok(observed, "Selected context must reach the target query, not only its URL")
    const query = observed.postDataJSON()
    assert.equal(query.start, Date.parse(range.from) / 1000); assert.equal(query.end, Date.parse(range.to) / 1000)
    assert.equal(documents.get("audit-target").variables[0].defaultValue, "unset")
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    return { selected: service, value, query: query.query, start: query.start, end: query.end }
  }, { widget: kind, viewport: width, category: "drilldown" })
  await context.close()
}

async function confirmationAudit(width) {
  const { page, context, documents } = await openFixture("normal", width)
  await check(`${width}px Gamma confirmations preserve drafts on Cancel/Escape and accept explicit actions`, async () => {
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByLabel("Dashboard title", { exact: true }).fill("Unpublished audit draft")
    const navigate = async () => {
      const link = page.getByRole("navigation", { name: "Dashboard library", exact: true }).getByRole("button", { name: "Audit destination", exact: true })
      if (!(await link.isVisible())) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
      await link.click()
      const dialog = page.getByRole("alertdialog")
      await dialog.waitFor(); await withinViewport(page, dialog)
      assert.equal(await dialog.getByRole("button", { name: "Cancel", exact: true }).evaluate(element => element === document.activeElement), true)
      await page.keyboard.press("Tab")
      assert.equal(await dialog.getByRole("button", { name: "Discard changes", exact: true }).evaluate(element => element === document.activeElement), true, "Tab must stay in the top confirmation rather than the underlying drawer")
      await page.keyboard.press("Shift+Tab")
      return dialog
    }
    const firstDialog = await navigate(); await page.keyboard.press("Escape")
    await firstDialog.waitFor({ state: "hidden" })
    if (width < 600) {
      assert.equal(await page.getByRole("dialog", { name: "Insights navigation", exact: true }).isVisible(), true, "Escape should dismiss only the top confirmation")
      assert.equal(await page.evaluate(() => document.body.style.overflow), "hidden", "Drawer should retain its scroll lock after cancelling the nested dialog")
    }
    assert.equal(await page.getByLabel("Dashboard title", { exact: true }).inputValue(), "Unpublished audit draft")
    await navigate(); await respondToGammaConfirmation(page, "Cancel")
    assert.equal(new URL(page.url()).searchParams.get("dashboard"), "audit")
    await navigate(); await screenshot(page, `confirmation-${width}.png`)
    await respondToGammaConfirmation(page, "Discard changes")
    await page.getByRole("heading", { name: "Audit destination", exact: true }).waitFor()
    assert.notEqual(await page.evaluate(() => document.body.style.overflow), "hidden", "Accepted navigation should release both modal and drawer scroll locks")
    assert.equal(documents.get("audit").title, "Every widget audit")
    await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
    const manager = page.getByRole("region", { name: "Manage dashboards", exact: true })
    await manager.getByRole("button", { name: "Delete dashboard", exact: true }).click()
    await respondToGammaConfirmation(page, "Cancel")
    assert.ok(documents.has("audit-target"))
    await manager.getByRole("button", { name: "Delete dashboard", exact: true }).click()
    await respondToGammaConfirmation(page, "Delete dashboard")
    await page.getByText("Dashboard deleted.", { exact: true }).waitFor()
    assert.ok(!documents.has("audit-target"))
    return { initialFocus: "Cancel", escapePreservedDraft: true, cancelledDeletePreservedDashboard: true, acceptedDeleteRemovedDashboard: true }
  }, { viewport: width, category: "confirmation" })
  await context.close()
}

async function tableOverflowAudit() {
  const { page, context } = await openFixture("bounded", 390)
  for (const kind of ["table", "traces"]) await check(`${kind}: bounded rows remain keyboard-scrollable with a sticky header on mobile`, async () => {
    const region = page.locator(`[data-widget-id="${kind}"]`).getByRole("region")
    await region.scrollIntoViewIfNeeded(); await region.focus()
    const before = await region.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft, height: element.clientHeight, contentHeight: element.scrollHeight, width: element.clientWidth, contentWidth: element.scrollWidth, headerTop: element.querySelector("th").getBoundingClientRect().top }))
    assert.ok(before.contentHeight > before.height)
    for (let index = 0; index < 8; index++) await page.keyboard.press("ArrowDown")
    await page.waitForFunction(label => document.querySelector(`[aria-label=${JSON.stringify(label)}]`).scrollTop > 0, await region.getAttribute("aria-label"))
    for (let index = 0; index < 8; index++) await page.keyboard.press("ArrowRight")
    if (before.contentWidth > before.width) await page.waitForFunction(label => document.querySelector(`[aria-label=${JSON.stringify(label)}]`).scrollLeft > 0, await region.getAttribute("aria-label"))
    const after = await region.evaluate(element => ({ top: element.scrollTop, left: element.scrollLeft, headerTop: element.querySelector("th").getBoundingClientRect().top, regionTop: element.getBoundingClientRect().top }))
    assert.ok(after.top > 0)
    assert.ok(Math.abs(after.headerTop - before.headerTop) <= 2, "Column headings must remain visible while rows scroll")
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    return { before, after }
  }, { widget: kind, category: "keyboard-scroll", viewport: 390 })
  await context.close()
}

async function isolationAudit() {
  for (const [name, change, message] of [
    ["unknown plugin", widget => ({ ...widget, pluginId: "unregistered-audit-plugin" }), /Widget plugin unavailable/],
    ["invalid plugin configuration", widget => ({ ...widget, config: { label: 12 } }), /Widget could not render/],
    ["missing provider", widget => ({ ...widget, providerId: "missing-connection" }), /not configured/],
    ["one failed provider query", widget => ({ ...widget, query: "audit_failure" }), /Audit backend failed/],
  ]) {
    const { page, context } = await openFixture("normal", 390, false, {}, document => ({ ...document, widgets: document.widgets.map(widget => widget.id === "gauge" ? change(widget) : widget) }))
    await check(`${name} remains isolated to its widget and offers an honest error`, async () => {
      const gauge = page.locator('[data-widget-id="gauge"]')
      assert.match(await gauge.getByRole("alert").innerText(), message)
      assert.equal(await gauge.getByRole("meter").count(), 0)
      await page.locator('[data-widget-id="stat"]').getByText("42.57", { exact: false }).waitFor()
      assert.equal(await page.locator('[data-widget-id="traces"] tbody tr').count(), 3)
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    }, { widget: "gauge", category: "failure-isolation" })
    await context.close()
  }
  const { page, context } = await openFixture("bounded", 390, false, {}, document => ({ ...document, widgets: document.widgets.map(widget => ({ ...widget, options: { ...widget.options, showLegend: false } })) }))
  for (const kind of ["timeseries", "bar"]) await check(`${kind}: series limit remains explicit when the legend is hidden`, async () => {
    await page.locator(`[data-widget-id="${kind}"]`).getByText("First 12 of 120 series", { exact: true }).waitFor()
  }, { widget: kind, category: "bounds" })
  await context.close()
}

async function detailAudit(width, touch = false) {
  const { page, context } = await openFixture("long", width, false, touch ? { isMobile: true, hasTouch: true } : {})
  for (const kind of ["stat", "table", "traces", "heatmap", "gauge"]) await check(`${kind}: full ${touch ? "touch" : "pointer and keyboard"} detail is exact, unclipped and dismissible at ${width}px`, async () => {
    const tile = page.locator(`[data-widget-id="${kind}"]`)
    const trigger = kind === "heatmap" ? tile.getByRole("group").getByRole("button").first()
      : tile.getByRole("button", { name: kind === "table" ? /^Inspect series / : kind === "traces" ? /^Inspect trace / : /^Inspect value for / }).first()
    await trigger.scrollIntoViewIfNeeded()
    if (touch) await trigger.tap()
    else { await trigger.hover(); await page.getByRole("tooltip").waitFor(); await trigger.click() }
    const tooltip = page.getByRole("tooltip")
    await tooltip.waitFor()
    assert.equal(await trigger.getAttribute("aria-pressed"), "true")
    assert.equal(await trigger.getAttribute("aria-describedby"), await tooltip.getAttribute("id"))
    const measured = await withinViewport(page, tooltip)
    assert.equal(await tooltip.evaluate(element => element.closest("[data-widget-id]") === null), true, "Details must escape tile clipping")
    assert.equal(await tooltip.locator("[data-metric-value]").getAttribute("data-metric-value"), kind === "traces" ? "72.25" : "42.56789")
    assert.equal(await tooltip.locator("time").getAttribute("datetime"), new Date(stamp).toISOString())
    let traceRendering
    if (kind === "traces") {
      const before = await tooltip.innerText(), started = Date.now()
      // Chromium can report the visible portal before its nested labels have
      // joined innerText during placement. Require the rendered text to settle;
      // DOM textContent alone would conceal a genuinely hidden label block.
      await page.waitForFunction(expected => {
        const text = document.querySelector('[role="tooltip"]')?.innerText ?? ""
        return text.includes(expected.id) && text.includes(expected.operation)
      }, { id: "a".repeat(31) + "0", operation: "POST /api/payments/very-long-route/with-customer-context/and-observability-details" }, { polling: "raf", timeout: 5000 })
      await withinViewport(page, tooltip)
      traceRendering = { before, after: await tooltip.innerText(), elapsedMs: Date.now() - started }
    }
    const detailText = await tooltip.innerText()
    assert.ok(detailText.includes(`${longName}-1`), `The complete series/service name must remain inspectable: ${JSON.stringify(detailText)}`)
    if (kind === "traces") {
      assert.ok(detailText.includes("a".repeat(31) + "0"), `Trace details must retain the complete trace ID: ${JSON.stringify(detailText)}`)
      assert.ok(detailText.includes("POST /api/payments/very-long-route/with-customer-context/and-observability-details"), `Trace details must retain the complete operation: ${JSON.stringify(detailText)}`)
    } else assert.ok(detailText.includes("eu-central-1"), `Metric details must retain the full region label: ${JSON.stringify(detailText)}`)
    const path = resolve(output, `detail-${kind}-${width}${touch ? "-touch" : ""}.png`)
    await page.screenshot({ path }); screenshots.push(path)
    if (touch) {
      await trigger.tap(); await tooltip.waitFor({ state: "hidden" })
      await trigger.tap(); await tooltip.waitFor(); await page.touchscreen.tap(2, 2)
      await tooltip.waitFor({ state: "hidden" })
    } else {
      await page.keyboard.press("Escape"); await tooltip.waitFor({ state: "hidden" })
      await trigger.evaluate(element => element.blur()); await trigger.focus()
      await tooltip.waitFor(); await withinViewport(page, tooltip)
      await page.keyboard.press("End")
      const scroll = await tooltip.evaluate(element => ({ top: element.scrollTop, maximum: element.scrollHeight - element.clientHeight }))
      if (scroll.maximum > 1) assert.ok(scroll.top > 0, "Keyboard users must be able to read all detail content")
      await page.keyboard.press("Home"); assert.equal(await tooltip.evaluate(element => element.scrollTop), 0)
      await page.keyboard.press("Escape"); await tooltip.waitFor({ state: "hidden" })
      assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
    }
    return { exactValue: kind === "traces" ? 72.25 : 42.56789, fullLabels: true, pinned: true, measured, ...(traceRendering ? { traceRendering } : {}) }
  }, { widget: kind, category: "full-details", viewport: width, touch })
  await context.close()
}

async function chartInspectorAudit(width, height = width < 600 ? 844 : 1050) {
  const { page, context } = await openFixture("history", width, false, { viewport: { width, height } }, document => ({ ...document, widgets: document.widgets.map(widget => ({ ...widget, options: { ...widget.options, showTooltip: false, background: "#102030", ...(widget.type === "bar" ? { textColor: "#ffffff" } : {}) } })) }))
  for (const kind of ["timeseries", "bar"]) await check(`${kind}: exact data inspector works with keyboard and Gamma series selection at ${width}px`, async () => {
    const tile = page.locator(`[data-widget-id="${kind}"]`)
    const opener = tile.getByRole("button", { name: `Inspect chart data for ${titles[kind]}`, exact: true })
    await opener.scrollIntoViewIfNeeded(); await opener.focus(); await page.keyboard.press("Enter")
    const dialog = page.getByRole("dialog", { name: `${titles[kind]} data`, exact: true })
    await dialog.waitFor(); await withinViewport(page, dialog)
    await withinViewport(page, dialog.getByRole("button", { name: "Close data", exact: true }))
    assert.equal(await dialog.getByRole("button", { name: "Close data", exact: true }).evaluate(element => element === document.activeElement), true)
    const contrast = await dialog.evaluate(element => {
      const rgb = value => (value.match(/[\d.]+/g) ?? []).map(Number)
      const luminance = channels => channels.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
      return [...element.querySelectorAll("h2,p,th,td,dt,dd")].filter(node => node.textContent.trim()).map(node => {
        let parent = node, background
        while (parent) { const color = rgb(getComputedStyle(parent).backgroundColor); if (color.length >= 3 && color[3] !== 0) { background = color; break }; parent = parent.parentElement }
        const foreground = rgb(getComputedStyle(node).color), a = luminance(foreground), b = luminance(background ?? [255,255,255])
        return { text: node.textContent.slice(0, 60), ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) }
      })
    })
    for (const sample of contrast) assert.ok(sample.ratio >= 4.5, `Dark widget leaked low-contrast styling into inspector: ${JSON.stringify(sample)}`)
    const selector = dialog.getByRole("combobox", { name: "Data series", exact: true })
    await selector.click(); await page.keyboard.press("Escape")
    assert.equal(await dialog.isVisible(), true, "First Escape must close only the Gamma dropdown")
    assert.equal(await selector.getAttribute("aria-expanded"), "false")
    await selectGammaOption(page, selector, "worker-west")
    assert.match(await dialog.locator("dl").innerText(), /worker-west/)
    if (kind === "timeseries") {
      assert.equal(await dialog.locator("tbody tr").count(), 25)
      await dialog.getByRole("button", { name: "Next observations", exact: true }).click()
      await dialog.getByText("No data", { exact: true }).waitFor()
      await dialog.getByRole("button", { name: "Next observations", exact: true }).click()
      assert.equal(await dialog.locator("tbody tr").count(), 10)
      assert.equal(await dialog.getByRole("button", { name: "Next observations", exact: true }).isDisabled(), true)
    } else assert.equal(await dialog.locator("tbody tr").count(), 1)
    assert.equal(await dialog.locator("[data-metric-value]").last().getAttribute("data-metric-value"), String(60.123456789))
    assert.equal(await dialog.locator("time").last().getAttribute("datetime"), new Date(stamp).toISOString())
    await withinViewport(page, dialog.getByRole("button", { name: "Next observations", exact: true }))
    const path = resolve(output, `data-${kind}-${width}.png`); await page.screenshot({ path }); screenshots.push(path)
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" })
    assert.equal(await opener.evaluate(element => element === document.activeElement), true)
    return { popupTooltipsDisabled: true, fullPrecision: 60.123456789, missingSamplesVisible: kind === "timeseries", modalSeriesSelection: true, minimumInspectorContrast: Math.min(...contrast.map(sample => sample.ratio)), customDarkBackground: true, viewport: { width, height } }
  }, { widget: kind, category: "data-inspector", viewport: width })
  await context.close()
}

async function missingObservationAudit() {
  const { page, context } = await openFixture("tail-null", 390, true)
  for (const kind of ["heatmap", "gauge"]) await check(`${kind}: a missing latest observation cannot drill down using an older healthy value`, async () => {
    const tile = page.locator(`[data-widget-id="${kind}"]`)
    const trigger = kind === "heatmap" ? tile.getByRole("group").getByRole("button").first() : tile.getByRole("button", { name: /^Select signal for/ })
    await trigger.click(); await page.keyboard.press("Escape")
    await tile.getByRole("button", { name: `Open related dashboard from ${titles[kind]}`, exact: true }).click()
    const item = page.getByRole("menuitem", { name: /^Inspect selected signal/ })
    assert.equal(await item.getAttribute("aria-disabled"), "true")
    assert.match(await item.innerText(), /no finite value/i)
    await page.keyboard.press("Escape")
    assert.equal(new URL(page.url()).searchParams.get("dashboard"), "audit")
    return { displayedLatest: "No data", olderValidValue: 42.56789, navigationDisabled: true }
  }, { widget: kind, category: "missing-observation-context", viewport: 390 })
  await context.close()
}

try {
  await mkdir(output, { recursive: true })
  if (detailsOnly) await detailAudit(390, true)
  if (!detailsOnly) for (const width of [1512, 768, 390]) for (const state of ["normal", "long"]) {
    const { page, context } = await openFixture(state, width)
    await check(`${state} all-widget layout at ${width}px`, () => geometry(page, width), { viewport: width, state })
    await screenshot(page, `${state}-${width}.png`)
    await stateAssertions(page, state)
    await context.close()
  }
  if (!inspectOnly && !detailsOnly) {
    for (const width of [1512, 390]) for (const state of ["empty", "error", "zero", "negative", "null", "tail-null", "bounded"]) {
      const { page, context } = await openFixture(state, width)
      await check(`${state} ${width}px geometry`, () => geometry(page, width), { viewport: width, state })
      await stateAssertions(page, state)
      if (["empty", "error", "null", "tail-null"].includes(state) && width === 390) await screenshot(page, `${state}-${width}.png`)
      await context.close()
    }
    await editingAudit()
    await tableOverflowAudit()
    await isolationAudit()
    await detailAudit(1512)
    await detailAudit(390, true)
    for (const width of [1512, 390]) await chartInspectorAudit(width)
    await chartInspectorAudit(844, 390)
    await missingObservationAudit()
    for (const width of [1512, 390]) for (const kind of kinds) await drilldownAudit(width, kind)
    for (const width of [1512, 390]) await confirmationAudit(width)
  }
} finally {
  await active?.context.close().catch(() => {})
  await browser.close()
  const coverage = kinds.map(widget => {
    const checks = reports.filter(report => report.widget === widget)
    return { widget, passed: checks.filter(check => check.passed && check.status !== "not-applicable").length, failed: checks.filter(check => !check.passed).length, states: [...new Set(checks.map(check => check.state).filter(Boolean))], viewports: [...new Set(checks.map(check => check.viewport).filter(Boolean))], interactions: [...new Set(checks.map(check => check.category).filter(Boolean))], notApplicable: checks.filter(check => check.status === "not-applicable").map(check => ({ state: check.state, reason: check.reason })) }
  })
  await writeFile(resolve(output, detailsOnly ? "details-report.json" : "report.json"), JSON.stringify({ baseURL, inspectOnly, detailsOnly, harness: "Deterministic normalized API fixture; no sample renderer substitution. Real Go integration covered by live/drilldown suites.", coverage, reports, pageErrors, requests, screenshots }, null, 2))
}
assert.deepEqual(pageErrors, [])
assert.equal(reports.filter(report => !report.passed).length, 0, "Widget audit found regressions; inspect report.json")
console.log(`${reports.filter(report => report.status !== "not-applicable").length} widget audit checks passed; ${reports.filter(report => report.status === "not-applicable").length} explicitly not applicable.`)
