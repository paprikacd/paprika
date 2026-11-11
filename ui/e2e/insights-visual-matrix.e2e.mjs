// Structural visual baseline for Insights dashboards.
//
// Renders the 16 repository examples (sample mode) and the 4 reference dashboards (imported
// through the real UI into the Go fixture workspace) in light and dark at 1512, 768 and 390 px.
// Each render is judged by the DOM probe (ui/dashboard-probe.mjs) and summarised as: probe
// findings, page scroll overflow, every widget's tile box and a widget state (loaded, empty,
// error). The summary is compared with ui/e2e/baselines/visual-matrix.json, so a new finding,
// new page overflow, a lost or gained widget, a moved tile or a changed state fails the run.
// Pixels are not compared; the structural summary is the gate.
//
// No Docker and no Next dev server. The Go fixture harness serves the static export in ui/out,
// so build it first (CI already does):
//
//   cd ui && npm run build
//   node --experimental-strip-types e2e/insights-visual-matrix.e2e.mjs            # check
//   node --experimental-strip-types e2e/insights-visual-matrix.e2e.mjs --update   # rewrite baseline
//
// Output for a failed run is written to artifacts/insights/visual-matrix/ (gitignored).
//
// Gallery matrix (local only, not in CI): the same probe over the real Prometheus, Tempo and
// PostgreSQL gallery needs Docker, so it is not part of this baseline. To inspect those nine
// dashboards by hand, start the stack with `node demo/insights-gallery/up.mjs` from the repo root.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { dashboardProbe } from "../dashboard-probe.mjs"
import { tileNotReadySelector } from "../render-worker.mjs"
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs"
import { referenceDashboards, resultForReferenceQuery } from "./fixtures/reference-dashboard-data.ts"
import { compareMatrix, formatProblems } from "./fixtures/visual-matrix-diff.mjs"
import { selectGammaOption } from "./gamma-controls.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const baselinePath = fileURLToPath(new URL("./baselines/visual-matrix.json", import.meta.url))
const output = join(repository, "artifacts/insights/visual-matrix")
const catalogPath = join(repository, "ui/src/features/insights/repository-examples/catalog.json")
const widths = [1512, 768, 390]
const themes = ["light", "dark"]
const tolerancePx = 3
const viewportHeight = 980
const settleTimeout = 30_000
// Fixed clock so sample and reference data render the same text, and so the baseline is stable.
const fixedTime = new Date("2026-10-28T13:00:00Z")
const pendingSelector = `${tileNotReadySelector},[role="status"][aria-label="Loading widget"]`
const update = process.argv.includes("--update")
const started = Date.now()

// Runs in the page. Self-contained, because Playwright serializes only this function's source.
function measureDashboard() {
  const within = (element, selector) => element.matches(selector) || element.querySelector(selector) !== null
  const visible = element => typeof element.checkVisibility !== "function" || element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  const stateOf = tile => {
    const alerts = [...tile.querySelectorAll('[role="alert"]')].filter(alert => visible(alert))
    if (alerts.length || within(tile, '[data-widget-state="source-unavailable"]')) return "error"
    if (/No data in this time range|No observations returned/.test(tile.textContent)) return "empty"
    return "loaded"
  }
  const tiles = [...document.querySelectorAll("[data-widget-id]")]
  const widgets = {}
  for (const tile of tiles) {
    const id = tile.getAttribute("data-widget-id")
    if (id in widgets) throw new Error(`duplicate widget id ${id}`)
    const box = tile.getBoundingClientRect()
    widgets[id] = { box: [box.left, box.top, box.width, box.height].map(Math.round), state: stateOf(tile) }
  }
  return {
    scrollWidth: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    widgets,
  }
}

// Scrolls each tile into view so lazy widgets mount and load, then waits for all of them.
async function settle(page, key) {
  const count = await page.locator("[data-widget-id]").count()
  assert.ok(count >= 1, `${key}: no widget tiles rendered`)
  for (let index = 0; index < count; index++) {
    await page.locator("[data-widget-id]").nth(index).scrollIntoViewIfNeeded()
    await page.waitForFunction(([position, selector]) => {
      const tile = document.querySelectorAll("[data-widget-id]")[position]
      return !!tile && !(tile.matches(selector) || tile.querySelector(selector))
    }, [index, pendingSelector], { timeout: settleTimeout }).catch(() => {
      throw new Error(`${key}: widget ${index} did not finish loading within ${settleTimeout / 1000}s`)
    })
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(selector => ![...document.querySelectorAll("[data-widget-id]")]
    .some(tile => tile.matches(selector) || tile.querySelector(selector)), pendingSelector, { timeout: settleTimeout })
    .catch(() => { throw new Error(`${key}: widgets still loading at the end of the page`) })
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

async function captureRender(page, key, url) {
  const pageErrors = []
  const onError = error => pageErrors.push(error.message)
  page.on("pageerror", onError)
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-widget-id]", { timeout: settleTimeout })
    await settle(page, key)
    const probed = await page.evaluate(dashboardProbe, {})
    const measured = await page.evaluate(measureDashboard)
    assert.deepEqual(pageErrors, [], `${key}: page errors during render`)
    return {
      findings: probed.findings
        .map(finding => `${finding.ruleId}@${finding.widgetId || "(page)"}:${finding.severity.replace("SEVERITY_", "")}`)
        .sort(),
      page: { overflowPx: Math.max(0, measured.scrollWidth - measured.viewport) },
      widgets: Object.fromEntries(Object.keys(measured.widgets).sort().map(id => [id, measured.widgets[id]])),
    }
  } finally {
    page.off("pageerror", onError)
  }
}

// Imports the four reference dashboards through the UI, as the reference harness does,
// then returns the persisted dashboards keyed by reference id.
async function importReferenceDashboards(environment, browser) {
  const generated = { kind: "PaprikaDashboardLibrary", schemaVersion: 1, dashboards: [], savedQueries: [] }
  for (const reference of referenceDashboards) {
    const bundle = structuredClone(reference.bundle)
    for (const query of bundle.savedQueries) query.providerId = environment.providerIds[query.kind]
    for (const board of bundle.dashboards) for (const widget of board.widgets) {
      widget.providerId = environment.providerIds[widget.dataKind ?? (widget.type === "traces" ? "traces" : "metrics")]
    }
    generated.dashboards.push(...bundle.dashboards)
    generated.savedQueries.push(...bundle.savedQueries)
  }
  const context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, reducedMotion: "reduce", timezoneId: "UTC" })
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    await environment.installQueryFixture(page, resultForReferenceQuery)
    await page.goto(`${environment.baseURL}/dashboard/insights/`, { waitUntil: "networkidle" })
    await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
    const importer = page.getByRole("region", { name: "Portable dashboard import", exact: true })
    await selectGammaOption(page, importer.getByRole("combobox", { name: "Library import format", exact: true }), "JSON")
    await importer.getByRole("textbox", { name: "Library import source", exact: true }).fill(JSON.stringify(generated))
    await importer.getByRole("button", { name: "Review import", exact: true }).click()
    await importer.getByRole("button", { name: "Import 4 as new", exact: true }).click()
    await importer.getByText(/^4 dashboard decisions completed\./).waitFor({ timeout: 60000 })
    await page.getByRole("button", { name: "Close dashboard manager", exact: true }).click()
  } finally {
    await context.close()
  }
  const saved = (await environment.api("dashboards")).document.dashboards
  return referenceDashboards.map(reference => {
    const board = saved.find(item => item.title === reference.title)
    assert.ok(board, `reference dashboard "${reference.title}" was not imported`)
    return { id: reference.id, boardId: board.id }
  })
}

const renders = {}
const pageErrorsSeen = []
const timings = { milliseconds: {} }
let environment, browser
try {
  await mkdir(output, { recursive: true })
  environment = await createReferenceDashboardEnvironment(repository, undefined)
  browser = await chromium.launch({ headless: true })
  const references = await importReferenceDashboards(environment, browser)
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"))
  const examples = catalog.flatMap(entry => entry.sample.dashboards.map(board => ({ id: board.id })))
  assert.equal(examples.length, 16, "the repository examples catalog must hold 16 dashboards")
  assert.equal(references.length, 4, "the reference set must hold 4 dashboards")

  for (const theme of themes) for (const width of widths) {
    const label = `${theme}/${width}`
    const began = Date.now()
    // Examples run without a token; references run with the fixture credential and query resolver.
    const exampleContext = await browser.newContext({ viewport: { width, height: viewportHeight }, colorScheme: theme, reducedMotion: "reduce", timezoneId: "Australia/Melbourne", serviceWorkers: "block" })
    const referenceContext = await browser.newContext({ viewport: { width, height: viewportHeight }, colorScheme: theme, reducedMotion: "reduce", timezoneId: "Australia/Melbourne", serviceWorkers: "block" })
    try {
      for (const context of [exampleContext, referenceContext]) {
        await context.addInitScript(value => { try { localStorage.setItem("paprika-insights-theme", value) } catch { /* Storage can be blocked. */ } }, theme)
      }
      const examplePage = await exampleContext.newPage()
      await examplePage.clock.setFixedTime(fixedTime)
      for (const example of examples) {
        const key = `example/${example.id}/${label}`
        renders[key] = await captureRender(examplePage, key, `${environment.baseURL}/dashboard/insights/?example=1&dashboard=${encodeURIComponent(example.id)}`)
      }
      const referencePage = await referenceContext.newPage()
      await referencePage.clock.setFixedTime(fixedTime)
      await environment.installQueryFixture(referencePage, resultForReferenceQuery)
      for (const reference of references) {
        const key = `reference/${reference.id}/${label}`
        renders[key] = await captureRender(referencePage, key, `${environment.baseURL}/dashboard/insights/?dashboard=${encodeURIComponent(reference.boardId)}`)
      }
    } finally {
      await exampleContext.close()
      await referenceContext.close()
    }
    timings.milliseconds[label] = Date.now() - began
    console.log(`PASS rendered ${label}: ${Object.keys(renders).filter(key => key.endsWith(label)).length} dashboards in ${Math.round((Date.now() - began) / 1000)}s`)
  }

  const current = { schema: 1, tolerancePx, viewportHeight, renders: Object.fromEntries(Object.keys(renders).sort().map(key => [key, renders[key]])) }
  const runtimeSeconds = Math.round((Date.now() - started) / 1000)
  await writeFile(join(output, "current.json"), JSON.stringify(current, null, 2) + "\n")

  if (update) {
    await mkdir(dirname(baselinePath), { recursive: true })
    await writeFile(baselinePath, JSON.stringify(current, null, 2) + "\n")
    console.log(`Wrote ${Object.keys(current.renders).length} renders to ${baselinePath} in ${runtimeSeconds}s`)
  } else {
    const baseline = JSON.parse(await readFile(baselinePath, "utf8").catch(() => {
      throw new Error(`No visual baseline at ${baselinePath}. Create it with --update.`)
    }))
    const problems = compareMatrix(baseline, current, tolerancePx)
    if (problems.length) {
      console.error(formatProblems(problems, Object.keys(current.renders).length, "ui/e2e/baselines/visual-matrix.json"))
      process.exitCode = 1
    } else {
      console.log(`PASS visual matrix: ${Object.keys(current.renders).length} renders match the baseline in ${runtimeSeconds}s`)
    }
  }
} catch (error) {
  pageErrorsSeen.push(error.message)
  console.error(error.stack ?? error.message)
  process.exitCode = 1
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ update, timings, errors: pageErrorsSeen }, null, 2) + "\n").catch(() => {})
  await browser?.close()
  await environment?.close()
}
