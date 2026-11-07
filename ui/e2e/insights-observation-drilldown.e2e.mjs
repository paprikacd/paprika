// A historical point must reach the target dashboard as the exact value,
// and a transient focus/hover must never choose it implicitly.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"
import { selectGammaOption } from "./gamma-controls.mjs"

const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = resolve(fileURLToPath(new URL("../../artifacts/insights/observation-drilldown", import.meta.url)))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" })
    const page = await context.newPage(), errors = [], responses = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("response", response => {
      if (response.url().endsWith("/api/insights/query") && response.ok()) responses.push(response.json().catch(() => null))
    })
    try {
      const { documents, failures } = await installRichChartFixtureAPI(page, base)
      const source = documents.get("example-artboard-fleet-atlas")
      const chart = source.widgets.find(widget => widget.id === "node-cpu")
      const target = structuredClone(source)
      target.id = "observation-target"
      target.title = "Selected observation destination"
      target.variables.push({ name: "reading", label: "Reading", defaultValue: "" }, { name: "node", label: "Node", defaultValue: "node-01" })
      documents.set(target.id, target)
      chart.drilldowns = [{ id: "detail", title: "Selected observation destination", dashboardId: target.id, carryTimeRange: false, bindings: [{ variable: "reading", source: "value" }, { variable: "node", source: "label", value: "node" }] }]
      await page.goto(`${base}/dashboard/insights/?dashboard=${source.id}`, { waitUntil: "networkidle" })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const tile = page.locator('[data-widget-id="node-cpu"]')
      await tile.scrollIntoViewIfNeeded()
      const plot = tile.getByRole("img", { name: "CPU utilization by node", exact: true })
      await plot.focus()
      const tooltip = page.getByRole("tooltip")
      await tooltip.waitFor()
      for (let step = 0; step < 8; step++) await plot.press("ArrowRight")
      assert.equal(await tooltip.getByRole("button", { name: "Use sample for dashboard links" }).count(), 0, "A preview must not offer a committed selection")
      const observation = tooltip.locator("[data-observation-value]")
      const reading = await observation.getAttribute("data-observation-value")
      assert.ok(Number.isFinite(Number(reading)))
      const selectedSeries = await observation.getAttribute("data-observation-series")
      const results = (await Promise.all(responses)).filter(Boolean).flatMap(result => result.series ?? [])
      const series = results.find(item => item.name === selectedSeries)
      assert.ok(series && series.points.length > 5, "Expected the selected source series")
      assert.notEqual(Number(reading), series.points.at(-1).value, "Select an observation that differs from the latest sample")
      await plot.press("Enter")
      await tooltip.getByRole("button", { name: "Use sample for dashboard links" }).click()
      await tile.getByText("Links use selected sample at", { exact: false }).waitFor()
      await page.screenshot({ path: `${output}/${theme.toLowerCase()}-${width}.png` })
      await tile.getByRole("button", { name: "Open related dashboard from CPU utilization by node" }).click()
      await page.getByRole("menuitem", { name: /Selected observation destination/ }).click()
      await page.waitForURL(url => url.searchParams.get("dashboard") === target.id)
      const parameters = JSON.parse(new URL(page.url()).searchParams.get("vars"))
      assert.equal(parameters.reading, reading, "Destination must get the selected point, not the latest sample")
      assert.match(parameters.node, /^node-0[1-7]$/)
      assert.deepEqual(failures, [])
      assert.deepEqual(errors, [])
      console.log(`PASS historical observation drilldown: ${theme} ${width}px`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
