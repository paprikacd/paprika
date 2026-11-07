// Real-provider, runtime-only dashboard time and preceding-period flow.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated local gallery is permitted")
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/dashboard-time-live")
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    try {
      const page = await context.newPage(), requests = [], errors = []
      page.on("pageerror", error => errors.push(error.message))
      page.on("response", response => {
        if (new URL(response.url()).pathname === "/api/insights/query" && response.request().method() === "POST" && response.ok()) requests.push({ request: response.request().postDataJSON(), data: response.json().catch(() => null) })
      })
      const id = "local-gallery-service-pulse"
      const before = await (await fetch(`${origin.origin}/api/insights/dashboards/${id}`)).json()
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      await selectGammaOption(page, page.getByRole("combobox", { name: "Service", exact: true }), "payments")
      const chart = page.locator('[data-widget-id="error-history"]')
      await chart.scrollIntoViewIfNeeded()
      await chart.getByRole("button", { name: /Compare window for/ }).click({ timeout: 30000 })
      const dialog = page.getByRole("dialog", { name: "Compare a window" })
      const end = dialog.getByRole("slider", { name: "Window end" })
      await end.fill(String(Math.floor(Number(await end.getAttribute("max")) / 2)))
      const chosen = await dialog.locator("label time").evaluateAll(nodes => nodes.map(node => Date.parse(node.dateTime)))
      assert.equal(chosen.length, 2)
      const existing = requests.length
      await dialog.getByRole("button", { name: "Compare previous period" }).click()
      const table = dialog.getByRole("region", { name: "Previous period results" })
      await table.waitFor({ timeout: 30000 })
      assert.ok(await table.locator("tbody tr time").count() >= 2, "Both actual windows must contain recorded samples")
      const priorRequest = requests.slice(existing).find(item => item.request.query?.includes('code="5xx"'))?.request
      assert.ok(priorRequest, "Comparison must issue a real preceding-period provider query")
      assert.ok(priorRequest.query.includes('service="payments"'), "Previous-period query must preserve the selected service")
      assert.equal(priorRequest.start, (chosen[0] - (chosen[1] - chosen[0])) / 1000)
      assert.equal(priorRequest.end, (chosen[0] - 1) / 1000)
      await page.screenshot({ path: resolve(output, `compare-${theme}-${width}.png`), animations: "disabled" })
      const previousData = await requests.slice(existing).find(item => item.request === priorRequest).data
      const firstPrior = previousData.series[0].points.filter(point => point.timestamp >= priorRequest.start * 1000 && point.timestamp < chosen[0]).sort((a, b) => a.timestamp - b.timestamp)[0]
      assert.ok(firstPrior, "The previous-period query must return actual observations")
      await dialog.getByRole("button", { name: "Overlay previous period" }).click()
      const legend = chart.getByRole("group", { name: "Previous period overlay" })
      await legend.waitFor()
      assert.match(await legend.innerText(), /dashed · aligned/)
      await page.waitForFunction(() => [...document.querySelectorAll('[data-widget-id="error-history"] svg path')].some(path => getComputedStyle(path).strokeDasharray !== "none" && getComputedStyle(path).strokeDasharray !== "0px"), null, { timeout: 10000 })
      const priorSeries = legend.locator("[data-prior-series]").first()
      assert.equal(Number(await priorSeries.getAttribute("data-prior-original-first")), firstPrior.timestamp)
      assert.equal(Number(await priorSeries.getAttribute("data-prior-aligned-first")), firstPrior.timestamp + chosen[1] - chosen[0])
      const inspector = chart.getByRole("button", { name: "Inspect chart data for Error budget burn rate · 1h · Previous period" })
      await inspector.click()
      const previousDialog = page.getByRole("dialog", { name: "Error budget burn rate · 1h · Previous period data" })
      await previousDialog.getByText(new Date(firstPrior.timestamp).toISOString()).waitFor()
      await previousDialog.getByRole("button", { name: "Close data" }).click()
      await page.screenshot({ path: resolve(output, `overlay-${theme}-${width}.png`), animations: "disabled" })
      await chart.getByRole("button", { name: "Reset chart zoom" }).click()
      assert.equal(await chart.getByRole("group", { name: "Previous period overlay" }).count(), 0)
      await chart.getByRole("button", { name: /Compare window for/ }).click()
      await end.fill(String(Math.floor(Number(await end.getAttribute("max")) / 2)))
      await dialog.getByRole("button", { name: "Apply to dashboard" }).click()
      const url = new URL(page.url())
      assert.ok(url.searchParams.has("from") && url.searchParams.has("to"), "The selected range must be shareable")
      assert.equal(JSON.parse(url.searchParams.get("vars")).service, "payments", "Shared service filter must survive time selection")
      const after = await (await fetch(`${origin.origin}/api/insights/dashboards/${id}`)).json()
      assert.deepEqual(after, before, "Runtime range selection must not write dashboard defaults")
      await page.reload({ waitUntil: "networkidle" })
      assert.ok(new URL(page.url()).searchParams.has("from"), "The range survives reload")
      const reliabilityRequests = requests.length
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-reliability-room`, { waitUntil: "networkidle" })
      const incident = page.locator('[data-widget-id="incidents-list"]')
      await incident.scrollIntoViewIfNeeded()
      const button = incident.getByRole("button", { name: "Focus time for row 1" })
      await button.waitFor({ timeout: 30000 })
      assert.equal(await button.isEnabled(), true)
      const incidentFrame = await Promise.all(requests.slice(reliabilityRequests).filter(item => {
        try { return item.request.kind === "records" && JSON.parse(item.request.query).parameters?.[0] === "checkout" }
        catch { return false }
      }).map(item => item.data))
      const frame = incidentFrame.map(item => item?.records).find(item => item?.columns?.some(column => column.key === "date") && item.columns.some(column => column.key === "value"))
      assert.ok(frame)
      const timestamp = frame.columns.findIndex(column => column.key === "date"), duration = frame.columns.findIndex(column => column.key === "value")
      const first = frame.rows[0], from = Date.parse(first[timestamp]) - 300_000, to = Date.parse(first[timestamp]) + first[duration] * 60_000 + 300_000
      await button.click()
      const focus = new URL(page.url())
      assert.equal(Date.parse(focus.searchParams.get("from")), from)
      assert.equal(Date.parse(focus.searchParams.get("to")), to)
      const traceWidget = page.locator('[data-widget-id="incident-traces"]')
      await traceWidget.scrollIntoViewIfNeeded()
      await traceWidget.getByRole("button", { name: "View waterfall" }).first().waitFor({ timeout: 30000 })
      assert.ok(requests.some(item => item.request.kind === "traces" && item.request.start === from / 1000 && item.request.end === to / 1000), "Incident selection must scope the real trace query")
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, "Time selection must not cause page overflow")
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: prior-period overlay and exact inspection, shared dashboard range, reload and incident focus`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
