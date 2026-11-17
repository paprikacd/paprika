// Read real Prometheus finite extreme values through the isolated Insights
// stack and verify gauge scales, inferred bounds and invalid-bound feedback.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const saved = (await (await api("/api/insights/saved-queries")).json()).queries.find(query => query.id === "local-signal-rate")
assert.ok(saved)
const id = `gauge-extremes-${Date.now()}`
const path = `/api/insights/dashboards/${id}`
const thresholds = [{ value: -1e308, color: "#00aa00", label: "Low" }, { value: 0, color: "#ffaa00", label: "Medium" }, { value: 5e307, color: "#cc0000", label: "High" }]
const widget = (id, query, options, config, x, y) => ({ id, title: id, type: "plugin", pluginId: "threshold-gauge", dataKind: "metrics", providerId: saved.providerId, query, unit: "", options: { ...options, showLegend: false }, config, layout: { x, y, w: 4, h: 4 } })
const document = { schemaVersion: 1, id, title: "Gauge extremes E2E", timeRange: "1h", refreshInterval: 0, variables: [], widgets: [
  ...["linear", "segmented", "radial"].map((display, index) => widget(display, "vector(5e307)", { min: -1e308, max: 1e308, thresholds }, { display, segments: 10 }, index * 4, 0)),
  widget("inferred-min", "vector(-1e308)", { max: -1e308 }, { display: "linear" }, 0, 4),
  widget("inferred-max", "vector(1e308)", { min: 1e308 }, { display: "linear" }, 4, 4),
  widget("invalid-bounds", "vector(1)", { min: Number.MAX_VALUE }, { display: "linear" }, 8, 4),
] }
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = [], responses = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("response", response => {
      if (new URL(response.url()).pathname === "/api/insights/query" && response.ok()) {
        try { if (response.request().postDataJSON().query === "vector(5e307)") responses.push(response.json()) } catch { /* Ignore unrelated requests. */ }
      }
    })
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
      for (const display of ["linear", "segmented", "radial"]) {
        const panel = page.locator(`[data-widget-id="${display}"]`)
        await panel.scrollIntoViewIfNeeded()
        const meter = panel.locator("[data-gauge-progress]")
        await meter.waitFor()
        assert.equal(Number(await meter.getAttribute("data-gauge-progress")), .75, `${display} fraction must remain finite`)
        assert.doesNotMatch(await meter.evaluate(element => element.outerHTML), /NaN|Infinity/)
        if (display === "segmented") {
          const colors = await meter.locator("[data-filled]").evaluateAll(items => items.map(item => item.style.getPropertyValue("--meter-fill")))
          assert.equal(colors.length, 10)
          assert.deepEqual([colors[0], colors[5], colors[9]], ["#00aa00", "#ffaa00", "#cc0000"])
        }
      }
      assert.ok(responses.length > 0, "Prometheus query must have completed")
      assert.equal((await responses.at(-1)).series[0].points.at(-1).value, 5e307)
      for (const id of ["inferred-min", "inferred-max"]) {
        const meter = page.locator(`[data-widget-id="${id}"] [role="meter"]`)
        await meter.scrollIntoViewIfNeeded()
        assert.ok(Number(await meter.getAttribute("aria-valuemin")) < Number(await meter.getAttribute("aria-valuemax")), `${id} must infer distinct bounds`)
      }
      const invalid = page.locator('[data-widget-id="invalid-bounds"]')
      await invalid.scrollIntoViewIfNeeded()
      await invalid.getByRole("alert").waitFor()
      assert.match(await invalid.getByRole("alert").innerText(), /finite gauge bounds/i)
      assert.equal(await invalid.getByRole("meter").count(), 0)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: finite gauge progress, thresholds, inferred bounds and invalid-bound feedback`)
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
