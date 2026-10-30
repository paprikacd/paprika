// Provider-generated names should be readable while retaining exact identity.
import assert from "node:assert/strict"
import { chromium } from "playwright"
const app = new URL(process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3199")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:51892")
assert.equal(app.hostname, "127.0.0.1"); assert.equal(api.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), headers = { ...route.request().headers() }
      delete headers.origin; delete headers.host
      const response = await route.fetch({ url: new URL(original.pathname + original.search, api).href, headers })
      await route.fulfill({ response })
    })
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-fleet-atlas", app).href, { waitUntil: "networkidle" })
      const widget = page.locator('[data-widget-id="cpu-meter"]')
      await widget.scrollIntoViewIfNeeded()
      const panels = widget.locator("[data-multiple-series]")
      await page.waitForFunction(() => document.querySelectorAll('[data-widget-id="cpu-meter"] [data-multiple-series]').length === 8)
      for (const panel of await panels.all()) {
        const identity = await panel.getAttribute("data-multiple-series")
        assert.match(identity, /^\{cluster="omega", node="node-0[1-8]"\}$/)
        const name = panel.locator(`[title=${JSON.stringify(identity)}]`)
        assert.match(await name.innerText(), /^node-0[1-8]$/)
        assert.equal(await name.getAttribute("aria-label"), identity)
      }
      const first = panels.first(), identity = await first.getAttribute("data-multiple-series")
      const plot = first.getByRole("group", { name: new RegExp("trend\\. Shared scales") })
      assert.ok((await plot.getAttribute("aria-label")).includes(identity))
      await plot.focus(); await page.getByRole("tooltip").waitFor(); await page.keyboard.press("Escape")
      assert.deepEqual(errors, [])
      console.log(`PASS small-multiple labels ${theme} ${width}px: concise labels with complete accessible identity`)
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally { await browser.close() }
