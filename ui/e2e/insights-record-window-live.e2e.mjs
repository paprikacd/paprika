// Local provider-backed record chart window comparison; no request interception.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated local gallery is allowed")
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/record-window-live")
await mkdir(output, { recursive: true })
const etag = response => response.headers()["x-paprika-document-etag"] ?? response.headers().etag
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    try {
      const page = await context.newPage(), replies = [], errors = [], writes = []
      page.on("pageerror", error => errors.push(error.message))
      page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/insights/query" && response.request().method() === "POST" && response.ok()) {
          try { const request = JSON.parse(response.request().postDataJSON().query); if (request.sql?.includes("FROM gallery.company_history WHERE symbol=$1")) replies.push(response.json()) } catch {}
        }
        if (["PUT", "POST", "PATCH", "DELETE"].includes(response.request().method()) && /\/api\/insights\/(dashboards|saved-queries)\//.test(new URL(response.url()).pathname)) writes.push(response.request().method())
      })
      const paths = ["/api/insights/dashboards/local-gallery-market-lens", "/api/insights/saved-queries/local-market-company-history"]
      const before = await Promise.all(paths.map(path => context.request.get(origin.origin + path)))
      assert.ok(before.every(response => response.ok() && etag(response)), "Dashboard and saved query have revisions")
      const url = new URL("/dashboard/insights/", origin)
      url.searchParams.set("dashboard", "local-gallery-market-lens")
      url.searchParams.set("from", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
      url.searchParams.set("to", new Date().toISOString())
      await page.goto(url.href, { waitUntil: "networkidle" })
      const chart = page.locator('[data-widget-id="selected-company-history"]')
      await chart.scrollIntoViewIfNeeded()
      await chart.getByRole("button", { name: /Compare window for/ }).waitFor({ timeout: 30000 })
      await page.waitForLoadState("networkidle")
      assert.ok(replies.length > 0, "A real PostgreSQL history query must have completed")
      const count = replies.length, data = await replies.at(-1), frame = data.records
      assert.ok(frame?.rows.length > 5, "The provider must return recorded history")
      const x = frame.columns.findIndex(column => column.key === "day"), y = frame.columns.findIndex(column => column.key === "short_interest")
      const rows = frame.rows.map(row => ({ time: Date.parse(row[x]), value: row[y] })).sort((a,b) => a.time-b.time)
      const originalPoints = await chart.locator("circle[aria-label]").count()
      await chart.getByRole("button", { name: /Compare window for/ }).click()
      const dialog = page.getByRole("dialog", { name: "Compare a window" })
      const start = dialog.getByRole("slider", { name: "Window start" }), end = dialog.getByRole("slider", { name: "Window end" })
      const maximum = Number(await end.getAttribute("max")), midpoint = Math.floor(maximum / 2)
      assert.ok(maximum > 5)
      await end.fill(String(midpoint)); await start.fill("1")
      const ordered = [...new Set(rows.map(row => row.time))].sort((a,b)=>a-b)
      const valid = rows.filter(row => row.time >= ordered[1] && row.time <= ordered[midpoint] && typeof row.value === "number")
      assert.ok(valid.length >= 2)
      const comparison = dialog.getByRole("region", { name: "Window comparison" }).locator("tbody tr").first()
      assert.equal(await comparison.locator("time").first().getAttribute("datetime"), new Date(valid[0].time).toISOString())
      assert.equal(await comparison.locator("time").last().getAttribute("datetime"), new Date(valid.at(-1).time).toISOString())
      assert.equal(await comparison.locator('[data-label="Change"] span').getAttribute("aria-label"), `Exact change ${valid.at(-1).value - valid[0].value} pp`)
      assert.equal(await dialog.getByRole("button", { name: /previous period|apply to dashboard/i }).count(), 0)
      await page.screenshot({ path: resolve(output, `comparison-${theme}-${width}.png`), animations: "disabled" })
      await dialog.getByRole("button", { name: "Zoom chart to window" }).click()
      assert.ok(await chart.locator("circle[aria-label]").count() < originalPoints, "Zoom shows the selected subset")
      await chart.getByRole("button", { name: "Reset chart zoom" }).click()
      assert.equal(await chart.locator("circle[aria-label]").count(), originalPoints)
      await page.waitForLoadState("networkidle")
      assert.equal(replies.length, count, "Local zoom does not repeat the provider query")
      const after = await Promise.all(paths.map(path => context.request.get(origin.origin + path)))
      assert.deepEqual(after.map(etag), before.map(etag), "Zoom leaves the dashboard and saved query revisions unchanged")
      assert.deepEqual(writes, [])
      assert.deepEqual(errors, [])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      console.log(`PASS ${theme} ${width}px: real PostgreSQL samples, local zoom/reset and unchanged document revisions`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
