// Gauge layout acceptance using isolated deterministic reference fixtures.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"
import { referenceDashboards, resultForReferenceQuery } from "./fixtures/reference-dashboard-data.ts"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = join(root, "artifacts/insights/gauge-layout")
const reports = [], errors = []
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
let currentPage
try {
  for (const { width, wideReading = false, sidebarClosed = false } of [{ width: 1600, sidebarClosed: true }, { width: 1440 }, { width: 1280 }, { width: 390 }, { width: 320 }, { width: 390, wideReading: true }]) for (const theme of ["Light", "Dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width >= 1440 ? 1100 : 844 }, colorScheme: theme.toLowerCase(), reducedMotion: "reduce" })
    const page = await context.newPage()
    currentPage = page
    page.on("pageerror", error => errors.push(error.message))
    const api = await installRichChartFixtureAPI(page, base)
    const reference = referenceDashboards.find(board => board.id === "reference-service-overview")
    const board = structuredClone(reference.bundle.dashboards[0])
    if (wideReading) {
      const widget = board.widgets.find(item => item.id === "reference-service-overview-disk-gauges")
      widget.unit = "MB/s"; widget.options.decimals = 2
    }
    api.documents.set(board.id, board)
    for (const query of reference.bundle.savedQueries) api.savedQueries.set(query.id, structuredClone(query))
    await page.route(`${base}/api/insights/query`, async route => {
      try {
        const request = route.request().postDataJSON(), result = resultForReferenceQuery(request)
        if (wideReading && request.query.includes("free_radial")) for (const series of result.series ?? []) for (const point of series.points) point.value = 123456.78
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(result) })
      }
      catch (error) { await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: error.message }) }) }
    })
    await page.goto(`${base}/dashboard/insights/?dashboard=${board.id}`, { waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Service overview", exact: true }).waitFor()
    await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
    if (sidebarClosed) {
      const sidebar = page.getByRole("button", { name: "Toggle sidebar", exact: true })
      if (await sidebar.getAttribute("aria-expanded") === "true") await sidebar.click()
    }
    const tile = page.locator('[data-widget-id="reference-service-overview-disk-gauges"]')
    await tile.scrollIntoViewIfNeeded()
    const bank = tile.getByRole("region", { name: "Free disk space · volumes gauges", exact: true })
    await bank.locator('[data-gauge-series]').nth(5).waitFor()
    await page.evaluate(() => document.fonts.ready)
    // Let responsive grid projection and the gauge ResizeObserver settle.
    await page.waitForTimeout(300)
    const geometry = await bank.evaluate(node => {
      const bounds = node.getBoundingClientRect(), rows = [...node.querySelectorAll('[data-gauge-series]')].map(row => {
        const box = row.getBoundingClientRect(), label = row.querySelector('[data-gauge-label]').getBoundingClientRect(), value = row.querySelector('[data-gauge-number]')
        const valueBox = value.getBoundingClientRect(), range = document.createRange(); range.selectNodeContents(value)
        const unit = row.querySelector('[data-gauge-unit]'), unitBox = unit?.getBoundingClientRect(), unitRange = document.createRange(); if (unit) unitRange.selectNodeContents(unit)
        const scale = [...row.querySelectorAll('[data-gauge-bound]')].map(bound => { const rect=bound.getBoundingClientRect(); return { left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,fontSize:parseFloat(getComputedStyle(bound).fontSize),scrollWidth:bound.scrollWidth,clientWidth:bound.clientWidth,text:bound.textContent } })
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1
        const ctx = canvas.getContext('2d'), ancestors=[]; for(let node=value; node; node=node.parentElement) ancestors.push(node)
        ctx.fillStyle = '#fff'; ctx.fillRect(0,0,1,1)
        for(const node of ancestors.reverse()) { ctx.fillStyle = getComputedStyle(node).backgroundColor; ctx.fillRect(0,0,1,1) }
        const background = [...ctx.getImageData(0,0,1,1).data].slice(0,3)
        ctx.clearRect(0,0,1,1); ctx.fillStyle = getComputedStyle(value).color; ctx.fillRect(0,0,1,1)
        const foreground = [...ctx.getImageData(0,0,1,1).data].slice(0,3)
        const lum = color => color.map(n => n/255).map(n => n <= .04045 ? n/12.92 : ((n+.055)/1.055)**2.4).reduce((sum,n,i) => sum + n*[.2126,.7152,.0722][i],0)
        const fg=lum(foreground), bg=lum(background), contrast=(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)
        return { name: row.dataset.gaugeSeries, top: box.top, left: box.left, right: box.right, bottom: box.bottom, labelBottom: label.bottom, glyphs: [...range.getClientRects()].map(glyph => ({ left: glyph.left, right: glyph.right, top: glyph.top, bottom: glyph.bottom })), valueLeft: valueBox.left, valueRight: valueBox.right, valueTop: valueBox.top, valueBottom: valueBox.bottom, valueClientHeight: value.clientHeight, valueScrollHeight: value.scrollHeight, value: value.textContent, unit: unit?.textContent, unitLeft: unitBox?.left, unitRight: unitBox?.right, unitGlyphs: unit ? [...unitRange.getClientRects()].map(glyph => ({ left: glyph.left, right: glyph.right })) : [], scale, foreground, background, contrast }
      })
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, clientWidth: node.clientWidth, scrollWidth: node.scrollWidth, rows }
    })
    const columns = new Set(geometry.rows.map(row => Math.round(row.left))).size
    assert.equal(geometry.rows.length, 6)
    if (width >= 1280) {
      assert.equal(columns, 3, `${width}px ${theme}: authored 3-column radial bank should fit: ${JSON.stringify(geometry)}`)
      assert.ok(geometry.rows.every(row => row.top >= geometry.top - 1 && row.bottom <= geometry.bottom + 1 && row.labelBottom <= geometry.bottom + 1), `${width}px ${theme}: all six radial gauges should be visible: ${JSON.stringify(geometry)}`)
    }
    if (wideReading) {
      assert.equal(columns, 2, "Long values need enough width even when the authored layout has three columns")
      assert.ok(geometry.rows.every(row => row.value === "123,456.78" && row.unit === "MB/s"), "Long values and units must remain complete")
      assert.ok((await bank.getByRole("meter").first().getAttribute("aria-valuetext")).includes("123456.78 MB/s"), "Out-of-scale exact values remain accessible")
    }
    for (const row of geometry.rows) {
      assert.ok(row.contrast >= 4.5, `${width}px ${theme}: status-colored gauge values need readable contrast: ${JSON.stringify(row)}`)
      assert.ok(row.glyphs.every(glyph => glyph.left >= row.valueLeft - .05 && glyph.right <= row.valueRight + .05), `${width}px ${theme}: gauge value clipped: ${JSON.stringify(row)}`)
      assert.ok(row.glyphs.every(glyph => glyph.top >= row.valueTop - 1 && glyph.bottom <= row.valueBottom + 1) && row.valueScrollHeight <= row.valueClientHeight + 1, `${width}px ${theme}: the value line needs enough height for its glyphs: ${JSON.stringify(row)}`)
      assert.ok(row.unitGlyphs.every(glyph => glyph.left >= row.unitLeft - .05 && glyph.right <= row.unitRight + .05), `${width}px ${theme}: gauge unit clipped: ${JSON.stringify(row)}`)
      assert.equal(row.scale.length, 2, "Radial gauges show both scale endpoints")
      assert.ok(row.scale.every(label => label.fontSize >= 10 && label.left >= row.left - 1 && label.right <= row.right + 1), `${width}px ${theme}: scale endpoints must be readable and inside the gauge: ${JSON.stringify(row)}`)
      assert.ok(row.scale[0].right <= row.scale[1].left, `${width}px ${theme}: scale endpoints must not overlap`)
      assert.ok(row.scale.every(label => label.right <= row.valueLeft || label.left >= row.valueRight || label.top >= row.valueBottom || label.bottom <= row.valueTop), `${width}px ${theme}: scale labels must not overlap the reading: ${JSON.stringify(row)}`)
    }
    if (!wideReading) assert.ok(new Set(geometry.rows.map(row => row.foreground.join(','))).size >= 3, `${width}px ${theme}: distinct gauge thresholds should be visible in the readings`)
    if (width >= 1280) {
      const trigger = bank.getByRole("button", { name: /(?:Inspect value|Select signal) for Free disk space · volumes: sda1/ })
      await trigger.hover()
      const tooltip = page.getByRole("tooltip")
      await tooltip.waitFor({ state: "visible" })
      assert.match(await tooltip.innerText(), /Critical[\s\S]*Below 10 GB[\s\S]*Scale: 0 to 100 GB/, `${width}px ${theme}: gauge tooltip should explain its threshold band and scale`)
      const [panel, widgetBounds] = await Promise.all([tooltip.boundingBox(), tile.boundingBox()])
      assert.ok(panel && widgetBounds && (panel.x + panel.width <= widgetBounds.x + 1 || panel.x >= widgetBounds.x + widgetBounds.width - 1 || panel.y + panel.height <= widgetBounds.y + 1 || panel.y >= widgetBounds.y + widgetBounds.height - 1), `${width}px ${theme}: gauge details should sit outside the widget when there is space`)
      if (width === 1600) await page.screenshot({ path: join(output, `gauge-tooltip-${theme.toLowerCase()}.png`), animations: "disabled" })
      if (width === 1600) assert.equal(await tooltip.getAttribute("data-tooltip-overlaps-other-widget"), "true", "This dense reference must exercise a tooltip over a neighboring chart")
      if (await tooltip.getAttribute("data-tooltip-overlaps-other-widget") === "true") {
        assert.equal(await tooltip.evaluate(element => getComputedStyle(element).pointerEvents), "none", "An unpinned tooltip cannot block a neighboring chart")
        await trigger.click()
        assert.equal(await trigger.getAttribute("aria-pressed"), "true", "Clicking the gauge pins details")
        assert.notEqual(await tooltip.evaluate(element => getComputedStyle(element).pointerEvents), "none", "Pinned details remain interactive")
        await page.keyboard.press("Escape")
      }
      await page.mouse.move(1, 1)
      await tooltip.waitFor({ state: "hidden" })
    }
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "No page-level horizontal overflow")
    if (geometry.scrollHeight <= geometry.clientHeight + 1 && geometry.scrollWidth <= geometry.clientWidth + 1) {
      await tile.locator('[data-gauge-overflow-hint]').waitFor({ state: "hidden", timeout: 3000 })
      assert.equal(await tile.locator('[data-gauge-overflow-hint]').count(), 0, "A bank that fits must not retain an overflow hint")
    }
    if (geometry.scrollHeight > geometry.clientHeight + 1) {
      assert.equal(await bank.getAttribute("tabindex"), "0", "Overflowing gauges must be keyboard reachable")
      await bank.focus(); await page.keyboard.press("End")
      await page.waitForFunction(() => { const node = document.querySelector('[aria-label="Free disk space · volumes gauges"]'); return node && node.scrollTop + node.clientHeight >= node.scrollHeight - 1 })
      const last = bank.locator('[data-gauge-series]').last().locator('[data-gauge-label]')
      assert.ok(await last.evaluate(label => { const bank = label.closest('[data-gauge-bank-display]')?.getBoundingClientRect(), rect = label.getBoundingClientRect(); return bank && rect.top >= bank.top - 1 && rect.bottom <= bank.bottom + 1 }), "Keyboard scrolling exposes the final gauge")
    }
    await page.screenshot({ path: join(output, `radial-${wideReading ? "wide-" : ""}${theme.toLowerCase()}-${width}.png`), animations: "disabled" })
    reports.push({ width, theme, wideReading, columns, bank: geometry })
    console.log(`PASS ${wideReading ? "wide-reading " : ""}radial bank ${theme} ${width}px, ${columns} columns`)
    await context.close()
  }
  assert.deepEqual(errors, [])
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: true, reports, errors }, null, 2))
} catch (error) {
  await currentPage?.screenshot({ path: join(output, "failure.png"), animations: "disabled" }).catch(() => {})
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: false, reports, errors, error: error.stack }, null, 2))
  console.error(error.stack); process.exitCode = 1
} finally { await browser.close() }
