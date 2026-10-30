// Exercise result-column discovery in the real widget editor and conditional
// persistence. Only unique dashboards in the isolated local store are changed.
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
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const document = await (await api("/api/insights/dashboards/local-gallery-market-lens")).json()
    const id = `record-fields-e2e-${Date.now()}-${theme.toLowerCase()}-${width}`
    document.id = id; document.title = "Record field authoring E2E"
    const widget = document.widgets.find(item => item.id === "composition")
    delete widget.config.group
    const created = await api(`/api/insights/dashboards/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
    const originalETag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" })
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
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const tile = page.locator('[data-widget-id="composition"]')
      await tile.scrollIntoViewIfNeeded()
      await tile.getByRole("group", { name: "Company composition by market cap" }).waitFor()
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await tile.getByRole("button", { name: "Edit Company composition by market cap", exact: true }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      await editor.getByText(/Available result fields:.*market_cap \(number\)/).waitFor()
      const group = editor.getByLabel("Group field", { exact: true })
      assert.ok(await group.evaluate(input => [...input.list.options].some(option => option.value === "sector")))
      const area = editor.getByLabel("Area field", { exact: true })
      assert.ok(await area.evaluate(input => [...input.list.options].some(option => option.value === "market_cap")))
      assert.equal(await area.evaluate(input => [...input.list.options].some(option => option.value === "sector")), false)
      await group.fill("sector")
      await editor.getByRole("tab", { name: "Links" }).click()
      const binding = editor.getByLabel("Selection 1 field", { exact: true })
      assert.ok(await binding.evaluate(input => [...input.list.options].some(option => option.value === "ticker")))
      assert.equal(await binding.inputValue(), "ticker")
      await editor.getByRole("button", { name: "Apply widget" }).click()
      const write = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/insights/dashboards/${id}` && response.ok())
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
      await write
      const saved = await api(`/api/insights/dashboards/${id}`)
      const savedETag = saved.headers.get("x-paprika-document-etag") ?? saved.headers.get("etag")
      assert.ok(originalETag && savedETag && originalETag !== savedETag)
      assert.equal((await saved.json()).widgets.find(item => item.id === "composition").config.group, "sector")
      await page.reload({ waitUntil: "networkidle" })
      await tile.scrollIntoViewIfNeeded()
      await tile.getByText("Technology", { exact: true }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: result fields, typed suggestions, selection binding, save and reload`)
    } finally {
      closing = true
      await page.unrouteAll({ behavior: "ignoreErrors" })
      await context.close()
      const current = await api(`/api/insights/dashboards/${id}`)
      const etag = current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag")
      await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": etag } })
    }
  }
} finally { await browser.close() }
