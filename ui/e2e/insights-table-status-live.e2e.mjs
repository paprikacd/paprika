// Exercise authored presentation against an isolated Insights store and real
// PostgreSQL rows. The cloned test dashboard leaves the gallery board intact.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL ?? "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only an isolated loopback harness is supported")
const id = `table-status-e2e-${Date.now()}`
const dashboardResponse = await fetch(new URL("/api/insights/dashboards/local-gallery-edge-watch", origin))
assert.equal(dashboardResponse.status, 200)
const dashboard = await dashboardResponse.json()
dashboard.id = id
dashboard.title = "Table status presentation · E2E"
const risk = dashboard.widgets.find(widget => widget.id === "risks")
const mapping = [{ value: "Blocking", color: "#ef5a46" }, { value: "Challenging", color: "#f4b333" }, { value: "Monitoring", color: "#7992a1" }, { value: "Allowed", color: "#13c8a1" }]
risk.config.cellStyles.find(style => style.column === "risk").barColorMode = "value"
risk.config.cellStyles = [...risk.config.cellStyles.filter(style => style.column !== "status"), { column: "status", display: "status-badge", mappings: mapping }]
const create = await fetch(new URL(`/api/insights/dashboards/${id}`, origin), { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(dashboard) })
assert.equal(create.status, 200, `Dashboard save failed: ${await create.text()}`)
const saved = await (await fetch(new URL(`/api/insights/dashboards/${id}`, origin))).json()
assert.deepEqual(saved.widgets.find(widget => widget.id === "risks").config, risk.config, "Table configuration must persist through the real service")
const output = resolve("../artifacts/insights/table-status-live")
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    try {
      const page = await context.newPage(), responses = [], errors = []
      page.on("pageerror", error => errors.push(error.message))
      page.on("response", response => { if (new URL(response.url()).pathname === "/api/insights/query" && response.ok()) responses.push(response.json().catch(() => null)) })
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="risks"]')
      await panel.scrollIntoViewIfNeeded()
      const region = panel.getByRole("region", { name: "Risk by source records" })
      const badges = region.locator('[data-cell-display="status-badge"]')
      await badges.first().waitFor()
      assert.equal(await badges.count(), 5)
      assert.deepEqual(await badges.allTextContents(), ["Blocking", "Challenging", "Monitoring", "Allowed", "Allowed"])
      const statusColors = await badges.locator('[aria-hidden="true"]').evaluateAll(dots => dots.map(dot => getComputedStyle(dot).backgroundColor))
      assert.equal(statusColors[0], "rgb(239, 90, 70)")
      assert.equal(statusColors[1], "rgb(244, 179, 51)")
      assert.equal(statusColors[3], "rgb(19, 200, 161)")
      const bars = region.locator('[data-cell-display="bar-segments"] [data-bar-end]')
      const barColors = await bars.evaluateAll(fills => fills.map(fill => getComputedStyle(fill).backgroundColor))
      assert.deepEqual(barColors, ["rgb(239, 90, 70)", "rgb(239, 90, 70)", "rgb(244, 179, 51)", "rgb(19, 200, 161)", "rgb(19, 200, 161)"])
      const source = (await Promise.all(responses)).find(result => result?.records?.columns?.some(column => column.key === "risk"))
      assert.ok(source, "Status labels and bar values must come from PostgreSQL")
      const statusColumn = source.records.columns.findIndex(column => column.key === "status")
      assert.deepEqual(source.records.rows.map(row => row[statusColumn]), ["Blocking", "Challenging", "Monitoring", "Allowed", "Allowed"])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      if (await region.evaluate(node => node.scrollWidth > node.clientWidth + 1)) {
        await region.focus()
        for (let n = 0; n < 8; n++) await page.keyboard.press("ArrowRight")
        await page.waitForTimeout(200)
        assert.ok(await region.evaluate(node => node.scrollLeft > 0), "Status columns must remain reachable with the keyboard")
      }
      assert.deepEqual(errors, [])
      await panel.screenshot({ path: `${output}/${theme}-${width}.png`, animations: "disabled" })
      console.log(`PASS ${theme} ${width}px: provider status labels and single-color threshold gauges`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
