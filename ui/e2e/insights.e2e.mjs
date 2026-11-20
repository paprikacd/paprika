import { applyWidgetChanges, openDashboardEditor, activateDashboardAction } from "./gamma-controls.mjs";
// Run against a local Next development server:
// INSIGHTS_E2E_URL=http://localhost:3015 node e2e/insights.e2e.mjs
// This script owns fresh browser contexts and writes screenshots outside source.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const baseURL = process.env.INSIGHTS_E2E_URL || "http://localhost:3015"
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights")
const reports = []
const pageErrors = []
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, reducedMotion: "reduce" })
const page = await context.newPage()
page.on("pageerror", (error) => pageErrors.push(error.message))
page.setDefaultTimeout(15_000)

async function check(name, callback) {
  const started = Date.now()
  try {
    const evidence = await callback()
    reports.push({ name, passed: true, milliseconds: Date.now() - started, evidence })
    console.log(`PASS ${name}${evidence ? `: ${JSON.stringify(evidence)}` : ""}`)
  } catch (error) {
    reports.push({ name, passed: false, error: error.message })
    await page.screenshot({ path: resolve(output, "failure.png"), fullPage: true }).catch(() => {})
    throw error
  }
}

async function sourceEditor() {
  await activateDashboardAction(page, "Code")
  const editor = page.getByRole("region", { name: "Dashboard source editor" })
  await editor.getByRole("button", { name: "JSON", exact: true }).click()
  return editor
}

async function settleLayout() {
  // Panel close changes the canvas width. ResizeObserver publishes the grid's
  // measured width on the following frame; do not start a pointer action using
  // the previous narrow-panel geometry.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))))
}

async function readDocument() {
  const editor = await sourceEditor()
  const document = JSON.parse(await editor.getByRole("textbox", { name: "Dashboard source" }).inputValue())
  await editor.getByRole("button", { name: "Close source editor" }).click()
  await settleLayout()
  return document
}

function widget(document, id) {
  const value = document.widgets.find((item) => item.id === id)
  assert.ok(value, `Widget ${id} must exist`)
  return value
}

function savedLayouts(document) {
  return Object.fromEntries(document.widgets.map((item) => [item.id, item.layout]))
}

function toOpenUI(document) {
  const names = { timeseries: "TimeSeries", bar: "BarChart", stat: "Stat", table: "MetricsTable", traces: "Traces", heatmap: "Heatmap" }
  const args = (values) => values.map((value) => JSON.stringify(value ?? null)).join(", ")
  return `root = Dashboard(${args([document.id, document.title, document.timeRange, document.refreshInterval])}, [${document.widgets.map((_, index) => `widget${index}`).join(", ")}], ${JSON.stringify(document.description ?? null)})\n` + document.widgets.map((item, index) => `widget${index} = ${names[item.type]}(${args([item.id, item.title, item.providerId, item.query, item.unit, item.layout, item.description, item.color, item.options])})`).join("\n")
}

async function pointerDrag(locator, deltaX, deltaY) {
  await locator.scrollIntoViewIfNeeded()
  await settleLayout()
  const box = await locator.boundingBox()
  assert.ok(box, "Pointer target must have a visible bounding box")
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + deltaX, y + deltaY, { steps: 20 })
  await page.mouse.up()
  await settleLayout()
}

try {
  await check("initial sample dashboard renders real charts and traces", async () => {
    await page.goto(`${baseURL}/dashboard/insights/?example=1`, { waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Service overview", exact: true }).waitFor()
    await page.locator('[data-widget-id="traffic"] svg[aria-label="Traffic over time"]').waitFor()
    assert.equal(await page.locator("[data-widget-id]").count(), 7)
    await page.locator('[data-widget-id="traces"]').scrollIntoViewIfNeeded()
    await page.getByRole("region", { name: "Recent traces traces" }).getByText("GET /api/applications").waitFor()
    await page.evaluate(() => window.scrollTo(0, 0))
    await settleLayout()
    await page.screenshot({ path: resolve(output, "dashboard-desktop.png"), fullPage: true })
    return { widgets: 7, charts: await page.locator('[data-widget-id] svg[role="img"]').count() }
  })

  await check("visual editor updates title and PromQL and adds a widget", async () => {
    await openDashboardEditor(page)
    await page.getByRole("button", { name: "Edit Request rate", exact: true }).click()
    const editor = page.getByRole("region", { name: "Widget editor" })
    await editor.getByLabel("Title", { exact: true }).fill("Total request rate")
    await editor.getByRole("textbox", { name: /^PromQL query/ }).fill("sum(rate(http_requests_total[1m]))")
    await editor.getByRole("button", { name: "Apply changes", exact: true }).click()
    await page.getByRole("button", { name: "Add widget", exact: true }).click()
    await page.getByRole("button", { name: "Single value One number, clear context" }).click()
    await editor.getByLabel("Title", { exact: true }).fill("Worker capacity")
    await editor.getByRole("textbox", { name: /^PromQL query/ }).fill("sum(up)")
    await editor.getByRole("button", { name: "Apply changes", exact: true }).click()
    const document = await readDocument()
    assert.equal(document.widgets.length, 8)
    assert.equal(widget(document, "requests").query, "sum(rate(http_requests_total[1m]))")
    assert.equal(widget(document, "requests").title, "Total request rate")
    assert.ok(document.widgets.some((item) => item.title === "Worker capacity" && item.query === "sum(up)"))
  })

  let resizedDocument
  await check("pointer drag and resize change the saved grid document", async () => {
    const before = await readDocument()
    const canvas = await page.getByTestId("dashboard-canvas").boundingBox()
    assert.ok(canvas && canvas.width > 640, "Desktop drag requires a wide canvas")
    // Alt+ArrowDown on the focused tile swaps it below the widget it shares columns with; Undo restores the saved grid.
    await page.locator('article[data-widget-id="requests"]').focus()
    await page.keyboard.press("Alt+ArrowDown")
    const reordered = await readDocument()
    assert.ok(widget(reordered, "requests").layout.y >= widget(reordered, "traffic").layout.y + widget(reordered, "traffic").layout.h, "Alt+ArrowDown must leave the widget below the one it swapped with")
    assert.match(await page.locator('[data-testid="dashboard-canvas"] [aria-live="polite"]').textContent(), /^Moved .+ down, below Traffic over time: row \d+, columns \d+ to \d+\.$/)
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    assert.deepEqual(widget(await readDocument(), "requests").layout, widget(before, "requests").layout)
    // Vertical drag, from the saved grid restored above. Rows are 74px apart (a 58px row plus its 16px gap). Dragging
    // requests down 5 rows carries it past traffic's midpoint, so it settles below traffic. Dragging it back up past
    // that midpoint restores the whole saved grid.
    const grip = page.locator('[data-widget-id="requests"] .insights-drag-handle')
    const row = 74
    await pointerDrag(grip, 0, row * 5)
    const lowered = await readDocument()
    assert.ok(widget(lowered, "requests").layout.y >= widget(lowered, "traffic").layout.y + widget(lowered, "traffic").layout.h, "Dragging requests down past traffic's midpoint must leave it below traffic")
    await pointerDrag(grip, 0, -row * 3)
    assert.deepEqual(savedLayouts(await readDocument()), savedLayouts(before), "Dragging back past traffic's midpoint must restore the saved grid")
    const column = (canvas.width + 16) / 12
    await pointerDrag(page.locator('[data-widget-id="requests"] .insights-drag-handle'), column * 4, 0)
    const moved = await readDocument()
    assert.notDeepEqual(widget(moved, "requests").layout, widget(before, "requests").layout, "Drag must update the document, not just the DOM transform")
    const beforeResize = widget(moved, "requests").layout
    await pointerDrag(page.locator('.react-grid-item:has([data-widget-id="requests"]) > .react-resizable-handle-se'), column, 74)
    resizedDocument = await readDocument()
    const afterResize = widget(resizedDocument, "requests").layout
    assert.ok(afterResize.w > beforeResize.w || afterResize.h > beforeResize.h, "Resize must update width or height in the document")
    await page.screenshot({ path: resolve(output, "dashboard-edited.png"), fullPage: true })
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    const undone = await readDocument()
    assert.deepEqual(widget(undone, "requests").layout, beforeResize)
    await page.getByRole("button", { name: "Redo", exact: true }).click()
    const redone = await readDocument()
    assert.deepEqual(widget(redone, "requests").layout, afterResize)
    return { before: widget(before, "requests").layout, lowered: widget(lowered, "requests").layout, moved: beforeResize, resized: afterResize, undoRedo: true }
  })

  await check("edge handles resize one saved widget per drag, and each drag undoes in one step", async () => {
    const start = await readDocument()
    const target = "latency"
    const canvas = await page.getByTestId("dashboard-canvas").boundingBox()
    const column = (canvas.width + 16) / 12
    const handle = (edge) => page.locator(`.react-grid-item:has([data-widget-id="${target}"]) > .react-resizable-handle-${edge}`)
    const before = widget(start, target).layout
    assert.ok(before.x > 0, "The west-edge drag needs a widget that can move left")
    // Edge handles are 8px strips with no rotation, not react-resizable's centred corner glyphs.
    const edge = await handle("e").evaluate((element) => {
      const style = getComputedStyle(element)
      return { width: parseFloat(style.width), transform: style.transform, cursor: style.cursor }
    })
    assert.deepEqual(edge, { width: 8, transform: "none", cursor: "ew-resize" }, "East handle is an 8px edge strip")
    // The grip pill is the handle's ::after. react-resizable's own corner glyph would win a tie, so check the computed pill.
    const pill = async (edge) => handle(edge).evaluate((element) => {
      const style = getComputedStyle(element, "::after")
      return { width: parseFloat(style.width), height: parseFloat(style.height), border: parseFloat(style.borderRightWidth) + parseFloat(style.borderBottomWidth) }
    })
    assert.deepEqual(await pill("e"), { width: 3, height: 32, border: 0 }, "East handle shows a 3x32 pill, not a corner glyph")
    assert.deepEqual(await pill("s"), { width: 32, height: 3, border: 0 }, "South handle shows a 32x3 pill, not a corner glyph")
    // Action triggers sit in the title's strip: no tile's title may run under its actions trigger.
    const titleUnderAction = await page.$$eval("[data-widget-actions]", (triggers) => triggers.flatMap((trigger) => {
      const heading = trigger.closest("article")?.querySelector("h3")
      if (!heading) return []
      const a = trigger.getBoundingClientRect()
      const b = heading.getBoundingClientRect()
      return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom ? [trigger.dataset.widgetActions] : []
    }))
    assert.deepEqual(titleUnderAction, [], "No title runs under its tile's actions trigger")
    await pointerDrag(handle("e"), column, 0)
    const east = widget(await readDocument(), target).layout
    assert.ok(east.w > before.w && east.x === before.x, "East edge drag must widen the widget from its right side")
    await pointerDrag(handle("w"), -column, 0)
    const west = widget(await readDocument(), target).layout
    assert.ok(west.x < east.x && west.w > east.w, "West edge drag must move the left edge and widen the widget")
    await pointerDrag(handle("s"), 0, 74)
    const south = widget(await readDocument(), target).layout
    assert.ok(south.h > west.h && south.x === west.x && south.w === west.w, "South edge drag must change only the height")
    for (let undo = 0; undo < 3; undo += 1) await page.getByRole("button", { name: "Undo", exact: true }).click()
    assert.deepEqual(widget(await readDocument(), target).layout, before, "Each edge drag is one undo step")
    return { before, east, west, south }
  })

  await check("JSON and YAML editing apply atomically and reject invalid source", async () => {
    let editor = await sourceEditor()
    const updated = { ...resizedDocument, title: "JSON edited overview" }
    await editor.getByRole("textbox", { name: "Dashboard source" }).fill(JSON.stringify(updated, null, 2))
    await editor.getByRole("button", { name: "Replace dashboard draft", exact: true }).click()
    await page.getByRole("textbox", { name: "Dashboard title", exact: true }).waitFor()
    assert.equal(await page.getByRole("textbox", { name: "Dashboard title", exact: true }).inputValue(), updated.title)
    editor = await sourceEditor()
    await editor.getByRole("button", { name: "YAML", exact: true }).click()
    const yaml = await editor.getByRole("textbox", { name: "Dashboard source" }).inputValue()
    await editor.getByRole("textbox", { name: "Dashboard source" }).fill(yaml.replace("title: JSON edited overview", "title: YAML edited overview"))
    await editor.getByRole("button", { name: "Replace dashboard draft", exact: true }).click()
    assert.equal(await page.getByRole("textbox", { name: "Dashboard title", exact: true }).inputValue(), "YAML edited overview")
    editor = await sourceEditor()
    const valid = await editor.getByRole("textbox", { name: "Dashboard source" }).inputValue()
    const invalid = JSON.parse(valid)
    invalid.widgets[0].layout.w = 99
    await editor.getByRole("textbox", { name: "Dashboard source" }).fill(JSON.stringify(invalid))
    await editor.getByRole("button", { name: "Replace dashboard draft", exact: true }).click()
    await editor.getByRole("alert").waitFor()
    await editor.getByRole("button", { name: "Close source editor" }).click()
    assert.deepEqual(await readDocument(), JSON.parse(valid), "Invalid document must leave the canvas unchanged")
  })

  await check("OpenUI definition requires review before apply and remains undoable", async () => {
    const before = await readDocument()
    await page.getByRole("button", { name: "Build with AI", exact: true }).click()
    const ai = page.getByRole("region", { name: "Build with AI", exact: true })
    assert.equal(await ai.getByRole("button", { name: "Replace dashboard draft", exact: true }).isDisabled(), true)
    const generated = { ...before, title: "AI reviewed overview", widgets: before.widgets.map((item, index) => index === 0 ? { ...item, title: "AI request rate" } : item) }
    await ai.getByRole("textbox", { name: "AI-generated definition", exact: true }).fill(toOpenUI(generated))
    await ai.getByRole("button", { name: "Review definition", exact: true }).click()
    await ai.getByText("Definition valid · 8 widgets", { exact: true }).waitFor()
    await page.screenshot({ path: resolve(output, "dashboard-ai-review.png"), fullPage: true })
    await ai.getByRole("button", { name: "Replace dashboard draft", exact: true }).click()
    if (await ai.isVisible()) await ai.getByRole("button", { name: "Close AI builder" }).click()
    assert.equal((await readDocument()).title, "AI reviewed overview")
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    assert.equal((await readDocument()).title, before.title)
    await page.getByRole("button", { name: "Redo", exact: true }).click()
    assert.equal((await readDocument()).title, generated.title)
  })

  await check("save and reload retain queries and pointer-edited layouts", async () => {
    const document = await readDocument()
    await applyWidgetChanges(page);
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByText("Example saved in this browser.", { exact: true }).waitFor()
    await page.getByText("All changes saved", { exact: true }).waitFor()
    await page.reload({ waitUntil: "networkidle" })
    await page.getByRole("heading", { name: document.title, exact: true }).waitFor()
    assert.deepEqual(await readDocument(), document)
    assert.deepEqual(widget(document, "requests").layout, widget(resizedDocument, "requests").layout)
  })

  await check("mobile view has no horizontal overflow and honors reduced motion", async () => {
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" })
    const mobilePage = await mobile.newPage()
    mobilePage.on("pageerror", (error) => pageErrors.push(error.message))
    await mobilePage.goto(`${baseURL}/dashboard/insights/?example=1`, { waitUntil: "networkidle" })
    await mobilePage.getByRole("heading", { name: "Service overview", exact: true }).waitFor()
    assert.ok(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile page must not overflow horizontally")
    assert.equal(await mobilePage.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches), true)
    await openDashboardEditor(mobilePage)
    await mobilePage.getByRole("button", { name: "Edit Request rate", exact: true }).click()
    await mobilePage.getByRole("region", { name: "Widget editor" }).getByLabel("Title", { exact: true }).fill("Mobile request rate")
    await mobilePage.getByRole("button", { name: "Apply changes", exact: true }).click()
    await mobilePage.getByRole("heading", { name: "Mobile request rate", exact: true }).waitFor()
    await mobilePage.waitForFunction(() => document.querySelector('[data-widget-id="requests"]')?.getBoundingClientRect().width > 300)
    assert.ok(await mobilePage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "Mobile edit controls must not overflow horizontally")
    await mobilePage.screenshot({ path: resolve(output, "dashboard-mobile.png"), fullPage: true })
    await mobilePage.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await mobilePage.getByText("All changes saved", { exact: true }).waitFor()
    await mobilePage.getByRole("button", { name: "Toggle sidebar" }).click()
    await mobilePage.getByRole("button", { name: "New dashboard", exact: true }).waitFor({ state: "visible" })
    await mobilePage.getByRole("button", { name: "New dashboard", exact: true }).click()
    await mobilePage.getByRole("textbox", { name: "Dashboard title", exact: true }).fill("Mobile workspace dashboard")
    await mobilePage.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await mobilePage.getByRole("heading", { name: "Mobile workspace dashboard", exact: true }).waitFor()
    await mobilePage.reload({ waitUntil: "networkidle" })
    await mobilePage.getByRole("heading", { name: "Mobile workspace dashboard", exact: true }).waitFor()
    await mobilePage.getByRole("button", { name: "Toggle sidebar" }).click()
    await mobilePage.getByRole("button", { name: "Service overview", exact: true }).click()
    await mobilePage.getByRole("heading", { name: "Service overview", exact: true }).waitFor()
    await mobilePage.getByRole("heading", { name: "Mobile request rate", exact: true }).waitFor()
    await mobile.close()
  })

  assert.deepEqual(pageErrors, [], "Browser must not emit unhandled page errors")
  console.log(`\n${reports.length} end-to-end checks passed. Screenshots: ${output}`)
} finally {
  await writeFile(resolve(output, "e2e-report.json"), JSON.stringify({ baseURL, reports, pageErrors }, null, 2))
  await browser.close()
}
