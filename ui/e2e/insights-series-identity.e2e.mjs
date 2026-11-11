// One service keeps one colour across a time series, a bar chart, a record chart and a stat sparkline, and across a
// refresh that reorders and adds series. Name mode is the default, so no series-colour mode is authored here.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { routeAnonymousAuthConfiguration } from "./anonymous-auth-fixture.mjs"

// The palette and the identity slots are pinned here, and series-palette.ts / series-color-identity.test.ts pin the same
// values: service=checkout hashes to slot 6 (zero-based), and an unlabelled series takes slot 0.
const SERIES_HEX = {
  light: ["#003d75", "#0c9a93", "#887fd0", "#127a8b", "#a75fa7", "#61516f", "#b77080", "#86885b"],
  dark: ["#21ccfe", "#32dcd5", "#ae7ecf", "#29a1a3", "#d76fa1", "#a5a1c9", "#e7a5c4", "#999a66"],
}

const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const prom = labels => `{${Object.keys(labels).sort().map(key => `${key}=${JSON.stringify(labels[key])}`).join(", ")}}`
const service = (name, value) => ({ name: prom({ service: name }), labels: { service: name }, value })
const sets = { phase: 0 }
const series = () => ({
  svc_overview: sets.phase === 0
    ? [service("catalog", 3), service("checkout", 5), service("worker", 7)]
    : [service("worker", 7), service("search", 2), service("checkout", 5), service("catalog", 3)],
  svc_pair: [service("api", 4), service("checkout", 5)],
  svc_checkout: [service("checkout", 5)],
  svc_total: [{ name: "Value", labels: {}, value: 9 }],
  svc_codes: ["200", "201", "404", "429", "500", "503"].map((code, index) => ({ name: prom({ status_code: code }), labels: { status_code: code }, value: index + 1 })),
})
const layout = (x, y, w = 6, h = 4) => ({ x, y, w, h })
const metric = (id, title, type, query, at, extra = {}) => ({ id, title, type, providerId: "prom", query, unit: "req/s", layout: at, options: { showLegend: true }, ...extra })
const dashboard = {
  schemaVersion: 1, id: "series-identity", title: "Series identity", timeRange: "1h", refreshInterval: 0,
  widgets: [
    metric("ts-overview", "Request rate by service", "timeseries", "svc_overview", layout(0, 0)),
    metric("bar-overview", "Latest by service", "bar", "svc_overview", layout(6, 0)),
    metric("ts-pair", "API vs checkout", "timeseries", "svc_pair", layout(0, 4)),
    metric("stat-checkout", "Checkout rate", "stat", "svc_checkout", layout(6, 4, 3, 3), { options: { showSparkline: true } }),
    metric("ts-total", "Total rate", "timeseries", "svc_total", layout(9, 4, 3, 3)),
    metric("ts-codes", "Requests by status", "timeseries", "svc_codes", layout(0, 8)),
    { id: "rec", title: "Records by service", type: "plugin", pluginId: "records-line", dataKind: "records", providerId: "rec", query: "{}", unit: "", layout: layout(6, 8), config: { x: "at", y: ["requests"], group: "service" } },
  ],
}
function query(request) {
  if (request.kind === "records") {
    const rows = []
    for (const [index, name] of ["catalog", "checkout", "worker"].entries()) for (let step = 0; step < 6; step++) rows.push([new Date(request.start * 1000 + step * 60000).toISOString(), name, index + step])
    return { records: { columns: [{ key: "at", type: "timestamp" }, { key: "service", type: "string" }, { key: "requests", type: "number" }], rows } }
  }
  const entries = series()[request.query] ?? []
  return { series: entries.map(entry => ({ name: entry.name, labels: entry.labels, points: Array.from({ length: 30 }, (_, step) => ({ timestamp: (request.start + (request.end - request.start) * step / 29) * 1000, value: entry.value + Math.sin(step) })) })) }
}

/** The rgb() a palette hex computes to, as the browser reports a swatch, stroke or fill colour. */
const toRgb = hex => `rgb(${[1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)).join(", ")})`
const checkoutSlot = 6

const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) {
    const rgb = slot => toRgb(SERIES_HEX[theme][slot])
    sets.phase = 0
    const context = await browser.newContext({ viewport: { width: 1512, height: 1400 }, reducedMotion: "reduce" })
    try {
      const page = await context.newPage(), errors = []
      page.on("pageerror", error => errors.push(error.message))
      await page.addInitScript(value => window.localStorage.setItem("paprika-insights-theme", value), theme)
      await routeAnonymousAuthConfiguration(page)
      await page.route(`${new URL(base).origin}/api/insights/**`, async route => {
        const request = route.request(), path = new URL(request.url()).pathname.replace("/api/insights", "")
        let body = {}, status = 200
        if (path === "/providers") body = { providers: [{ id: "prom", name: "Prom", type: "prometheus", capabilities: ["metrics"] }, { id: "rec", name: "Records", type: "shorted", capabilities: ["records"] }] }
        else if (path === "/provider-configs") body = { providers: [] }
        else if (path === "/observe-connection") body = { configured: false, connected: false, transport: "mcp", tools: [], providerCount: 0 }
        else if (path === "/dashboards") body = { dashboards: [dashboard] }
        else if (path === "/saved-queries") body = { queries: [] }
        else if (path === `/dashboards/${dashboard.id}`) body = dashboard
        else if (path.endsWith("/metadata")) body = { values: [] }
        else if (path === "/query") body = query(request.postDataJSON())
        else { status = 404; body = { error: path } }
        await route.fulfill({ status, contentType: "application/json", headers: { ETag: '"series-identity"' }, body: JSON.stringify(body) })
      })
      // Legend swatches, bar fills, record strokes and the stat sparkline, as the browser computes them.
      const legend = async id => {
        const tile = page.locator(`[data-widget-id="${id}"]`)
        await tile.scrollIntoViewIfNeeded()
        await tile.locator('[role="listitem"]').first().waitFor({ timeout: 15000 })
        return tile.evaluate(element => Object.fromEntries([...element.querySelectorAll('[role="listitem"]')].map(item => {
          const swatch = item.querySelector('[class*="swatch"], i')
          return [item.textContent.trim(), swatch ? getComputedStyle(swatch).backgroundColor : null]
        })))
      }
      const colourOf = (entries, name) => {
        const key = Object.keys(entries).find(label => label.includes(name))
        assert.ok(key, `legend lists ${name}: ${JSON.stringify(entries)}`)
        return entries[key]
      }
      const read = async () => {
        const out = { overview: await legend("ts-overview"), pair: await legend("ts-pair"), codes: await legend("ts-codes"), records: await legend("rec") }
        // A lone generic series shows no legend, so its colour is read from its line.
        const total = page.locator('[data-widget-id="ts-total"] path[stroke]').first()
        await total.waitFor({ timeout: 15000 })
        out.totalStroke = await total.evaluate(element => getComputedStyle(element).stroke)
        const bars = page.locator('[data-widget-id="bar-overview"] g[data-ts-key="bar-y-0"] rect')
        await bars.first().waitFor({ timeout: 15000 })
        out.barFills = await bars.evaluateAll(nodes => nodes.map(node => getComputedStyle(node).fill))
        const stat = page.locator('[data-widget-id="stat-checkout"] svg[data-stat-sparkline]')
        await stat.waitFor({ timeout: 20000 })
        out.statSparkline = await stat.evaluate(element => getComputedStyle(element).color)
        return out
      }
      await page.goto(`${base}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" })
      const first = await read()

      const checkout = rgb(checkoutSlot)
      assert.equal(colourOf(first.overview, "checkout"), checkout, "time series: checkout draws its identity slot")
      // The bar order is the result order: catalog, checkout, worker.
      // Bars follow the result order of the current phase, so find checkout's bar by its place in that order.
      const barOrder = series().svc_overview.map(entry => entry.labels.service)
      assert.equal(first.barFills[barOrder.indexOf("checkout")], checkout, "bar chart: checkout draws the same colour")
      assert.equal(colourOf(first.records, "checkout"), checkout, "record chart: the checkout group draws the same colour")
      assert.equal(first.statSparkline, checkout, "stat sparkline: checkout draws the same colour")
      assert.equal(colourOf(first.pair, "checkout"), checkout, "a second time series, with a different peer, keeps the colour")
      // A generic series ("Value") draws the first slot, which is the same colour the unlabelled stat uses.
      assert.equal(first.totalStroke, rgb(0), "an unlabelled series draws the first slot")
      // Distinct status codes keep distinct colours.
      const codeColours = Object.values(first.codes)
      assert.equal(new Set(codeColours).size, 6, `six status codes, six colours: ${JSON.stringify(first.codes)}`)

      sets.phase = 1
      await page.reload({ waitUntil: "networkidle" })
      const second = await read()
      assert.equal(colourOf(second.overview, "checkout"), checkout, "after a refresh that reorders and adds series, checkout keeps its colour")
      assert.equal(colourOf(second.records, "checkout"), checkout, "after the refresh the record group keeps its colour")
      assert.deepEqual(errors, [], "no page errors")
      console.log(`PASS ${theme}: one colour for checkout across time series, bar, record and stat, through a refresh`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
