// Exercise the centered directional axis through the real editor and store.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const api = async (path, init) => {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status} ${await response.clone().text()}`)
  return response
}
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const source = await (await api("/api/insights/dashboards/local-gallery-edge-watch")).json()
    const id = `directional-axis-e2e-${Date.now()}-${width}-${theme}`
    source.id = id; source.title = "Directional axis E2E"
    const flow = source.widgets.find(widget => widget.id === "flow")
    flow.config.symmetricAxis = false
    const create = await api(`/api/insights/dashboards/${id}`, { method: "PUT", headers: { "content-type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(source) })
    const initialETag = create.headers.get("x-paprika-document-etag") ?? create.headers.get("etag")
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
      const tile = page.locator('[data-widget-id="flow"]')
      await tile.scrollIntoViewIfNeeded()
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await tile.getByRole("button", { name: "Edit Traffic flow", exact: true }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      const toggle = editor.getByRole("switch", { name: /Center zero on the value axis/ })
      await toggle.waitFor(); assert.equal(await toggle.isChecked(), false)
      await toggle.check()
      const unchanged = await api(`/api/insights/dashboards/${id}`)
      assert.equal(unchanged.headers.get("x-paprika-document-etag") ?? unchanged.headers.get("etag"), initialETag, "Draft edits do not persist")
      await editor.getByRole("button", { name: "Apply widget" }).click()
      const write = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/insights/dashboards/${id}` && response.ok())
      await page.getByRole("button", { name: "Save dashboard", exact: true }).click(); await write
      const savedResponse = await api(`/api/insights/dashboards/${id}`), saved = await savedResponse.json()
      const savedETag = savedResponse.headers.get("x-paprika-document-etag") ?? savedResponse.headers.get("etag")
      assert.ok(savedETag && savedETag !== initialETag)
      assert.equal(saved.widgets.find(widget => widget.id === "flow").config.symmetricAxis, true)
      await page.reload({ waitUntil: "networkidle" })
      const chart = page.locator('[data-widget-id="flow"] svg[role="group"]')
      await chart.scrollIntoViewIfNeeded(); await chart.waitFor()
      const geometry = await chart.evaluate(element => ({ ticks: [...element.querySelectorAll("[data-value-axis]")].map(tick => Number(tick.getAttribute("y"))), zero: Number(element.querySelector('line[class*="baseline"]')?.getAttribute("y1")) }))
      assert.ok(geometry.ticks.length >= 3 && Math.abs(geometry.zero - (geometry.ticks[0] + geometry.ticks.at(-1)) / 2) < .1, "Saved centered axis must render with zero at the midpoint")
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: author, save and reload centered directional axis`)
    } finally {
      await context.close()
      const current = await api(`/api/insights/dashboards/${id}`)
      const etag = current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag")
      assert.ok(etag); await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": etag } })
    }
  }
} finally { await browser.close() }
