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
  await page.getByRole("button", { name: "Code", exact: true }).click()
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
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit Request rate", exact: true }).click()
    const editor = page.getByRole("region", { name: "Widget editor" })
    await editor.getByLabel("Title", { exact: true }).fill("Total request rate")
    await editor.getByRole("textbox", { name: /^PromQL query/ }).fill("sum(rate(http_requests_total[1m]))")
    await editor.getByRole("button", { name: "Apply widget", exact: true }).click()
    await editor.getByRole("button", { name: "Close widget editor" }).click()
    await page.getByRole("button", { name: "Add widget", exact: true }).click()
    await page.getByRole("button", { name: "Single value One number, clear context" }).click()
    await editor.getByLabel("Title", { exact: true }).fill("Worker capacity")
    await editor.getByRole("textbox", { name: /^PromQL query/ }).fill("sum(up)")
    await editor.getByRole("button", { name: "Apply widget", exact: true }).click()
    await editor.getByRole("button", { name: "Close widget editor" }).click()
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
    return { before: widget(before, "requests").layout, moved: beforeResize, resized: afterResize, undoRedo: true }
  })

  await check("JSON and YAML editing apply atomically and reject invalid source", async () => {
    let editor = await sourceEditor()
    const updated = { ...resizedDocument, title: "JSON edited overview" }
    await editor.getByRole("textbox", { name: "Dashboard source" }).fill(JSON.stringify(updated, null, 2))
    await editor.getByRole("button", { name: "Apply to canvas", exact: true }).click()
    await page.getByRole("textbox", { name: "Dashboard title", exact: true }).waitFor()
    assert.equal(await page.getByRole("textbox", { name: "Dashboard title", exact: true }).inputValue(), updated.title)
    editor = await sourceEditor()
    await editor.getByRole("button", { name: "YAML", exact: true }).click()
    const yaml = await editor.getByRole("textbox", { name: "Dashboard source" }).inputValue()
    await editor.getByRole("textbox", { name: "Dashboard source" }).fill(yaml.replace("title: JSON edited overview", "title: YAML edited overview"))
    await editor.getByRole("button", { name: "Apply to canvas", exact: true }).click()
    assert.equal(await page.getByRole("textbox", { name: "Dashboard title", exact: true }).inputValue(), "YAML edited overview")
    editor = await sourceEditor()
    const valid = await editor.getByRole("textbox", { name: "Dashboard source" }).inputValue()
    const invalid = JSON.parse(valid)
    invalid.widgets[0].layout.w = 99
    await editor.getByRole("textbox", { name: "Dashboard source" }).fill(JSON.stringify(invalid))
    await editor.getByRole("button", { name: "Apply to canvas", exact: true }).click()
    await editor.getByRole("alert").waitFor()
    await editor.getByRole("button", { name: "Close source editor" }).click()
    assert.deepEqual(await readDocument(), JSON.parse(valid), "Invalid document must leave the canvas unchanged")
  })

  await check("OpenUI definition requires review before apply and remains undoable", async () => {
    const before = await readDocument()
    await page.getByRole("button", { name: "Build with AI", exact: true }).click()
    const ai = page.getByRole("region", { name: "Build with AI", exact: true })
    assert.equal(await ai.getByRole("button", { name: "Apply to canvas", exact: true }).isDisabled(), true)
    const generated = { ...before, title: "AI reviewed overview", widgets: before.widgets.map((item, index) => index === 0 ? { ...item, title: "AI request rate" } : item) }
    await ai.getByRole("textbox", { name: "AI-generated definition", exact: true }).fill(toOpenUI(generated))
    await ai.getByRole("button", { name: "Review definition", exact: true }).click()
    await ai.getByText("Definition valid · 8 widgets", { exact: true }).waitFor()
    await page.screenshot({ path: resolve(output, "dashboard-ai-review.png"), fullPage: true })
    await ai.getByRole("button", { name: "Apply to canvas", exact: true }).click()
    if (await ai.isVisible()) await ai.getByRole("button", { name: "Close AI builder" }).click()
    assert.equal((await readDocument()).title, "AI reviewed overview")
    await page.getByRole("button", { name: "Undo", exact: true }).click()
    assert.equal((await readDocument()).title, before.title)
    await page.getByRole("button", { name: "Redo", exact: true }).click()
    assert.equal((await readDocument()).title, generated.title)
  })

  await check("save and reload retain queries and pointer-edited layouts", async () => {
    const document = await readDocument()
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
    await mobilePage.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await mobilePage.getByRole("button", { name: "Edit Request rate", exact: true }).click()
    await mobilePage.getByRole("region", { name: "Widget editor" }).getByLabel("Title", { exact: true }).fill("Mobile request rate")
    await mobilePage.getByRole("button", { name: "Apply widget", exact: true }).click()
    await mobilePage.getByRole("button", { name: "Close widget editor" }).click()
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
