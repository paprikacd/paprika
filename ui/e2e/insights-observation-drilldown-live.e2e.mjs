// Real-provider historical-point navigation against an isolated local gallery.
// No query intercepts: Prometheus supplies the samples via Insights/Observe.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const base = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(base.hostname, "127.0.0.1", "Only the isolated loopback gallery is supported")
assert.equal(base.protocol, "http:")
const run = `obs-live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
const sourceID = `${run}-source`, targetID = `${run}-target`
const path = id => new URL(`/api/insights/dashboards/${id}`, base)
const etag = response => response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
const created = []
const output = resolve(fileURLToPath(new URL("../../artifacts/insights/observation-drilldown-live", import.meta.url)))
await mkdir(output, { recursive: true })

async function create(doc) {
  const response = await fetch(path(doc.id), { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(doc) })
  assert.equal(response.status, 200, `Create ${doc.id}: ${await response.text()}`)
  const version = etag(response)
  assert.ok(version, `Create ${doc.id} must return an ETag`)
  created.push({ id: doc.id, version })
}

let browser
try {
  const response = await fetch(path("local-gallery-fleet-atlas"))
  assert.equal(response.status, 200)
  const original = await response.json()
  const source = structuredClone(original)
  source.id = sourceID
  source.title = "Historical observation source · E2E"
  source.widgets = [source.widgets.find(widget => widget.id === "node-cpu")]
  const chart = source.widgets[0]
  chart.layout = { x: 0, y: 0, w: 12, h: 6 }
  chart.drilldowns = [{ id: "detail", title: "Historical observation destination", dashboardId: targetID, carryTimeRange: true, bindings: [{ variable: "reading", source: "value" }, { variable: "node", source: "label", value: "node" }] }]
  const target = structuredClone(original)
  target.id = targetID
  target.title = "Historical observation destination · E2E"
  target.variables.push({ name: "reading", label: "Reading", defaultValue: "" })
  target.widgets = [target.widgets.find(widget => widget.id === "selected-node-history")]
  target.widgets[0].layout = { x: 0, y: 0, w: 12, h: 6 }
  await create(target)
  await create(source)
  browser = await chromium.launch({ headless: true })
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" })
    const page = await context.newPage(), errors = [], responses = []
    page.setDefaultTimeout(30000)
    page.on("pageerror", error => errors.push(error.message))
    page.on("response", response => {
      if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return
      try {
        const request = response.request().postDataJSON()
        if (request.kind === "metrics" && request.query.includes("paprika_demo_node_cpu_ratio"))
          responses.push(response.json().then(data => ({ request, data })).catch(() => null))
      } catch { /* Ignore unrelated results. */ }
    })
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${sourceID}`, base).href, { waitUntil: "networkidle" })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const tile = page.locator('[data-widget-id="node-cpu"]')
      const plot = tile.getByRole("img", { name: "CPU utilization by node", exact: true })
      await plot.scrollIntoViewIfNeeded()
      await plot.focus()
      const tooltip = page.getByRole("tooltip")
      await tooltip.waitFor()
      for (let step = 0; step < 8; step++) await plot.press("ArrowRight")
      assert.equal(await tooltip.getByRole("button", { name: "Use sample for dashboard links" }).count(), 0, "Transient focus must not commit an observation")
      const observation = tooltip.locator("[data-observation-value]")
      const reading = await observation.getAttribute("data-observation-value")
      const timestamp = Number(await observation.getAttribute("data-observation-timestamp"))
      const seriesName = await observation.getAttribute("data-observation-series")
      assert.ok(Number.isFinite(Number(reading)) && Number.isFinite(timestamp))
      const results = (await Promise.all(responses)).filter(Boolean)
      const series = results.flatMap(result => result.data.series ?? []).find(item => item.name === seriesName && item.points.some(point => point.timestamp === timestamp && point.value === Number(reading)))
      assert.ok(series, "The selected exact timestamp and value must come from the live Prometheus query response")
      assert.notEqual(Number(reading), series.points.at(-1)?.value, "The selected point must differ from the latest sample")
      const node = series.labels.node
      assert.match(node, /^node-0[1-8]$/)
      await plot.press("Enter")
      await tooltip.getByRole("button", { name: "Use sample for dashboard links" }).click()
      await tile.getByText("Links use selected sample at", { exact: false }).waitFor()
      await page.screenshot({ path: `${output}/${theme.toLowerCase()}-${width}.png` })
      await tile.getByRole("button", { name: "Open related dashboard from CPU utilization by node" }).click()
      await page.getByRole("menuitem", { name: /Historical observation destination/ }).click()
      await page.waitForURL(url => url.searchParams.get("dashboard") === targetID)
      let url = new URL(page.url())
      const variables = JSON.parse(url.searchParams.get("vars"))
      assert.equal(variables.reading, reading, "The destination must get the exact selected value")
      assert.equal(variables.node, node, "The destination must get the selected provider label")
      assert.ok(url.searchParams.get("from") && url.searchParams.get("to"), "The dashboard window must be carried")
      const range = Date.parse(url.searchParams.get("to")) - Date.parse(url.searchParams.get("from"))
      assert.equal(range, 6 * 3600_000)
      await page.locator('[data-widget-id="selected-node-history"]').getByRole("img").waitFor()
      const destinationResults = (await Promise.all(responses)).filter(Boolean)
      assert.ok(destinationResults.some(({ request, data }) => request.query.includes(`node="${node}"`) && data.series?.some(item => item.labels.node === node)), "The bound node must reach the real destination query")
      await page.reload({ waitUntil: "networkidle" })
      url = new URL(page.url())
      assert.deepEqual(JSON.parse(url.searchParams.get("vars")), variables, "Reload must retain view-only context")
      assert.ok(url.searchParams.get("from") && url.searchParams.get("to"))
      assert.deepEqual(errors, [])
      console.log(`PASS real historical observation drilldown: ${theme} ${width}px`)
    } finally { await context.close() }
  }
  for (const { id, version } of created) {
    const current = await fetch(path(id))
    assert.equal(etag(current), version, "Viewing and navigation must not save either dashboard")
  }
} finally {
  await browser?.close()
  // Test-owned documents only, guarded by the exact creation ETags. A conflict
  // is reported and preserved rather than deleting somebody else's edit.
  for (const { id, version } of created.reverse()) {
    const response = await fetch(path(id), { method: "DELETE", headers: { "If-Match": version } })
    if (!response.ok && response.status !== 404) console.error(`Could not remove test dashboard ${id}: HTTP ${response.status}`)
  }
}
