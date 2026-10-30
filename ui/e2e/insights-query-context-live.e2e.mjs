// Query preview must follow the dashboard's selected variables, even when the
// authored expression and time range have not changed.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
const app = new URL(process.env.INSIGHTS_E2E_URL || origin.href)
for (const url of [origin, app]) assert.equal(url.hostname, "127.0.0.1")
const api = async (path, options) => {
  const response = await fetch(new URL(path, origin), options)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const base = await (await api("/api/insights/dashboards/local-gallery-service-pulse")).json()
const id = `query-context-e2e-${Date.now()}`
const document = { schemaVersion: 1, id, title: "Query context E2E", timeRange: "1h", refreshInterval: 0,
  variables: [{ name: "service", label: "Service", defaultValue: "checkout", options: ["checkout", "payments"] }],
  widgets: [{ id: "requests", title: "Requests", type: "timeseries", providerId: base.widgets[0].providerId,
    query: 'rate(paprika_demo_requests_total{cluster="omega",service={{service}}}[5m])', unit: "", layout: { x: 0, y: 0, w: 6, h: 5 } }] }
const path = `/api/insights/dashboards/${id}`
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: app.origin, theme })
    const page = await context.newPage(), errors = [], requests = []
    let closing = false
    page.on("pageerror", error => errors.push(error.message))
    if (app.origin !== origin.origin) await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), headers = { ...route.request().headers() }
      delete headers.origin; delete headers.host
      if (original.pathname === "/api/insights/query") requests.push(route.request().postDataJSON())
      try { await route.fulfill({ response: await route.fetch({ url: new URL(original.pathname + original.search, origin).href, headers }) }) }
      catch (error) { if (!closing) throw error }
    })
    else page.on("request", request => { if (new URL(request.url()).pathname === "/api/insights/query") requests.push(request.postDataJSON()) })
    try {
      await page.goto(`${app.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await page.locator('[data-widget-id="requests"]').getByRole("button", { name: "Edit Requests", exact: true }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      const run = editor.getByRole("button", { name: "Run query", exact: true })
      await run.click()
      await editor.getByLabel("Query preview").waitFor()
      assert.ok(requests.some(request => request.query?.includes('service="checkout"')))
      await selectGammaOption(page, page.getByRole("combobox", { name: "Service", exact: true }), "payments")
      await editor.getByLabel("Query preview").waitFor({ state: "hidden" })
      await run.click()
      await editor.getByLabel("Query preview").waitFor()
      assert.ok(requests.some(request => request.query?.includes('service="payments"')))
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: query preview reruns with the newly selected service`)
    } finally { closing = true; await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
