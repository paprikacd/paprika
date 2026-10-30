// Verify destination changes preserve a live query's drilldown bindings until
// explicitly confirmed, and that only saving the dashboard persists them.
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
const read = async id => {
  const response = await api(`/api/insights/dashboards/${id}`)
  return { body: await response.json(), etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") }
}
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const original = await read("local-gallery-fleet-atlas")
    const suffix = `${Date.now()}-${theme.toLowerCase()}-${width}`
    const ids = [`drilldown-source-${suffix}`, `drilldown-old-${suffix}`, `drilldown-new-${suffix}`]
    const oldTarget = { ...structuredClone(original.body), id: ids[1], title: `Drilldown old ${suffix}`, variables: [{ name: "node", label: "Node" }, { name: "region", label: "Region" }] }
    const newTarget = { ...structuredClone(original.body), id: ids[2], title: `Drilldown new ${suffix}`, variables: [{ name: "region", label: "Region" }] }
    const document = { ...structuredClone(original.body), id: ids[0], title: `Drilldown source ${suffix}` }
    const widget = document.widgets.find(item => item.id === "node-cpu")
    assert.ok(widget, "Real Prometheus-backed node CPU widget exists")
    widget.drilldowns = [{ id: "destination-check", title: "Inspect node", dashboardId: ids[1], bindings: [{ variable: "node", source: "label", value: "node" }, { variable: "region", source: "constant", value: "west" }] }]
    const created = []
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
      for (const doc of [oldTarget, newTarget, document]) {
        await api(`/api/insights/dashboards/${doc.id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(doc) })
        created.push(doc.id)
      }
      const before = await read(ids[0])
      await page.goto(`${app.origin}/dashboard/insights/?dashboard=${ids[0]}`, { waitUntil: "networkidle" })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const tile = page.locator('[data-widget-id="node-cpu"]')
      await tile.scrollIntoViewIfNeeded()
      await tile.getByRole("img", { name: "CPU utilization by node", exact: true }).waitFor()
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await tile.getByRole("button", { name: "Edit CPU utilization by node", exact: true }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      await editor.getByRole("tab", { name: "Links" }).click()
      const destination = editor.getByRole("combobox", { name: "Link 1 destination", exact: true })
      const chooseNew = () => selectGammaOption(page, destination, new RegExp(`Drilldown new ${suffix}`))
      await chooseNew()
      await editor.getByRole("status").getByText(/Bindings for node will be removed/).waitFor()
      const warning = editor.getByRole("status")
      const bounds = await warning.boundingBox()
      assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, "Confirmation remains inside the viewport")
      assert.match(await destination.innerText(), /Drilldown old/)
      assert.deepEqual(await read(ids[0]), before)
      await editor.getByRole("button", { name: "Keep current destination" }).click()
      assert.equal(await destination.evaluate(element => document.activeElement === element), true)
      await chooseNew()
      await editor.getByRole("button", { name: "Remove incompatible bindings and switch" }).click()
      assert.equal(await destination.evaluate(element => document.activeElement === element), true)
      assert.match(await destination.innerText(), /Drilldown new/)
      assert.match(await editor.getByRole("combobox", { name: "Link 1 binding 1 variable" }).innerText(), /Region/)
      assert.deepEqual(await read(ids[0]), before)
      await editor.getByRole("button", { name: "Apply widget" }).click()
      assert.deepEqual(await read(ids[0]), before)
      const write = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/insights/dashboards/${ids[0]}` && response.ok())
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
      await write
      const saved = await read(ids[0])
      assert.ok(before.etag && saved.etag && before.etag !== saved.etag)
      assert.deepEqual(saved.body.widgets.find(item => item.id === "node-cpu").drilldowns[0].bindings, [{ variable: "region", source: "constant", value: "west" }])
      assert.equal(saved.body.widgets.find(item => item.id === "node-cpu").drilldowns[0].dashboardId, ids[2])
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: destination confirmation and ETag-protected saved bindings`)
    } finally {
      closing = true
      await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close()
      for (const id of created.reverse()) {
        const current = await read(id)
        await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": current.etag } })
      }
    }
  }
} finally { await browser.close() }
