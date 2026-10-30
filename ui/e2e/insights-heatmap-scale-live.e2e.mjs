// Compare linear and logarithmic presentation using the same real Prometheus
// histogram. This creates and removes only an isolated dashboard with ETags.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/heatmap-scale-live")
await mkdir(output, { recursive: true })
const api = async (path, init) => {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const source = await (await api("/api/insights/dashboards/local-gallery-service-pulse")).json()
const revisions = await Promise.all(["/api/insights/dashboards/local-gallery-signal-kit", "/api/insights/saved-queries/local-signal-latency-distribution"].map(async path => {
  const response = await api(path)
  return response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
}))
assert.ok(revisions.every(Boolean))
const distribution = source.widgets.find(widget => widget.id === "latency-distribution")
assert.ok(distribution?.queryRef)
const id = `heatmap-scale-${Date.now()}`
const make = (name, colorScale, x) => ({ ...structuredClone(distribution), id: name, title: `${name} density`, config: { ...distribution.config, colorScale }, layout: { x, y: 0, w: 6, h: 5 } })
const synthetic = { ...make("zero-and-missing", "logarithmic", 0), title: "Synthetic zero and missing buckets", layout: { x: 0, y: 5, w: 12, h: 4 }, query: [
  'label_replace(vector(0), "le", "1", "", "")',
  'label_replace(vector(0.001), "le", "2", "", "")',
  'label_replace(vector(1), "le", "3", "", "")',
  'label_replace(vector(0/0), "le", "4", "", "")',
  'label_replace(vector(1000), "le", "+Inf", "", "")',
].join(" or ") }
delete synthetic.queryRef
const inconsistent = { ...make("tiny-inconsistent", "logarithmic", 0), title: "Tiny non-monotonic bucket rates", layout: { x: 0, y: 9, w: 12, h: 4 }, query: [
  'label_replace(vector(1e-12), "le", "1", "", "")',
  'label_replace(vector(0), "le", "2", "", "")',
  'label_replace(vector(0), "le", "3", "", "")',
].join(" or ") }
delete inconsistent.queryRef
const document = { schemaVersion: 1, id, title: "Histogram color scale", timeRange: "1h", refreshInterval: 0, variables: source.variables, widgets: [make("linear", "linear", 0), make("logarithmic", "logarithmic", 6), synthetic, inconsistent] }
const path = `/api/insights/dashboards/${id}`
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = [], results = [], inconsistentResults = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("response", response => {
      if (new URL(response.url()).pathname === "/api/insights/query" && response.ok()) {
        const request = response.request().postDataJSON()
        if (request.query?.includes("paprika_demo_request_duration_seconds_bucket")) results.push({ request, data: response.json().catch(() => null) })
        if (request.query === inconsistent.query) inconsistentResults.push(response.json())
      }
    })
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
      const linear = page.locator('[data-widget-id="linear"]'), log = page.locator('[data-widget-id="logarithmic"]')
      await linear.locator('[data-bucket-value]').first().waitFor()
      await log.locator('[data-bucket-value]').first().waitFor()
      assert.ok(results.length > 0, "The real histogram must be queried")
      const frame = await results[0].data
      assert.ok(frame.series?.length > 1 && frame.series.every(item => item.points.length > 1))
      assert.equal(await linear.getByText(/Logarithmic · zero separate/).count(), 0)
      await log.getByText(/Logarithmic · zero separate/).waitFor()
      const cells = panel => panel.locator('[data-bucket-value]').evaluateAll(elements => elements.map(element => ({ upper: element.getAttribute('data-bucket-upper'), timestamp: element.getAttribute('data-timestamp'), value: element.getAttribute('data-bucket-value'), fill: element.getAttribute('fill') })))
      const left = await cells(linear), right = await cells(log)
      assert.deepEqual(right.map(({ upper, timestamp, value }) => ({ upper, timestamp, value })), left.map(({ upper, timestamp, value }) => ({ upper, timestamp, value })), "Color scaling must never change observed cells")
      assert.ok(right.some((cell, index) => cell.value !== "unknown" && Number(cell.value) > 0 && cell.fill !== left[index].fill), "Skewed real buckets must use different color bands")
      const states = page.locator('[data-widget-id="zero-and-missing"]')
      await states.scrollIntoViewIfNeeded()
      const zero = states.locator('[data-bucket-upper="1"][data-bucket-value="0"]').first()
      const missing = states.locator('[data-bucket-upper="4"][data-bucket-value="unknown"]').first()
      await zero.waitFor()
      await missing.waitFor()
      assert.match(await missing.getAttribute("fill"), /^url\(#.+-missing\)$/)
      assert.notEqual(await zero.getAttribute("fill"), await missing.getAttribute("fill"), "Observed zero and missing must have distinct rendering")
      await states.screenshot({ path: resolve(output, `states-${theme}-${width}.png`), animations: "disabled" })
      const small = page.locator('[data-widget-id="tiny-inconsistent"]')
      await small.scrollIntoViewIfNeeded()
      const invalid = small.locator('[data-bucket-upper="2"][data-bucket-value="unknown"]').first()
      const realZero = small.locator('[data-bucket-upper="3"][data-bucket-value="0"]').first()
      await invalid.waitFor()
      await realZero.waitFor()
      assert.ok(inconsistentResults.length > 0, "Tiny bucket values must come from the real provider response")
      const sourceBuckets = (await inconsistentResults.at(-1)).series
      assert.equal(sourceBuckets.find(series => series.labels.le === "1").points.at(-1).value, 1e-12)
      assert.equal(sourceBuckets.find(series => series.labels.le === "2").points.at(-1).value, 0)
      assert.equal(sourceBuckets.find(series => series.labels.le === "3").points.at(-1).value, 0)
      assert.match(await invalid.getAttribute("fill"), /^url\(#.+-missing\)$/)
      assert.notEqual(await invalid.getAttribute("fill"), await realZero.getAttribute("fill"), "A decreasing tiny bucket must be unknown, not an observed zero")
      const maximum = await small.locator('[aria-label^="Color encodes bucket"] > span').nth(1).innerText()
      assert.match(maximum, /≈1\.00e-12/, "A nonzero heatmap scale must not be labeled as zero by fixed decimals")
      await small.getByText(/non-monotonic or negative bucket observations omitted/i).waitFor()
      const noticeBounds = await small.evaluate(panel => {
        const text = [...panel.querySelectorAll("span")].find(element => element.textContent?.startsWith("Sampled observations"))
        const card = panel.getBoundingClientRect(), bounds = text?.getBoundingClientRect()
        return bounds ? { cardLeft: card.left, cardRight: card.right, textLeft: bounds.left, textRight: bounds.right } : null
      })
      assert.ok(noticeBounds && noticeBounds.textLeft >= noticeBounds.cardLeft && noticeBounds.textRight <= noticeBounds.cardRight + 1, `Heatmap notices must stay inside the widget: ${JSON.stringify(noticeBounds)}`)
      await small.screenshot({ path: resolve(output, `tiny-${theme}-${width}.png`), animations: "disabled" })
      await log.scrollIntoViewIfNeeded()
      const chart = log.getByRole("group", { name: /histogram buckets/ })
      await chart.focus()
      await page.getByRole("region", { name: "Observation details" }).waitFor()
      await page.keyboard.press("Escape")
      await log.screenshot({ path: resolve(output, `${theme}-${width}.png`), animations: "disabled" })
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-signal-kit", origin).href, { waitUntil: "networkidle" })
      const signal = page.locator('[data-widget-id="latency-distribution"]')
      await signal.scrollIntoViewIfNeeded()
      await signal.getByText(/Logarithmic · zero separate/).waitFor()
      const selected = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false
        const request = response.request().postDataJSON()
        return request.query?.includes("paprika_demo_request_duration_seconds_bucket") && request.query.includes("sum by (le)") && !request.query.includes("histogram_quantile") && request.query.includes('cluster="delta"')
      }, { timeout: 30000 })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "delta")
      await signal.scrollIntoViewIfNeeded()
      const selectedResponse = await selected
      const selectedFrame = await selectedResponse.json()
      assert.ok(selectedFrame.series?.length > 1, "Signal Kit must execute the saved histogram query for the selected cluster")
      await signal.getByText(/Logarithmic · zero separate/).waitFor()
      assert.deepEqual(errors, [])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      console.log(`PASS ${theme} ${width}px: real histogram values unchanged, logarithmic legend and exact inspection`)
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
  const after = await Promise.all(["/api/insights/dashboards/local-gallery-signal-kit", "/api/insights/saved-queries/local-signal-latency-distribution"].map(async path => {
    const response = await api(path)
    return response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
  }))
  assert.deepEqual(after, revisions, "Inspection and filtering do not change the saved dashboard or query")
}
