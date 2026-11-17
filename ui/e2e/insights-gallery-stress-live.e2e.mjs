// Exercise bounded, heterogeneous provider data through the actual local UI.
// The gallery stack is synthetic; no provider request is intercepted.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated loopback gallery is supported")
const output = resolve(fileURLToPath(new URL("../../artifacts/insights/gallery-stress-live", import.meta.url)))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    page.setDefaultTimeout(30000)
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-stress-lab", origin).href, { waitUntil: "networkidle" })
      const monitors = page.locator('[data-widget-id="stress-monitors"]')
      const records = page.locator('[data-widget-id="stress-records"]')
      const traces = page.locator('[data-widget-id="stress-traces"]')
      await monitors.getByText("Provider response may be incomplete. Narrow the query or check the data source.").waitFor()
      await records.scrollIntoViewIfNeeded()
      await records.getByText("Provider response may be incomplete. Narrow the query or check the data source.").waitFor()
      await records.getByText("sample-0001").waitFor()
      await traces.scrollIntoViewIfNeeded()
      await traces.getByText(/checkout/i).first().waitFor()
      await traces.getByText("Provider response may be incomplete. Narrow the query or check the data source.").waitFor()
      // Searching is scoped to the fetched page. Check that the null record
      // remains null rather than a fabricated zero, and an actual zero remains.
      await records.scrollIntoViewIfNeeded()
      const filter = records.getByRole("textbox", { name: "Filter Recorded observations · nulls, zeroes and outliers" })
      await filter.fill("sample-0113")
      const missing = records.locator("tr").filter({ hasText: "sample-0113" })
      await missing.waitFor()
      assert.ok(await missing.locator('[data-cell-missing]').count(), "Null latency must stay missing")
      await filter.fill("sample-0097")
      const zero = records.locator("tr").filter({ hasText: "sample-0097" })
      await zero.waitFor()
      assert.match(await zero.innerText(), /0(?:\.0+)?\s*ms/)
      await filter.clear()
      const delta = page.waitForResponse(response => {
        if (!response.ok() || new URL(response.url()).pathname !== "/api/insights/query") return false
        try { const request = response.request().postDataJSON(); return request.kind === "records" && JSON.parse(request.query).parameters?.[0] === "delta" } catch { return false }
      })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "delta")
      const data = await (await delta).json()
      assert.equal(data.truncated, true)
      assert.equal(data.records.truncated, true)
      assert.equal(data.records.rows.length, 1000)
      await records.getByText("sample-0001").waitFor()
      assert.deepEqual(errors, [])
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No page-level horizontal overflow")
      await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true })
      console.log(`PASS stress dashboard: ${theme} ${width}px; provider limits, zero/null values and shared filter`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
