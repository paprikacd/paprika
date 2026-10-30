// Rich chart integration uses test-only HTTP fixtures and the actual application.
// These compositions are not dashboard templates and are never shipped in the public gallery.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"
import { chartFixtures } from "./fixtures/rich-chart-data.ts"

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
  const details = page.getByRole("region", { name: "Observation details", exact: true })
  await details.waitFor()
  const assertOutsideWhenAvailable = async label => {
    await until(async () => await details.getAttribute("data-tooltip-pointer") !== "true", `${label} must use anchored placement`)
    const outside = await details.getAttribute("data-tooltip-overlap") !== "true"
    if (outside) {
      const panel = await details.boundingBox(), card = await element.boundingBox()
      assert.ok(panel.x + panel.width <= card.x + .5 || panel.x >= card.x + card.width - .5 || panel.y + panel.height <= card.y + .5 || panel.y >= card.y + card.height - .5, `${label} must stay outside the widget when space is available`)
    }
    return outside
  }
  await plot.press("ArrowLeft")
  await assertOutsideWhenAvailable("Keyboard inspection")
  await plot.press("Enter")
  await details.getByRole("button", { name: "Unpin observation", exact: true }).waitFor()
  await assertOutsideWhenAvailable("Pinned keyboard inspection")
  await page.mouse.move(1, 1)
  assert.equal(await details.isVisible(), true, "Pinned observation must survive pointer exit")
  await plot.press("Escape")
  await details.waitFor({ state: "hidden" })
  const bounds = await plot.boundingBox()
  await page.mouse.move(bounds.x + bounds.width * .35, bounds.y + bounds.height * .45)
  await details.waitFor()
  assert.equal(await details.evaluate(node => node.parentElement === document.body), true, "Inspector must escape the clipped widget")
  const firstTime = await details.locator("time").getAttribute("datetime")
  await page.mouse.move(bounds.x + bounds.width * .72, bounds.y + bounds.height * .45, { steps: 12 })
  await until(async () => await details.locator("time").getAttribute("datetime") !== firstTime, "Pointer traversal must update the actual inspected observation")
  const observed = { timestamp: await details.locator("time").getAttribute("datetime"), value: await details.locator("[data-metric-value]").getAttribute("data-metric-value") }
  const inspection = await details.boundingBox(), viewport = page.viewportSize()
  const fitsViewport = inspection.x >= 0 && inspection.x + inspection.width <= viewport.width + 1 && inspection.y >= 0 && inspection.y + inspection.height <= viewport.height + 1
  // Capture the failed geometry before throwing; do not wait for it to settle
  // or change the assertion. Dev and static-export CSS/effect timing may differ.
  const geometry = fitsViewport ? undefined : await details.evaluate(node => {
    const describe = element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect()
      return {
        tag: element.tagName, id: element.id, className: element.getAttribute("class"), inline: element.getAttribute("style"),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        offset: { left: element.offsetLeft, top: element.offsetTop, width: element.offsetWidth, height: element.offsetHeight, parent: element.offsetParent?.tagName },
        computed: Object.fromEntries(["position", "left", "top", "right", "bottom", "width", "height", "max-height", "transform", "translate", "scale", "zoom", "transition", "animation", "contain", "filter", "perspective", "will-change"].map(name => [name, style.getPropertyValue(name)])),
      }
    }
    const ancestors = []
    for (let parent = node.parentElement; parent; parent = parent.parentElement) ancestors.push(describe(parent))
    return { panel: describe(node), ancestors, placement: node.getAttribute("data-placement"), innerViewport: { width: innerWidth, height: innerHeight }, scroll: { x: scrollX, y: scrollY }, visualViewport: window.visualViewport && { width: visualViewport.width, height: visualViewport.height, left: visualViewport.offsetLeft, top: visualViewport.offsetTop, scale: visualViewport.scale } }
  })
  const pointerGeometry = fitsViewport ? undefined : { originalPlot: bounds, currentPlot: await plot.boundingBox(), intendedPointer: { x: bounds.x + bounds.width * .72, y: bounds.y + bounds.height * .45 } }
  assert.ok(fitsViewport, `Metric inspection must fit the viewport: ${JSON.stringify({inspection,viewport,observed,geometry,pointerGeometry})}`)
  const pointerPreview = await details.getAttribute("data-tooltip-pointer") === "true"
  const overlapping = await details.getAttribute("data-tooltip-overlap") === "true"
  const coveringNeighbor = await details.getAttribute("data-tooltip-overlaps-other-widget") === "true"
  const coveringControls = await details.getAttribute("data-tooltip-overlaps-controls") === "true"
  if (pointerPreview) {
    const point = { x: bounds.x + bounds.width * .72, y: bounds.y + bounds.height * .45 }
    const clearGap = Math.max(inspection.x - point.x, point.x - inspection.x - inspection.width, inspection.y - point.y, point.y - inspection.y - inspection.height)
    assert.ok(clearGap >= 15.5, "Pointer preview must leave the cursor uncovered with a 16px gap")
    assert.equal(await details.evaluate(node => getComputedStyle(node).pointerEvents), "none", "Pointer previews must not intercept chart interaction")
    assert.equal(await plot.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), point), true, "The chart must receive input at the inspection pointer")
    assert.equal(await details.evaluate(node => {
      const box = node.getBoundingClientRect(), hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
      return !!hit && !node.contains(hit)
    }), true, "Pointer input must pass through the preview surface")
  } else {
    await assertOutsideWhenAvailable("Anchored hover inspection")
  }
  const hoverTransfer = !pointerPreview && !overlapping && !coveringNeighbor && !coveringControls
  if (hoverTransfer) {
    await details.hover()
    await page.waitForTimeout(220)
    assert.equal(await details.isVisible(), true, "Hover transfer to the external inspector must keep it open")
    assert.deepEqual({ timestamp: await details.locator("time").getAttribute("datetime"), value: await details.locator("[data-metric-value]").getAttribute("data-metric-value") }, observed, "Panel transfer must retain the selected sample")
    await details.getByRole("button", { name: "Pin observation", exact: true }).click()
    await details.getByRole("button", { name: "Unpin observation", exact: true }).waitFor()
  } else {
    assert.equal(await details.evaluate(node => getComputedStyle(node).pointerEvents), "none", "A pointer preview or overlapping inspector must not intercept pointer movement")
    if (coveringNeighbor) {
      const passesThrough = await details.evaluate((node, id) => {
        const panel = node.getBoundingClientRect(), owner = document.querySelector(`[data-widget-id="${id}"]`)
        return [...document.querySelectorAll('[data-widget-id]')].filter(other => other !== owner && !other.contains(owner) && !owner?.contains(other)).some(other => {
          const box = other.getBoundingClientRect(), left = Math.max(panel.left, box.left), right = Math.min(panel.right, box.right), top = Math.max(panel.top, box.top), bottom = Math.min(panel.bottom, box.bottom)
          if (right <= left || bottom <= top) return false
          const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2)
          return !!hit && other.contains(hit) && !node.contains(hit)
        })
      }, id)
      assert.equal(passesThrough, true, "The neighboring widget must receive pointer events through the unpinned inspector")
    }
    await plot.click({ position: { x: bounds.width * .72, y: bounds.height * .45 } })
    await details.getByRole("button", { name: "Unpin observation", exact: true }).waitFor()
    assert.notEqual(await details.evaluate(node => getComputedStyle(node).pointerEvents), "none", "Pinned content must be interactive")
  }
  const pinnedOutsideWidget = await assertOutsideWhenAvailable("Pinned pointer inspection")
  if (id === "flow") {
    const theme = await page.locator("[data-insights-theme]").first().getAttribute("data-insights-theme")
    await page.screenshot({ path: join(output, `external-tooltip-${theme}-${viewport.width}.png`), fullPage: false, animations: "disabled" })
  }
  await page.evaluate(() => scrollBy(0, 30))
  await page.waitForTimeout(80)
  const afterScroll = await details.boundingBox()
  assert.ok(afterScroll.x >= 0 && afterScroll.x + afterScroll.width <= viewport.width + 1 && afterScroll.y >= 0 && afterScroll.y + afterScroll.height <= viewport.height + 1, "Pinned inspection must remain in the viewport after scrolling")
  if (id === "flow" && viewport.width >= 1200) {
    const narrow = { width: viewport.width - 180, height: viewport.height }
    await page.setViewportSize(narrow)
    await until(async () => { const box = await details.boundingBox(); return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= narrow.width + 1 && box.y + box.height <= narrow.height + 1 }, "Pinned inspector must reposition after resizing")
    await page.setViewportSize(viewport)
    await until(async () => { const box = await details.boundingBox(); return !!box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1 }, "Pinned inspector must remain in view after restoring size")
  }
  await page.keyboard.press("Escape")
  await details.waitFor({ state: "hidden" })
  return { keyboard: true, pinned: true, pointerTraversal: true, pointerPreview, hoverTransfer, fallbackPassThrough: !hoverTransfer, outsideWidget: pinnedOutsideWidget, scrollPlacement: true }
}
async function inspectScrollableMetric() {
  // Exercise an actual narrow, touch-capable viewport, including coarse pointer styling.
  const previousPage = page, previousFixtureAPI = fixtureAPI
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", timezoneId: "UTC" })
  page = await mobile.newPage(); page.setDefaultTimeout(15000)
  fixtureAPI = await installRichChartFixtureAPI(page, base)
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => { if (!request.url().startsWith(new URL(base).origin) && !request.url().startsWith("data:")) liveRequests.push(request.url()) })
  const board = fixtureAPI.documents.get("example-artboard-edge-watch")
  const widget = board.widgets.find(widget => widget.id === "flow")
  widget.layout.h = 4 // the supported minimum short chart card
  const query = fixtureAPI.savedQueries.get(widget.queryRef.id).query
  const fixture = chartFixtures.find(fixture => fixture.metric === query.slice(0, query.indexOf("{")))
  assert.ok(fixture?.series?.length, "The scroll regression must use a saved-query metric fixture")
  const original = fixture.series, expectedValue = 42.123456789
  const longLabels = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`resource_${index}`, `cluster/omega/namespace/observability/deployment/ingestion-worker-${index}/instance/long-label-regression`]))
  // Enrich only this HTTP fixture for the scroll test; never alter renderer DOM or styles.
  fixture.series = original.map(source => ({ ...source, name: `{namespace="observability", pod="paprika-insights-observability-probe-8f7d6d97d8-12345", container="${source.name}"}`, labels: { ...source.labels, ...longLabels }, base: expectedValue, variation: 0, trend: 0, gaps: undefined }))
  try {
    await open(studies[2])
    const element = await ready(widget), plot = element.locator('svg[role="group"]').first()
    const details = page.getByRole("region", { name: "Observation details", exact: true })
    const reading = details.locator("[data-metric-value]")
    const exactReading = async (state) => {
      assert.equal(Number(await reading.getAttribute("data-metric-value")), expectedValue, `${state}: the exact selected sample must remain unchanged`)
      const bounds = await reading.evaluate(node => {
        const value = node.getBoundingClientRect(), panel = node.closest('[aria-label="Observation details"]').getBoundingClientRect()
        return { value: { top: value.top, bottom: value.bottom, left: value.left, right: value.right }, panel: { top: panel.top, bottom: panel.bottom, left: panel.left, right: panel.right }, scrollTop: node.closest('[aria-label="Observation details"]').scrollTop }
      })
      assert.ok(bounds.value.top >= bounds.panel.top && bounds.value.bottom <= bounds.panel.bottom && bounds.value.left >= bounds.panel.left && bounds.value.right <= bounds.panel.right, `${state}: exact sample must be visible without scrolling: ${JSON.stringify(bounds)}`)
    }
    // Pointer hover must reveal the observed value before any scroll or pin.
    const plotBox = await plot.boundingBox()
    await page.mouse.move(plotBox.x + plotBox.width * .62, plotBox.y + plotBox.height * .45)
    await details.waitFor()
    await exactReading("Hover")
    await page.screenshot({ path: join(output, "long-series-hover-mobile.png"), fullPage: false, animations: "disabled" })
    assert.equal(await details.getAttribute("tabindex"), null, "Transient inspection must not gain a tab stop")
    await plot.focus()
    await plot.press("Enter")
    await details.getByText("Pinned observation", { exact: true }).waitFor()
    await exactReading("Pinned")
    assert.equal(await details.getAttribute("tabindex"), "0", "Pinned inspection must be keyboard focusable")
    await page.keyboard.press("Tab")
    assert.equal(await details.evaluate(node => document.activeElement === node), true, "Tab from the chart must reach its pinned scroll surface")
    const geometry = await details.evaluate(node => ({ client: node.clientHeight, scroll: node.scrollHeight, containment: getComputedStyle(node).overscrollBehaviorY }))
    assert.ok(geometry.scroll > geometry.client + 100, "Long label metadata must force real inspector overflow")
    assert.equal(geometry.containment, "contain")
    await details.getByText(longLabels.resource_11, { exact: true }).waitFor({ state: "attached" })
    await details.getByText(/paprika-insights-observability-probe-8f7d6d97d8-12345/, { exact: false }).first().waitFor({ state: "attached" })
    const documentScroll = () => page.evaluate(() => ({ x: scrollX, y: scrollY }))
    const initialPage = await documentScroll()
    await page.keyboard.press("PageDown")
    await until(async () => await details.evaluate(node => node.scrollTop) > 0, "PageDown must scroll the focused inspector")
    const afterPageDown = await details.evaluate(node => node.scrollTop)
    assert.deepEqual(await documentScroll(), initialPage, "PageDown must not scroll the dashboard")
    await page.keyboard.press("End")
    await until(async () => await details.evaluate(node => node.scrollTop >= node.scrollHeight - node.clientHeight - 1), "End must reach the inspector's final metadata")
    const bottom = await details.evaluate(node => node.scrollTop)
    await details.hover()
    const beforeWheel = await documentScroll()
    const pageRoom = await page.evaluate(() => ({ above: scrollY, below: document.documentElement.scrollHeight - innerHeight - scrollY }))
    assert.ok(pageRoom.above > 100 && pageRoom.below > 100, "The dashboard must have room to scroll so containment is tested at both boundaries")
    await page.mouse.wheel(0, 700)
    await page.waitForTimeout(200)
    assert.deepEqual(await documentScroll(), beforeWheel, "Wheel at the inspector's bottom must not propagate to the dashboard")
    assert.ok(await details.evaluate(node => node.scrollTop >= node.scrollHeight - node.clientHeight - 1))
    await page.keyboard.press("Home")
    await until(async () => await details.evaluate(node => node.scrollTop <= 1), "Home must return to the selected sample")
    await page.mouse.wheel(0, -700)
    await page.waitForTimeout(200)
    assert.deepEqual(await documentScroll(), beforeWheel, "Wheel at the inspector's top must not propagate to the dashboard")
    await exactReading("Home")
    await page.screenshot({ path: join(output, "pinned-inspector-mobile-keyboard-scroll.png"), fullPage: false, animations: "disabled" })
    await page.keyboard.press("Escape")
    await details.waitFor({ state: "hidden" })
    assert.equal(await plot.evaluate(node => document.activeElement === node), true, "Escape must return focus to the chart without reopening its inspector")
    assert.deepEqual(fixtureAPI.failures, [], "No mobile fixture contract failures")
    return { mobileWidth: 390, coarsePointer: true, savedQuery: widget.queryRef.id, exactValue: expectedValue, labelCount: Object.keys(longLabels).length, initialHoverVisible: true, initiallyPinnedVisible: true, tabFocus: true, afterPageDown, bottom, wheelContainedBothBoundaries: true, escapeClosed: true, focusRestored: true }
  } finally { fixture.series = original; await mobile.close(); page = previousPage; fixtureAPI = previousFixtureAPI }
}
async function inspectCompactProviderLabels() {
  const board = fixtureAPI.documents.get("example-artboard-fleet-atlas")
  const gaugeIndex = board.widgets.findIndex(widget => widget.id === "cpu-meter")
  const gauge = board.widgets[gaugeIndex], plot = board.widgets.find(widget => widget.id === "node-cpu")
  const originalGauge = structuredClone(gauge), originalVariables = structuredClone(board.variables)
  const query = fixtureAPI.savedQueries.get(plot.queryRef.id).query
  const metric = query.slice(0, query.indexOf("{")), fixture = chartFixtures.find(fixture => fixture.metric === metric)
  assert.ok(fixture?.series?.length, "The provider label check requires the saved node query")
  const originalSeries = fixture.series
  const canonical = labels => metric + "{" + Object.entries(labels).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(", ") + "}"
  fixture.series = originalSeries.map(source => {
    const labels = { ...source.labels, pod: `paprika-observability-collector-deployment-87f6b76b67-${source.labels.cluster}-${source.labels.node}` }
    return { ...source, labels, name: canonical(labels) }
  })
  Object.assign(gauge, {
    providerId: plot.providerId, query: plot.query, queryRef: structuredClone(plot.queryRef),
    config: { display: "segmented", seriesMode: "all", columns: 1, maxSeries: 7, segments: 16, showThresholds: false },
    drilldowns: [{ id: "inspect-node", title: "Inspect selected signal", dashboardId: board.id, bindings: [
      { variable: "selected_node", source: "label", value: "node" },
      { variable: "selected_pod", source: "label", value: "pod" },
      { variable: "selected_series", source: "series" },
      { variable: "selected_value", source: "value" },
    ] }],
  })
  board.variables.push(...["selected_node", "selected_pod", "selected_series", "selected_value"].map(name => ({ name, label: name })))
  try {
    await open(studies[1])
    const chart = await ready(plot), legend = chart.getByRole("list", { name: "Latest values by series" })
    const legendRows = legend.getByRole("listitem")
    await until(async () => await legendRows.count() === 7, "All seven saved-query time series must appear in the legend")
    const firstOmega = fixture.series.find(source => source.labels.cluster === "omega" && source.labels.node === "node-01")
    assert.equal(await legendRows.first().getAttribute("title"), firstOmega.name, "Legend title must preserve the raw source name")
    await legendRows.first().locator('[aria-hidden="true"]').filter({ hasText: "node-01" }).waitFor()
    const element = tile(gauge.id), bank = element.getByRole("region", { name: `${gauge.title} gauges`, exact: true })
    await element.scrollIntoViewIfNeeded()
    await until(async () => await bank.locator("[data-gauge-series]").count() === 7, "The gauge must render all seven scoped series")
    assert.deepEqual(await element.getByRole("alert").allTextContents(), [])
    const assertRows = async (cluster, count) => {
      const sources = fixture.series.filter(source => source.labels.cluster === cluster)
      const rows = bank.locator("[data-gauge-series]")
      await until(async () => await rows.count() === count, `Expected ${count} ${cluster} gauge rows`)
      for (let index = 0; index < count; index++) {
        const row = rows.nth(index), source = sources[index], label = row.locator("[data-gauge-label]")
        assert.equal(await row.getAttribute("data-gauge-series"), source.name, "The plotted series identity must remain unchanged")
        assert.equal(await label.getAttribute("title"), source.name, "The full source identity must remain on the label")
        const visible = label.locator('[aria-hidden="true"]')
        assert.equal(await visible.innerText(), source.labels.node, "The visible identifier must distinguish the real node")
        const bounds = await visible.evaluate(node => {
          const text = document.createRange(); text.selectNodeContents(node)
          const glyph = text.getBoundingClientRect(), container = node.parentElement.getBoundingClientRect()
          return { left: glyph.left, right: glyph.right, containerLeft: container.left, containerRight: container.right }
        })
        assert.ok(bounds.left >= bounds.containerLeft - .05 && bounds.right <= bounds.containerRight + .05, `Node label must fit at 390px: ${JSON.stringify(bounds)}`)
        const button = row.getByRole("button")
        assert.ok((await button.getAttribute("aria-label")).includes(source.name), "Accessible selection name must preserve full source identity")
      }
      return rows
    }
    await assertRows("omega", 7)
    await selectGammaOption(page, scopeControl(board.variables[0]), "staging")
    await element.scrollIntoViewIfNeeded()
    const rows = await assertRows("staging", 4)
    assert.ok(fixtureAPI.calls.some(call => call.path === "/query" && call.document?.query === `${metric}{cluster="staging"}`), "The shared filter must resolve into the saved provider query")
    const source = fixture.series.find(source => source.labels.cluster === "staging" && source.labels.node === "node-01"), first = rows.first()
    const rawValue = await first.locator("[data-gauge-value]").getAttribute("data-gauge-value")
    assert.ok(Number.isFinite(Number(rawValue)), "The selected observation must be finite")
    await first.getByRole("button").click()
    await element.getByRole("status").filter({ hasText: `Selected: ${source.name}` }).waitFor()
    const details = page.getByRole("tooltip")
    await details.getByText(source.name, { exact: true }).waitFor()
    await details.getByText(source.labels.node, { exact: true }).waitFor()
    await details.getByText(source.labels.pod, { exact: true }).waitFor()
    assert.equal(await details.locator("[data-metric-value]").getAttribute("data-metric-value"), rawValue)
    await page.screenshot({ path: join(output, "compact-provider-labels-mobile.png"), fullPage: false, animations: "disabled" })
    await page.keyboard.press("Escape")
    await element.getByRole("button", { name: `Open related dashboard from ${gauge.title}`, exact: true }).click()
    await page.getByRole("menuitem", { name: "Inspect selected signal", exact: false }).click()
    await until(() => {
      const params = new URL(page.url()).searchParams, values = JSON.parse(params.get("vars") ?? "{}")
      return values.selected_node === source.labels.node && values.selected_pod === source.labels.pod && values.selected_series === source.name && values.selected_value === rawValue
    }, "Drilldown must carry the complete original labels, series and exact value")
    return { width: 390, before: 7, after: 4, shortLabel: source.labels.node, fullIdentityRetained: true, exactSelectionContextRetained: true, sharedFilter: "staging", standardLegend: true }
  } finally {
    fixture.series = originalSeries
    board.widgets[gaugeIndex] = originalGauge
    board.variables = originalVariables
  }
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
    if (width === 390) {
      await check("Pinned mobile metric inspector supports native keyboard scrolling and contains wheel gestures", inspectScrollableMetric)
      await check("Provider series stay distinguishable and retain exact context through a mobile filter and drilldown", inspectCompactProviderLabels)
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
