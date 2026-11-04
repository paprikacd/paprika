// Author a geo selection binding through the actual editor, persist it through
// Insights, then verify the selected record drives a real PostgreSQL query.
// All dashboard writes target unique documents in a local-only gallery store.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
const app = new URL(process.env.INSIGHTS_E2E_URL || origin.href)
for (const url of [origin, app]) assert.equal(url.hostname, "127.0.0.1", "The test requires loopback-only services")
const out = resolve(fileURLToPath(new URL("../../artifacts/insights/geo-authoring-live", import.meta.url)))
await mkdir(out, { recursive: true })
const api = async (path, options) => {
  const response = await fetch(new URL(path, origin), options)
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
  return response
}
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const source = await (await api("/api/insights/dashboards/local-gallery-edge-watch")).json()
    const id = `geo-authoring-e2e-${Date.now()}-${width}-${theme.toLowerCase()}`
    source.id = id
    source.title = "Geo authoring E2E"
    const geo = source.widgets.find(widget => widget.id === "geo-honeycomb")
    delete geo.selectionBindings
    const created = await api(`/api/insights/dashboards/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(source) })
    const initialETag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" })
    const page = await context.newPage(), errors = []
    let closing = false
    page.on("pageerror", error => errors.push(error.message))
    if (app.origin !== origin.origin) await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), destination = new URL(original.pathname + original.search, origin)
      const headers = { ...route.request().headers() }; delete headers.origin; delete headers.host
      try { await route.fulfill({ response: await route.fetch({ url: destination.href, headers }) }) }
      catch (error) { if (!closing) throw error }
    })
    try {
      await page.goto(`${app.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const tile = page.locator('[data-widget-id="geo-honeycomb"]')
      await tile.scrollIntoViewIfNeeded()
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await tile.getByRole("button", { name: "Edit Source requests · honeycomb", exact: true }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      await editor.getByRole("tab", { name: "Links" }).click()
      const controls = editor.getByRole("region", { name: "Dashboard selection filters" })
      await controls.getByRole("button", { name: "Add selection binding" }).click()
      await selectGammaOption(page, controls.getByRole("combobox", { name: "Selection 1 variable" }), "Location")
      await controls.getByLabel("Selection 1 field", { exact: true }).fill("label")
      await editor.getByRole("button", { name: "Apply widget" }).click()
      const savedWrite = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/insights/dashboards/${id}` && response.ok())
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
      await savedWrite
      const savedResponse = await api(`/api/insights/dashboards/${id}`)
      const saved = await savedResponse.json(), savedETag = savedResponse.headers.get("x-paprika-document-etag") ?? savedResponse.headers.get("etag")
      assert.ok(initialETag && savedETag && initialETag !== savedETag, "Editor changes must persist with a new document revision")
      assert.deepEqual(saved.widgets.find(widget => widget.id === geo.id).selectionBindings, [{ variable: "location", source: "label", value: "label" }])
      await page.reload({ waitUntil: "networkidle" })
      const detail = page.locator('[data-widget-id="geo-selected-detail"]')
      await detail.scrollIntoViewIfNeeded()
      await detail.getByText("Melbourne sample 1").waitFor()
      await tile.scrollIntoViewIfNeeded()
      const target = tile.getByRole("button", { name: /Tokyo sample 2 ·/ })
      await target.waitFor()
      await target.focus()
      assert.ok(!page.url().includes("Tokyo"), "Focus alone must not change the filter")
      const query = page.waitForResponse(response => {
        if (!response.url().includes("/api/insights/query") || response.request().method() !== "POST" || !response.ok()) return false
        try { const request = response.request().postDataJSON(); return request.kind === "records" && JSON.stringify(JSON.parse(request.query).parameters) === JSON.stringify(["omega", "Tokyo sample 2"]) } catch { return false }
      })
      await target.press("Enter")
      await page.waitForURL(/Tokyo/)
      await detail.scrollIntoViewIfNeeded()
      const observedRequest = (await query).request().postDataJSON()
      const returned = await (await api("/api/insights/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(observedRequest) })).json()
      const field = returned.records.columns.findIndex(column => column.key === "label")
      assert.ok(returned.records.rows.some(row => row[field] === "Tokyo sample 2"), "The destination query must return the exact selected record")
      await detail.getByText("Tokyo sample 2").waitFor()
      const persisted = await (await api(`/api/insights/dashboards/${id}`)).json()
      assert.equal(persisted.variables.find(variable => variable.name === "location").defaultValue, "Melbourne sample 1", "Selection is view-only")
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
      assert.deepEqual(errors, [])
      await page.screenshot({ path: `${out}/${theme.toLowerCase()}-${width}.png` })
      console.log(`PASS ${theme} ${width}px: author, save, reload and select a real geo observation`)
    } finally {
      closing = true
      await context.close()
      const current = await api(`/api/insights/dashboards/${id}`)
      const etag = current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag")
      assert.ok(etag)
      await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": etag } })
    }
  }
} finally { await browser.close() }
