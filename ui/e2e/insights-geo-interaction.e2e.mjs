// Renderer, saved-query tooltip and selection binding integration. The API is
// deterministic fixture data; production-provider coverage is separate.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"

const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const origin = new URL(base).origin
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: "reduce" })
    try {
      await context.addInitScript(({ origin, theme }) => { if (location.origin === origin) localStorage.setItem("paprika-insights-theme", theme) }, { origin, theme })
      const page = await context.newPage(), errors = []
      page.on("pageerror", error => errors.push(error.message))
      const api = await installRichChartFixtureAPI(page, base)
      const board = api.documents.get("example-artboard-edge-watch")
      const geo = board.widgets.find(widget => widget.id === "locations")
      geo.pluginId = "geo-heatmap"
      geo.config = { mode:"grid", label:"label", value:"value", aggregation:"mean", gridColumns:8 }
      geo.options = { ...geo.options, tooltipView:{ type:"stat", source:{ type:"saved", ref:{ id:"ab-edge-watch-ingress", bindings:[{parameter:"gateway",source:"label",label:"gateway"}] } } } }
      geo.selectionBindings = [{variable:"location",source:"label",value:"label"}]
      board.variables.push({ name:"location", label:"Location", defaultValue:"unset" })
      board.widgets = [geo]
      await page.goto(`${origin}/dashboard/insights/?dashboard=${board.id}`, { waitUntil:"networkidle" })
      const cell = page.getByRole("button", { name:/Melbourne · Mean of value/ })
      await cell.waitFor({ timeout:30000 })
      const requests = () => api.calls.filter(call => call.path === "/query" && call.document?.kind === "metrics")
      assert.equal(requests().length, 0, "Tooltip query must not run while closed")
      const response = page.waitForResponse(response => response.url().includes("/api/insights/query") && response.request().postDataJSON()?.kind === "metrics" && response.ok())
      await cell.focus()
      const tooltip = page.getByRole("tooltip"); await tooltip.waitFor()
      const instructions = tooltip.locator("[data-tooltip-instructions]")
      assert.equal(await instructions.getByText("Swipe to scroll · tap outside to close").isVisible(), width === 390)
      assert.equal(await instructions.getByText("Page Up/Down to scroll · Esc to close").isVisible(), width !== 390)
      await page.waitForFunction(() => document.querySelector('[data-tooltip-widget="stat"]'))
      await response
      assert.equal(requests().length, 1)
      assert.match(requests()[0].document.query, /gateway="edge-01"/)
      assert.ok(!page.url().includes("Melbourne"), "Focusing should not select a location")
      const assertFooterVisible = async () => {
        const bounds = await instructions.evaluate(element => {
          const footer = element.closest("div").getBoundingClientRect()
          const panel = element.closest('[role="tooltip"]').getBoundingClientRect()
          return { footerTop:footer.top, footerBottom:footer.bottom, panelTop:panel.top, panelBottom:panel.bottom, viewportHeight:window.innerHeight }
        })
        assert.ok(bounds.footerTop >= bounds.panelTop && bounds.footerBottom <= bounds.panelBottom + 1, `Footer clipped by tooltip: ${JSON.stringify(bounds)}`)
        assert.ok(bounds.footerTop >= 0 && bounds.footerBottom <= bounds.viewportHeight, `Footer outside viewport: ${JSON.stringify(bounds)}`)
      }
      await assertFooterVisible()
      await cell.press("Enter")
      await page.waitForURL(/Melbourne/)
      if (width === 390) {
        await cell.tap()
        await tooltip.waitFor()
        await tooltip.getByText("Latest valid sample", {exact:false}).waitFor()
        // Allow the tooltip ResizeObserver to position the loaded content.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        const panel = await tooltip.boundingBox()
        const before = await tooltip.evaluate(element => ({ top:element.scrollTop, max:element.scrollHeight-element.clientHeight }))
        assert.ok(before.max > 0, "Fixture must exercise a scrollable inspector")
        const session = await context.newCDPSession(page)
        const x = panel.x + panel.width / 2, y = panel.y + panel.height / 2
        await session.send("Input.dispatchTouchEvent", { type:"touchStart", touchPoints:[{x,y}] })
        for (let distance = 20; distance <= 140; distance += 20) {
          await session.send("Input.dispatchTouchEvent", { type:"touchMove", touchPoints:[{x,y:y-distance}] })
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        await session.send("Input.dispatchTouchEvent", { type:"touchEnd", touchPoints:[] })
        await page.waitForFunction(() => document.querySelector('[role="tooltip"]').scrollTop > 0)
        await assertFooterVisible()
        await session.detach()
      }
      assert.ok(page.url().includes("Melbourne"), "Activating should set a shareable dashboard variable")
      await page.keyboard.press("Escape")
      await tooltip.waitFor({ state:"hidden" })
      if (width === 390) {
        await cell.tap()
        await tooltip.waitFor()
        await page.locator("body").tap({ position:{x:5,y:5} })
        await tooltip.waitFor({ state:"hidden" })
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      assert.deepEqual(errors, []); assert.deepEqual(api.failures, [])
      console.log(`PASS ${theme} ${width}px: saved-query tooltip, focus and explicit geo selection`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
