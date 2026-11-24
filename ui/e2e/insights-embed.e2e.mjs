// Insights embed mode, as an application page frames it: one widget, read-only, filling the frame, at phone, tablet
// and desktop widths in light and dark. Real Insights documents and providers; query values are deterministic.
// Run after `npm run build` from ui/: node e2e/insights-embed.e2e.mjs
// Screenshots go to INSIGHTS_EMBED_SCREENSHOTS (default: a temporary directory, printed at the end).
import assert from "node:assert/strict"
import { mkdir, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const shots = process.env.INSIGHTS_EMBED_SCREENSHOTS || await mkdtemp(join(tmpdir(), "insights-embed-"))
await mkdir(shots, { recursive: true })
// Without INSIGHTS_E2E_URL the harness serves ui/out itself.
const environment = await createReferenceDashboardEnvironment(repository, process.env.INSIGHTS_E2E_URL)
const browser = await chromium.launch({ headless: true })

// One row is 58 px plus a 16 px gap, and the frame adds a 28 px line for the Open dashboard link (frameHeight).
const frameHeight = rows => Math.min(560, Math.max(120, rows * 74 - 16 + 28))

try {
  const metrics = environment.providerIds.metrics
  const dashboard = {
    schemaVersion: 1, id: "embed-check", title: "Checkout service", timeRange: "1h", refreshInterval: 15,
    variables: [{ name: "service", defaultValue: "web" }],
    widgets: [
      {
        id: "requests", title: "Request rate", type: "timeseries", providerId: metrics, unit: "req/s",
        query: "sum(rate(http_requests_total{service={{service}}}[5m])) by (route)",
        drilldowns: [{ id: "inspect", title: "Inspect", dashboardId: "embed-check" }],
        layout: { x: 0, y: 0, w: 8, h: 4 },
      },
      {
        id: "errors", title: "Error ratio", type: "stat", providerId: metrics, unit: "%",
        query: "sum(rate(http_errors_total{service={{service}}}[5m]))", options: { showSparkline: true, decimals: 2 },
        layout: { x: 8, y: 0, w: 4, h: 2 },
      },
    ],
  }
  await environment.api(`dashboards/${dashboard.id}`, "PUT", dashboard, { "If-None-Match": "*" })

  const services = new Set()
  const resolver = request => {
    services.add(/service="([^"]*)"/.exec(request.query)?.[1])
    const step = Math.max(request.step || 60, 60)
    const series = (name, base) => ({
      name, labels: { route: name },
      points: Array.from({ length: Math.floor((request.end - request.start) / step) + 1 }, (_, index) => ({
        timestamp: (request.start + index * step) * 1000, value: base + 6 * Math.sin(index / 5) + index * 0.05,
      })),
    })
    return { series: request.query.includes("by (route)") ? [series("/checkout", 42), series("/cart", 18), series("/pay", 9)] : [series("errors", 0.42)] }
  }
  const embedURL = (widget, theme) => {
    const search = new URLSearchParams({ dashboard: dashboard.id, vars: JSON.stringify({ service: "checkout" }), embed: widget, theme })
    return `${environment.baseURL}/dashboard/insights/?${search}`
  }

  for (const theme of ["light", "dark"]) {
    for (const width of [390, 768, 1512]) {
      for (const [widget, rows] of [["requests", 4], ["errors", 2]]) {
        const context = await browser.newContext({ viewport: { width, height: frameHeight(rows) } })
        const page = await context.newPage()
        await environment.installQueryFixture(page, resolver)
        const errors = []
        page.on("pageerror", error => errors.push(error.message))
        try {
          await page.goto(embedURL(widget, theme), { waitUntil: "networkidle" })
          const tile = page.locator("[data-widget-id]")
          await tile.first().waitFor()
          await page.waitForFunction(() => !document.querySelector("[aria-busy=true]"))
          const label = `${widget} ${width}px ${theme}`
          assert.equal(await tile.count(), 1, `${label}: one tile`)
          assert.equal(await tile.getAttribute("data-widget-id"), widget)
          assert.equal(await page.locator("[data-insights-embed]").getAttribute("data-insights-theme"), theme, `${label}: theme`)
          // No workspace chrome: no sidebar, toolbar, editing or drilldown controls, and one link.
          assert.equal(await page.locator("nav, aside, [role=toolbar], [data-widget-edit], [data-widget-actions]").count(), 0, `${label}: no chrome`)
          assert.equal(await page.getByRole("button", { name: /Explore|Edit|Save|Open related/ }).count(), 0, `${label}: no edit or drilldown buttons`)
          const links = page.getByRole("link")
          assert.equal(await links.count(), 1, `${label}: only the Open dashboard link`)
          assert.equal(await links.getAttribute("target"), "_top")
          const href = new URL(await links.getAttribute("href"), environment.baseURL)
          assert.equal(href.origin, new URL(environment.baseURL).origin)
          assert.deepEqual(Object.fromEntries(href.searchParams), { dashboard: dashboard.id, vars: '{"service":"checkout"}' }, `${label}: link drops embed parameters`)
          // The tile fills the frame without overflowing it, and nothing inside it is clipped sideways.
          const geometry = await page.evaluate(() => {
            const root = document.documentElement, tile = document.querySelector("[data-widget-id]").getBoundingClientRect()
            const clipped = [...document.querySelectorAll("[data-widget-id] *")].filter(element => {
              const style = getComputedStyle(element)
              return element.children.length === 0 && element.textContent.trim() && style.overflowX !== "visible" && style.textOverflow !== "ellipsis" && element.scrollWidth > element.clientWidth + 1
            }).map(element => element.textContent.trim().slice(0, 40))
            return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight, tile: { top: tile.top, bottom: tile.bottom, width: tile.width }, clipped }
          })
          assert.ok(geometry.scrollWidth <= geometry.clientWidth, `${label}: no horizontal overflow (${geometry.scrollWidth} > ${geometry.clientWidth})`)
          assert.ok(geometry.scrollHeight <= geometry.clientHeight, `${label}: no vertical scroll (${geometry.scrollHeight} > ${geometry.clientHeight})`)
          assert.ok(geometry.tile.width >= width - 2, `${label}: tile fills the width`)
          assert.ok(geometry.tile.bottom - geometry.tile.top >= frameHeight(rows) - 40, `${label}: tile fills the height`)
          assert.deepEqual(geometry.clipped, [], `${label}: no clipped text`)
          assert.deepEqual(errors, [], `${label}: no page errors`)
          await page.screenshot({ path: join(shots, `embed-${widget}-${width}-${theme}.png`) })
          if (widget === "requests" && width === 390) {
            // The tile's read-only data inspector opens inside the frame and stays within it.
            await page.getByRole("button", { name: /Inspect chart data/ }).click()
            const dialog = page.getByRole("dialog")
            await dialog.waitFor()
            const box = await dialog.boundingBox()
            assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${label}: the data inspector fits the frame width`)
            await page.screenshot({ path: join(shots, `embed-inspect-${width}-${theme}.png`) })
            await page.keyboard.press("Escape")
            await dialog.waitFor({ state: "hidden" })
          }
        } finally {
          await context.close()
        }
      }
    }
  }
  assert.deepEqual([...services], ["checkout"], "Every query used the link's variable value")

  // As an application page frames it: same origin, the session shared through storage, Open dashboard leaves the frame.
  for (const width of [390, 1512]) {
    const context = await browser.newContext({ viewport: { width, height: 700 } })
    const page = await context.newPage()
    await environment.installQueryFixture(page, resolver)
    const host = `${environment.baseURL}/__embed-host/`
    await page.route(host, route => route.fulfill({
      status: 200, contentType: "text/html",
      body: `<!doctype html><meta name="viewport" content="width=device-width"><body style="margin:0;padding:16px;font-family:sans-serif;background:#f4f1ea">
        <h3>Dashboards for this application</h3>
        <iframe title="Checkout service: summary widget" src="${embedURL("requests", "light")}" loading="lazy" style="display:block;width:100%;height:${frameHeight(4)}px;border:0"></iframe></body>`,
    }))
    try {
      await page.goto(host)
      const frame = page.frameLocator("iframe")
      await frame.locator("[data-widget-id=requests]").waitFor()
      await frame.locator(".recharts-surface, svg").first().waitFor()
      await page.waitForTimeout(500)
      await page.screenshot({ path: join(shots, `host-${width}.png`) })
      await frame.getByRole("link", { name: "Open dashboard" }).click()
      await page.waitForURL(url => url.pathname === "/dashboard/insights/" && !url.searchParams.has("embed"))
      assert.equal(new URL(page.url()).searchParams.get("dashboard"), dashboard.id, "Open dashboard opens the whole dashboard in the top window")
    } finally {
      await context.close()
    }
  }
  assert.deepEqual(environment.failures, [], "Query fixtures saw only valid requests")
  console.log(`Insights embed: PASS. Screenshots in ${shots}`)
} finally {
  await browser.close()
  await environment.close()
}
