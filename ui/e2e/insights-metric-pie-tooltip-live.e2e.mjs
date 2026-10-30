// Inspect live Prometheus pie slices without mutating saved documents.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const api = async (path, init) => {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const base = await (await api("/api/insights/dashboards/local-gallery-service-pulse")).json()
const id = `pie-tooltip-e2e-${Date.now()}`
const expression = 'sum by (service) (rate(paprika_demo_requests_total{cluster="omega"}[5m]))'
const document = { schemaVersion: 1, id, title: "Pie tooltip E2E", timeRange: "1h", refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: "checkout" }], widgets: [{
  id: "shares", title: "Service shares", type: "plugin", pluginId: "pie", dataKind: "metrics", providerId: base.widgets[0].providerId,
  query: expression, unit: "req/s", layout: { x: 0, y: 0, w: 6, h: 5 }, options: { decimals: 2, showTooltip: true },
}, {
  id: "selectable", title: "Select a service", type: "plugin", pluginId: "pie", dataKind: "metrics", providerId: base.widgets[0].providerId,
  query: expression, unit: "req/s", layout: { x: 6, y: 0, w: 6, h: 5 }, options: { decimals: 2, showTooltip: true },
  selectionBindings: [{ variable: "service", source: "label", value: "service" }],
}, {
  id: "many", title: "Node shares", type: "plugin", pluginId: "pie", dataKind: "metrics", providerId: base.widgets[0].providerId,
  query: "paprika_demo_node_cpu_ratio", unit: "", layout: { x: 0, y: 5, w: 6, h: 5 }, options: { decimals: 2, showTooltip: true },
}] }
const path = `/api/insights/dashboards/${id}`
const created = await api(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
let sawLegendOverflow = false
await mkdir("../artifacts/insights/metric-pie-tooltip-live", { recursive: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce", ...(width === 390 ? { hasTouch: true, isMobile: true } : {}) })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = [], responses = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("response", response => {
      if (new URL(response.url()).pathname === "/api/insights/query" && response.ok()) {
        try { if (response.request().postDataJSON().query === expression) responses.push(response.json()) } catch { /* Non-query requests are ignored. */ }
      }
    })
    try {
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="shares"]')
      await panel.scrollIntoViewIfNeeded()
      const group = panel.getByRole("group", { name: "Service shares" })
      const slice = group.locator('[data-pie-index]').filter({ hasText: "" }).first()
      await slice.waitFor()
      const legend = panel.getByRole("region", { name: "Legend for Service shares" })
      const legendSize = await legend.evaluate(element => ({ client: element.clientHeight, scroll: element.scrollHeight }))
      assert.ok(legendSize.scroll <= legendSize.client + 1, `Six service legend entries should fit: ${JSON.stringify(legendSize)}`)
      assert.ok(responses.length > 0)
      const result = await responses.at(-1)
      const sampleTime = Number(await slice.getAttribute("data-pie-timestamp")), sampleValue = Number(await slice.getAttribute("data-pie-value"))
      const match = result.series.find(series => series.points.some(point => point.timestamp === sampleTime && point.value === sampleValue))
      assert.ok(match?.labels?.service, "The slice must represent an actual labelled provider observation")
      const coordinate = await slice.locator("path").evaluate(path => {
        const box = path.getBBox(), matrix = path.getScreenCTM()
        if (!matrix) throw Error("Pie slice has no screen transform")
        for (let y = 1; y < 20; y++) for (let x = 1; x < 20; x++) {
          const point = new DOMPoint(box.x + box.width * x / 20, box.y + box.height * y / 20)
          if (path.isPointInFill(point)) { const screen = point.matrixTransform(matrix); return { x: screen.x, y: screen.y } }
        }
        throw Error("No visible interior point in pie slice")
      })
      const initial = new URL(page.url()).searchParams.get("vars")
      if (width === 390) {
        await page.touchscreen.tap(coordinate.x, coordinate.y)
      } else {
        await page.mouse.move(coordinate.x, coordinate.y)
        const preview = page.getByRole("tooltip")
        await preview.waitFor()
        assert.equal(new URL(page.url()).searchParams.get("vars"), initial, "Hover must not select a service")
        assert.equal(await slice.getAttribute("aria-pressed"), "false")
        await page.mouse.click(coordinate.x, coordinate.y)
      }
      const tip = page.getByRole("tooltip")
      await tip.waitFor()
      assert.equal(await tip.locator("time").getAttribute("datetime"), new Date(sampleTime).toISOString())
      assert.equal(await tip.locator("time").count(), 1, "The observation timestamp appears once")
      const timestampBounds = await tip.evaluate(element => {
        const time = element.querySelector("time")?.getBoundingClientRect()
        const footer = element.querySelector("[data-tooltip-instructions]")?.closest('[class*="tooltipFooter"]')?.getBoundingClientRect()
        const panel = element.getBoundingClientRect()
        return time && footer ? { timeTop: time.top, timeBottom: time.bottom, panelTop: panel.top, panelBottom: panel.bottom, footerTop: footer.top, scrollTop: element.scrollTop } : null
      })
      assert.ok(timestampBounds && timestampBounds.scrollTop === 0 && timestampBounds.timeTop >= timestampBounds.panelTop && timestampBounds.timeBottom <= Math.min(timestampBounds.panelBottom, timestampBounds.footerTop) + 1, `The timestamp must be visible before scrolling and not covered by instructions: ${JSON.stringify(timestampBounds)}`)
      assert.ok(await tip.locator(`[data-metric-value="${sampleValue}"]`).count())
      assert.match(await tip.innerText(), /Share of positive observations:/)
      await page.waitForFunction(element => element.getAttribute("aria-pressed") === "true", await slice.elementHandle(), { timeout: 5000 })
      const intersections = await tip.evaluate(element => {
        const panel = element.getBoundingClientRect()
        return [...document.querySelectorAll("[data-tooltip-obstacle]")].map(control => {
          const bounds = control.getBoundingClientRect()
          return { width: Math.max(0, Math.min(panel.right, bounds.right) - Math.max(panel.left, bounds.left)), height: Math.max(0, Math.min(panel.bottom, bounds.bottom) - Math.max(panel.top, bounds.top)) }
        }).filter(overlap => overlap.width > 1 && overlap.height > 1)
      })
      assert.deepEqual(intersections, [], "The pinned pie inspector must leave dashboard controls uncovered when another placement fits")
      await page.screenshot({ path: `../artifacts/insights/metric-pie-tooltip-live/${theme}-${width}.png`, animations: "disabled" })
      await page.keyboard.press("Escape")
      await tip.waitFor({ state: "hidden" })
      await page.evaluate(() => document.activeElement instanceof HTMLElement || document.activeElement instanceof SVGElement ? document.activeElement.blur() : undefined)
      await slice.focus()
      await tip.waitFor()
      assert.equal(new URL(page.url()).searchParams.get("vars"), initial, "Inspection without bindings must not select a service")
      await page.keyboard.press("Escape")
      const selectable = page.locator('[data-widget-id="selectable"]')
      await selectable.scrollIntoViewIfNeeded()
      const target = selectable.locator('[data-pie-index]').first()
      await target.focus()
      await page.keyboard.press("Enter")
      await page.waitForFunction(({ service }) => { try { return JSON.parse(new URL(location.href).searchParams.get("vars")).service === service } catch { return false } }, { service: match.labels.service })
      const many = page.locator('[data-widget-id="many"]')
      await many.scrollIntoViewIfNeeded()
      const longLegend = many.getByRole("region", { name: "Legend for Node shares" })
      await longLegend.locator(":scope > span").first().waitFor()
      const nodeLabels = await longLegend.locator(":scope > span").evaluateAll(entries => entries.map(entry => ({ text: [...entry.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join("").trim(), full: entry.getAttribute("title"), accessible: entry.getAttribute("aria-label") })))
      assert.ok(nodeLabels.length >= 12 && nodeLabels.every(entry => entry.text.includes("node-") && !entry.text.includes("{")), "Generated node identities should be concise")
      assert.equal(new Set(nodeLabels.map(entry => entry.text)).size, nodeLabels.length, "Compact labels must distinguish every series")
      assert.ok(nodeLabels.every(entry => entry.full?.includes("cluster=") && entry.accessible?.includes(entry.full)), "The full provider identity must remain available")
      if (await longLegend.evaluate(element => element.scrollHeight > element.clientHeight + 1)) {
        sawLegendOverflow = true
        await many.getByText("Scroll the legend to see more series.").waitFor()
        await longLegend.focus()
        await longLegend.press("End")
        await page.waitForFunction(element => element.scrollTop > 0, await longLegend.elementHandle())
      } else assert.equal(await many.getByText("Scroll the legend to see more series.").count(), 0)
      await page.screenshot({ path: `../artifacts/insights/metric-pie-tooltip-live/legend-${theme}-${width}.png`, animations: "disabled" })
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: exact live pie observation, explicit selection, pinning and keyboard inspection`)
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
assert.ok(sawLegendOverflow, "A long legend must remain keyboard-scrollable where space is limited")
