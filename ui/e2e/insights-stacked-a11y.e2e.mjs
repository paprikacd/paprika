// Large SVG plots should expose one navigable chart rather than hundreds of
// decorative images, while preserving exact point inspection via keyboard.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"
import { selectGammaOption } from "./gamma-controls.mjs"

const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["Light", "Dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: "reduce" })
    try {
      const page = await context.newPage(), errors = []
      page.on("pageerror", error => errors.push(error.message))
      await installRichChartFixtureAPI(page, base)
      await page.goto(`${base}/dashboard/insights/?dashboard=example-artboard-edge-watch`, { waitUntil: "networkidle" })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
      const tile = page.locator('[data-widget-id="outcomes"]')
      await tile.scrollIntoViewIfNeeded()
      const plot = tile.getByRole("group", { name: /Request outcomes/ })
      await plot.waitFor()
      assert.ok(await plot.locator("[data-metric-marks] rect[data-raw-value]").count() > 30, "The visual sample must contain many marks")
      const tree = await plot.ariaSnapshot()
      assert.doesNotMatch(tree, /(?:^|\n)\s*- img(?:\s|:|$)/, `Decorative marks leaked into the accessibility tree: ${tree}`)
      await plot.focus()
      await plot.press("ArrowLeft")
      await plot.press("Enter")
      const details = page.getByRole("region", { name: "Observation details" })
      await details.waitFor()
      assert.ok(await details.locator("[data-metric-value]").count(), "Keyboard inspection must expose an exact observed value")
      await plot.press("Escape")
      await details.waitFor({ state: "hidden" })
      assert.deepEqual(errors, [])
      console.log(`PASS stacked chart accessibility: ${theme} ${width}px`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
