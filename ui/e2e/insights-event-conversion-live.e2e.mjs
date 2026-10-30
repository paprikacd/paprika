// Switching visualization types must not silently remove a saved event query.
// Exercise a unique ETag-protected dashboard with real local providers.
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
const source = base.widgets.find(widget => widget.id === "request-history")
assert.ok(source?.annotationSource?.queryRef?.id)
const original = structuredClone(source.annotationSource)
const id = `event-conversion-e2e-${Date.now()}`
const document = { schemaVersion: 1, id, title: "Event conversion E2E", timeRange: "1h", refreshInterval: 0, variables: base.variables, widgets: [{ ...source, layout: { x: 0, y: 0, w: 8, h: 5 } }] }
const path = `/api/insights/dashboards/${id}`
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
let revision = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(revision)
const browser = await chromium.launch({ headless: true })
await mkdir("../artifacts/insights/event-conversion-live", { recursive: true })
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
      const tile = page.locator(`[data-widget-id="${source.id}"]`)
      await tile.getByRole("img", { name: source.title, exact: true }).waitFor()
      await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
      await tile.getByRole("button", { name: `Edit ${source.title}`, exact: true }).click()
      const editor = page.getByRole("region", { name: "Widget editor" })
      const viz = editor.getByRole("combobox", { name: "Visualization", exact: true })
      await selectGammaOption(page, viz, /^Bar chart/)
      const prompt = editor.getByText(/event query will be removed from this draft/i)
      await prompt.waitFor()
      assert.match(await viz.innerText(), /Time series/, "A pending conversion must not replace the active draft")
      await prompt.scrollIntoViewIfNeeded()
      await page.screenshot({ path: `../artifacts/insights/event-conversion-live/${theme}-${width}.png`, animations: "disabled" })
      await editor.getByRole("button", { name: "Keep current visualization" }).click()
      assert.equal(await prompt.count(), 0)
      assert.match(await viz.innerText(), /Time series/)
      assert.ok(await editor.getByRole("combobox", { name: "Event saved query" }).count(), "Keeping the chart retains its configured event query")
      const before = await api(path)
      assert.equal(before.headers.get("x-paprika-document-etag") ?? before.headers.get("etag"), revision)
      assert.deepEqual((await before.json()).widgets[0].annotationSource, original)
      assert.deepEqual((await (await api(path)).json()).widgets[0].queryRef, source.queryRef)
      await selectGammaOption(page, viz, /^Trace explorer/)
      await editor.getByText(/saved query connection.*removed/i).waitFor()
      await editor.getByText(/event query will be removed from this draft/i).waitFor()
      await editor.getByText(/saved query connection.*removed/i).scrollIntoViewIfNeeded()
      await page.screenshot({ path: `../artifacts/insights/event-conversion-live/${theme}-${width}-cross-kind.png`, animations: "disabled" })
      await editor.getByRole("button", { name: "Keep current visualization" }).click()
      assert.match(await viz.innerText(), /Time series/)
      if (theme === "dark" && width === 390) {
        await selectGammaOption(page, viz, /^Trace explorer/)
        await editor.getByRole("button", { name: "Replace query and switch" }).click()
        assert.match(await viz.innerText(), /Trace explorer/)
        await editor.getByRole("button", { name: "Apply widget" }).click()
        const write = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === path && response.ok())
        await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
        await write
        const persisted = await api(path)
        const next = persisted.headers.get("x-paprika-document-etag") ?? persisted.headers.get("etag")
        assert.ok(next && next !== revision)
        const savedWidget = (await persisted.json()).widgets[0]
        assert.equal(savedWidget.type, "traces")
        assert.equal(savedWidget.query, "{}")
        assert.equal(savedWidget.queryRef, undefined)
        assert.equal(savedWidget.annotationSource, undefined)
        revision = next
      } else {
        await selectGammaOption(page, viz, /^Bar chart/)
        await editor.getByRole("button", { name: "Remove event query and switch" }).click()
        assert.match(await viz.innerText(), /Bar chart/)
        await editor.getByRole("button", { name: "Close widget editor" }).click()
        const persisted = await api(path)
        assert.equal(persisted.headers.get("x-paprika-document-etag") ?? persisted.headers.get("etag"), revision)
        assert.deepEqual((await persisted.json()).widgets[0].annotationSource, original)
      }
      assert.deepEqual(errors, [])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
      console.log(`PASS ${theme} ${width}px: event query preserved until explicit conversion${theme === "dark" && width === 390 ? " and Save" : " or discard"}`)
    } finally { closing = true; await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), revision)
  await api(path, { method: "DELETE", headers: { "If-Match": revision } })
}
