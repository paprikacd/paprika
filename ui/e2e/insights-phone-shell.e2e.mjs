// Phone shell (viewport <= 600px) on the browser-local example workspace and a seeded dashboard with variables.
// Sample mode makes no provider requests. Run from ui/: node e2e/run-insights.mjs e2e/insights-phone-shell.e2e.mjs
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/phone-shell")
const exampleStore = "paprika-insights-example-v1"
const themeKey = "paprika-insights-theme"
const viewports = [{ width: 390, height: 844 }, { width: 360, height: 780 }]
const themes = ["light", "dark"]
const reports = [], pageErrors = []

// Two lines of description are shown on a phone; the rest waits behind More.
const edge = {
  schemaVersion: 1,
  id: "phone-edge",
  title: "Edge network",
  description: "Cache, origin and request health for every edge location we run, refreshed from the same sources as the on-call overview. The first two lines are what a phone shows first; the rest opens on demand.",
  timeRange: "1h",
  refreshInterval: 0,
  variables: [
    { name: "cluster", label: "Cluster", defaultValue: "omega", options: ["omega", "alpha", "beta"] },
    { name: "location", label: "Location", defaultValue: "Melbourne sample 1" },
  ],
  widgets: [
    { id: "edge-requests", title: "Requests", type: "stat", providerId: "example-prometheus", query: "sum(rate(http_requests_total[5m]))", unit: "req/s", options: { showSparkline: true, sparklinePlacement: "side", decimals: 0 }, layout: { x: 0, y: 0, w: 6, h: 2 } },
    { id: "edge-errors", title: "Error ratio", type: "stat", providerId: "example-prometheus", query: 'sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m])) * 100', unit: "%", options: { showSparkline: true, sparklinePlacement: "side", decimals: 2 }, layout: { x: 6, y: 0, w: 6, h: 2 } },
    { id: "edge-traffic", title: "Traffic over time", type: "timeseries", providerId: "example-prometheus", query: "sum by (service) (rate(http_requests_total[5m]))", unit: "req/s", layout: { x: 0, y: 2, w: 12, h: 4 } },
  ],
}

async function check(name, run) {
  try {
    const evidence = await run()
    reports.push({ name, passed: true, evidence })
    console.log(`PASS ${name}`)
  } catch (error) {
    reports.push({ name, passed: false, error: error.message })
    throw error
  }
}

/** Accessible name of the focused element, as a screen reader would announce its label. */
const focusedName = page => page.evaluate(() => {
  const element = document.activeElement
  if (!element || element === document.body) return null
  return element.getAttribute("aria-label") || element.textContent.trim()
})

/** Open the example workspace, or the seeded edge dashboard, in a fresh phone-sized context. */
async function open(browser, { viewport, theme, dashboard }) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", timezoneId: "UTC", isMobile: true, hasTouch: true })
  await context.addInitScript(([key, value]) => { localStorage.setItem(key, value) }, [themeKey, theme])
  const page = await context.newPage()
  page.on("pageerror", error => pageErrors.push(error.message))
  page.setDefaultTimeout(15_000)
  if (dashboard) {
    await page.goto(`${baseURL}/dashboard/insights/?example=1`, { waitUntil: "networkidle" })
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [exampleStore, JSON.stringify({ dashboards: [dashboard], activeId: dashboard.id })])
    await page.goto(`${baseURL}/dashboard/insights/?example=1&dashboard=${encodeURIComponent(dashboard.id)}`, { waitUntil: "networkidle" })
    await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor()
  } else {
    await page.goto(`${baseURL}/dashboard/insights/?example=1`, { waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Service overview", exact: true }).waitFor()
  }
  return { context, page }
}

/** Geometry of the phone shell: canvas top, first chart top, and horizontal overflow. */
const geometry = (page, chartId) => page.evaluate(id => {
  const canvas = document.querySelector('[data-testid="dashboard-canvas"]')
  const chart = document.querySelector(`[data-widget-id="${id}"]`)
  return {
    phoneShell: document.querySelector("[data-phone-shell]") !== null,
    viewportHeight: innerHeight,
    canvasTop: Math.round(canvas.getBoundingClientRect().top),
    chartTop: Math.round(chart.getBoundingClientRect().top),
    overflow: document.documentElement.scrollWidth - innerWidth,
  }
}, chartId)

/** Names of the focusable stops from the Dashboard actions trigger until the canvas, in Tab order. */
async function tabStopsToCanvas(page) {
  await page.evaluate(() => document.activeElement?.blur())
  const stops = []
  for (let index = 0; index < 24; index++) {
    await page.keyboard.press("Tab")
    const stop = await page.evaluate(() => {
      const element = document.activeElement
      if (!element || element === document.body) return "canvas"
      if (element.closest('[data-testid="dashboard-canvas"], [data-widget-id]')) return "canvas"
      return element.getAttribute("aria-label") || element.textContent.trim()
    })
    if (stop === "canvas") break
    stops.push(stop)
  }
  return stops
}

async function checkMenu(page, viewport) {
  const trigger = page.getByRole("button", { name: "Dashboard actions", exact: true })
  const menu = page.getByRole("menu", { name: "Dashboard actions", exact: true })
  const order = ["Edit dashboard", "Dashboard as code", "Query inspector", "Manage dashboards", "Build with AI", "Auto refresh off", "Every 15 s", "Every 30 s", "Every 1 min"]
  await trigger.focus()
  await page.keyboard.press("ArrowDown")
  await menu.waitFor()
  for (const group of ["Dashboard", "Workspace", "Auto refresh"]) await menu.getByRole("group", { name: group, exact: true }).waitFor()
  assert.equal(await focusedName(page), order[0], "ArrowDown opens the menu on its first item")
  const walked = [order[0]]
  for (let index = 1; index < order.length; index++) {
    await page.keyboard.press("ArrowDown")
    walked.push(await focusedName(page))
  }
  assert.deepEqual(walked, order, "Arrow keys cross the Dashboard, Workspace and Auto refresh groups in order")
  await page.keyboard.press("End")
  assert.equal(await focusedName(page), "Every 1 min", "End moves to the last item across groups")
  await page.keyboard.press("Escape")
  await menu.waitFor({ state: "detached" })
  assert.equal(await focusedName(page), "Dashboard actions", "Escape returns focus to the menu trigger")
  return { items: order.length, viewport: viewport.width }
}

async function checkEditFocus(page) {
  await page.getByRole("button", { name: "Dashboard actions", exact: true }).click()
  await page.getByRole("menuitem", { name: "Edit dashboard", exact: true }).click()
  const title = page.getByRole("textbox", { name: "Dashboard title", exact: true })
  await title.waitFor()
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Dashboard title")
  assert.equal(await page.getByRole("button", { name: "Save dashboard", exact: true }).isVisible(), true, "Editing shows Save")
  assert.equal(await page.getByRole("button", { name: "Edit dashboard", exact: true }).count(), 0, "Edit is not a header button on phones")
}

// The control row is one line: every visible control in the Dashboard view group shares its top edge, so nothing wraps under the chip.
async function checkControlRow(page) {
  const tops = await page.locator('[role="group"][aria-label="Dashboard view"] > :not(dialog)').evaluateAll(elements => elements
    .filter(element => element.getBoundingClientRect().height > 0)
    .map(element => Math.round(element.getBoundingClientRect().top)))
  assert.ok(tops.length >= 2, `The Dashboard view group has ${tops.length} visible controls`)
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 2, `The control row wraps: control tops ${tops.join(", ")}`)
  return tops
}

async function checkSaveFocus(page) {
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
  await page.getByRole("textbox", { name: "Dashboard title", exact: true }).waitFor({ state: "hidden" })
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Dashboard actions")
}

async function checkSheet(page) {
  const chip = page.getByRole("button", { name: /^Dashboard variables:/ })
  const dialog = page.locator("dialog[open]")
  await chip.focus()
  await page.keyboard.press("Enter")
  await dialog.waitFor()
  assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, "Opening the sheet moves focus inside it")
  assert.equal(await dialog.getByRole("textbox", { name: "Location", exact: true }).isVisible(), true, "The sheet hosts the text variable")
  await page.keyboard.press("Escape")
  await dialog.waitFor({ state: "detached" })
  assert.match(await focusedName(page), /^Dashboard variables:/, "Escape returns focus to the variables chip")
}

const browser = await chromium.launch({ headless: true })
await mkdir(output, { recursive: true })
try {
  for (const viewport of viewports) for (const theme of themes) {
    const label = `${viewport.width}x${viewport.height} ${theme}`

    await check(`${label}: example first chart above the fold, no overflow, menu groups and focus`, async () => {
      const { context, page } = await open(browser, { viewport, theme })
      try {
        const shape = await geometry(page, "traffic")
        assert.equal(shape.phoneShell, true, "The phone shell is on at this width")
        assert.ok(shape.chartTop < shape.viewportHeight - 100, `First chart at ${shape.chartTop}px is not above the fold (${shape.viewportHeight}px tall)`)
        assert.ok(shape.canvasTop <= 300, `Canvas starts at ${shape.canvasTop}px, below the header and control row`)
        assert.ok(shape.overflow <= 1, `Page overflows horizontally by ${shape.overflow}px`)
        const stops = await tabStopsToCanvas(page)
        const start = stops.indexOf("Dashboard actions")
        assert.ok(start >= 0, `Dashboard actions is a tab stop: ${stops.join(", ")}`)
        // The example declares a service variable (R78), so its chip sits in the control row after Dashboard actions, as on the
        // edge dashboard below. A flagged attention chip (for example "1 critical") can follow Refresh, before the canvas.
        const [, chip, ...controls] = stops.slice(start)
        assert.match(chip ?? "", /^Dashboard variables: Service/, `The variables chip follows Dashboard actions: ${stops.slice(start).join(", ")}`)
        assert.deepEqual(controls.slice(0, 2), ["Time range", "Refresh data"], "Time range and Refresh follow the variables chip")
        for (const stop of controls.slice(2)) assert.match(stop, /: show first \w+ widget, /, `Only attention chips follow Refresh: ${stop}`)
        assert.equal(stops.includes("Edit dashboard") || stops.includes("Dashboard as code"), false, "Edit and Code are only in the menu")
        const controlRow = await checkControlRow(page)
        const menu = await checkMenu(page, viewport)
        await page.screenshot({ path: resolve(output, `example-${viewport.width}-${theme}.png`) })
        return { ...shape, tabStops: stops.slice(start), menu, controlRow }
      } finally {
        await context.close()
      }
    })

    await check(`${label}: edge dashboard shows the variables chip, sheet and Edit focus`, async () => {
      const { context, page } = await open(browser, { viewport, theme, dashboard: edge })
      try {
        const shape = await geometry(page, "edge-traffic")
        assert.ok(shape.chartTop < shape.viewportHeight - 100, `Edge first chart at ${shape.chartTop}px is not above the fold`)
        assert.ok(shape.overflow <= 1, `Page overflows horizontally by ${shape.overflow}px`)
        const stops = await tabStopsToCanvas(page)
        const start = stops.indexOf("Dashboard actions")
        assert.match(stops[start + 1], /^Dashboard variables:/, "The variables chip follows Dashboard actions")
        assert.deepEqual(stops.slice(start + 2), ["Time range", "Refresh data"], "Time range and Refresh follow the chip")
        await checkSheet(page)
        const controlRow = await checkControlRow(page)
        await checkEditFocus(page)
        await checkSaveFocus(page)
        await page.screenshot({ path: resolve(output, `edge-${viewport.width}-${theme}.png`) })
        return { ...shape, tabStops: stops.slice(start), controlRow }
      } finally {
        await context.close()
      }
    })
  }
  assert.deepEqual(pageErrors, [], "No page errors")
  console.log(`${reports.length} phone shell browser scenarios passed.`)
} finally {
  await browser.close()
}
