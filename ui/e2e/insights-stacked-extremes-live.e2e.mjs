// Exercise extreme signed scales and overflowing stacks through the real
// local Prometheus provider and the browser, without modifying shared data.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium } from "playwright"

const receipt = JSON.parse(await readFile(process.argv[2], "utf8"))
assert.equal(receipt.syntheticData, true)
const origin = new URL(receipt.url)
assert.ok(origin.protocol === "http:" && origin.hostname === "127.0.0.1" && !origin.username && !origin.password)
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}: ${await response.clone().text()}`)
  return response
}
const saved = (await (await api("/api/insights/saved-queries")).json()).queries.find(query => query.id === "local-signal-rate")
assert.ok(saved?.providerId)
const label = (value, name) => `label_replace(vector(${value}),"side","${name}","","")`
const signed = `${label("1e308", "positive")} or ${label("-1e308", "negative")}`
const traffic = `${label("1e308", "inbound")} or ${label("1e308", "outbound")}`
const overflowing = `${label("1e308", "a")} or ${label("1e308", "b")}`
const id = `stacked-extremes-${Date.now()}`
const path = `/api/insights/dashboards/${id}`
const widget = (id, query, pluginId, x, config = {}) => ({ id, title: id, type: "plugin", pluginId, dataKind: "metrics", providerId: saved.providerId, query, unit: "", options: { showLegend: true }, config, layout: { x, y: 0, w: 4, h: 4 } })
const document = { schemaVersion: 1, id, title: "Extreme stacks validation", timeRange: "15m", refreshInterval: 0, variables: [], widgets: [widget("signed", signed, "stacked-timeseries", 0), widget("traffic", traffic, "directional-traffic", 4, { directionLabel: "side", outboundValue: "outbound" }), widget("overflow", overflowing, "stacked-timeseries", 8)] }
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(value => localStorage.setItem("paprika-insights-theme", value), theme)
    const page = await context.newPage(), errors = [], returned = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("response", response => {
      if (new URL(response.url()).pathname === "/api/insights/query" && response.ok()) {
        try { if ([signed, traffic, overflowing].includes(response.request().postDataJSON().query)) returned.push(response.json()) } catch { /* Ignore unrelated responses. */ }
      }
    })
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
      for (const name of ["signed", "traffic"]) {
        const panel = page.locator(`[data-widget-id="${name}"]`)
        await panel.scrollIntoViewIfNeeded()
        const labels = panel.locator("[data-value-axis]")
        await labels.first().waitFor()
        const positions = await labels.evaluateAll(nodes => nodes.map(node => Number(node.getAttribute("y"))))
        assert.ok(positions.length >= 3 && positions.every(Number.isFinite) && new Set(positions).size === positions.length, `${name} finite distinct axis positions`)
        const marks = panel.locator("[data-metric-marks] path")
        assert.ok(await marks.count() >= 2, `${name} draws both series`)
        for (const geometry of await marks.evaluateAll(paths => paths.map(path => path.getAttribute("d")))) assert.doesNotMatch(geometry, /NaN|Infinity/)
      }
      const overflow = page.locator('[data-widget-id="overflow"]')
      await overflow.scrollIntoViewIfNeeded()
      await overflow.getByText(/time columns? omitted: the stack exceeds the finite numeric range/i).waitFor()
      assert.equal(await overflow.locator("[data-metric-marks] path").count(), 0, "No partial stacked geometry should imply a complete total")
      const chart = overflow.getByRole("group", { name: /Stacked observations/ })
      await chart.focus()
      const details = page.getByRole("region", { name: "Observation details" })
      await details.waitFor()
      await details.getByText(/stack exceeds the finite numeric range/i).waitFor()
      assert.ok(await details.locator('[data-metric-value="1e+308"]').count(), "The original finite observation remains inspectable")
      const responses = await Promise.all(returned)
      assert.equal(responses.length, 3)
      assert.ok(responses.every(result => result.series?.length === 2 && result.series.every(series => Number.isFinite(series.points.at(-1).value))))
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: finite signed axes, omitted overflowing stack and exact inspection`)
    } finally { await context.close() }
  }
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
} finally {
  await browser.close()
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
