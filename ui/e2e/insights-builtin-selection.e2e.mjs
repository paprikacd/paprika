// Built-in click-to-filter: timeseries legend, bar (legend, mark and tooltip-free bar), table, heatmap and traces
// filter a dashboard only on a deliberate press, mark the applied entry, and add one history step per change.
// Mocked API, so no live providers are needed. Run from ui/: node e2e/run-insights.mjs e2e/insights-builtin-selection.e2e.mjs
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { routeAnonymousAuthConfiguration } from "./anonymous-auth-fixture.mjs"

const base = process.env.INSIGHTS_E2E_URL
const services = ["api", "worker", "db"]
const bind = [{ variable: "service", source: "label", value: "service" }]
const w = (id, title, type, query, layout, extra = {}) => ({ id, title, type, providerId: "example-prometheus", query, unit: "req/s", layout, ...extra })
const dashboard = {
  schemaVersion: 1, id: "builtin-selection", title: "Built-in selection", timeRange: "1h", refreshInterval: 0,
  variables: [{ name: "service", label: "Service", defaultValue: "api", options: services }],
  widgets: [
    w("ts", "Requests by service", "timeseries", "requests{}", { x: 0, y: 0, w: 6, h: 5 }, { selectionBindings: bind }),
    w("bar", "Latest by service", "bar", "requests{}", { x: 6, y: 0, w: 6, h: 5 }, { selectionBindings: bind }),
    w("quiet", "Bar without tooltip", "bar", "requests{}", { x: 0, y: 5, w: 6, h: 5 }, { selectionBindings: bind, options: { showTooltip: false } }),
    w("table", "Service table", "table", "requests{}", { x: 6, y: 5, w: 6, h: 5 }, { selectionBindings: bind }),
    w("heat", "Service heatmap", "heatmap", "requests{}", { x: 0, y: 10, w: 6, h: 5 }, { selectionBindings: bind }),
    { id: "traces", title: "Recent traces", type: "traces", providerId: "example-tempo", query: "{}", unit: "ms", layout: { x: 6, y: 10, w: 6, h: 5 }, selectionBindings: bind },
  ],
}
const providers = [
  { id: "example-prometheus", name: "Test metric fixtures", type: "prometheus", capabilities: ["metrics"] },
  { id: "example-tempo", name: "Test trace fixtures", type: "tempo", capabilities: ["traces"] },
]
function result(request) {
  if (request.kind === "traces") {
    return { traces: services.map((service, i) => ({ traceId: `${i + 1}`.repeat(32).slice(0, 32), service, operation: `GET /${service}`, durationMs: 10 + i * 7, status: "ok", startTime: (request.end - 30 * (i + 1)) * 1000 })) }
  }
  const labels = Object.fromEntries([...request.query.matchAll(/([A-Za-z_]+)=("(?:\\.|[^"\\])*")/g)].map(m => [m[1], JSON.parse(m[2])]))
  return {
    series: services.flatMap((service, index) => {
      if (labels.service && labels.service !== service) return []
      return [{ name: service, labels: { service, __name__: "requests" }, points: Array.from({ length: 31 }, (_, p) => ({ timestamp: (request.start + (request.end - request.start) * p / 30) * 1000, value: 10 * (index + 1) + Math.sin(p / 3 + index) * 3 })) }]
    }),
  }
}
async function install(page) {
  await routeAnonymousAuthConfiguration(page)
  await page.route(`${new URL(base).origin}/api/insights/**`, async route => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace("/api/insights", "")
    let body
    let status = 200
    if (path === "/providers") body = { providers }
    else if (path === "/provider-configs") body = { providers: [] }
    else if (path === "/observe-connection") body = { configured: false, connected: false, transport: "mcp", tools: [], providerCount: 0 }
    else if (path === "/dashboards") body = { dashboards: [dashboard] }
    else if (path === "/saved-queries") body = { queries: [] }
    else if (path.startsWith("/dashboards/")) body = dashboard
    else if (path.endsWith("/metadata")) body = { values: [] }
    else if (path === "/query") body = result(request.postDataJSON())
    else { status = 404; body = { error: `unexpected ${path}` } }
    await route.fulfill({ status, contentType: "application/json", headers: { ETag: '"builtin-selection"' }, body: JSON.stringify(body) })
  })
}

const browser = await chromium.launch({ headless: true })
try {
  // Light at desktop width with a pointer; dark at phone width with touch, where the coarse-pointer rules apply.
  for (const [theme, width, phone] of [["light", 1512, false], ["dark", 390, true]]) {
    const tag = `${theme}-${width}`
    const context = await browser.newContext({ viewport: { width, height: 1000 }, hasTouch: phone, isMobile: phone, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", error => errors.push(error.message))
    await install(page)
    const tile = id => page.locator(`[data-widget-id="${id}"]`)
    // A Tab sweep or arrow keys never change the filters; only the deliberate presses below do.
    const act = async (locator) => { if (phone) await locator.tap(); else await locator.click() }
    await page.goto(`${base}/dashboard/insights/?dashboard=${dashboard.id}`)
    // Tiles load when they scroll into view, so visit each one before reading it.
    for (const id of ["ts", "bar", "quiet", "table", "heat", "traces"]) { await tile(id).scrollIntoViewIfNeeded(); await page.waitForTimeout(300) }
    await tile("table").getByText("worker").first().waitFor({ timeout: 60000 })
    await tile("traces").getByText("GET /worker").first().waitFor({ timeout: 30000 })
    await page.evaluate(() => window.scrollTo(0, 0))
    const start = page.url()

    if (phone) {
      // Touch-pointer rules apply to the bar legend: its rows must fit the footer without scrolling.
      const cdp = await context.newCDPSession(page)
      await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }] })
      await page.waitForTimeout(300)
      const legend = await tile("bar").locator('[role="list"][aria-label="Latest values by category"]').evaluate(node => ({ client: node.clientHeight, scroll: node.scrollHeight }))
      assert.ok(legend.scroll <= legend.client, `${tag}: bar legend fits its footer with touch rows (${JSON.stringify(legend)})`)
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.equal(overflow, 0, `${tag}: page must not scroll horizontally`)

    await page.locator("body").focus()
    for (let i = 0; i < 80; i++) await page.keyboard.press("Tab")
    assert.equal(page.url(), start, `${tag}: Tab focus changed filters`)
    const tsWorker = tile("ts").getByRole("button", { name: /worker/ }).first()
    await tsWorker.focus()
    await page.keyboard.press("ArrowRight")
    assert.equal(page.url(), start, `${tag}: arrow keys changed filters`)

    // Timeseries legend: a press filters, marks the applied entry, and re-activating it adds no history step.
    await act(tsWorker)
    await page.waitForFunction(() => location.search.includes("worker"), null, { timeout: 10000 })
    const afterTs = page.url()
    assert.equal(await tsWorker.getAttribute("aria-current"), "true", `${tag}: applied timeseries entry is marked`)
    const historyBefore = await page.evaluate(() => history.length)
    await act(tsWorker)
    await page.waitForTimeout(400)
    assert.equal(await page.evaluate(() => history.length), historyBefore, `${tag}: re-activating the applied entry adds no history step`)
    assert.equal(page.url(), afterTs)
    await page.goBack()
    await page.waitForTimeout(400)
    assert.equal(page.url(), start, `${tag}: Back restores the previous filter`)
    console.log(`PASS ${tag}: timeseries legend filters, marks, and Back restores`)

    // Bar legend, a bar with no tooltip (its mark), table row, heatmap cell and trace row each filter once.
    const barWorker = tile("bar").getByRole("button", { name: /worker/ }).first()
    await act(barWorker)
    await page.waitForFunction(() => location.search.includes("worker"), null, { timeout: 10000 })
    await page.goBack(); await page.waitForTimeout(400)
    assert.equal(page.url(), start, `${tag}: bar legend Back`)

    // Marks are read and clicked where they are on screen, so the tile must be in view first.
    await tile("quiet").scrollIntoViewIfNeeded()
    await page.waitForTimeout(300)
    const quietBars = await tile("quiet").evaluate(node => {
      const svg = [...node.querySelectorAll("svg")].sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
      return [...svg.querySelectorAll("rect")].map(r => r.getBoundingClientRect()).filter(b => b.width > 6 && b.height > 6 && b.width < 200).map(b => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }))
    })
    assert.ok(quietBars.length >= 3, `${tag}: quiet bar marks are visible`)
    const dbMark = quietBars.sort((a, b) => a.x - b.x)[2]
    await page.mouse.click(dbMark.x, dbMark.y)
    await page.waitForFunction(() => location.search.includes("db"), null, { timeout: 10000 })
    console.log(`PASS ${tag}: a bar with its tooltip hidden filters on its mark`)
    await page.goBack(); await page.waitForTimeout(400)
    assert.equal(page.url(), start, `${tag}: Back restores the filter before the keyboard step`)
    // With the tooltip off, a bar still takes keyboard focus and Enter filters on it.
    await tile("quiet").getByRole("img", { name: "Bar without tooltip" }).focus()
    await page.keyboard.press("ArrowRight")
    await page.keyboard.press("Enter")
    await page.waitForTimeout(400)
    assert.notEqual(page.url(), start, `${tag}: Enter on a bar with its tooltip hidden filters`)
    await page.goBack(); await page.waitForTimeout(400)

    await act(tile("table").locator("tbody tr", { hasText: "db" }).first())
    await page.waitForFunction(() => location.search.includes("db"), null, { timeout: 10000 })
    await page.goBack(); await page.waitForTimeout(400)

    await tile("heat").locator("button[aria-label]").first().focus()
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("ArrowRight")
    assert.equal(page.url(), start, `${tag}: heatmap arrow keys changed filters`)
    await page.keyboard.press("Enter")
    await page.waitForTimeout(400)
    assert.notEqual(page.url(), start, `${tag}: heatmap Enter filters`)
    await page.goBack(); await page.waitForTimeout(400)

    await act(tile("traces").locator("tbody tr", { hasText: "GET /worker" }).first())
    await page.waitForFunction(() => location.search.includes("worker"), null, { timeout: 10000 })
    console.log(`PASS ${tag}: bar legend, table row, heatmap cell and trace row each filter; keys and Tab do not`)

    assert.deepEqual(errors, [], `${tag}: no page errors`)
    await context.close()
  }
} finally {
  await browser.close()
}
