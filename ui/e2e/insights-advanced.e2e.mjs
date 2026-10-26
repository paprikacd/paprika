import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption, respondToGammaConfirmation } from "./gamma-controls.mjs"

const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights")
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({
  viewport: { width: 1512, height: 1050 },
  reducedMotion: "reduce",
  timezoneId: "UTC",
})
const page = await context.newPage()
const errors = [],
  reports = []
page.on("pageerror", (error) => errors.push(error.message))
page.on("dialog", dialog => { errors.push(`Unexpected native dialog: ${dialog.message()}`); void dialog.dismiss() })
page.setDefaultTimeout(15_000)
const editor = () => page.getByRole("region", { name: "Widget editor" })
const manager = () => page.getByRole("region", { name: "Manage dashboards", exact: true })
async function check(name, action) {
  try {
    const evidence = await action()
    reports.push({ name, passed: true, evidence })
    console.log(`PASS ${name}`)
  } catch (error) {
    reports.push({ name, passed: false, error: error.message })
    await page
      .screenshot({
        path: resolve(output, "advanced-failure.png"),
        fullPage: true,
        timeout: 5000,
      })
      .catch(() => {})
    throw error
  }
}
async function document() {
  await page.getByRole("button", { name: "Code", exact: true }).click()
  const source = page.getByRole("region", { name: "Dashboard source editor" })
  await source.getByRole("button", { name: "JSON", exact: true }).click()
  const value = JSON.parse(
    await source.getByRole("textbox", { name: "Dashboard source" }).inputValue(),
  )
  await source.getByRole("button", { name: "Close source editor" }).click()
  return value
}
async function save() {
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
  await page.getByText("All changes saved", { exact: true }).waitFor()
}
try {
  await page.goto(`${baseURL}/dashboard/insights/?example=1`, {
    waitUntil: "networkidle",
  })
  await check(
    "threshold heatmap renders real colored cells, keyboard tooltips, and editable thresholds",
    async () => {
      const heatmap = page.getByRole("group", {
        name: "Service health heatmap",
      })
      await page.locator('[data-widget-id="health"]').scrollIntoViewIfNeeded()
      await heatmap.waitFor()
      assert.equal(await heatmap.getByRole("button").count(), 6)
      const unavailable = heatmap.getByRole("button", {
        name: /worker-west: 0.*Unavailable/,
      })
      await unavailable.focus()
    await page.getByRole("tooltip").locator("strong").filter({ hasText: /^worker-west$/ }).waitFor()
      assert.equal(
        await unavailable.evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgb(192, 100, 79)",
      )
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await page.getByRole("button", { name: "Edit Service health", exact: true }).click()
      await editor().getByRole("tab", { name: "Style", exact: true }).click()
      await editor().getByLabel("Threshold 1 color", { exact: true }).fill("#ad3f32")
      await editor().getByLabel("Threshold 1 label", { exact: true }).fill("Needs attention")
      await editor().getByRole("button", { name: "Apply widget", exact: true }).click()
      await editor().getByRole("button", { name: "Close widget editor" }).click()
      const changed = heatmap.getByRole("button", {
        name: /worker-west: 0.*Needs attention/,
      })
      assert.equal(
        await changed.evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgb(173, 63, 50)",
      )
      return { cells: 6, thresholdColor: "#ad3f32", keyboardTooltip: true }
    },
  )
  await check(
    "chart styling changes axes, interpolation, colors, bounds, and tooltip controls",
    async () => {
      await page.getByRole("button", { name: "Edit Traffic over time", exact: true }).click()
      await editor().getByRole("tab", { name: "Style", exact: true }).click()
      await editor().getByLabel("X axis label", { exact: true }).fill("Observation time")
      await editor().getByLabel("Y axis label", { exact: true }).fill("Requests per second")
      await editor().getByLabel("Decimal places", { exact: true }).fill("1")
      await selectGammaOption(page, editor().getByRole("combobox", { name: "Display", exact: true }), "Area")
      await selectGammaOption(page, editor().getByRole("combobox", { name: "Curve", exact: true }), "Step")
      await editor().getByLabel("Y minimum", { exact: true }).fill("0")
      await editor().getByLabel("Y maximum", { exact: true }).fill("2000")
      await editor().getByLabel("Background", { exact: true }).fill("#f5f8f1")
      await editor().getByRole("tab", { name: "Tooltips", exact: true }).click()
      await editor().getByRole("switch", { name: "Show tooltips", exact: true }).uncheck()
      await editor().getByRole("button", { name: "Apply widget", exact: true }).click()
      await editor().getByRole("button", { name: "Close widget editor" }).click()
      const tile = page.locator('[data-widget-id="traffic"]')
      await tile.getByText("Observation time", { exact: true }).waitFor()
      await tile.getByText("Requests per second", { exact: true }).waitFor()
      assert.equal(
        await tile.evaluate((el) => getComputedStyle(el).backgroundColor),
        "rgb(245, 248, 241)",
      )
      const value = await document()
      assert.deepEqual(value.widgets.find((item) => item.id === "traffic").options, {
        display: "area",
        xAxisLabel: "Observation time",
        yAxisLabel: "Requests per second",
        showTooltip: false,
        decimals: 1,
        min: 0,
        max: 2000,
        curve: "step",
        background: "#f5f8f1",
      })
    },
  )
  await check(
    "registered widget plugin appears in library and renders its configurable meter",
    async () => {
      await page.getByRole("button", { name: "Add widget", exact: true }).click()
      const library = page.getByRole("region", { name: "Widget library" })
      await library.getByRole("button", { name: "Plugins", exact: true }).click()
      await library
        .getByRole("button", {
          name: /Threshold gauge A value against healthy limits/,
        })
        .click()
      await editor().getByLabel("Title", { exact: true }).fill("Available capacity")
      await editor()
        .getByLabel(/^Plugin configuration/)
        .fill('{"label":"Worker availability"}')
      await editor().getByRole("button", { name: "Apply widget", exact: true }).click()
      await editor().getByRole("button", { name: "Close widget editor" }).click()
      const tile = page.getByRole("article", {
        name: "Available capacity",
        exact: true,
      })
      await tile.scrollIntoViewIfNeeded()
      await tile.getByRole("meter", { name: "Available capacity" }).waitFor()
      await tile.getByText("Worker availability", { exact: true }).waitFor()
      const value = await document()
      assert.equal(value.widgets.at(-1).pluginId, "threshold-gauge")
      assert.deepEqual(value.widgets.at(-1).config, {
        label: "Worker availability",
      })
    },
  )
  await check(
    "absolute time range remains fixed across refresh and survives document save",
    async () => {
      await page.getByRole("button", { name: "Choose custom time range" }).click()
      await page.getByLabel("Range start", { exact: true }).fill("2026-10-20T12:00")
      await page.getByLabel("Range end", { exact: true }).fill("2026-10-20T13:30")
      await page.getByRole("button", { name: "Apply time range" }).click()
      assert.equal(await page.getByRole("combobox", { name: "Auto refresh" }).isDisabled(), true)
      await page.getByRole("button", { name: "Refresh data", exact: true }).click()
      assert.deepEqual((await document()).customTimeRange, {
        from: "2026-10-20T12:00:00.000Z",
        to: "2026-10-20T13:30:00.000Z",
      })
      await save()
      await page.reload({ waitUntil: "networkidle" })
      assert.deepEqual((await document()).customTimeRange, {
        from: "2026-10-20T12:00:00.000Z",
        to: "2026-10-20T13:30:00.000Z",
      })
    },
  )
  await check(
    "dashboard filetree supports rename, nested folders, duplication, and drag moves",
    async () => {
      await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
      await manager().getByLabel("Name", { exact: true }).fill("Production overview")
      await manager().getByLabel("Folder", { exact: true }).fill("Production/Payments")
      await manager().getByRole("button", { name: "Apply dashboard details" }).click()
      await save()
      const tree = page.getByRole("navigation", { name: "Dashboard library" })
      await tree.getByRole("button", { name: "Production", exact: true }).waitFor()
      await tree.getByRole("button", { name: "Payments", exact: true }).waitFor()
      await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
      await manager().getByRole("button", { name: "Duplicate", exact: true }).click()
      await page.getByLabel("Dashboard title", { exact: true }).fill("Staging overview")
      await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
      await manager().getByLabel("Folder", { exact: true }).fill("Staging")
      await manager().getByRole("button", { name: "Apply dashboard details" }).click()
      await save()
      await tree
        .getByRole("button", { name: "Staging overview", exact: true })
        .dragTo(tree.getByRole("button", { name: "Payments", exact: true }))
      await save()
      assert.equal((await document()).folder, "Production/Payments")
      await page.reload({ waitUntil: "networkidle" })
      await page.getByRole("heading", { name: "Staging overview", exact: true }).waitFor()
      assert.equal((await document()).folder, "Production/Payments")
    },
  )
  await check(
    "library export/import remaps providers, creates new identities, and preserves widget options",
    async () => {
      await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
      const downloadPromise = page.waitForEvent("download")
      await manager().getByRole("button", { name: "JSON", exact: true }).click()
      const download = await downloadPromise
      const exported = JSON.parse(await readFile(await download.path(), "utf8"))
      assert.equal(exported.kind, "PaprikaDashboardLibrary")
      assert.equal(exported.dashboards.length, 2)
      const imported = {
        ...exported.dashboards[0],
        title: "Imported production",
        widgets: exported.dashboards[0].widgets.map((item) =>
          item.providerId === "example-prometheus"
            ? { ...item, providerId: "production-metrics" }
            : item,
        ),
      }
      await selectGammaOption(page, manager().getByRole("combobox", { name: "Library import format" }), "JSON")
      await manager()
        .getByRole("textbox", { name: "Library import source" })
        .fill(JSON.stringify(imported))
      await manager().getByRole("button", { name: "Review import", exact: true }).click()
      assert.equal(
        await manager().getByRole("button", { name: "Import 1 as new", exact: true }).isDisabled(),
        true,
      )
      await selectGammaOption(page, manager().getByRole("combobox", {
        name: "Connect production-metrics",
        exact: true,
      }), "Prometheus · example")
      await manager().getByRole("button", { name: "Import 1 as new", exact: true }).click()
      await manager()
        .getByRole("status")
        .getByText(/^1 dashboard decisions? completed\./)
        .waitFor()
      await page
        .getByRole("navigation", { name: "Dashboard library" })
        .getByRole("button", { name: "Imported production", exact: true })
        .click()
      const current = await document()
      assert.notEqual(current.id, imported.id)
      assert.deepEqual(current.widgets, exported.dashboards[0].widgets)
      await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
      await manager().getByRole("button", { name: "Delete dashboard", exact: true }).click()
      await respondToGammaConfirmation(page, "Delete dashboard")
      await page.getByText("Dashboard deleted.", { exact: true }).waitFor()
      assert.equal(
        await page
          .getByRole("navigation", { name: "Dashboard library" })
          .getByRole("button", { name: "Imported production", exact: true })
          .count(),
        0,
      )
    },
  )
  await check("Gamma editor, dashboard manager, and custom dates fit a mobile screen", async () => {
    await page.screenshot({ path: resolve(output, "dashboard-advanced-desktop.png"), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
    await manager().waitFor()
    await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, undefined, { timeout: 5000 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await manager().getByRole("button", { name: "Close dashboard manager" }).click()
    await page.getByRole("button", { name: "Edit Service health", exact: true }).click()
    await editor().getByRole("tab", { name: "Style", exact: true }).click()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({
      path: resolve(output, "dashboard-advanced-mobile.png"),
      fullPage: true,
    })
    await editor().getByRole("button", { name: "Close widget editor" }).click()
    await page.getByRole("button", { name: "Choose custom time range" }).click()
    await page.getByLabel("Range start", { exact: true }).waitFor()
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.getByRole("button", { name: "Close time range" }).click()
  })
  assert.deepEqual(errors, [])
  console.log(`${reports.length} advanced browser scenarios passed.`)
} finally {
  await writeFile(
    resolve(output, "advanced-e2e-report.json"),
    JSON.stringify({ baseURL, reports, errors }, null, 2),
  )
  await browser.close()
}
