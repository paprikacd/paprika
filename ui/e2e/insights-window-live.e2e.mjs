// Optional real-provider window comparison smoke. No request interception.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated local gallery is allowed")
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/window-live")
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    try {
      const page = await context.newPage(), errors = [], replies = []
      page.on("pageerror", error => errors.push(error.message))
      page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/insights/query" && response.request().method() === "POST" && response.ok()) replies.push({ query: response.request().postDataJSON().query, data: response.json().catch(() => null) })
      })
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-service-pulse`, { waitUntil: "networkidle" })
      const chart = page.locator('[data-widget-id="error-history"]')
      await chart.scrollIntoViewIfNeeded()
      await chart.getByRole("button", { name: /Compare window for/ }).waitFor({ timeout: 30000 })
      await page.waitForLoadState("networkidle")
      const latest = Number(await chart.locator("[data-legend-timestamp]").first().getAttribute("data-legend-timestamp"))
      const queryCount = replies.filter(reply => reply.query?.includes('code="5xx"')).length
      await chart.getByRole("button", { name: /Compare window for/ }).click()
      const dialog = page.getByRole("dialog", { name: "Compare a window" })
      const start = dialog.getByRole("slider", { name: "Window start" }), end = dialog.getByRole("slider", { name: "Window end" })
      const maximum = Number(await end.getAttribute("max"))
      assert.ok(maximum > 5, "The real provider must return sufficient observations")
      await end.fill(String(Math.floor(maximum / 2)))
      await start.focus(); await start.press("ArrowRight")
      assert.equal(await start.inputValue(), "1", "Keyboard can adjust the selected start")
      assert.ok(await start.getAttribute("aria-valuetext"), "Slider exposes a readable timestamp")
      assert.ok(await dialog.getByRole("region", { name: "Window comparison" }).locator("tbody tr").count(), "Actual series comparisons are displayed")
      const errorReply = replies.find(reply => reply.query?.includes('code="5xx"'))
      assert.ok(errorReply, "Expected a real Prometheus error ratio query")
      const frame = await errorReply.data
      const points = frame.series[0].points
      const ordered = [...new Set(points.map(point => point.timestamp))].sort((a, b) => a - b)
      const valid = points.filter(point => point.timestamp >= ordered[1] && point.timestamp <= ordered[Math.floor(maximum / 2)] && typeof point.value === "number").sort((a, b) => a.timestamp - b.timestamp)
      const row = dialog.getByRole("region", { name: "Window comparison" }).locator("tbody tr").first()
      assert.ok(valid.length >= 2)
      assert.equal(await row.locator("time").first().getAttribute("datetime"), new Date(valid[0].timestamp).toISOString())
      assert.equal(await row.locator("time").last().getAttribute("datetime"), new Date(valid.at(-1).timestamp).toISOString())
      const changeBox = await row.locator('[data-label="Change"]').boundingBox(), compareBox = await dialog.getByRole("region", { name: "Window comparison" }).boundingBox()
      assert.ok(changeBox && compareBox && changeBox.x >= compareBox.x && changeBox.x + changeBox.width <= compareBox.x + compareBox.width + 1, "The change must be visible without horizontal scrolling")
      await page.screenshot({ path: resolve(output, `compare-${theme}-${width}.png`), animations: "disabled" })
      await dialog.getByRole("button", { name: "Zoom chart to window" }).click()
      await chart.getByRole("button", { name: "Reset chart zoom" }).waitFor()
      const zoomLatest = Number(await chart.locator("[data-legend-timestamp]").first().getAttribute("data-legend-timestamp"))
      assert.ok(zoomLatest < latest, "Zoom must show an earlier real observation, not the original latest value")
      assert.equal(replies.filter(reply => reply.query?.includes('code="5xx"')).length, queryCount, "Chart-local zoom must not re-run its provider query")
      await chart.getByRole("button", { name: "Reset chart zoom" }).click()
      assert.equal(Number(await chart.locator("[data-legend-timestamp]").first().getAttribute("data-legend-timestamp")), latest)
      await chart.getByRole("button", { name: /Compare window for/ }).click()
      const overview = dialog.locator("[data-window-overview]"), box = await overview.boundingBox()
      assert.ok(box)
      await page.mouse.move(box.x + box.width * .2, box.y + box.height / 2)
      await page.mouse.down(); await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2, { steps: 8 }); await page.mouse.up()
      assert.ok(Number(await start.inputValue()) > 0 && Number(await end.inputValue()) < maximum, "Pointer drag selects an inner window")
      await page.keyboard.press("Escape")
      assert.equal(await dialog.count(), 0, "Escape closes the comparison")
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: real observations, keyboard and drag selection, zoom and reset`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
