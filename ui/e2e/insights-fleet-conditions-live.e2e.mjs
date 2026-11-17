// Observe the node-condition samples from the isolated real provider stack.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    try {
      const page = await context.newPage(), errors = []
      page.on("pageerror", error => errors.push(error.message))
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-fleet-atlas", origin).href, { waitUntil: "networkidle" })
      await page.locator('[data-widget-id="nodes"]').getByText("Ready nodes · observed").waitFor()
      const history = page.locator('[data-widget-id="states"]')
      await history.scrollIntoViewIfNeeded()
      await page.waitForFunction(() => document.querySelectorAll('[data-widget-id="states"] [data-history-series]').length === 8)
      for (const label of ["Unavailable", "Pressure", "Ready", "Unknown"]) await history.getByRole("group", { name: "Status history legend" }).getByText(label, { exact: true }).waitFor()
      for (const value of ["0", "1", "2"]) assert.ok(await history.locator(`[data-history-value="${value}"]`).count(), `Missing sampled state ${value}`)
      const unavailable = history.locator('[data-history-value="0"]').first()
      await unavailable.focus()
      await page.getByRole("tooltip").getByText("Unavailable", { exact: true }).waitFor()
      await page.keyboard.press("Escape")
      const update = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false
        try { const query = response.request().postDataJSON().query; return query.includes("paprika_demo_node_condition_state") && query.includes('cluster="delta"') && !query.includes("sum(") } catch { return false }
      })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "delta")
      await history.scrollIntoViewIfNeeded()
      const data = await (await update).json()
      assert.equal(data.series.length, 8)
      assert.ok(data.series.every(series => series.labels.cluster === "delta" && series.labels.node))
      assert.deepEqual(errors, [])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      console.log(`PASS Fleet Atlas ${theme} ${width}px: observed conditions, keyboard detail and cluster filter`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
