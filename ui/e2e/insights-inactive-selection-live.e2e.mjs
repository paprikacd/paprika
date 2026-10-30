// A visualisation change must not hide retained dashboard-filter bindings.
// This uses a unique ETag-protected dashboard against the local provider.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
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
const id = `inactive-selection-e2e-${Date.now()}`
const document = { schemaVersion: 1, id, title: "Inactive selection E2E", timeRange: "1h", refreshInterval: 0, variables: [{ name: "service", defaultValue: "checkout" }], widgets: [{
  id: "shares", title: "Service shares", type: "plugin", pluginId: "pie", dataKind: "metrics", providerId: base.widgets[0].providerId,
  query: 'sum by (service) (rate(paprika_demo_requests_total{cluster="omega"}[5m]))', unit: "", layout: { x: 0, y: 0, w: 6, h: 5 },
  selectionBindings: [{ variable: "service", source: "label", value: "service" }],
}] }
const path = `/api/insights/dashboards/${id}`
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
let revision = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(revision)
const browser = await chromium.launch({ headless: true })
await mkdir("../artifacts/insights/inactive-selection-live", { recursive: true })
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
      await editor.getByLabel("Selection 1 field", { exact: true }).waitFor()
      const viz = editor.getByRole("combobox", { name: "Visualization" })
      await selectGammaOption(page, viz, /^Distribution heatmap/)
      await editor.getByText(/retained but inactive/).waitFor()
      await editor.getByText(/retained but inactive/).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `../artifacts/insights/inactive-selection-live/${theme}-${width}.png`, animations: "disabled" })
      assert.equal(await editor.getByRole("button", { name: "Add selection binding" }).count(), 0)
      await selectGammaOption(page, viz, /^Pie \/ donut/)
      assert.equal(await editor.getByLabel("Selection 1 field", { exact: true }).inputValue(), "service")
      await selectGammaOption(page, viz, /^Distribution heatmap/)
      await editor.getByRole("button", { name: "Remove inactive selection bindings" }).click()
      assert.equal(await editor.getByText(/retained but inactive/).count(), 0)
      if (theme === "dark" && width === 390) {
        await editor.getByRole("button", { name: "Apply widget" }).click()
        const write = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === path && response.ok())
        await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
        await write
        const saved = await api(path)
        const nextRevision = saved.headers.get("x-paprika-document-etag") ?? saved.headers.get("etag")
        assert.ok(nextRevision && nextRevision !== revision, "Explicit Save must create a new revision")
        const widget = (await saved.json()).widgets[0]
        assert.equal(widget.pluginId, "distribution-heatmap")
        assert.equal(widget.selectionBindings, undefined, "Explicit removal must persist")
        revision = nextRevision
      } else {
        // Closing a draft must leave the persisted binding and ETag unchanged.
        await editor.getByRole("button", { name: "Close widget editor" }).click()
        const persisted = await api(path)
        assert.equal(persisted.headers.get("x-paprika-document-etag") ?? persisted.headers.get("etag"), revision)
        assert.deepEqual((await persisted.json()).widgets[0].selectionBindings, document.widgets[0].selectionBindings)
      }
      assert.deepEqual(errors, [])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
      console.log(`PASS ${theme} ${width}px: inactive bindings are explained, recoverable and removable${theme === "dark" && width === 390 ? " with explicit save" : " without implicit persistence"}`)
    } finally { closing = true; await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), revision)
  await api(path, { method: "DELETE", headers: { "If-Match": revision } })
}
