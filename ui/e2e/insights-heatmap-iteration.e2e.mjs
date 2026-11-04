// Browser acceptance for readable, truthful heatmaps and their portaled details.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { installRichChartFixtureAPI } from "./fixtures/rich-chart-api.mjs"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const distributionOnly = process.env.HEATMAP_DISTRIBUTION_ONLY === "1"
const output = join(root, "artifacts/insights/heatmap-iteration")
const reports = [], errors = [], external = []
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until(test, message, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { if (await test()) return; await pause(50) }
  throw new Error(message)
}
async function moveTo(page, locator) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  assert.ok(box && box.width > 1 && box.height > 2, "A visible cell needs a usable hit area")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 })
}
async function inspectPosition(panel, widget) {
  const evidence = await panel.evaluate(node => {
    const panel = node.getBoundingClientRect(), owner = document.querySelector('[data-widget-id="latency-distribution"]').getBoundingClientRect()
    const intersects = panel.left < owner.right && panel.right > owner.left && panel.top < owner.bottom && panel.bottom > owner.top
    return { parentIsBody: node.parentElement === document.body, intersects, pointerEvents: getComputedStyle(node).pointerEvents, left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom, viewportWidth: innerWidth, viewportHeight: innerHeight }
  })
  assert.ok(evidence.parentIsBody, "The inspector must escape the widget's clipping")
  assert.ok(evidence.left >= 0 && evidence.right <= evidence.viewportWidth + 1 && evidence.top >= 0 && evidence.bottom <= evidence.viewportHeight + 1, "The inspector must stay in the viewport")
  if (evidence.intersects) assert.equal(evidence.pointerEvents, "none", "A hover inspector without outside space must not intercept chart input")
  assert.ok(await widget.locator('[data-bucket-value]').count() > 0)
  return evidence
}

await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1512, 390]) for (const theme of ["Light", "Dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1100 }, reducedMotion: "reduce" })
    const page = await context.newPage(), fixture = await installRichChartFixtureAPI(page, base)
    page.on("pageerror", error => errors.push(error.message))
    page.on("request", request => { if (!request.url().startsWith(base) && !request.url().startsWith("data:")) external.push(request.url()) })
    await page.goto(`${base}/dashboard/insights/?dashboard=example-artboard-service-pulse`, { waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Service Pulse · Test fixture", exact: true }).waitFor()
    await selectGammaOption(page, page.getByRole("combobox", { name: "Dashboard appearance", exact: true }), theme)
    const heatmap = page.locator('[data-widget-id="latency-distribution"]')
    await heatmap.scrollIntoViewIfNeeded()
    await until(async () => await heatmap.locator('[data-bucket-value]').count() > 20, "Distribution cells did not render")
    const cells = heatmap.locator('[data-bucket-value]')
    await until(async () => await cells.evaluateAll(nodes => {
      const bucket = nodes[0]?.getAttribute('data-bucket-upper')
      const columns = nodes.filter(node => node.getAttribute('data-bucket-upper') === bucket).map(node => {
        const rect = node.getBoundingClientRect()
        return { left: rect.left, right: rect.right, width: rect.width }
      }).sort((a, b) => a.left - b.left)
      return columns.length > 2 && columns.every((cell, index) => cell.width > 0 && (!index || cell.left - columns[index - 1].right <= 1.1))
    }), 'Continuous source samples should fill the time grid with only a fine cell separator')
    const candidates = await cells.evaluateAll(nodes => nodes.map((node, index) => ({ index, value: node.getAttribute("data-bucket-value"), timestamp: node.getAttribute("data-timestamp"), width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height })).filter(cell => cell.value !== "unknown" && cell.width > 2 && cell.height > 3))
    assert.ok(candidates.length > 2, "Expected multiple visible observations")
    const first = candidates[0], second = candidates.find(cell => cell.value !== first.value)
    assert.ok(second, "Fixture needs distinct observations for pointer movement")
    await moveTo(page, cells.nth(first.index))
    const details = page.getByRole("region", { name: "Observation details", exact: true })
    await details.waitFor()
    await until(async () => await details.locator('[data-metric-value]').getAttribute('data-metric-value') === first.value, "First cell detail did not match the source")
    const geometry = await inspectPosition(details, heatmap)
    await moveTo(page, cells.nth(second.index))
    await until(async () => await details.locator('[data-metric-value]').getAttribute('data-metric-value') === second.value, "Moving across cells must update the same inspector")
    assert.equal(Date.parse(await details.locator('time').getAttribute('datetime')), Number(second.timestamp))
    await page.screenshot({ path: join(output, `distribution-${theme.toLowerCase()}-${width}.png`), fullPage: false, animations: "disabled" })
    await cells.nth(second.index).click({ force: true })
    await details.getByText("Pinned observation", { exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await details.waitFor({ state: "hidden" })
    reports.push({ check: "distribution", width, theme, sampledCells: candidates.length, geometry, hoverAndPin: true })

    if (distributionOnly) { assert.deepEqual(fixture.failures, []); await context.close(); console.log(`PASS ${theme} ${width}px distribution heatmap`); continue }

    const history = page.locator('[data-widget-id="states"]')
    await history.scrollIntoViewIfNeeded()
    await until(async () => await history.locator('[data-history-value]').count() > 4, "Status history did not render")
    const rows = history.locator('[data-history-series]')
    const alignment = await rows.evaluateAll(nodes => {
      const a = [...nodes[0].querySelectorAll('[data-history-timestamp]')]
      const b = [...nodes[1].querySelectorAll('[data-history-timestamp]')]
      for (const item of a) {
        const match = b.find(other => other.getAttribute('data-history-timestamp') === item.getAttribute('data-history-timestamp'))
        if (match) return Math.abs(parseFloat(item.style.left) - parseFloat(match.style.left))
      }
      return null
    })
    assert.ok(alignment !== null && alignment < .001, "Equal timestamps must align across status rows")
    const unknown = history.locator('[data-history-value="unknown"]').first()
    await unknown.waitFor()
    assert.match(await unknown.evaluate(node => getComputedStyle(node).backgroundImage), /repeating-linear-gradient/)
    await moveTo(page, unknown)
    const tip = page.getByRole("tooltip").filter({ hasText: "No data" })
    await tip.waitFor()
    await until(async () => /No data/.test(await tip.innerText()), "Unknown observation detail did not become visible")
    assert.equal(Date.parse(await tip.locator('time').getAttribute('datetime')), Number(await unknown.getAttribute('data-history-timestamp')))
    const portal = await tip.evaluate(node => node.parentElement === document.body)
    assert.ok(portal, "Status details must use the outside-widget portal")
    await unknown.click({ force: true })
    assert.equal(await unknown.getAttribute('aria-pressed'), 'true')
    await page.screenshot({ path: join(output, `history-${theme.toLowerCase()}-${width}.png`), fullPage: false, animations: "disabled" })
    await page.keyboard.press('Escape')
    await tip.waitFor({ state: 'hidden' })
    const historyCells = history.locator('[data-history-key]')
    assert.equal(await history.locator('[data-history-key][tabindex="0"]').count(), 1, 'History has one tab stop regardless of sample count')
    const firstCell = historyCells.first()
    await firstCell.focus()
    const firstKey = await firstCell.getAttribute('data-history-key')
    await page.keyboard.press('ArrowRight')
    await until(async () => await history.locator('[data-history-key]:focus').getAttribute('data-history-key') !== firstKey, 'Arrow keys did not move to the next sample')
    const focused = history.locator('[data-history-key]:focus')
    assert.equal(await focused.getAttribute('tabindex'), '0')
    await page.keyboard.press('Enter')
    assert.equal(await focused.getAttribute('aria-pressed'), 'true')
    const focusedValue = await focused.getAttribute('data-history-value')
    if (focusedValue !== 'unknown') await until(async () => await page.getByRole('tooltip').locator('[data-metric-value]').getAttribute('data-metric-value') === focusedValue, 'Keyboard detail did not match the focused sample')
    await page.keyboard.press('Escape')
    assert.deepEqual(fixture.failures, [])
    reports.push({ check: "status history", width, theme, aligned: true, unknownHatched: true, hoverAndPin: true })
    await context.close()
    console.log(`PASS ${theme} ${width}px distribution and status heatmaps`)
  }
  // A sparse provider response has real empty time, not another observation to snap to.
  const sparseContext = await browser.newContext({ viewport: { width: 1512, height: 1100 }, reducedMotion: "reduce" })
  const sparsePage = await sparseContext.newPage(), sparseFixture = await installRichChartFixtureAPI(sparsePage, base)
  sparsePage.on("pageerror", error => errors.push(error.message))
  sparsePage.on("request", request => { if (!request.url().startsWith(base) && !request.url().startsWith("data:")) external.push(request.url()) })
  await sparsePage.route('**/api/insights/query', async route => {
    const request = route.request().postDataJSON()
    if (!request.query.startsWith('paprika_example_ab_service_pulse_latency_buckets{')) return route.fallback()
    const times = [0, .05, .9, 1].map(fraction => (request.start + (request.end - request.start) * fraction) * 1000)
    const series = [10, 25, 50, 100, 250, 500, '+Inf'].map((le, index) => ({ name: `≤ ${le}`, labels: { le: String(le), service: 'uptime-api' }, points: times.map(timestamp => ({ timestamp, value: (index + 1) * 10 })) }))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ series }) })
  })
  await sparsePage.goto(`${base}/dashboard/insights/?dashboard=example-artboard-service-pulse`, { waitUntil: 'networkidle' })
  const sparse = sparsePage.locator('[data-widget-id="latency-distribution"]')
  await sparse.scrollIntoViewIfNeeded()
  await until(async () => await sparse.locator('[data-bucket-value]').count() === 28, 'Sparse heatmap did not render')
  const sparseCells = sparse.locator('[data-bucket-value]')
  await moveTo(sparsePage, sparseCells.nth(1))
  const sparseDetails = sparsePage.getByRole('region', { name: 'Observation details', exact: true })
  await sparseDetails.waitFor()
  const leftCell = await sparseCells.nth(1).boundingBox(), rightCell = await sparseCells.nth(2).boundingBox()
  assert.ok(rightCell.x - (leftCell.x + leftCell.width) > 20, 'Fixture needs a visible unobserved interval')
  await sparsePage.mouse.move((leftCell.x + leftCell.width + rightCell.x) / 2, leftCell.y + leftCell.height / 2)
  await sparseDetails.waitFor({ state: 'hidden' })
  assert.deepEqual(sparseFixture.failures, [])
  reports.push({ check: 'sparse gap hit testing', width: 1512, hoverDoesNotInventData: true })
  await sparseContext.close()
  console.log('PASS sparse unobserved interval does not select a nearby sample')
  assert.deepEqual(errors, []); assert.deepEqual(external, [])
} finally {
  await browser.close()
  await writeFile(join(output, "report.json"), JSON.stringify({ passed: reports.length === (distributionOnly ? 5 : 9) && !errors.length && !external.length, base, reports, errors, external }, null, 2))
}
