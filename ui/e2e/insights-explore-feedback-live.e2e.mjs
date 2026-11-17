// Real local PostgreSQL/Insights responses, including a provider error. No
// query response or result data is mocked; only the UI/API origins are joined.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const app = new URL(process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3197")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:64509")
for (const url of [app, api]) assert.equal(url.hostname, "127.0.0.1")
const output = resolve(fileURLToPath(new URL("../../artifacts/insights/explore-feedback-live", import.meta.url)))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url())
      const headers = { ...route.request().headers() }; delete headers.origin; delete headers.host
      const response = await route.fetch({ url: new URL(original.pathname + original.search, api).href, headers })
      await route.fulfill({ response })
    })
    try {
      page.setDefaultTimeout(30000)
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-stress-lab", app).href, { waitUntil: "networkidle" })
      const nav = page.locator("#insights-navigation")
      if (!await nav.isVisible()) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
      await nav.getByRole("button", { name: /^Explore\b/ }).click()
      const explorer = page.getByRole("region", { name: "Data source explorer", exact: true }).last()
      await explorer.getByRole("heading", { name: "Explore", exact: true }).waitFor()
      await selectGammaOption(page, explorer.getByRole("combobox", { name: "Explore data source", exact: true }), "observability/gallery-postgresql")
      await selectGammaOption(page, explorer.getByRole("combobox", { name: "Open saved query", exact: true }), /Stress observations/)
      const results = explorer.getByRole("region", { name: "Explore query results" })
      await results.getByRole("button", { name: "Run query", exact: true }).click()
      const summary = results.getByLabel("Result summary")
      await summary.getByText(/1,000 rows · 5 columns/).waitFor()
      await summary.getByText("Partial provider response · data may be incomplete.").waitFor()
      // A result's bounds remain visible before selecting mandatory chart fields.
      await selectGammaOption(page, results.getByRole("combobox", { name: "Explore record visualization", exact: true }), "Record bar chart")
      await results.getByText("Choose the result columns to preview this visualization.").waitFor()
      await summary.getByText(/1,000 rows · 5 columns/).waitFor()
      const field = explorer.getByRole("textbox", { name: "SQL query" })
      await field.fill("SELECT nonexistent_field FROM gallery.stress_observations WHERE to_jsonb(stress_observations)->>'cluster'=$1")
      await results.getByRole("button", { name: "Run query", exact: true }).click()
      const error = results.getByRole("alert")
      await error.waitFor()
      assert.match(await error.innerText(), /provider query failed/i)
      await results.getByText("Latest run failed. Showing the previous result for different inputs.").waitFor()
      await summary.getByText(/1,000 rows · 5 columns/).waitFor()
      await explorer.getByRole("textbox", { name: "Test value for cluster" }).fill("delta")
      assert.equal(await error.count(), 0, "An error from previous test values must not describe the current inputs")
      await results.getByText(/Inputs changed. Showing the previous result/).waitFor()
      // A failure on the first run must not look like a workspace that has
      // never run. Reload to discard the draft without changing saved data.
      page.once("dialog", dialog => dialog.accept())
      await page.reload({ waitUntil: "networkidle" })
      if (!await nav.isVisible()) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
      await nav.getByRole("button", { name: /^Explore\b/ }).click()
      const fresh = page.getByRole("region", { name: "Data source explorer", exact: true }).last()
      await selectGammaOption(page, fresh.getByRole("combobox", { name: "Explore data source", exact: true }), "observability/gallery-postgresql")
      await fresh.getByRole("textbox", { name: "SQL query" }).fill("SELECT nonexistent_field FROM gallery.stress_observations")
      const freshResults = fresh.getByRole("region", { name: "Explore query results" })
      await freshResults.getByRole("button", { name: "Run query", exact: true }).click()
      await freshResults.getByRole("alert").waitFor()
      await freshResults.getByRole("heading", { name: "Query failed" }).waitFor()
      assert.equal(await freshResults.getByText("Ready when you are").count(), 0)
      assert.deepEqual(errors, [])
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      await page.screenshot({ path: `${output}/${theme}-${width}.png`, fullPage: true })
      console.log(`PASS Explore provider feedback: ${theme} ${width}px`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
