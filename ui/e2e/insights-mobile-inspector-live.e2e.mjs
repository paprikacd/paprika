// A pinned, saved-query inspector can be made compact without losing the
// selected observation, refetching its child or rewriting the dashboard.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const dashboardPath = "/api/insights/dashboards/local-gallery-service-pulse"
const etag = response => response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
const before = await fetch(new URL(dashboardPath, origin))
assert.ok(before.ok && etag(before))
const browser = await chromium.launch({ headless: true })
await mkdir("../artifacts/insights/mobile-inspector-live", { recursive: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 760 }, colorScheme: theme, reducedMotion: "reduce", ...(width === 390 ? { hasTouch: true, isMobile: true } : {}) })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = [], childRequests = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("request", request => {
      if (new URL(request.url()).pathname !== "/api/insights/query" || request.method() !== "POST") return
      try {
        const payload = request.postDataJSON()
        if (payload.query?.includes("paprika_demo_requests_total") && !payload.query.includes("sum by (service)")) childRequests.push(payload)
      } catch { /* Ignore unrelated requests. */ }
    })
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-service-pulse", origin).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="request-history"]')
      await panel.evaluate(element => element.scrollIntoView({ block: "center" }))
      const chart = panel.getByRole("img", { name: "Request rate by service", exact: true })
      await chart.waitFor()
      await chart.focus()
      const tip = page.getByRole("tooltip")
      await tip.waitFor()
      const observation = tip.locator("[data-observation-timestamp]")
      const timestamp = await observation.getAttribute("data-observation-timestamp")
      const value = await observation.getAttribute("data-observation-value")
      await chart.press("Enter")
      await tip.getByRole("region", { name: "Selected service · request history" }).waitFor()
      await page.waitForLoadState("networkidle")
      const count = childRequests.length
      assert.ok(count > 0, "The tooltip must run its actual saved query")
      if (width === 390) {
        const minimize = tip.getByRole("button", { name: "Minimize inspector" })
        await minimize.waitFor()
        const expanded = await tip.boundingBox()
        await minimize.focus()
        await minimize.press("Enter")
        const restore = tip.getByRole("button", { name: "Show inspector details" })
        await restore.waitFor()
        assert.equal(await restore.getAttribute("aria-expanded"), "false")
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Show inspector details", "Focus stays on the toggle")
        assert.equal(await tip.getByRole("region", { name: "Selected service · request history" }).count(), 0, "Details are hidden while minimized")
        const compact = await tip.boundingBox()
        assert.ok(compact.width * compact.height < expanded.width * expanded.height / 2, "The minimized panel must substantially reduce the obstruction")
        await page.screenshot({ path: `../artifacts/insights/mobile-inspector-live/${theme}-minimized.png`, animations: "disabled" })
        await restore.press("Enter")
        await tip.getByRole("region", { name: "Selected service · request history" }).waitFor()
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Minimize inspector")
        assert.equal(await observation.getAttribute("data-observation-timestamp"), timestamp)
        assert.equal(await observation.getAttribute("data-observation-value"), value)
        await page.waitForLoadState("networkidle")
        assert.equal(childRequests.length, count, "Minimizing and restoring must not reissue the child query")
        await minimize.press("Enter")
        const close = tip.getByRole("button", { name: "Close inspector" })
        await close.focus()
        await close.press("Enter")
        await tip.waitFor({ state: "hidden" })
        assert.equal(await chart.evaluate(element => document.activeElement === element), true, "Closing returns focus to the chart")
      } else {
        assert.equal(await tip.getByRole("button", { name: "Minimize inspector" }).count(), 0, "Desktop keeps the existing inspector behavior")
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: pinned saved-query inspector and accessible compact controls`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
const after = await fetch(new URL(dashboardPath, origin))
assert.equal(etag(after), etag(before), "Inspecting leaves the saved dashboard unchanged")
