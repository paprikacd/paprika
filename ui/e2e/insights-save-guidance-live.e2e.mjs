// Focused chart Apply guidance for invalid live drafts against isolated
// Insights storage and the actual local providers.
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
    const document = await (await api("/api/insights/dashboards/local-gallery-service-pulse")).json()
    const id = `save-guidance-${Date.now()}-${theme.toLowerCase()}-${width}`
    document.id = id; document.title = "Save guidance test"
    const created = await api(`/api/insights/dashboards/${id}`, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
    const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
    const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: "reduce" })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    let closing = false
    if (app.origin !== origin.origin) await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), headers = { ...route.request().headers() }
      delete headers.origin; delete headers.host
      try { await route.fulfill({ response: await route.fetch({ url: new URL(original.pathname + original.search, origin).href, headers }) }) }
      catch (error) { if (!closing) throw error }
    })
    try {
      await page.goto(`${app.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      const tile = page.locator('[data-widget-id="latency"]')
      await tile.scrollIntoViewIfNeeded()
      await tile.getByRole("button", { name: /^Edit / }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      const title = editor.getByRole("textbox", { name: "Title", exact: true })
      const original = await title.inputValue()
      await title.fill("")
      const apply = editor.getByRole("button", { name: "Apply changes", exact: true })
      const hint = editor.getByRole("alert").filter({ hasText: "title:" })
      await hint.waitFor()
      assert.equal(await apply.isDisabled(), true)
      assert.equal(await title.getAttribute("aria-describedby"), await hint.getAttribute("id"))
      if (process.env.SAVE_GUIDANCE_SCREENSHOTS) {
        await hint.scrollIntoViewIfNeeded()
        await page.screenshot({ path: `${process.env.SAVE_GUIDANCE_SCREENSHOTS}/save-${theme.toLowerCase()}-${width}.png`, animations: "disabled" })
      }
      const unchanged = await api(`/api/insights/dashboards/${id}`)
      assert.equal(unchanged.headers.get("x-paprika-document-etag") ?? unchanged.headers.get("etag"), etag)
      await title.fill(original)
      await hint.waitFor({ state: "hidden" })
      assert.equal(await apply.isEnabled(), true, "Correcting the draft should immediately restore Apply")
      await title.fill("")
      await hint.waitFor()
      await editor.getByRole("button", { name: "Discard", exact: true }).click()
      await hint.waitFor({ state: "hidden" })
      assert.equal(await page.getByRole("button", { name: "Save dashboard", exact: true }).isEnabled(), true, "Discarding an invalid draft returns to the unchanged dashboard")
      await tile.getByRole("heading", { name: original, exact: true }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: invalid Apply reason, correction and Discard recovery`)
    } finally {
      closing = true
      await page.unrouteAll({ behavior: "ignoreErrors" })
      await context.close()
      const current = await api(`/api/insights/dashboards/${id}`)
      const currentETag = current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag")
      await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": currentETag } })
    }
  }
} finally { await browser.close() }
