// Real browser checks of compact and scrollable statistics legends.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"
import { referenceDashboards, resultForReferenceQuery } from "./fixtures/reference-dashboard-data.ts"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const base = (process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015").replace(/\/+$/, "")
const output = join(root, "artifacts/insights/legend-layout")
const reports = [], errors = []
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
let currentPage
try {
  for (const { width, extra = false } of [{ width: 1440 }, { width: 390 }, { width: 390, extra: true }, { width: 320 }]) for (const theme of ["Light", "Dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width >= 1440 ? 1000 : 844 }, colorScheme: theme.toLowerCase(), reducedMotion: "reduce" })
    const page = await context.newPage(); currentPage = page; page.on("pageerror", error => errors.push(error.message))
    const api = await installRichChartFixtureAPI(page, base)
    const reference = referenceDashboards.find(board => board.id === "reference-service-overview")
    const board = structuredClone(reference.bundle.dashboards[0]), widget = board.widgets.find(item => item.id === "reference-service-overview-requests")
    widget.config = { ...widget.config, legendDisplay: "table", legendPosition: "right" }; widget.options.decimals = 2
    api.documents.set(board.id, board); for (const query of reference.bundle.savedQueries) api.savedQueries.set(query.id, structuredClone(query))
    await page.route(`${base}/api/insights/query`, async route => {
      const request = route.request().postDataJSON(), result = resultForReferenceQuery(request)
      if (extra && request.query.includes("reference_service_overview_requests")) for (const index of [5, 6]) result.series.push({ ...structuredClone(result.series[0]), name: `web_server_0${index}`, labels: { ...result.series[0].labels, server: `web_server_0${index}` } })
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) })
    })
    await page.goto(`${base}/dashboard/insights/?dashboard=${board.id}`, { waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Service overview", exact: true }).waitFor()
    await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
    const tile = page.locator(`[data-widget-id="${widget.id}"]`); await tile.scrollIntoViewIfNeeded()
    const legend = tile.getByRole("region", { name: "Series statistics", exact: true })
    const count = extra ? 6 : 4; await legend.locator("tbody tr").nth(count - 1).waitFor(); await page.evaluate(() => document.fonts.ready); await page.waitForTimeout(300)
    const geometry = await legend.evaluate(node => { const box = node.getBoundingClientRect(); return { height: node.clientHeight, content: node.scrollHeight, width: node.clientWidth, contentWidth: node.scrollWidth, top: box.top, bottom: box.bottom, plotHeight: node.parentElement.parentElement.querySelector("svg[role=group]").getBoundingClientRect().height, rows: [...node.querySelectorAll("tbody tr")].map(row => { const r=row.getBoundingClientRect(); return { name: row.querySelector("th")?.textContent, top:r.top, bottom:r.bottom, values:[...row.querySelectorAll("td")].map(cell => cell.textContent) } }) } })
    assert.equal(geometry.rows.length, count)
    assert.ok(geometry.plotHeight >= 95, `The plot must stay useful beside its legend: ${JSON.stringify(geometry)}`)
    assert.ok(geometry.rows.every(row => row.values.length === 3 && row.values.every(value => value.includes("req/s"))), "Current, mean and maximum keep their units")
    if (width >= 390 && !extra) {
      assert.ok(geometry.rows.every(row => row.top >= geometry.top - 1 && row.bottom <= geometry.bottom + 1), `All four rows should fit: ${JSON.stringify(geometry)}`)
      await tile.getByText("Scroll to see all statistics", { exact: false }).waitFor({ state: "hidden" })
      assert.equal(geometry.contentWidth, geometry.width, "All legend columns should be visible")
    }
    if (extra) {
      assert.ok(geometry.content > geometry.height + 1, "Additional series must remain accessible by scrolling")
      assert.equal(await legend.getAttribute("tabindex"), "0")
      await tile.getByText("Scroll to see all statistics", { exact: false }).waitFor()
      await legend.focus(); await page.keyboard.press("End")
      await page.waitForFunction(() => { const node=document.querySelector('[aria-label="Series statistics"]'); return node && node.scrollTop + node.clientHeight >= node.scrollHeight - 1 })
      assert.ok(await legend.locator("tbody tr").last().evaluate(row => {const box=row.closest('[aria-label="Series statistics"]').getBoundingClientRect(), r=row.getBoundingClientRect(); return r.top >= box.top - 1 && r.bottom <= box.bottom + 1}), "Keyboard scrolling exposes the final statistics row")
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Legend must not overflow the page")
    await page.screenshot({ path: join(output, `legend-${extra ? "extra-" : ""}${theme.toLowerCase()}-${width}.png`), animations: "disabled" })
    reports.push({ width, theme, extra, geometry }); console.log(`PASS statistics legend ${theme} ${width}px, ${count} rows`)
    await context.close()
  }
  assert.deepEqual(errors, []); await writeFile(join(output, "report.json"), JSON.stringify({ passed: true, reports, errors }, null, 2))
} catch(error) {
  await currentPage?.screenshot({ path: join(output, "failure.png"), animations: "disabled" }).catch(() => {})
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: false, reports, errors, error: error.stack }, null, 2)); console.error(error.stack); process.exitCode = 1
} finally { await browser.close() }
