// Read synthetic Edge Watch data from the real local Insights/provider stack.
// Sorting and row numbers are view-only and must not rewrite the dashboard.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const endpoint = new URL("/api/insights/dashboards/local-gallery-edge-watch", origin)
const before = await fetch(endpoint)
assert.equal(before.status, 200)
const etag = before.headers.get("x-paprika-document-etag") ?? before.headers.get("etag")
assert.ok(etag)
const document = await before.text()
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", origin).href, { waitUntil: "networkidle" })
      for (const [id, count] of [["destinations", 10], ["risks", 5]]) {
        const panel = page.locator(`[data-widget-id="${id}"]`)
        await panel.scrollIntoViewIfNeeded()
        const table = panel.getByRole("table")
        await table.getByRole("columnheader", { name: "Row number" }).waitFor()
        await table.locator("tbody tr").nth(count - 1).waitFor()
        assert.deepEqual(await table.locator("tbody tr").evaluateAll(rows => rows.map(row => row.cells[0].textContent)), Array.from({ length: count }, (_, i) => String(i + 1)))
        const region = panel.getByRole("region", { name: id === "destinations" ? "Top destinations records" : "Risk by source records" })
        const visibleRows = await region.evaluate(element => ({ visible: element.clientHeight, content: element.scrollHeight }))
        assert.ok(visibleRows.content <= visibleRows.visible + 1, `${id} rows should fit vertically: ${JSON.stringify(visibleRows)}`)
      }
      for (const id of ["flow", "outcomes"]) {
        const plot = page.locator(`[data-widget-id="${id}"] svg[role="group"]`)
        await plot.waitFor()
        assert.ok((await plot.boundingBox()).height >= 90, `${id} plot needs room alongside the legend and comparison controls`)
      }
      await page.locator('[data-widget-id="locations"] [data-map-plane]').waitFor()
      const destinations = page.locator('[data-widget-id="destinations"]')
      await destinations.getByRole("button", { name: "destination", exact: true }).click()
      const table = destinations.getByRole("table")
      assert.deepEqual(await table.locator("tbody tr").evaluateAll(rows => rows.map(row => row.cells[0].textContent)), Array.from({ length: 10 }, (_, i) => String(i + 1)))
      assert.equal(await table.getByRole("columnheader", { name: "destination ↑" }).getAttribute("aria-sort"), "ascending")
      const riskPanel = page.locator('[data-widget-id="risks"]')
      await riskPanel.scrollIntoViewIfNeeded()
      const riskRegion = riskPanel.getByRole("region", { name: "Risk by source records" })
      const riskColors = await riskRegion.locator("tbody tr").evaluateAll(rows => rows.map(row => ({
        risk: Number(row.cells[4].innerText),
        color: row.cells[3].querySelector("svg")?.style.color,
        meaning: row.cells[3].querySelector('[data-history-color-meaning]')?.textContent,
      })))
      for (const entry of riskColors) {
        assert.equal(entry.color, entry.risk >= 70 ? "rgb(239, 90, 70)" : entry.risk >= 40 ? "rgb(244, 179, 51)" : "rgb(19, 200, 161)")
        assert.match(entry.meaning, /Color by risk:/)
      }
      const riskWidth = await riskRegion.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }))
      if (width === 1512) {
        assert.ok(riskWidth.scroll <= riskWidth.client + 1, `Desktop risk table must fit: ${JSON.stringify(riskWidth)}`)
        assert.equal(await riskPanel.getByText("Scroll horizontally to see more columns").count(), 0)
        assert.deepEqual(await riskRegion.locator("tbody td").evaluateAll(cells => cells.filter(cell => cell.scrollWidth > cell.clientWidth + 1).map(cell => cell.innerText)), [], "Desktop values should remain visible")
      } else {
        assert.ok(riskWidth.scroll > riskWidth.client + 1, "A narrow viewport retains a scrollable table instead of hiding columns")
        await riskPanel.getByText("Scroll horizontally to see more columns").waitFor()
        await riskRegion.focus()
        for (let i = 0; i < 10; i++) await riskRegion.press("ArrowRight")
        await page.waitForFunction(element => element.scrollLeft > 0, await riskRegion.elementHandle())
        assert.ok(await riskRegion.evaluate(element => element.scrollLeft > 0), "Keyboard users can scroll to the status column")
      }
      await riskPanel.getByRole("button", { name: "risk", exact: true }).click()
      assert.equal(await riskPanel.getByRole("columnheader", { name: "risk ↑" }).getAttribute("aria-sort"), "ascending")
      const blocked = page.locator('[data-widget-id="blocked-requests"]')
      await blocked.scrollIntoViewIfNeeded()
      await blocked.locator('[data-styled-cell="status-badge"]').first().waitFor()
      assert.ok(await blocked.getByText("Blocked", { exact: true }).count() > 0)
      const blockedRows = await blocked.getByRole("region", { name: "Recent blocked requests records" }).evaluate(element => ({ visible: element.clientHeight, content: element.scrollHeight }))
      assert.ok(blockedRows.content <= blockedRows.visible + 1, `Blocked rows should fit vertically: ${JSON.stringify(blockedRows)}`)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: numbered destinations and risks, sorted order, blocked status`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
const after = await fetch(endpoint)
assert.equal(await after.text(), document)
assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag)
