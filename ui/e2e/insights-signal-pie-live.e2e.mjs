// The permanent Signal Kit pie must render real synthetic provider observations
// and follow the same runtime cluster filter without changing saved documents.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const paths = ["/api/insights/dashboards/local-gallery-signal-kit", "/api/insights/saved-queries/local-signal-node-ratios"]
async function read(path) {
  const response = await fetch(new URL(path, origin))
  assert.ok(response.ok, `${path}: ${response.status}`)
  return { document: await response.text(), etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") }
}
const before = await Promise.all(paths.map(read))
assert.ok(before.every(item => item.etag))
const dashboard = JSON.parse(before[0].document), saved = JSON.parse(before[1].document)
const widget = dashboard.widgets.find(item => item.id === "node-ratio-shares")
assert.equal(widget?.pluginId, "pie")
assert.equal(widget?.queryRef?.id, saved.id)
assert.ok(widget.queryRef.bindings.some(binding => binding.parameter === "cluster" && binding.variable === "cluster"))
assert.match(widget.description, /relative shares.*not a measurement/i)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = [], writes = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("request", request => {
      if (/^\/api\/insights\/(dashboards|saved-queries)\//.test(new URL(request.url()).pathname) && ["PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(request.url())
    })
    const responseFor = cluster => page.waitForResponse(response => {
      if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false
      try { const query = response.request().postDataJSON().query; return query === saved.query.replaceAll("{{cluster}}", JSON.stringify(cluster)) } catch { return false }
    }, { timeout: 30000 })
    async function compare(panel, data, cluster) {
      assert.equal(data.series.length, 8)
      assert.ok(data.series.every(series => series.labels.cluster === cluster && series.labels.node))
      await page.waitForFunction(({ id, cluster }) => {
        const items = [...document.querySelectorAll(`[data-widget-id="${id}"] [data-pie-index]`)]
        return items.length === 8 && items.every(item => item.getAttribute("aria-label")?.includes(`cluster="${cluster}"`))
      }, { id: widget.id, cluster }, { timeout: 30000 })
      const shown = await panel.locator("[data-pie-index]").evaluateAll(items => items.map(item => ({ name: item.getAttribute("aria-label"), value: Number(item.getAttribute("data-pie-value")), timestamp: Number(item.getAttribute("data-pie-timestamp")) })))
      for (const series of data.series) {
        const latest = series.points.filter(point => Number.isFinite(point.timestamp)).reduce((a, b) => !a || b.timestamp >= a.timestamp ? b : a, null)
        assert.ok(latest && Number.isFinite(latest.value) && latest.value > 0)
        assert.ok(shown.some(item => item.name.includes(`node="${series.labels.node}"`) && item.value === latest.value && item.timestamp === latest.timestamp), `The ${cluster}/${series.labels.node} slice must match its actual latest observation`)
      }
      const legend = panel.getByRole("region", { name: `Legend for ${widget.title}` })
      const names = await legend.locator(":scope > span").evaluateAll(items => items.map(item => ({ text: [...item.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").trim(), title: item.getAttribute("title") })))
      assert.equal(names.length, 8)
      assert.equal(new Set(names.map(item => item.text)).size, 8)
      assert.ok(names.every(item => item.text.includes("node-") && item.title.includes(`cluster="${cluster}"`)))
    }
    try {
      const first = responseFor("omega")
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-signal-kit", origin).href, { waitUntil: "networkidle" })
      const panel = page.locator(`[data-widget-id="${widget.id}"]`)
      await panel.scrollIntoViewIfNeeded()
      await panel.getByRole("group", { name: widget.title, exact: true }).waitFor()
      const omega = await (await first).json()
      await compare(panel, omega, "omega")
      const slice = panel.locator("[data-pie-index]").first()
      await slice.focus()
      const tooltip = page.getByRole("tooltip")
      await tooltip.waitFor()
      assert.ok(await tooltip.locator("time").count() === 1, "Inspection includes the selected exact timestamp")
      await page.keyboard.press("Escape")
      const second = responseFor("delta")
      await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "delta")
      await panel.scrollIntoViewIfNeeded()
      const delta = await (await second).json()
      await compare(panel, delta, "delta")
      assert.notDeepEqual(delta.series.map(series => series.points.at(-1)?.value), omega.series.map(series => series.points.at(-1)?.value), "Selecting another cluster must change provider observations")
      assert.deepEqual(writes, [])
      assert.deepEqual(errors, [])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      console.log(`PASS ${theme} ${width}px: permanent saved-query pie follows cluster and exact provider values`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
assert.deepEqual(await Promise.all(paths.map(read)), before, "Viewing and filtering leave saved dashboard and query ETags unchanged")
