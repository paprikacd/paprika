// Verify selection-binding guidance against actual Prometheus series, using a
// temporary dashboard and leaving its saved document untouched.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
const app = new URL(process.env.INSIGHTS_E2E_URL || origin.href)
for (const url of [origin, app]) assert.equal(url.hostname, "127.0.0.1")
const api = async (path, options) => {
  const response = await fetch(new URL(path, origin), options)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const base = await (await api("/api/insights/dashboards/local-gallery-service-pulse")).json()
const id = `selection-fields-e2e-${Date.now()}`
const document = { schemaVersion: 1, id, title: "Selection field authoring E2E", timeRange: "1h", refreshInterval: 0, variables: [{ name: "service", defaultValue: "checkout" }], widgets: [{
  id: "shares", title: "Service shares", type: "plugin", pluginId: "pie", dataKind: "metrics", providerId: base.widgets[0].providerId,
  query: 'sum by (service) (rate(paprika_demo_requests_total{cluster="omega"}[5m])) or vector(1)', unit: "", layout: { x: 0, y: 0, w: 6, h: 5 },
  selectionBindings: [{ variable: "service", source: "label", value: "service" }],
}] }
const path = `/api/insights/dashboards/${id}`
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
await mkdir("../artifacts/insights/selection-fields-live", { recursive: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: app.origin, theme })
    const page = await context.newPage(), errors = []
    let closing = false
    page.on("pageerror", error => errors.push(error.message))
    if (app.origin !== origin.origin) await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), headers = { ...route.request().headers() }
      delete headers.origin; delete headers.host
      try { await route.fulfill({ response: await route.fetch({ url: new URL(original.pathname + original.search, origin).href, headers }) }) }
      catch (error) { if (!closing) throw error }
    })
    try {
      await page.goto(`${app.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      const tile = page.locator('[data-widget-id="shares"]')
      await tile.getByRole("group", { name: "Service shares" }).waitFor()
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await tile.getByRole("button", { name: "Edit Service shares", exact: true }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      await editor.getByRole("tab", { name: "Links" }).click()
      const input = editor.getByLabel("Selection 1 field", { exact: true })
      assert.ok(await input.evaluate(element => [...element.list.options].some(option => option.value === "service")))
      await editor.getByText(/“service” appears in \d+ of \d+ loaded series/).waitFor()
      await input.fill("missing_label")
      await editor.getByText(/current result has no “missing_label” label/).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
      assert.deepEqual(errors, [])
      await page.screenshot({ path: `../artifacts/insights/selection-fields-live/${theme}-${width}.png` })
      console.log(`PASS ${theme} ${width}px: loaded metric labels, incomplete selection warning and missing-label guidance`)
    } finally {
      closing = true
      await page.unrouteAll({ behavior: "ignoreErrors" })
      await context.close()
    }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
