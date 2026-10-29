// Rich chart integration uses test-only HTTP fixtures and the actual application.
// These compositions are not dashboard templates and are never shipped in the public gallery.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = join(root, "artifacts/insights/rich-charts")
const studies = [
  { id: "service-pulse", title: "Service Pulse", secondary: "latency-distribution" },
  { id: "fleet-atlas", title: "Fleet Atlas", secondary: "resources" },
  { id: "edge-watch", title: "Edge Watch", secondary: "locations" },
  { id: "market-lens", title: "Market Lens", secondary: "rankings" },
  { id: "reliability-room", title: "Reliability Room", secondary: "incidents-list" },
  { id: "collection-control", title: "Collection Control", secondary: "topology" },
]
const reports = [], errors = [], liveRequests = []
let browser, context, page, current, fixtureAPI
await mkdir(output, { recursive: true })
const tile = id => page.locator(`[data-widget-id=${JSON.stringify(id)}]`)
const editor = () => page.getByRole("region", { name: "Widget editor", exact: true })
const scopeControl = variable => page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: variable.label, exact: true })
async function until(predicate, message, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}
async function check(name, action) {
  try { const evidence = await action(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) {
    const receipt = { name, passed: false, error: error.stack, url: page?.url(), viewport: page?.viewportSize() }
    reports.push(receipt)
    await page?.screenshot({ path: join(output, "failure.png"), fullPage: false }).catch(() => {})
    await writeFile(join(output, "failure.txt"), `${JSON.stringify(receipt, null, 2)}\n${await page?.locator("body").innerText().catch(() => "")}`)
    throw error
  }
}
async function ready(widget) {
  const element = tile(widget.id)
  await element.scrollIntoViewIfNeeded()
  await element.getByRole("status", { name: "Loading widget" }).waitFor({ state: "hidden" })
  await until(async () => !(await element.locator('[aria-busy="true"]').count()) && !/Querying data source|No data in this time range/.test(await element.innerText()), `${widget.title} did not finish querying`)
  assert.deepEqual(await element.getByRole("alert").allTextContents(), [], `${widget.title} has a render/query error`)
  assert.ok((await element.innerText()).trim().length > widget.title.length, `${widget.title} has no rendered content`)
  if (widget.type === "stat") await until(async () => await element.locator("[data-metric-value]").count() === 1, `${widget.title} has no observed value`)
  if (widget.pluginId === "distribution-heatmap") await until(async () => await element.locator("rect[data-bucket-value]").count() > 20, "Histogram buckets must render observations")
  if (widget.pluginId === "stacked-timeseries" || widget.pluginId === "directional-traffic") assert.ok(await element.locator("g[data-series]").count() >= 2, `${widget.title} requires multiple plotted contributions`)
  if (["connection-map", "pipeline-topology", "incident-calendar"].includes(widget.pluginId)) assert.equal(await element.locator(`[data-operational-chart="${widget.pluginId}"]`).count(), 1)
  if (widget.pluginId === "threshold-gauge") assert.equal(await element.locator(`[data-gauge-display="${widget.config.display}"]`).count(), 1)
  if (["distribution-heatmap", "stacked-timeseries", "directional-traffic"].includes(widget.pluginId)) {
    await until(async () => element.locator("text[data-value-axis]").evaluateAll(labels => labels.length > 0 && labels.every(label => {
      const text = label.getBoundingClientRect(), plot = label.ownerSVGElement.getBoundingClientRect()
      return text.left >= plot.left - 1 && text.right <= plot.right + 1
    })), `${widget.title} clips value-axis labels`)
  }
  if (["stacked-timeseries", "directional-traffic"].includes(widget.pluginId)) {
    const legend = element.getByRole("region", { name: "Latest recorded values", exact: true })
    await legend.waitFor()
    const shape = await legend.evaluate(container => {
      const bounds = container.getBoundingClientRect()
      const rows = [...container.querySelectorAll("span[title]")].map(label => label.parentElement.getBoundingClientRect())
      return { count: rows.length, allVisible: rows.every(row => row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1), overflow: container.scrollHeight > container.clientHeight + 1 }
    })
    assert.ok(shape.count >= 2)
    if (!shape.allVisible) {
      assert.equal(shape.overflow, true, "A clipped legend must be a real scroll surface")
      await element.getByText("Scroll to see all series", { exact: false }).waitFor()
      assert.equal(await legend.getAttribute("tabindex"), "0", "An overflowing legend must be keyboard accessible")
    }
  }
  return element
}
async function noOverflow() {
  const sizes = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }))
  assert.ok(sizes.page <= sizes.viewport + 1, `Horizontal page overflow: ${JSON.stringify(sizes)}`)
  return sizes
}
async function open(study) {
  await page.goto(`${base}/dashboard/insights/?dashboard=example-artboard-${study.id}`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: `${study.title} · Test fixture`, exact: true }).waitFor()
  current = fixtureAPI.documents.get(`example-artboard-${study.id}`)
  assert.ok(current, `The HTTP fixture must seed ${study.title}`)
  return current
}
async function chartSnapshot(id) {
  return tile(id).evaluate(element => ({
    text: element.innerText,
    cells: [...element.querySelectorAll("[data-bucket-value]")].map(cell => cell.getAttribute("data-bucket-value")),
  }))
}
async function inspectMetric(id) {
  const element = tile(id)
  await element.scrollIntoViewIfNeeded()
  const plot = element.locator('svg[role="group"]').first()
  await plot.focus()
  const details = element.getByRole("region", { name: "Observation details", exact: true })
  await details.waitFor()
  await plot.press("ArrowLeft")
  await plot.press("Enter")
  await details.getByRole("button", { name: "Unpin observation", exact: true }).waitFor()
  await page.mouse.move(1, 1)
  assert.equal(await details.isVisible(), true, "Pinned observation must survive pointer exit")
  await plot.press("Escape")
  await details.waitFor({ state: "hidden" })
  const bounds = await plot.boundingBox()
  await page.mouse.move(bounds.x + bounds.width * .62, bounds.y + bounds.height * .45)
  await details.waitFor()
  const inspection = await details.boundingBox(), viewport = page.viewportSize()
  assert.ok(inspection.x >= 0 && inspection.x + inspection.width <= viewport.width + 1, "Metric inspection must fit the viewport")
  await page.keyboard.press("Escape")
  return { keyboard: true, pinned: true, pointer: true }
}
async function inspectRecord(id, name) {
  const element = tile(id)
  await element.scrollIntoViewIfNeeded()
  const mark = element.getByRole("button", { name }).first()
  await mark.focus()
  const details = page.getByRole("tooltip")
  await details.waitFor()
  await mark.press("Enter")
  assert.equal(await mark.getAttribute("aria-pressed"), "true")
  await page.mouse.move(1, 1)
  await details.getByText("Pinned · tap again to close", { exact: true }).waitFor()
  const inspection = await details.boundingBox(), viewport = page.viewportSize()
  assert.ok(inspection.x >= 0 && inspection.x + inspection.width <= viewport.width + 1, "Record inspection must fit the viewport")
  await mark.press("Escape")
  await details.waitFor({ state: "hidden" })
  return { keyboard: true, pinned: true }
}
async function inspectTopologyScroll() {
  const element = tile("topology"), diagram = element.getByRole("region", { name: "Pipeline diagram", exact: true })
  await element.scrollIntoViewIfNeeded()
  const maximum = await diagram.evaluate(node => node.scrollWidth - node.clientWidth)
  if (maximum <= 1) return { overflow: false }
  await element.getByText("Scroll to explore all stages", { exact: true }).waitFor()
  const previous = element.getByRole("button", { name: "Previous pipeline stages", exact: true })
  const next = element.getByRole("button", { name: "Next pipeline stages", exact: true })
  const start = await diagram.evaluate(node => node.scrollLeft)
  assert.equal(await next.isDisabled(), false)
  await next.click()
  // Native scroll offsets update before the scroll event commits React's
  // navigation state. Verify both instead of reading disabled mid-frame.
  await until(async () => await diagram.evaluate(node => node.scrollLeft) > start && !(await previous.isDisabled()), "Next stages must move the diagram and enable previous navigation")
  const advanced = await diagram.evaluate(node => node.scrollLeft)
  assert.equal(await previous.isDisabled(), false)
  await previous.click()
  await until(async () => await diagram.evaluate(node => node.scrollLeft) < advanced && !(await next.isDisabled()), "Previous stages must move back and enable next navigation")
  assert.equal(await diagram.getAttribute("tabindex"), "0")
  return { overflow: true, start, advanced, maximum }
}
async function sourceRoundtrip() {
  await page.getByRole("button", { name: "Code", exact: true }).click()
  const source = page.getByRole("region", { name: "Dashboard source editor", exact: true })
  await source.getByRole("button", { name: "JSON", exact: true }).click()
  const original = JSON.parse(await source.getByRole("textbox", { name: "Dashboard source" }).inputValue())
  await source.getByRole("button", { name: "YAML", exact: true }).click()
  const yaml = await source.getByRole("textbox", { name: "Dashboard source" }).inputValue()
  assert.ok(yaml.includes("queryRef:") && yaml.includes("bindings:"))
  await source.getByRole("button", { name: "JSON", exact: true }).click()
  assert.deepEqual(JSON.parse(await source.getByRole("textbox", { name: "Dashboard source" }).inputValue()), original)
  await source.getByRole("button", { name: "Close source editor", exact: true }).click()
  return original
}

try {
  browser = await chromium.launch({ headless: true })
  for (const width of [1512, 390]) {
    context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, reducedMotion: "reduce", timezoneId: "UTC" })
    page = await context.newPage(); page.setDefaultTimeout(15000)
    fixtureAPI = await installRichChartFixtureAPI(page, base)
    page.on("pageerror", error => errors.push(error.message))
    page.on("dialog", dialog => { errors.push(`Unexpected native dialog: ${dialog.message()}`); void dialog.dismiss() })
    page.on("request", request => { if (!request.url().startsWith(new URL(base).origin) && !request.url().startsWith("data:")) liveRequests.push(request.url()) })
    for (const theme of ["Light", "Dark"]) for (const study of studies) {
      await check(`${study.title}: ${theme.toLowerCase()} ${width}px saved-query render and shared filter`, async () => {
        const board = await open(study)
        await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
        await until(async () => await page.locator(`[data-insights-theme="${theme.toLowerCase()}"]`).count() > 0, "Appearance did not change")
        const byId = fixtureAPI.savedQueries
        for (const widget of board.widgets) {
          const saved = byId.get(widget.queryRef?.id)
          assert.ok(saved, `${widget.title} must resolve a real saved query`)
          assert.deepEqual(widget.queryRef.bindings, [{ parameter: board.variables[0].name, source: "variable", variable: board.variables[0].name }])
          await ready(widget)
        }
        await noOverflow()
        const variable = board.variables[0], first = board.widgets.find(widget => widget.type === "stat")
        await tile(first.id).scrollIntoViewIfNeeded()
        const before = await tile(first.id).locator("[data-metric-value]").getAttribute("data-metric-value")
        const priorSecondary = await chartSnapshot(study.secondary)
        await selectGammaOption(page, scopeControl(variable), variable.options[1])
        await until(async () => await tile(first.id).locator("[data-metric-value]").getAttribute("data-metric-value") !== before, "Shared filter did not update the single value")
        await ready(board.widgets.find(widget => widget.id === study.secondary))
        await until(async () => JSON.stringify(await chartSnapshot(study.secondary)) !== JSON.stringify(priorSecondary), "Shared filter did not update the dependent chart or records")
        for (const widget of board.widgets) {
          await ready(widget)
          const saved = byId.get(widget.queryRef.id)
          const expectedQuery = saved.query.replaceAll(`{{${variable.name}}}`, JSON.stringify(variable.options[1]))
          assert.ok(fixtureAPI.calls.some(call => call.path === "/query" && call.document?.query === expectedQuery && call.document?.providerId === saved.providerId), `${widget.title} never executed its scoped saved query`)
        }
        assert.deepEqual(JSON.parse(new URL(page.url()).searchParams.get("vars")), { [variable.name]: variable.options[1] })
        const stored = fixtureAPI.documents.get(board.id)
        assert.equal(stored.variables[0].defaultValue, variable.options[0], "Viewing a filter must not persist a dashboard default")
        await selectGammaOption(page, scopeControl(variable), variable.options[0])
        for (const widget of board.widgets) {
          const element = await ready(widget)
          if (["distribution-heatmap", "stacked-timeseries", "directional-traffic", "connection-map", "pipeline-topology", "incident-calendar", "threshold-gauge"].includes(widget.pluginId)) {
            await page.mouse.move(1, 1)
            await page.keyboard.press("Escape")
            await until(async () => await page.getByRole("tooltip").count() === 0, "Prior hover detail should clear before visual capture")
            await element.screenshot({ path: join(output, `${study.id}-${widget.id}-${theme.toLowerCase()}-${width}.png`), animations: "disabled" })
          }
        }
        if (study.id === "service-pulse") await inspectMetric("latency-distribution")
        if (study.id === "edge-watch") { await inspectMetric("flow"); await inspectMetric("outcomes"); await inspectRecord("locations", "Inspect location Melbourne") }
        if (study.id === "reliability-room") await inspectRecord("calendar", /^2026-10-05:/)
        if (study.id === "collection-control") { await inspectMetric("throughput"); await inspectRecord("topology", /^Inspect connection Sources to Collector:/); await inspectTopologyScroll() }
        await noOverflow()
        await page.evaluate(() => scrollTo(0, 0))
        await page.screenshot({ path: join(output, `${study.id}-${theme.toLowerCase()}-${width}.png`), fullPage: false })
        return { widgets: board.widgets.length, savedQueries: new Set(board.widgets.map(widget => widget.queryRef.id)).size, variable: variable.name, options: variable.options, httpFixturesOnly: true }
      })
    }
    if (width === 1512) {
      await check("Guided histogram settings preview, save, reload and JSON/YAML preserve saved-query bindings", async () => {
        await open(studies[0])
        await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
        await page.getByRole("button", { name: "Edit Latency distribution", exact: true }).click()
        await editor().getByRole("tab", { name: "Query", exact: true }).click()
        await editor().getByRole("spinbutton", { name: "Maximum time columns", exact: true }).fill("24")
        await editor().getByRole("button", { name: "Apply widget", exact: true }).click()
        await editor().getByRole("button", { name: "Close widget editor", exact: true }).click()
        const authored = await sourceRoundtrip()
        const histogram = authored.widgets.find(widget => widget.id === "latency-distribution")
        assert.equal(histogram.config.maxColumns, 24)
        assert.equal(histogram.queryRef.id, "ab-service-pulse-latency-buckets")
        await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
        await page.getByText("All changes saved", { exact: true }).waitFor()
        await page.reload({ waitUntil: "networkidle" })
        await page.getByRole("heading", { name: "Service Pulse · Test fixture", exact: true }).waitFor()
        const persisted = fixtureAPI.documents.get("example-artboard-service-pulse")
        assert.equal(persisted.widgets.find(widget => widget.id === "latency-distribution").config.maxColumns, 24)
        await ready(persisted.widgets.find(widget => widget.id === "latency-distribution"))
        assert.ok(await tile("latency-distribution").locator("rect[data-bucket-value]").count() <= 7 * 24)
        assert.ok(fixtureAPI.calls.some(call => call.method === "PUT" && call.path === "/dashboards/example-artboard-service-pulse"))
        return { maximumColumns: 24, queryBindingsPreserved: true, etagWriteAndReload: true }
      })
      await check("Existing chart visualization and gauge appearance are authorable without losing saved queries", async () => {
        const board = await open(studies[1])
        const originalSeries = structuredClone(board.widgets.find(widget => widget.id === "node-cpu"))
        const originalGauge = structuredClone(board.widgets.find(widget => widget.id === "cpu-meter"))
        await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
        await tile("node-cpu").getByRole("button", { name: "Edit CPU utilization by node", exact: true }).click()
        await selectGammaOption(page, editor().getByRole("combobox", { name: "Visualization", exact: true }), /^Stacked time series /)
        await editor().getByRole("tab", { name: "Query", exact: true }).click()
        await selectGammaOption(page, editor().getByRole("combobox", { name: "Stack display", exact: true }), "Stacked time bars")
        await editor().getByRole("button", { name: "Apply widget", exact: true }).click()
        await editor().getByRole("button", { name: "Close widget editor", exact: true }).click()
        let authored = await sourceRoundtrip()
        const converted = authored.widgets.find(widget => widget.id === "node-cpu")
        assert.equal(converted.type, "plugin")
        assert.equal(converted.pluginId, "stacked-timeseries")
        assert.equal(converted.config.display, "bar")
        assert.deepEqual(converted.queryRef, originalSeries.queryRef)
        assert.equal(converted.providerId, originalSeries.providerId)
        await ready(converted)
        assert.ok(await tile("node-cpu").locator("rect[data-raw-value]").count() > 20)
        await tile("cpu-meter").getByRole("button", { name: "Edit CPU used", exact: true }).click()
        await editor().getByRole("tab", { name: "Query", exact: true }).click()
        for (const [label, display] of [["Continuous", "linear"], ["Segmented", "segmented"], ["Radial", "radial"]]) {
          await selectGammaOption(page, editor().getByRole("combobox", { name: "Meter appearance", exact: true }), label)
          await until(async () => await tile("cpu-meter").locator(`[data-gauge-display="${display}"]`).count() === 1, `${label} should preview before Apply`)
          assert.deepEqual(fixtureAPI.documents.get(board.id).widgets.find(widget => widget.id === "cpu-meter"), originalGauge, "A preview must not persist before saving")
        }
        await editor().getByRole("button", { name: "Apply widget", exact: true }).click()
        await editor().getByRole("button", { name: "Close widget editor", exact: true }).click()
        authored = await sourceRoundtrip()
        assert.deepEqual(authored.widgets.find(widget => widget.id === "cpu-meter").queryRef, originalGauge.queryRef)
        assert.equal(authored.widgets.find(widget => widget.id === "cpu-meter").config.display, "radial")
        await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
        await page.getByText("All changes saved", { exact: true }).waitFor()
        await page.reload({ waitUntil: "networkidle" })
        await page.getByRole("heading", { name: "Fleet Atlas · Test fixture", exact: true }).waitFor()
        const persisted = fixtureAPI.documents.get(board.id)
        await ready(persisted.widgets.find(widget => widget.id === "node-cpu"))
        await ready(persisted.widgets.find(widget => widget.id === "cpu-meter"))
        assert.equal(persisted.widgets.find(widget => widget.id === "node-cpu").pluginId, "stacked-timeseries")
        assert.equal(persisted.widgets.find(widget => widget.id === "cpu-meter").config.display, "radial")
        await selectGammaOption(page, scopeControl(persisted.variables[0]), "staging")
        await until(async () => await tile("node-cpu").locator("g[data-series]").count() === 4, "Converted chart must still follow its existing shared cluster filter")
        await ready(persisted.widgets.find(widget => widget.id === "cpu-meter"))
        return { existingTimeSeriesConverted: true, stackedBarsRendered: true, gaugePreviewModes: ["linear", "segmented", "radial"], queryBindingsPreserved: true, savedAndReloaded: true, sharedFilterRetained: true }
      })
    }
    assert.deepEqual(fixtureAPI.failures, [], "No test API contract failures")
    await writeFile(join(output, `api-calls-${width}.json`), JSON.stringify(fixtureAPI.calls, null, 2))
    await context.close(); context = undefined
  }
  assert.deepEqual(errors, [], "No browser runtime errors")
  assert.deepEqual(liveRequests, [], "Chart fixtures must never contact external providers")
} catch (error) { process.exitCode = 1; console.error(error.stack) }
finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: !process.exitCode, base, reports, errors, liveRequests, fixtureFailures: fixtureAPI?.failures ?? [] }, null, 2))
  if (fixtureAPI) await writeFile(join(output, "last-api-calls.json"), JSON.stringify(fixtureAPI.calls, null, 2))
  await context?.close(); await browser?.close()
}
