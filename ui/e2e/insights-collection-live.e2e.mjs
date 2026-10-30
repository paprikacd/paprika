// Real-provider check for collection throughput, freshness and job-history views.
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
      const baselineResponse = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false
        try { const query = response.request().postDataJSON().query; return query.includes("sum by (signal)") && query.includes('cluster="omega"') } catch { return false }
      })
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-collection-control", origin).href, { waitUntil: "networkidle" })
      const throughput = page.locator('[data-widget-id="throughput"]')
      await throughput.scrollIntoViewIfNeeded()
      const plot = throughput.getByRole("img", { name: "Ingestion throughput", exact: true })
      await plot.waitFor()
      const baseline = await (await baselineResponse).json()
      assert.deepEqual(new Set(baseline.series.map(series => series.labels.signal)), new Set(["metrics", "logs", "traces"]))
      assert.ok(baseline.series.every(series => series.points.length > 1), "Each signal needs real history")
      const legend = throughput.getByRole("list", { name: "Latest values by series" })
      assert.equal(await legend.getByRole("listitem").count(), 3, "All independent series must be listed")
      await plot.focus()
      const chartTooltip = page.getByRole("tooltip")
      await chartTooltip.waitFor()
      const exactValue = Number(await chartTooltip.locator("[data-observation-value]").getAttribute("data-observation-value"))
      assert.ok(baseline.series.some(series => series.points.some(point => point.value === exactValue)), "Tooltip must report an actual independent sample")
      await page.keyboard.press("Escape")
      const freshness = page.locator('[data-widget-id="source-freshness"]')
      await freshness.scrollIntoViewIfNeeded()
      const bank = freshness.getByRole("region", { name: "Freshness by source gauges" })
      await bank.waitFor()
      await page.waitForFunction(() => document.querySelectorAll('[data-widget-id="source-freshness"] [data-gauge-series]').length === 5)
      assert.equal(await bank.locator('[data-gauge-orientation="horizontal"][role="meter"]').count(), 5)
      assert.equal(await bank.locator('[data-gauge-status]').count(), 5)
      const delayed = bank.locator('[data-gauge-series]').filter({ hasText: "market-sync" })
      assert.equal(await delayed.locator('[data-gauge-status]').innerText(), "Delayed")
      assert.match(await delayed.getByRole("meter").getAttribute("aria-valuetext"), /Delayed/)
      await delayed.getByRole("button", { name: /Inspect value/ }).focus()
      await page.getByRole("tooltip").getByText("Delayed", { exact: true }).waitFor()
      await page.keyboard.press("Escape")
      const history = page.locator('[data-widget-id="job-states"]')
      await history.scrollIntoViewIfNeeded()
      await page.waitForFunction(() => document.querySelectorAll('[data-widget-id="job-states"] [data-history-series]').length === 6)
      for (const label of ["Failed", "Running", "Complete", "Unknown"]) await history.getByRole("group", { name: "Status history legend" }).getByText(label, { exact: true }).waitFor()
      const cell = history.locator('[data-history-value="0"]').first()
      await cell.focus()
      await page.getByRole("tooltip").getByText("Failed", { exact: true }).waitFor()
      await page.keyboard.press("Escape")
      const failures = page.locator('[data-widget-id="failures"]')
      await failures.scrollIntoViewIfNeeded()
      await failures.getByRole("table").waitFor()
      const badges = failures.locator('[data-cell-display="status-badge"]')
      await badges.first().waitFor()
      const labels = await badges.allTextContents()
      assert.ok(labels.includes("Failed") && labels.includes("Retrying"), "Recent job table must show both recorded failure states")
      assert.ok(labels.every(label => ["Failed", "Retrying"].includes(label)), "Successful jobs must not be presented as failures")
      const metricResponse = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false
        try { const query = response.request().postDataJSON().query; return query.includes("paprika_demo_job_execution_state") && query.includes('cluster="delta"') } catch { return false }
      })
      const throughputResponse = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false
        try { const query = response.request().postDataJSON().query; return query.includes("sum by (signal)") && query.includes('cluster="delta"') } catch { return false }
      })
      const failureResponse = page.waitForResponse(response => {
        if (new URL(response.url()).pathname !== "/api/insights/query" || !response.ok()) return false
        try { const query = JSON.parse(response.request().postDataJSON().query); return query.sql.includes("FROM gallery.jobs") && query.parameters[0] === "delta" } catch { return false }
      })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Cluster", exact: true }), "delta")
      await history.scrollIntoViewIfNeeded() // Offscreen widgets defer queries on narrow screens.
      const data = await (await metricResponse).json()
      assert.equal(data.series.length, 6)
      assert.ok(data.series.every(series => series.labels.cluster === "delta" && series.labels.task))
      assert.deepEqual(new Set(data.series.flatMap(series => series.points.map(point => point.value))), new Set([0, 1, 2]))
      await throughput.scrollIntoViewIfNeeded()
      const alternate = await (await throughputResponse).json()
      assert.deepEqual(new Set(alternate.series.map(series => series.labels.signal)), new Set(["metrics", "logs", "traces"]))
      assert.notDeepEqual(alternate.series.map(series => series.points.at(-1)?.value), baseline.series.map(series => series.points.at(-1)?.value), "Changing cluster must change the provider observations")
      assert.equal(await legend.getByRole("listitem").count(), 3)
      await failures.scrollIntoViewIfNeeded()
      const records = (await (await failureResponse).json()).records
      const status = records.columns.findIndex(column => column.key === "status")
      assert.ok(status >= 0 && records.rows.length > 0 && records.rows.every(row => ["Failed", "Retrying"].includes(row[status])), "The selected cluster's provider data must contain only failed or retrying jobs")
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      assert.deepEqual(errors, [])
      console.log(`PASS collection ${theme} ${width}px: independent throughput, threshold statuses, sampled jobs, keyboard details and cluster filter`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
