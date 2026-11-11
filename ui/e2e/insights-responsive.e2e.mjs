import { applyWidgetChanges } from "./gamma-controls.mjs";
// Run from ui/ against a fresh production export or development server:
// INSIGHTS_E2E_URL=http://127.0.0.1:3015 node e2e/insights-responsive.e2e.mjs
// Responsive and interaction tests use fresh browser contexts. The tooltip
// fixture supplies deterministic normalized API data; live adapters are covered
// separately by insights-live.e2e.mjs.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { routeAnonymousAuthConfiguration } from "./anonymous-auth-fixture.mjs"
import { installChartSystemFixture } from "./fixtures/chart-system.mjs"

const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights")
const reports = [], pageErrors = []
const widths = [1512, 1280, 1100, 1024, 900, 768, 640, 600, 390, 320, 768, 1512]
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, reducedMotion: "reduce", timezoneId: "UTC" })
const page = await context.newPage()
let activePage = page
function observe(target) {
  target.on("pageerror", (error) => pageErrors.push(error.message))
  target.on("dialog", dialog => { pageErrors.push(`Unexpected native dialog: ${dialog.message()}`); void dialog.dismiss() })
  target.setDefaultTimeout(15_000)
}
observe(page)

async function check(name, action) {
  const started = Date.now()
  try {
    const evidence = await action()
    reports.push({ name, passed: true, milliseconds: Date.now() - started, evidence })
    console.log(`PASS ${name}`)
  } catch (error) {
    reports.push({ name, passed: false, error: error.message })
    await activePage.screenshot({ path: resolve(output, "responsive-failure.png"), fullPage: true }).catch(() => {})
    throw error
  }
}
async function settle(target = page) {
  await target.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))))
}
async function stableGeometry(target = page) {
  // ResizeObserver, React Grid Layout and chart scales each publish geometry.
  // Wait for consecutive unchanged animation frames, not a fixed time delay.
  await target.evaluate(() => new Promise((resolve, reject) => {
    let previous = "", unchanged = 0
    const deadline = performance.now() + 5000
    function sample() {
      const boxes = [...document.querySelectorAll('[data-widget-id], [data-widget-id] svg[role="img"], [aria-label="Widget editor"]')]
        .map((element) => { const r = element.getBoundingClientRect(); return [r.x, r.y, r.width, r.height] })
      const next = JSON.stringify([document.documentElement.scrollWidth, boxes])
      unchanged = next === previous ? unchanged + 1 : 0
      previous = next
      if (unchanged >= 4) resolve(null)
      else if (performance.now() > deadline) reject(new Error("Dashboard geometry did not settle"))
      else requestAnimationFrame(sample)
    }
    requestAnimationFrame(sample)
  }))
}
async function document() {
  await page.getByRole("button", { name: "Code", exact: true }).click()
  const source = page.getByRole("region", { name: "Dashboard source editor" })
  await source.getByRole("button", { name: "JSON", exact: true }).click()
  const value = JSON.parse(await source.getByRole("textbox", { name: "Dashboard source" }).inputValue())
  await source.getByRole("button", { name: "Close source editor" }).click()
  await settle()
  return value
}
async function editing() {
  const button = page.getByRole("button", { name: "Edit dashboard", exact: true })
  if (await button.isVisible()) await button.click()
}
const editor = () => page.getByRole("region", { name: "Widget editor" })
const heatmap = () => page.getByRole("group", { name: "Service health heatmap", exact: true })
const unavailable = () => heatmap().getByRole("button", { name: /worker-west: 0.*Unavailable/ })
async function heatmapStyle() {
  await editing()
  await page.getByRole("button", { name: "Edit Service health", exact: true }).click()
  await editor().getByRole("tab", { name: "Style", exact: true }).click()
}
async function applyWidget() {
  await editor().getByRole("button", { name: "Apply changes", exact: true }).click()
  await settle()
}
async function save() {
  await applyWidgetChanges(page);
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
  await page.getByText("All changes saved", { exact: true }).waitFor()
}
async function geometry(width, withEditor, original) {
  await page.setViewportSize({ width, height: width < 600 ? 844 : 1050 })
  await settle()
  await page.waitForFunction(() => {
    const canvas = document.querySelector('[data-testid="dashboard-canvas"]')
    if (!canvas) return false
    const width = canvas.getBoundingClientRect().width
    // The mode on screen is the previous one: the wide grid holds down to 880px once shown, and returns at 960px.
    const previous = canvas.getAttribute("data-layout-mode")
    const expected = width >= (previous === "wide" ? 880 : 960) ? "wide" : width >= 600 ? "compact" : "stacked"
    return previous === expected
  })
  await stableGeometry()
  const result = await page.evaluate(() => {
    const rect = (el) => { const box = el.getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height } }
    const canvas = document.querySelector('[data-testid="dashboard-canvas"]')
    const panel = document.querySelector('[aria-label="Widget editor"]')
    return {
      viewport: innerWidth,
      overflow: document.documentElement.scrollWidth - innerWidth,
      mode: canvas.getAttribute("data-layout-mode"),
      canvas: rect(canvas),
      panel: panel ? { ...rect(panel), overflow: panel.scrollWidth - panel.clientWidth } : null,
      topbar: {
        breadcrumb: rect(document.querySelector('[aria-label="Toggle sidebar"]').parentElement),
        actions: rect(document.querySelector('[aria-label="Copy dashboard link"]').parentElement),
      },
      heatmap: (() => {
        const group = document.querySelector('[role="group"][aria-label="Service health heatmap"]')
        return group ? { ...rect(group), scrollHeight: group.scrollHeight, clientHeight: group.clientHeight,
          container: rect(group.parentElement),
          cells: [...group.querySelectorAll("button")].map((cell) => ({ ...rect(cell), text: [...cell.querySelectorAll("span,strong")].map(rect) })) } : null
      })(),
      overflowElements: [...document.querySelectorAll("body *")].map((el) => ({ tag: el.tagName, className: el.getAttribute("class"), ...rect(el) }))
        .filter((el) => el.x + el.width > innerWidth + 1).sort((a, b) => b.x + b.width - a.x - a.width).slice(0, 5),
      widgets: [...document.querySelectorAll("[data-widget-id]")].map((el) => ({
        id: el.dataset.widgetId, ...rect(el),
        charts: [...el.querySelectorAll('svg[role="img"]')].map(rect),
        titleSize: parseFloat(getComputedStyle(el.querySelector("h2,h3,h4") || el).fontSize),
      })),
    }
  })
  const where = `${width}px ${withEditor ? "with editor" : "view mode"}`
  assert.ok(result.overflow <= 1, `${where}: page overflowed by ${result.overflow}px; ${JSON.stringify(result.overflowElements)}`)
  assert.ok(result.topbar.breadcrumb.x + result.topbar.breadcrumb.width <= result.topbar.actions.x + 1, `${where}: breadcrumb overlaps dashboard actions`)
  assert.equal(result.widgets.length, withEditor ? 1 : original.widgets.length, `${where}: focus shows only the selected chart; the dashboard shows every widget`)
  for (const widget of result.widgets) {
    const definition = original.widgets.find((item) => item.id === widget.id)
    const minimum = definition.type === "stat" ? 180 : 240
    assert.ok(widget.width >= minimum, `${where}: ${widget.id} is only ${widget.width}px wide`)
    assert.ok(widget.height >= (definition.type === "stat" ? 94 : 120), `${where}: ${widget.id} is too short`)
    assert.ok(widget.titleSize >= 10, `${where}: ${widget.id} title is too small`)
    assert.ok(widget.x >= -1 && widget.x + widget.width <= width + 1, `${where}: ${widget.id} escaped viewport`)
    if (!withEditor && (result.mode === "stacked" || (result.mode === "compact" && definition.type !== "stat"))) {
      assert.ok(widget.width >= result.canvas.width - 1, `${where}: ${widget.id} must use the available canvas width`)
    }
    for (const chart of widget.charts) {
      assert.ok(chart.width > 50 && chart.height > 20, `${where}: ${widget.id} chart collapsed`)
      assert.ok(chart.x >= widget.x - 1 && chart.x + chart.width <= widget.x + widget.width + 1, `${where}: ${widget.id} chart overflowed its tile`)
    }
  }
  for (let i = 0; i < result.widgets.length; i++) for (let j = i + 1; j < result.widgets.length; j++) {
    const a = result.widgets[i], b = result.widgets[j]
    const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
    const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
    assert.ok(overlapX <= 1 || overlapY <= 1, `${where}: ${a.id} overlaps ${b.id}`)
  }
  assert.ok(result.heatmap, `${where}: default heatmap must render`)
  assert.equal(result.heatmap.cells.length, 6, `${where}: all six health cells must be present`)
  assert.ok(result.heatmap.scrollHeight <= result.heatmap.clientHeight + 1, `${where}: default heatmap must fit all six cells without internal vertical scrolling (${result.heatmap.scrollHeight}px content / ${result.heatmap.clientHeight}px visible)`)
  assert.ok(result.heatmap.y + result.heatmap.height <= result.heatmap.container.y + result.heatmap.container.height + 1, `${where}: heatmap exceeds its visible container`)
  for (const cell of result.heatmap.cells) for (const text of cell.text) {
    assert.ok(text.y >= result.heatmap.y - 1 && text.y + text.height <= result.heatmap.y + result.heatmap.height + 1, `${where}: heatmap cell label or value is vertically clipped`)
  }
  if (withEditor) {
    assert.ok(result.panel && result.panel.width >= 280, `${where}: editor must stay usable`)
    assert.ok(result.panel.x >= -1 && result.panel.x + result.panel.width <= width + 1 && result.panel.overflow <= 1, `${where}: editor overflowed`)
    await editor().getByRole("button", { name: "Apply changes", exact: true }).scrollIntoViewIfNeeded()
    await editor().getByRole("button", { name: "Apply changes" }).scrollIntoViewIfNeeded()
    if (result.mode !== "wide") {
      assert.equal(await page.locator(".insights-drag-handle:visible").count(), 0, `${where}: adaptive view must not offer desktop-layout dragging`)
      assert.equal(await page.locator(".react-resizable-handle:visible").count(), 0, `${where}: adaptive view must not offer desktop-layout resizing`)
    }
  }
  return { width, mode: result.mode, canvasWidth: result.canvas.width, minimumTileWidth: Math.min(...result.widgets.map((item) => item.width)), editorWidth: result.panel?.width,
    tiles: result.widgets.map((widget) => ({ id: widget.id, x: Math.round((widget.x - result.canvas.x) * 100) / 100, y: Math.round((widget.y - result.canvas.y) * 100) / 100, width: widget.width, height: widget.height })) }
}

const timestamp = Date.parse("2026-10-20T12:34:56.789Z")
const detailedName = "worker-west-production-eu-central-1a-observability"
const detailedLabels = Object.fromEntries([
  ["service", detailedName], ["job", "paprika"], ["cluster", "production-eu-central-1"],
  ["namespace", "observability"], ["region", "eu-central-1"], ["zone", "eu-central-1a"],
  ["instance", "worker-west-23.internal:9090"], ["team", "platform-engineering"],
  ["version", "2026.10.20+build.123456789"], ["deployment", "production/critical-workers"],
  ["owner", "observability-on-call"], ["description", "A complete label value that must wrap without being shortened or clipped in a narrow viewport"],
])
const tooltipDashboard = {
  schemaVersion: 1, id: "tooltip-fixture", title: "Detailed service diagnostics", timeRange: "1h", refreshInterval: 0,
  widgets: [{ id: "details", title: "Detailed health", type: "heatmap", providerId: "fixture-metrics", query: "up", unit: "req/s",
    options: { decimals: 2, showLabels: false, showValues: false, thresholds: [{ value: 0, color: "#c0644f", label: "Unavailable" }, { value: 1, color: "#648b76", label: "Healthy" }] },
    layout: { x: 0, y: 0, w: 12, h: 4 } }],
}
async function diagnosticPage(options) {
  const diagnosticContext = await browser.newContext({ reducedMotion: "reduce", timezoneId: "UTC", ...options })
  const target = await diagnosticContext.newPage()
  activePage = target
  observe(target)
  await routeAnonymousAuthConfiguration(target)
  await target.route("**/api/insights/**", async (route) => {
    const url = new URL(route.request().url())
    let body
    if (url.pathname === "/api/insights/providers") body = { providers: [{ id: "fixture-metrics", name: "Diagnostic metrics", type: "prometheus", capabilities: ["metrics"] }] }
    else if (url.pathname === "/api/insights/dashboards") body = { dashboards: [tooltipDashboard] }
    else if (url.pathname === "/api/insights/saved-queries") body = { queries: [] }
    else if (url.pathname === `/api/insights/dashboards/${tooltipDashboard.id}`) body = tooltipDashboard
    else if (url.pathname === "/api/insights/query") {
      assert.equal(route.request().postDataJSON().providerId, "fixture-metrics")
      body = { series: [{ name: detailedName, labels: detailedLabels, points: [{ timestamp, value: 0.123456789 }] }] }
    } else throw new Error(`Unexpected diagnostic API request: ${url.pathname}`)
    await route.fulfill({ status: 200, contentType: "application/json", headers: { ETag: '"tooltip-fixture"' }, body: JSON.stringify(body) })
  })
  await target.goto(`${baseURL}/dashboard/insights/`, { waitUntil: "networkidle" })
  await target.getByRole("heading", { name: tooltipDashboard.title, exact: true }).waitFor()
  await target.getByRole("group", { name: "Detailed health heatmap", exact: true }).waitFor()
  return { target, diagnosticContext, cell: target.getByRole("group", { name: "Detailed health heatmap", exact: true }).getByRole("button") }
}
async function completeTooltip(target, cell) {
  const tip = target.getByRole("tooltip")
  await tip.waitFor()
  await settle(target)
  const id = await tip.getAttribute("id")
  assert.equal(await cell.getAttribute("aria-describedby"), id, "Cell must reference its accessible tooltip")
  assert.ok((await tip.textContent()).includes(detailedName), "Full series name must remain readable")
  const actualLabels = await tip.locator("dl > div").evaluateAll((rows) => Object.fromEntries(rows.map((row) => [row.querySelector("dt").textContent.trim().replace(/:$/, ""), row.querySelector("dd").textContent])))
  assert.deepEqual(actualLabels, detailedLabels, "Tooltip must preserve every label key and full value")
  assert.equal(await tip.locator("[data-metric-value]").getAttribute("data-metric-value"), "0.123456789", "Tooltip must preserve the exact underlying value")
  assert.equal(await tip.locator("time").getAttribute("datetime"), new Date(timestamp).toISOString())
  assert.match(await tip.innerText(), /Unavailable/)
  assert.match(await tip.innerText(), /req\/s/)
  const bounds = await tip.evaluate((el) => {
    const box = el.getBoundingClientRect()
    // Transient inspectors intentionally allow pointer events through. Enable
    // hit testing briefly to measure visual occlusion, then restore behavior.
    const pointerEvents = el.style.pointerEvents
    el.style.pointerEvents = "auto"
    const atCenter = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    el.style.pointerEvents = pointerEvents
    return { x: box.x, y: box.y, width: box.width, height: box.height, viewportWidth: innerWidth, viewportHeight: innerHeight,
      clipped: !el.contains(atCenter), insideTile: !!el.closest("[data-widget-id]"), horizontalOverflow: el.scrollWidth - el.clientWidth,
      verticalOverflow: el.scrollHeight - el.clientHeight, overflowY: getComputedStyle(el).overflowY }
  })
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= bounds.viewportWidth + 1 && bounds.y + bounds.height <= bounds.viewportHeight + 1, `Tooltip escaped viewport: ${JSON.stringify(bounds)}`)
  assert.equal(bounds.clipped, false, "Tooltip must not be obscured or clipped by a tile")
  assert.equal(bounds.insideTile, false, "Tooltip must render outside overflow-clipping tile ancestors")
  assert.ok(bounds.horizontalOverflow <= 1, "Long label values must wrap inside the tooltip")
  if (bounds.verticalOverflow > 1) assert.ok(["auto", "scroll"].includes(bounds.overflowY), "Long tooltip details must be scrollable, never hidden")
  return bounds
}

try {
  await page.goto(`${baseURL}/dashboard/insights/?example=1`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: "Service overview", exact: true }).waitFor()
  const original = await document()
  await editing()
  await save()
  const storage = await page.evaluate(() => localStorage.getItem("paprika-insights-example-v1"))
  await check("one dashboard resizes through desktop, tablet, and mobile without overlap or layout mutation", async () => {
    const measurements = []
    for (const width of widths) {
      measurements.push(await geometry(width, false, original))
      if (width === 768) await page.screenshot({ path: resolve(output, "dashboard-responsive-tablet.png"), fullPage: true })
      if (width === 390) await page.screenshot({ path: resolve(output, "dashboard-responsive-mobile-text.png"), fullPage: true })
    }
    assert.deepEqual((await document()).widgets.map(({ id, layout }) => ({ id, layout })), original.widgets.map(({ id, layout }) => ({ id, layout })))
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika-insights-example-v1")), storage)
    assert.ok(new Set(measurements.map((item) => item.mode)).size === 3, "All three responsive modes must be exercised")
    assert.deepEqual(measurements.at(-1).tiles, measurements[0].tiles, "Growing back to desktop must restore the original visual arrangement")
    return measurements
  })
  await check("open editor remains reachable during resize and preserves desktop layouts", async () => {
    await heatmapStyle()
    const measurements = []
    for (const width of widths) measurements.push(await geometry(width, true, original))
    await editor().getByRole("button", { name: "Apply changes" }).click()
    assert.deepEqual((await document()).widgets.map(({ id, layout }) => ({ id, layout })), original.widgets.map(({ id, layout }) => ({ id, layout })))
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika-insights-example-v1")), storage)
    assert.deepEqual(measurements.at(-1).tiles, measurements[0].tiles, "Editor resize roundtrip must restore its original visual arrangement")
    return measurements
  })
  await check("heatmap labels and values toggle independently while accessible names remain complete", async () => {
    await heatmapStyle()
    assert.equal(await editor().getByRole("switch", { name: "Show labels", exact: true }).isChecked(), true)
    assert.equal(await editor().getByRole("switch", { name: "Show values", exact: true }).isChecked(), true)
    await editor().getByRole("switch", { name: "Show labels", exact: true }).uncheck()
    await applyWidget()
    assert.equal((await unavailable().innerText()).trim(), "0")
    await heatmapStyle()
    await editor().getByRole("switch", { name: "Show labels", exact: true }).check()
    await editor().getByRole("switch", { name: "Show values", exact: true }).uncheck()
    await applyWidget()
    assert.equal((await unavailable().innerText()).trim(), "worker-west")
    await heatmapStyle()
    await editor().getByRole("switch", { name: "Show labels", exact: true }).uncheck()
    await applyWidget()
    assert.equal((await unavailable().innerText()).trim(), "")
    assert.match(await unavailable().getAttribute("aria-label"), /worker-west: 0.*Unavailable/)
    await save()
    await page.reload({ waitUntil: "networkidle" })
    const saved = (await document()).widgets.find((widget) => widget.id === "health")
    assert.equal(saved.options.showLabels, false)
    assert.equal(saved.options.showValues, false)
    assert.equal((await unavailable().innerText()).trim(), "")
    return { combinations: ["values only", "labels only", "neither"], survivesReload: true }
  })
  await check("export and import retain hidden heatmap text options", async () => {
    await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
    const manager = page.getByRole("region", { name: "Manage dashboards", exact: true })
    const downloading = page.waitForEvent("download")
    await manager.getByRole("button", { name: "JSON", exact: true }).click()
    const download = await downloading
    const library = JSON.parse(await readFile(await download.path(), "utf8"))
    const exported = library.dashboards.find((item) => item.id === original.id)
    assert.equal(exported.widgets.find((widget) => widget.id === "health").options.showLabels, false)
    assert.equal(exported.widgets.find((widget) => widget.id === "health").options.showValues, false)
    const imported = { ...exported, title: "Imported hidden heatmap" }
    await selectGammaOption(page, manager.getByRole("combobox", { name: "Library import format" }), "JSON")
    await manager.getByRole("textbox", { name: "Library import source" }).fill(JSON.stringify(imported))
    await manager.getByRole("button", { name: "Review import", exact: true }).click()
    await manager.getByRole("button", { name: "Import 1 as new", exact: true }).click()
    await manager.getByRole("status").getByText(/^1 dashboard decisions? completed\./).waitFor()
    await page.getByRole("navigation", { name: "Dashboard library" }).getByRole("button", { name: imported.title, exact: true }).click()
    const restored = await document()
    assert.notEqual(restored.id, original.id)
    assert.deepEqual(restored.widgets, exported.widgets)
    assert.equal((await unavailable().innerText()).trim(), "")
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('[data-testid="dashboard-canvas"][data-layout-mode="stacked"]').waitFor()
    await stableGeometry()
    await unavailable().scrollIntoViewIfNeeded()
    await page.screenshot({ path: resolve(output, "dashboard-responsive-mobile.png"), fullPage: true })
    return { importedAsNew: true, flagsPreserved: true }
  })
  await check("short touch viewports can scroll navigation and use custom dates without overflow", async () => {
    const landscape = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", timezoneId: "UTC" })
    const target = await landscape.newPage()
    observe(target)
    activePage = target
    await target.goto(`${baseURL}/dashboard/insights/?example=1`, { waitUntil: "networkidle" })
    await target.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    const navigation = target.getByRole("dialog", { name: "Insights navigation", exact: true })
    const lastAction = navigation.getByRole("button", { name: "Dashboard as code", exact: true })
    await lastAction.scrollIntoViewIfNeeded()
    assert.ok(await navigation.evaluate((el) => el.scrollTop > 0), "Short navigation must scroll to its lower actions")
    const actionBounds = await lastAction.boundingBox()
    assert.ok(actionBounds.y >= 0 && actionBounds.y + actionBounds.height <= 390, "Last navigation action must be visible and reachable")
    await target.screenshot({ path: resolve(output, "dashboard-responsive-landscape-navigation.png"), fullPage: true })
    await lastAction.click()
    await navigation.waitFor({ state: "hidden" })
    await target.getByRole("button", { name: "Close source editor", exact: true }).click()
    await target.getByRole("button", { name: "Choose custom time range", exact: true }).click()
    const range = target.getByRole("region", { name: "Custom time range", exact: true })
    const bounds = await range.boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 844, "Date popup must stay within the short viewport width")
    await target.getByLabel("Range start", { exact: true }).fill("2026-10-20T10:00")
    await target.getByLabel("Range end", { exact: true }).fill("2026-10-20T12:00")
    await range.getByRole("button", { name: "Apply time range", exact: true }).click()
    assert.equal(await target.getByRole("combobox", { name: "Time range", exact: true }).innerText(), "Custom range…")
    assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
    await landscape.close()
    activePage = page
    return { width: 844, height: 390, lowerNavigationActionReachable: true, customDatesApplied: true }
  })
  await check("editing a lower widget on mobile brings a focused editor into view", async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await editing()
    await page.getByRole("button", { name: "Edit Service health", exact: true }).scrollIntoViewIfNeeded()
    await page.getByRole("button", { name: "Edit Service health", exact: true }).click()
    await page.waitForFunction(() => !!document.activeElement?.closest('[aria-label="Widget editor"]'))
    const focus = await page.evaluate(() => {
      const panel = document.querySelector('[aria-label="Widget editor"]').getBoundingClientRect()
      const field = document.activeElement.getBoundingClientRect()
      return { panelTop: panel.top, panelLeft: panel.left, panelWidth: panel.width, focusTop: field.top, focusBottom: field.bottom, viewportHeight: innerHeight, viewportWidth: innerWidth }
    })
    assert.ok(focus.panelTop >= -1 && focus.panelTop < focus.viewportHeight - 50, "Mobile editor must scroll into view after editing a lower widget")
    assert.ok(focus.panelLeft >= -1 && focus.panelLeft + focus.panelWidth <= focus.viewportWidth + 1)
    assert.ok(focus.focusTop >= 0 && focus.focusBottom <= focus.viewportHeight, "Focused editor field must be visible")
    // Capture the real viewport: Chromium full-page capture can paint off-screen
    // transformed grid items as narrow strips even when their geometry is valid.
    await page.screenshot({ path: resolve(output, "dashboard-responsive-mobile-editor.png"), fullPage: false })
    await page.locator('[data-widget-id="health"]').scrollIntoViewIfNeeded()
    await stableGeometry()
    assert.ok(await page.locator('[data-testid="dashboard-canvas"]').evaluate((canvas) => {
      const width = canvas.getBoundingClientRect().width
      return [...canvas.querySelectorAll(".react-grid-item")].every(tile => Math.abs(tile.getBoundingClientRect().width - width) <= 1)
    }), "Mobile widgets must retain their full canvas width while the editor is open")
    await page.mouse.move(2, 422)
    await page.getByRole("tooltip").waitFor({ state: "hidden" })
    await page.screenshot({ path: resolve(output, "dashboard-responsive-mobile-editor-canvas.png"), fullPage: false })
    await editor().getByRole("button", { name: "Apply changes" }).click()
    await page.setViewportSize({ width: 1512, height: 1050 })
    return focus
  })
  await check("heatmap tooltip exposes full data with pointer and keyboard and stays inside the viewport", async () => {
    const { target, diagnosticContext, cell } = await diagnosticPage({ viewport: { width: 1280, height: 900 } })
    activePage = target
    const measurements = []
    await cell.hover()
    measurements.push(await completeTooltip(target, cell))
    await cell.click()
    assert.equal(await cell.getAttribute("aria-pressed"), "true")
    await target.mouse.move(5, 5)
    await target.getByRole("tooltip").waitFor()
    await target.keyboard.press("Escape")
    await target.getByRole("tooltip").waitFor({ state: "hidden" })
    await cell.focus()
    // Escape must remain dismissed until the cell is focused again.
    if (await target.getByRole("tooltip").count() === 0) {
      await target.getByRole("heading", { name: tooltipDashboard.title, exact: true }).click()
      await cell.focus()
    }
    measurements.push(await completeTooltip(target, cell))
    await cell.press("End")
    await settle(target)
    assert.ok(await target.getByRole("tooltip").evaluate((el) => el.scrollTop > 0), "Keyboard users must be able to scroll long tooltip details")
    await cell.press("Home")
    await settle(target)
    assert.equal(await target.getByRole("tooltip").evaluate((el) => el.scrollTop), 0)
    await cell.press("Escape")
    await target.getByRole("tooltip").waitFor({ state: "hidden" })
    for (const width of [768, 390, 320]) {
      await target.setViewportSize({ width, height: 600 })
      await cell.evaluate((el) => el.scrollIntoView({ block: "end" }))
      await target.mouse.move(1, 1)
      await cell.hover()
      measurements.push(await completeTooltip(target, cell))
      if (width === 320) await target.screenshot({ path: resolve(output, "heatmap-responsive-tooltip.png"), fullPage: true })
      await target.keyboard.press("Escape")
      await target.getByRole("tooltip").waitFor({ state: "hidden" })
    }
    await diagnosticContext.close()
    activePage = page
    return { labelCount: Object.keys(detailedLabels).length, exactValue: 0.123456789, measurements }
  })
  await check("touch users can pin, inspect, and dismiss heatmap details without hover", async () => {
    const { target, diagnosticContext, cell } = await diagnosticPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    activePage = target
    await cell.tap()
    assert.equal(await cell.getAttribute("aria-pressed"), "true")
    await completeTooltip(target, cell)
    // The top-left corner contains the mobile navigation toggle. Use the page
    // gutter so dismissal does not also open a dialog over the next target.
    const outside = { x: 2, y: Math.floor(target.viewportSize().height / 2) }
    assert.ok(await target.evaluate(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      return hit && !hit.closest('[role="tooltip"], button, input, a, [role="button"]')
    }, outside), "Outside tap must hit a noninteractive area beyond the tooltip")
    await target.touchscreen.tap(outside.x, outside.y)
    await target.getByRole("tooltip").waitFor({ state: "hidden" })
    assert.equal(await cell.getAttribute("aria-pressed"), "false")
    await cell.tap()
    await completeTooltip(target, cell)
    await cell.tap()
    await target.getByRole("tooltip").waitFor({ state: "hidden" })
    await diagnosticContext.close()
    activePage = page
    return { tapPins: true, outsideTapDismisses: true, secondTapDismisses: true }
  })

async function editIn(target) {
  const button = target.getByRole("button", { name: "Edit dashboard", exact: true })
  if (await button.isVisible()) await button.click()
}
async function documentIn(target) {
  await target.getByRole("button", { name: "Code", exact: true }).click()
  const source = target.getByRole("region", { name: "Dashboard source editor" })
  await source.getByRole("button", { name: "JSON", exact: true }).click()
  const value = JSON.parse(await source.getByRole("textbox", { name: "Dashboard source" }).inputValue())
  await source.getByRole("button", { name: "Close source editor" }).click()
  await settle(target)
  return value
}
// Side panels sit beside the canvas. Opening one must keep the wide grid, its drag handles and the tiles themselves,
// and it must not query again. The sidebar yields only while a panel needs its room, and returns when the panel closes.
const builderPanels = ["Manage dashboards", "Code", "Build with AI", "Data sources", "Add widget", "Examples"]
const panelBar = (target) => target.locator('[aria-label="Builder panel"]')
async function openPanel(target, name) {
  const loose = name === "Data sources" || name === "Examples"
  await target.getByRole("button", { name: loose ? new RegExp(`^${name}`) : name, exact: !loose }).first().click()
  await panelBar(target).waitFor()
  await stableGeometry(target)
}
async function closePanel(target) {
  await panelBar(target).getByRole("button", { name: /^Close/ }).first().click().catch(() => target.keyboard.press("Escape"))
  await panelBar(target).waitFor({ state: "detached" })
  await stableGeometry(target)
}
async function canvasState(target) {
  return target.evaluate(() => {
    const canvas = document.querySelector('[data-testid="dashboard-canvas"]')
    const panel = document.querySelector('[aria-label="Builder panel"]')
    return {
      mode: canvas.getAttribute("data-layout-mode"),
      canvas: Math.round(canvas.getBoundingClientRect().width),
      handles: document.querySelectorAll(".insights-drag-handle").length,
      panel: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
      sidebar: !!document.querySelector("#insights-navigation"),
      overflow: document.documentElement.scrollWidth - innerWidth,
    }
  })
}
async function resizeCanvasHost(target, width) {
  await target.setViewportSize({ width, height: 1050 })
  await settle(target)
  await target.waitForFunction(() => document.querySelector('[data-testid="dashboard-canvas"]') !== null)
  await stableGeometry(target)
}
const panelContext = await browser.newContext({ viewport: { width: 1512, height: 1050 }, reducedMotion: "reduce", timezoneId: "UTC" })
const panelPage = await panelContext.newPage()
observe(panelPage)
await panelPage.goto(`${baseURL}/dashboard/insights/?example=1`, { waitUntil: "networkidle" })
await panelPage.getByRole("button", { name: "Edit dashboard", exact: true }).click().catch(() => {})
await settle(panelPage)

await check("every side panel keeps the wide canvas and its drag handles at 1280, 1512 and 1600", async () => {
  const evidence = []
  for (const width of [1512, 1280, 1600]) {
    await resizeCanvasHost(panelPage, width)
    await editIn(panelPage)
    const before = await canvasState(panelPage)
    assert.equal(before.mode, "wide", `${width}px without a panel must be wide`)
    assert.ok(before.handles > 0, `${width}px must offer drag handles while editing`)
    for (const name of builderPanels) {
      await openPanel(panelPage, name)
      const open = await canvasState(panelPage)
      assert.equal(open.mode, "wide", `${width}px with ${name} open: canvas is ${open.canvas}px, which must stay wide`)
      assert.equal(open.handles, before.handles, `${width}px with ${name} open: every drag handle stays`)
      assert.ok(open.overflow <= 1, `${width}px with ${name} open: page overflowed by ${open.overflow}px`)
      evidence.push({ width, panel: name, ...open })
      await closePanel(panelPage)
    }
  }
  return { checked: evidence.length, evidence }
})

await check("the wide grid starts at 1270px for Manage and at 1368px for the 440px Code panel", async () => {
  const rows = []
  for (const [width, name] of [[1269, "Manage dashboards"], [1270, "Manage dashboards"], [1367, "Code"], [1368, "Code"]]) {
    await resizeCanvasHost(panelPage, width)
    await openPanel(panelPage, name)
    rows.push({ width, name, ...(await canvasState(panelPage)) })
    await closePanel(panelPage)
  }
  const row = (width, name) => rows.find((item) => item.width === width && item.name === name)
  assert.equal(row(1269, "Manage dashboards").mode, "compact", "Manage must not keep the wide grid at 1269px")
  assert.equal(row(1270, "Manage dashboards").mode, "wide", "Manage must keep the wide grid at 1270px")
  assert.equal(row(1367, "Code").panel, 342, "Code narrows to the standard panel below 1368px")
  assert.equal(row(1367, "Code").mode, "wide", "Narrowed Code keeps the wide grid at 1367px")
  assert.equal(row(1368, "Code").panel, 440, "Code takes its 440px width from 1368px")
  return rows
})

await check("panel open and close keep tile nodes and issue no queries on a live dashboard", async () => {
  const live = await browser.newContext({ viewport: { width: 1512, height: 1050 }, reducedMotion: "reduce", timezoneId: "UTC" })
  const target = await live.newPage()
  observe(target)
  try {
    const fixture = await installChartSystemFixture(target, baseURL)
    await target.goto(`${baseURL}/dashboard/insights/?dashboard=${fixture.dashboard.id}`)
    await target.locator('[data-widget-id="hex-map"] [data-geo-cell], [data-widget-id="hex-map"] [data-map-plane]').first().waitFor()
    await target.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await target.locator(".insights-drag-handle").first().waitFor()
    await target.evaluate(() => {
      window.__tiles = new Map([...document.querySelectorAll("[data-widget-id]")].map((node) => [node.dataset.widgetId, node]))
      window.__detached = 0
      new MutationObserver((records) => {
        for (const record of records) for (const node of record.removedNodes)
          if (node instanceof Element && (node.matches("[data-widget-id]") || node.querySelector("[data-widget-id]"))) window.__detached++
      }).observe(document.querySelector('[data-testid="dashboard-canvas"]'), { childList: true, subtree: true })
    })
    const queries = () => fixture.calls.filter((call) => call.path === "/query").length
    const tilesKept = () => target.evaluate(() => [...window.__tiles.entries()].every(([id, node]) => node.isConnected && document.querySelector(`[data-widget-id="${id}"]`) === node))
    const report = []
    for (const name of ["Manage dashboards", "Code", "Build with AI", "Add widget"]) {
      const before = queries()
      await openPanel(target, name)
      const opened = { mode: await target.getAttribute('[data-testid="dashboard-canvas"]', "data-layout-mode").catch(() => null) }
      assert.equal(await tilesKept(), true, `${name}: opening must keep every tile node`)
      await closePanel(target)
      assert.equal(await tilesKept(), true, `${name}: closing must keep every tile node`)
      assert.equal(queries() - before, 0, `${name}: opening and closing must not query again`)
      report.push({ name, queriesDuringOpenAndClose: queries() - before, ...opened })
    }
    assert.equal(await target.evaluate(() => window.__detached), 0, "No tile subtree may be detached while panels open and close")
    return { widgets: fixture.dashboard.widgets.length, detached: 0, panels: report }
  } finally {
    await live.close()
  }
})

await check("the sidebar yields to a panel that needs its room and returns on close, unless the user hid it", async () => {
  await resizeCanvasHost(panelPage, 1512)
  const toggle = panelPage.getByRole("button", { name: "Toggle sidebar", exact: true })
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Sidebar starts open at 1512px")
  await openPanel(panelPage, "Code")
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "Code needs the room, so the sidebar yields")
  assert.equal((await canvasState(panelPage)).sidebar, false, "A yielded sidebar is not in the layout")
  await closePanel(panelPage)
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Closing Code restores the sidebar")
  assert.equal((await canvasState(panelPage)).sidebar, true)
  await openPanel(panelPage, "Manage dashboards")
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Manage fits beside the open sidebar at 1512px")
  await closePanel(panelPage)
  // A sidebar the user hid stays hidden through panels, and returns only when the user shows it.
  await toggle.click()
  assert.equal(await toggle.getAttribute("aria-expanded"), "false")
  await openPanel(panelPage, "Code")
  await closePanel(panelPage)
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "A sidebar the user hid is not reopened by a panel")
  await toggle.click()
  assert.equal(await toggle.getAttribute("aria-expanded"), "true")
  return { restoredAfterCode: true, userHiddenStaysHidden: true }
})

await check("a canvas between 880 and 960px keeps the mode it already shows while a panel is open", async () => {
  await resizeCanvasHost(panelPage, 1400)
  await openPanel(panelPage, "Manage dashboards")
  const steps = []
  for (const width of [1400, 1300, 1250, 1300, 1400, 1300]) {
    await resizeCanvasHost(panelPage, width)
    steps.push({ width, ...(await canvasState(panelPage)) })
  }
  const modes = steps.map((step) => step.mode)
  assert.deepEqual(modes, ["wide", "wide", "compact", "compact", "wide", "wide"], `Hysteresis must hold the mode across 880-960px: ${JSON.stringify(steps)}`)
  assert.ok(steps[1].canvas >= 880 && steps[1].canvas < 960 && steps[3].canvas >= 880 && steps[3].canvas < 960, "The checkpoints must sit inside the hysteresis band")
  await closePanel(panelPage)
  return steps
})

await check("layout moves from the inspector work on the compact canvas, which is the saved grid", async () => {
  await resizeCanvasHost(panelPage, 768)
  await editIn(panelPage)
  // Read the saved grid before the widget editor takes over the toolbar that holds the Code button.
  const before = (await documentIn(panelPage)).widgets.find((item) => item.title === "Service health").layout
  await panelPage.getByRole("button", { name: "Edit Service health", exact: true }).click()
  const editorRegion = panelPage.getByRole("region", { name: "Widget editor" })
  await editorRegion.getByRole("tab", { name: "Layout", exact: true }).click()
  const moves = ["left", "right", "up", "down"].map((direction) => editorRegion.getByRole("button", { name: `Move widget ${direction}`, exact: true }))
  const enabled = []
  for (const [index, button] of moves.entries()) if (await button.isEnabled()) enabled.push(["left", "right", "up", "down"][index])
  assert.ok(enabled.length > 0, "At least one saved-grid move must be offered on the compact canvas")
  const position = editorRegion.getByRole("status").filter({ hasText: "Dashboard position" })
  const previous = await position.textContent()
  await editorRegion.getByRole("button", { name: `Move widget ${enabled[0]}`, exact: true }).click()
  await settle(panelPage)
  assert.notEqual(await position.textContent(), previous, "Moving from the inspector updates the staged position")
  await editorRegion.getByRole("button", { name: "Apply changes", exact: true }).click()
  await settle(panelPage)
  const after = (await documentIn(panelPage)).widgets.find((item) => item.title === "Service health").layout
  assert.notDeepEqual(after, before, "Applying a compact-canvas move saves the new saved-grid position")
  return { direction: enabled[0], enabled, before, after }
})

// Focus, Explore, the compact dark rail, resizing while a panel is open, and a sidebar the user showed over a panel.
async function focusedOpenerName(target) {
  return target.evaluate(() => document.activeElement?.dataset?.panelOpener ?? null)
}
await check("focus returns to the control that opened a panel after the sidebar yields", async () => {
  const rows = []
  for (const [width, name, opener] of [[1280, "Data sources", "providers"], [1512, "Examples", "examples"], [1280, "Examples", "examples"], [1280, "Dashboard as code", "source"]]) {
    await resizeCanvasHost(panelPage, width)
    await openPanel(panelPage, name)
    const yielded = (await canvasState(panelPage)).sidebar === false
    await closePanel(panelPage)
    const focused = await focusedOpenerName(panelPage)
    rows.push({ width, name, yielded, focused })
    assert.equal(focused, opener, `${width}px ${name}: closing must return focus to the ${opener} control, not the body`)
  }
  return rows
})

await check("Explore and back keep an open panel, the wide grid and its drag handles", async () => {
  await resizeCanvasHost(panelPage, 1512)
  await editIn(panelPage)
  await openPanel(panelPage, "Manage dashboards")
  const before = await canvasState(panelPage)
  await panelPage.locator("#insights-navigation").getByRole("button", { name: /^Explore/ }).click()
  await settle(panelPage)
  await panelPage.locator("#insights-navigation").getByRole("button", { name: /^Dashboards/ }).click()
  await stableGeometry(panelPage)
  const after = await canvasState(panelPage)
  assert.equal(after.mode, "wide", `Returning from Explore must keep the wide grid, got ${after.canvas}px`)
  assert.equal(after.handles, before.handles, "Returning from Explore must restore every drag handle")
  assert.ok(after.panel > 0, "The panel that was open stays open")
  await closePanel(panelPage)
  return { before, after }
})

await check("the compact dark rail yields to a panel and returns when it closes, keeping the wide grid from 1246px", async () => {
  const dark = await browser.newContext({ viewport: { width: 1280, height: 1050 }, reducedMotion: "reduce", timezoneId: "UTC" })
  await dark.addInitScript(() => { localStorage.setItem("paprika-insights-theme", "dark"); localStorage.setItem("paprika-insights-compact-view", "true") })
  const target = await dark.newPage()
  observe(target)
  try {
    await target.goto(`${baseURL}/dashboard/insights/?example=1`, { waitUntil: "networkidle" })
    await settle(target)
    const rail = target.locator("#insights-navigation")
    assert.equal(await target.evaluate(() => document.querySelector("[data-compact-shell]") !== null), true, "Compact dark view must be active")
    const rows = []
    for (const width of [1246, 1240]) {
      await resizeCanvasHost(target, width)
      await openPanel(target, "Data sources")
      rows.push({ width, ...(await canvasState(target)) })
      await closePanel(target)
    }
    assert.equal(rows[0].mode, "wide", "Compact dark keeps the wide grid from 1246px")
    assert.equal(rows[1].mode, "compact", "Compact dark drops to compact at 1240px")
    assert.equal(await rail.count() > 0, true, "The rail returns when the panel closes")
    await resizeCanvasHost(target, 1280)
    await openPanel(target, "Data sources")
    assert.equal(await rail.count(), 0, "The compact rail yields while the panel needs its room")
    assert.equal(await target.getByRole("button", { name: "Toggle sidebar", exact: true }).getAttribute("aria-expanded"), "false")
    await closePanel(target)
    assert.equal(await focusedOpenerName(target), "providers", "Focus returns to the rail's Data sources control")
    // Build with AI turns editing on, which leaves compact dark. The sidebar is then planned again, before paint.
    await target.getByRole("button", { name: "Dashboard actions", exact: true }).click()
    await target.getByRole("menuitem", { name: /Build with AI/ }).click()
    await stableGeometry(target)
    const ai = await canvasState(target)
    assert.equal(ai.mode, "wide", `Build with AI from compact dark keeps the wide grid, got ${ai.canvas}px`)
    assert.ok(ai.handles > 0, "Editing from Build with AI offers drag handles")
    await closePanel(target)
    return rows.concat([{ width: 1280, ai }])
  } finally {
    await dark.close()
  }
})

await check("resizing with a panel open re-plans the sidebar and the canvas stays wide", async () => {
  await resizeCanvasHost(panelPage, 1512)
  await editIn(panelPage)
  await openPanel(panelPage, "Code")
  const steps = []
  for (const width of [1512, 1600, 1280, 1300]) {
    await resizeCanvasHost(panelPage, width)
    steps.push({ width, ...(await canvasState(panelPage)) })
  }
  assert.ok(steps.every((step) => step.mode === "wide" && step.handles > 0), `Resizing must keep the wide grid: ${JSON.stringify(steps)}`)
  assert.equal(steps[1].sidebar, true, "At 1600px the room returns the sidebar beside the Code panel")
  assert.equal(steps[2].sidebar, false, "At 1280px the sidebar yields again")
  assert.equal(steps[2].panel, 342, "At 1280px the Code panel uses the standard width")
  await closePanel(panelPage)
  return steps
})

await check("a sidebar the user showed over a panel is not collapsed again by resizing", async () => {
  await resizeCanvasHost(panelPage, 1280)
  await openPanel(panelPage, "Manage dashboards")
  const toggle = panelPage.getByRole("button", { name: "Toggle sidebar", exact: true })
  assert.equal((await canvasState(panelPage)).sidebar, false, "At 1280px Manage yields the sidebar")
  await toggle.click()
  await stableGeometry(panelPage)
  const shown = await canvasState(panelPage)
  assert.equal(shown.sidebar, true, "The user's show overrides the yield")
  await resizeCanvasHost(panelPage, 1300)
  const resized = await canvasState(panelPage)
  assert.equal(resized.sidebar, true, "Resizing does not collapse the sidebar the user showed")
  assert.equal(await toggle.getAttribute("aria-expanded"), "true")
  await closePanel(panelPage)
  return { shown, resized }
})
  assert.deepEqual(pageErrors, [], "Responsive browser sessions must not have unhandled errors")
  console.log(`\n${reports.length} responsive integration checks passed.`)
} finally {
  await writeFile(resolve(output, "responsive-e2e-report.json"), JSON.stringify({ baseURL, reports, pageErrors }, null, 2))
  await browser.close()
}
