// Author a dashboard link from the loaded Prometheus label names, save it
// conditionally and follow the exact selected node into a real dashboard.
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
    const target = await read("local-gallery-fleet-atlas")
    const document = structuredClone(target.body)
    const id = `link-labels-e2e-${Date.now()}-${theme.toLowerCase()}-${width}`
    document.id = id; document.title = "Link label authoring E2E"
    const created = await api(`/api/insights/dashboards/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
    const initialETag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
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
      const tile = page.locator('[data-widget-id="node-cpu"]')
      await tile.scrollIntoViewIfNeeded()
      const chart = tile.getByRole("img", { name: "CPU utilization by node", exact: true })
      await chart.waitFor()
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await tile.getByRole("button", { name: "Edit CPU utilization by node", exact: true }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      await editor.getByRole("tab", { name: "Links" }).click()
      await editor.getByRole("button", { name: "Add dashboard link", exact: true }).click()
      await selectGammaOption(page, editor.getByRole("combobox", { name: "Link 1 destination", exact: true }), "Fleet Atlas · Local demo Local gallery demos")
      await editor.getByRole("button", { name: "Add variable binding to link 1", exact: true }).click()
      await selectGammaOption(page, editor.getByRole("combobox", { name: "Link 1 binding 1 variable", exact: true }), "Node node")
      const input = editor.getByLabel("Link 1 binding 1 label key", { exact: true })
      await editor.getByText(/Available result labels:.*node/).waitFor()
      assert.ok(await input.evaluate(element => [...element.list.options].some(option => option.value === "node")), "Loaded node labels should be suggested")
      await input.fill("node")
      await editor.getByRole("button", { name: "Apply widget" }).click()
      const write = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/insights/dashboards/${id}` && response.ok())
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
      await write
      const saved = await read(id)
      assert.ok(initialETag && saved.etag && initialETag !== saved.etag)
      const link = saved.body.widgets.find(item => item.id === "node-cpu").drilldowns[0]
      assert.deepEqual(link.bindings, [{ variable: "node", source: "label", value: "node" }])
      await page.reload({ waitUntil: "networkidle" })
      await tile.scrollIntoViewIfNeeded(); await chart.waitFor(); await chart.focus()
      await chart.press("ArrowRight")
      const tip = page.getByRole("tooltip")
      await tip.waitFor()
      const match = /node:\s*(node-\d+)/.exec(await tip.innerText())
      assert.ok(match, "The chart must expose the exact selected node")
      await chart.press("Enter")
      await tip.getByRole("button", { name: link.title, exact: true }).click()
      await page.waitForURL(url => url.searchParams.get("dashboard") === "local-gallery-fleet-atlas")
      assert.equal(JSON.parse(new URL(page.url()).searchParams.get("vars")).node, match[1])
      assert.deepEqual(await read("local-gallery-fleet-atlas"), target)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: discover, save and follow selected metric label`)
    } finally {
      closing = true
      await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close()
      const current = await read(id)
      await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": current.etag } })
    }
  }
} finally { await browser.close() }
