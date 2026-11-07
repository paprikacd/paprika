// Inject one temporary transport failure, then retry through the real local
// Insights/Observe/Prometheus stack. No successful data response is mocked.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const app = new URL(process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3199")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:51452")
for (const url of [app, api]) assert.equal(url.hostname, "127.0.0.1")
const path = "/api/insights/dashboards/local-gallery-edge-watch"
const saved = await fetch(new URL(path, api))
assert.equal(saved.status, 200)
const etag = saved.headers.get("x-paprika-document-etag") ?? saved.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(value => localStorage.setItem("paprika-insights-theme", value), theme)
    const page = await context.newPage(), errors = [], attempts = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url())
      if (original.pathname === "/api/insights/query" && route.request().method() === "POST") {
        const request = route.request().postDataJSON()
        if (request.query.includes("paprika_demo_network_mbps") && request.query.includes('direction="inbound"')) {
          attempts.push(request)
          if (attempts.length === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporary provider failure" }) })
        }
      }
      const headers = { ...route.request().headers() }; delete headers.origin; delete headers.host
      const response = await route.fetch({ url: new URL(original.pathname + original.search, api).href, headers })
      await route.fulfill({ response })
    })
    try {
      page.setDefaultTimeout(30000)
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", app).href, { waitUntil: "networkidle" })
      const card = page.locator('[data-widget-id="ingress"]')
      await card.scrollIntoViewIfNeeded()
      await card.getByRole("alert").waitFor()
      const retry = card.getByRole("button", { name: "Retry query for Ingress" })
      await retry.focus()
      await page.keyboard.press("Enter")
      await card.locator("[data-metric-value]").waitFor()
      const value = Number(await card.locator("[data-metric-value]").first().getAttribute("data-metric-value"))
      assert.ok(Number.isFinite(value) && value > 0, `Expected real positive ingress, got ${value}`)
      assert.equal(attempts.length, 2)
      assert.deepEqual(attempts[1], attempts[0], "Retry must use the same query and time range")
      assert.equal(await card.getByRole("alert").count(), 0)
      assert.deepEqual(errors, [])
      console.log(`PASS retry ${theme} ${width}px: injected failure then real Prometheus result`)
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally { await browser.close() }
const after = await fetch(new URL(path, api))
assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag, "Retry must not persist dashboard changes")
