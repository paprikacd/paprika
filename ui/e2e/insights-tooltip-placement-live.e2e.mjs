// Verify the shared floating inspector in the provider-backed dashboard.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", origin).href, { waitUntil: "networkidle" })
      const chart = page.locator('[data-widget-id="flow"] svg[role="group"]')
      await chart.scrollIntoViewIfNeeded()
      const rect = await chart.boundingBox()
      assert.ok(rect?.width > 60 && rect.height > 60)
      await page.mouse.move(rect.x + rect.width * .3, rect.y + rect.height * .5)
      const tooltip = page.getByRole("region", { name: "Observation details" })
      await tooltip.waitFor()
      const geometry = async (panel, id) => panel.evaluate((element, widgetId) => {
        const tip = element.getBoundingClientRect(), owner = document.querySelector(`[data-widget-id="${widgetId}"]`).getBoundingClientRect()
        return { left: tip.left, right: tip.right, top: tip.top, bottom: tip.bottom, width: innerWidth, height: innerHeight,
          actualOverlap: tip.left < owner.right && tip.right > owner.left && tip.top < owner.bottom && tip.bottom > owner.top,
          declaredOverlap: element.dataset.tooltipOverlap === "true", followsPointer: element.dataset.tooltipPointer === "true", pointer: getComputedStyle(element).pointerEvents,
          occupied: element.dataset.tooltipOverlapsOtherWidget === "true" || element.dataset.tooltipOverlapsControls === "true" }
      }, id)
      const insideViewport = state => assert.ok(state.left >= -1 && state.top >= -1 && state.right <= state.width + 1 && state.bottom <= state.height + 1, `Inspector leaves viewport: ${JSON.stringify(state)}`)
      const settles = async panel => panel.evaluate(element => new Promise(resolve => {
        const start = performance.now(); let last, stable = 0
        const measure = () => {
          const box = element.getBoundingClientRect(), next = [box.x, box.y, box.width, box.height]
          stable = last && next.every((value, index) => Math.abs(value - last[index]) < .25) ? stable + 1 : 0
          if (stable >= 3 || performance.now() - start > 2000) resolve(stable >= 3)
          else { last = next; requestAnimationFrame(measure) }
        }
        requestAnimationFrame(measure)
      }))
      const assertPointer = async (panel, x, y) => {
        await page.waitForFunction(({ element, y }) => {
          const box = element.getBoundingClientRect()
          return element.dataset.tooltipPointer === "true" && Math.min(Math.abs(box.top - y - 16), Math.abs(box.bottom - y + 16)) <= 2
        }, { element: await panel.elementHandle(), y })
        const bounds = await panel.boundingBox()
        assert.ok(bounds)
        const verticalGap = Math.min(Math.abs(bounds.y - (y + 16)), Math.abs(bounds.y + bounds.height - (y - 16)))
        assert.ok(verticalGap <= 2, `Tooltip must follow the pointer with a 16px vertical gap: ${JSON.stringify({ bounds, x, y, verticalGap })}`)
        assert.equal(await panel.evaluate(element => getComputedStyle(element).pointerEvents), "none", "Transient hover must not intercept the chart")
      }
      await assertPointer(tooltip, rect.x + rect.width * .3, rect.y + rect.height * .5)
      let state = await geometry(tooltip, "flow")
      insideViewport(state)
      assert.equal(await settles(tooltip), true, "Hover position must settle")
      assert.ok(state.bottom - state.top <= 350, "Transient traffic details should stay compact")
      await tooltip.getByText("Click or tap chart to pin details").waitFor()
      const peers = tooltip.getByRole("list", { name: "Series at selected time" })
      assert.equal(await peers.locator("li").count(), 2)
      await peers.getByText("inbound", { exact: true }).waitFor()
      await peers.getByText("outbound", { exact: true }).waitFor()
      if (!state.followsPointer && !state.declaredOverlap) assert.equal(state.actualOverlap, false, `Outside placement covers the owner: ${JSON.stringify(state)}`)
      if (state.actualOverlap || state.occupied) assert.equal(state.pointer, "none", "A hover preview must not block another chart")
      const first = await tooltip.locator("time").first().getAttribute("datetime")
      await page.mouse.move(rect.x + rect.width * .3 + 3, rect.y + rect.height * .5 + 2)
      await assertPointer(tooltip, rect.x + rect.width * .3 + 3, rect.y + rect.height * .5 + 2)
      const scroll = await page.evaluate(() => scrollY)
      await page.evaluate(() => window.scrollBy(0, 20))
      if (await page.evaluate(previous => scrollY !== previous, scroll)) {
        await assertPointer(tooltip, rect.x + rect.width * .3 + 3, rect.y + rect.height * .5 + 2)
        await page.evaluate(previous => window.scrollTo(0, previous), scroll)
      }
      await page.mouse.move(rect.x + rect.width * .7, rect.y + rect.height * .5)
      await page.waitForFunction(previous => document.querySelector('[aria-label="Observation details"] time')?.getAttribute("datetime") !== previous, first)
      await assertPointer(tooltip, rect.x + rect.width * .7, rect.y + rect.height * .5)
      await page.mouse.click(rect.x + rect.width * .7, rect.y + rect.height * .5)
      await tooltip.getByRole("button", { name: "Unpin observation" }).waitFor()
      assert.notEqual((await geometry(tooltip, "flow")).pointer, "none", "A pinned panel remains interactive")
      assert.equal(await tooltip.locator("[data-stat-sparkline]").count(), 1, "Pinning restores the detailed history")
      await page.setViewportSize({ width, height: 760 })
      assert.equal(await settles(tooltip), true, "Pinned position must settle after resize")
      state = await geometry(tooltip, "flow"); insideViewport(state)
      if (!state.declaredOverlap) assert.equal(state.actualOverlap, false)
      await page.keyboard.press("Escape"); await tooltip.waitFor({ state: "hidden" })
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-service-pulse", origin).href, { waitUntil: "networkidle" })
      await page.locator('[data-widget-id="request-history"]').scrollIntoViewIfNeeded()
      const line = page.locator('[data-widget-id="request-history"] svg[role="img"]')
      await line.scrollIntoViewIfNeeded()
      const lineBounds = await line.boundingBox()
      assert.ok(lineBounds?.width > 60 && lineBounds.height > 60)
      await page.mouse.move(lineBounds.x + lineBounds.width * .45, lineBounds.y + lineBounds.height * .5)
      const lineTip = page.getByRole("tooltip"); await lineTip.waitFor()
      await assertPointer(lineTip, lineBounds.x + lineBounds.width * .45, lineBounds.y + lineBounds.height * .5)
      await line.focus(); await line.press("ArrowRight")
      await page.waitForFunction(element => element.dataset.tooltipPointer !== "true", await lineTip.elementHandle())
      assert.equal(await settles(lineTip), true, "Keyboard line inspector should settle")
      state = await geometry(lineTip, "request-history"); insideViewport(state)
      if (!state.declaredOverlap) assert.equal(state.actualOverlap, false, `Line inspector covers its chart: ${JSON.stringify(state)}`)
      await line.press("Escape"); await lineTip.waitFor({ state: "hidden" })
      await page.locator('[data-widget-id="latency-distribution"]').scrollIntoViewIfNeeded()
      const heatmap = page.locator('[data-widget-id="latency-distribution"] svg[role="group"]')
      await heatmap.scrollIntoViewIfNeeded()
      const heatmapBounds = await heatmap.boundingBox()
      assert.ok(heatmapBounds?.width > 60 && heatmapBounds.height > 60)
      await page.mouse.move(heatmapBounds.x + heatmapBounds.width * .5, heatmapBounds.y + heatmapBounds.height * .5)
      const heatmapTip = page.getByRole("region", { name: "Observation details" }); await heatmapTip.waitFor()
      await assertPointer(heatmapTip, heatmapBounds.x + heatmapBounds.width * .5, heatmapBounds.y + heatmapBounds.height * .5)
      await heatmap.focus(); await heatmap.press("ArrowUp")
      await page.waitForFunction(element => element.dataset.tooltipPointer !== "true", await heatmapTip.elementHandle())
      assert.equal(await settles(heatmapTip), true, "Keyboard heatmap inspector should settle")
      state = await geometry(heatmapTip, "latency-distribution"); insideViewport(state)
      if (!state.declaredOverlap) assert.equal(state.actualOverlap, false, `Heatmap inspector covers its chart: ${JSON.stringify(state)}`)
      await heatmap.press("Escape"); await heatmapTip.waitFor({ state: "hidden" })
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: traffic, line and heatmap placement, pointer traversal, pin and resize`)
    } finally { await context.close() }
  }
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, colorScheme: theme, hasTouch: true, isMobile: true, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage()
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", origin).href, { waitUntil: "networkidle" })
      const chart = page.locator('[data-widget-id="flow"] svg[role="group"]')
      await chart.scrollIntoViewIfNeeded()
      const bounds = await chart.boundingBox()
      assert.ok(bounds?.width > 60 && bounds.height > 60)
      await page.touchscreen.tap(bounds.x + bounds.width * .5, bounds.y + bounds.height * .5)
      const panel = page.getByRole("region", { name: "Observation details" })
      await panel.getByRole("button", { name: "Unpin observation" }).waitFor()
      assert.notEqual(await panel.getAttribute("data-tooltip-pointer"), "true", "Touch must not use mouse hover placement")
      assert.notEqual(await panel.evaluate(node => getComputedStyle(node).pointerEvents), "none", "Touch-pinned details remain interactive")
      await page.keyboard.press("Escape"); await panel.waitFor({ state: "hidden" })
      console.log(`PASS ${theme} touch: chart tap pins interactive details and dismisses`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
