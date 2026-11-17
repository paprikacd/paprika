// Exact same-time comparison against the isolated Prometheus-backed gallery.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const endpoint = new URL("/api/insights/dashboards/local-gallery-edge-watch", origin)
const initial = await fetch(endpoint), document = await initial.text()
const etag = initial.headers.get("x-paprika-document-etag") ?? initial.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      const response = page.waitForResponse(response => {
        const request = response.request()
        if (!response.url().includes("/api/insights/query") || request.method() !== "POST") return false
        try { return request.postDataJSON().query?.includes("paprika_demo_network_mbps") && !request.postDataJSON().query?.includes("direction=") } catch { return false }
      })
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", origin).href, { waitUntil: "networkidle" })
      const result = await (await response).json()
      assert.equal(result.series.length, 2)
      const chart = page.locator('[data-widget-id="flow"] svg[role="group"]')
      await chart.scrollIntoViewIfNeeded(); await chart.focus(); await chart.press("ArrowLeft")
      const panel = page.getByRole("region", { name: "Observation details" })
      await panel.waitFor()
      const list = panel.getByRole("list", { name: "Series at selected time" })
      assert.equal(await list.locator("li").count(), 2)
      const timestamp = Date.parse(await panel.locator("time").first().getAttribute("datetime"))
      for (const [index, series] of result.series.entries()) {
        const expected = series.points.find(point => point.timestamp === timestamp)
        const row = list.locator(`li[data-series-index="${index}"]`)
        assert.equal(await row.getAttribute("data-series-value"), expected?.value == null ? "missing" : String(expected.value), "Each displayed comparison must use the exact returned timestamp")
      }
      await chart.press("Enter")
      assert.equal(await panel.getByRole("button", { name: "Unpin observation" }).getAttribute("aria-pressed"), "true")
      await page.keyboard.press("Escape"); await panel.waitFor({ state: "hidden" })
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: exact multi-series observations, pin and dismiss`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
const after = await fetch(endpoint)
assert.equal(await after.text(), document)
assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag)
