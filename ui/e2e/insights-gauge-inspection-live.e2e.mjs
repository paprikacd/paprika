// Real-provider gauge-bank layout and exact-value inspection across input modes.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const app = new URL(process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3199")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:51100")
assert.equal(app.hostname, "127.0.0.1")
assert.equal(api.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const mode of ["desktop", "mobile", "touch"]) {
    const context = await browser.newContext({ viewport: { width: mode === "desktop" ? 1512 : 390, height: 950 }, colorScheme: theme, reducedMotion: "reduce", ...(mode === "touch" ? { isMobile: true, hasTouch: true } : {}) })
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
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-collection-control", app).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="source-freshness"]')
      await panel.scrollIntoViewIfNeeded()
      const bank = panel.getByRole("region", { name: "Freshness by source gauges" })
      await page.waitForFunction(() => document.querySelectorAll('[data-widget-id="source-freshness"] [data-gauge-series]').length === 5)
      const bounds = await bank.evaluate(element => {
        const box = element.getBoundingClientRect()
        const rows = [...element.querySelectorAll('[data-gauge-series]')].map(row => row.getBoundingClientRect())
        return { height: box.height, bottomGap: box.bottom - rows.at(-1).bottom, topGap: rows[0].top - box.top, scroll: element.scrollHeight, client: element.clientHeight }
      })
      assert.ok(bounds.scroll <= bounds.client + 1, `Five rows should fit without scrolling: ${JSON.stringify(bounds)}`)
      assert.ok(bounds.bottomGap <= bounds.height * .25, `Rows should use the allocated height: ${JSON.stringify(bounds)}`)
      assert.ok(Math.abs(bounds.topGap - bounds.bottomGap) <= 3, `Rows should be balanced within the bank: ${JSON.stringify(bounds)}`)
      if (process.env.GAUGE_SCREENSHOTS) await panel.screenshot({ path: `${process.env.GAUGE_SCREENSHOTS}/gauge-${theme}-${mode}.png` })
      const row = bank.locator('[data-gauge-series]').filter({ hasText: "market-sync" })
      const trigger = row.getByRole("button", { name: /Inspect value/ })
      assert.equal(await row.locator('[data-gauge-value]').getAttribute("title"), null, "Custom details must not be doubled by a native title tooltip")
      const details = page.getByRole("tooltip")
      if (mode === "touch") {
        await trigger.tap()
        await details.getByText("Delayed", { exact: true }).waitFor()
        assert.equal(await trigger.getAttribute("aria-pressed"), "true", "Tap pins exact details")
        await trigger.tap()
        await details.waitFor({ state: "hidden" })
      } else {
        await trigger.hover()
        await details.getByText("Delayed", { exact: true }).waitFor()
        const panelBounds = await panel.boundingBox(), tipBounds = await details.boundingBox()
        assert.ok(panelBounds && tipBounds && (tipBounds.x + tipBounds.width <= panelBounds.x + 1 || tipBounds.x >= panelBounds.x + panelBounds.width - 1 || tipBounds.y + tipBounds.height <= panelBounds.y + 1 || tipBounds.y >= panelBounds.y + panelBounds.height - 1), "Hover details should not obscure the gauge when space is available")
        await page.mouse.move(1, 1)
        await details.waitFor({ state: "hidden" })
        await trigger.focus()
        await details.getByText("Delayed", { exact: true }).waitFor()
        await page.keyboard.press("Escape")
        await details.waitFor({ state: "hidden" })
      }
      // Small authored cards must retain an explicit, keyboard-scrollable
      // overflow path after the rows start filling the available bank height.
      if (mode === "desktop") {
        await bank.evaluate(element => { element.parentElement.style.height = "92px" })
        const hint = panel.locator('[data-gauge-overflow-hint]')
        await hint.waitFor()
        assert.equal(await bank.getAttribute("aria-describedby"), await hint.getAttribute("id"))
        const stable = await bank.evaluate(async element => {
          const parent = element.parentElement, transitions = []
          const observer = new MutationObserver(() => transitions.push(Boolean(parent.querySelector('[data-gauge-overflow-hint]'))))
          observer.observe(parent, { childList: true, subtree: true })
          await new Promise(resolve => setTimeout(resolve, 500))
          observer.disconnect()
          return { transitions, hint: Boolean(parent.querySelector('[data-gauge-overflow-hint]')), described: element.getAttribute("aria-describedby") }
        })
        assert.ok(stable.hint && stable.described && !stable.transitions.includes(false), `Overflow hint must not oscillate: ${JSON.stringify(stable)}`)
        await bank.focus()
        await page.keyboard.press("End")
        await page.waitForFunction(() => {
          const element = document.querySelector('[aria-label="Freshness by source gauges"]')
          return element && element.scrollTop > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 1
        })
        await bank.evaluate(element => { element.parentElement.style.height = "" })
        await hint.waitFor({ state: "hidden" })
        assert.equal(await bank.getAttribute("aria-describedby"), null, "Hint must clear after the card expands")
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${mode}: balanced rows and ${mode === "touch" ? "tap" : "hover and keyboard"} details`)
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
} finally { await browser.close() }
