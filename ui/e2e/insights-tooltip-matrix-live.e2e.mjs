// Exercise each shared custom-tooltip renderer against the isolated provider stack.
// Record table/list/matrix and the record treemap use native titles or no
// custom tooltip; they are intentionally not mistaken for ObservationTooltip.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  if (!response.ok) throw Error(`${path}: ${response.status}: ${await response.text()}`)
  return response
}
const fixtures = []
async function fixture(board, widget, type, pluginId) {
  const source = await (await api(`/api/insights/dashboards/local-gallery-${board}`)).json()
  const copy = structuredClone(source.widgets.find(item => item.id === widget))
  assert.ok(copy, `Missing source fixture ${board}/${widget}`)
  copy.id = "matrix-target"; copy.type = type; copy.layout = { x: 0, y: 0, w: 12, h: 5 }
  if (pluginId) copy.pluginId = pluginId
  else { delete copy.pluginId; delete copy.dataKind; delete copy.config; delete copy.annotationSource }
  const id = `tooltip-matrix-${type}-${pluginId ?? "builtin"}-${Date.now()}`
  const doc = { ...source, id, title: "Temporary tooltip matrix", widgets: [copy] }
  const response = await api(`/api/insights/dashboards/${id}`, { method: "PUT", headers: { "content-type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(doc) })
  const etag = response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
  assert.ok(etag); fixtures.push({ id, etag }); return id
}

let browser
try {
  const bar = await fixture("service-pulse", "request-history", "bar")
  const recordsBar = await fixture("market-lens", "history", "plugin", "records-bar")
  const cases = [
    { kind: "builtin bar", board: bar, widget: "matrix-target", selector: 'svg[role="img"]', svg: true },
    { kind: "stacked metric plot", board: "local-gallery-edge-watch", widget: "outcomes", selector: 'svg[role="group"]', svg: true },
    { kind: "small multiples", board: "local-gallery-fleet-atlas", widget: "cpu-meter", selector: 'svg[role="group"]', svg: true },
    { kind: "radial threshold gauge", board: "local-gallery-fleet-atlas", widget: "disk-meter", selector: 'button[aria-label^="Inspect value"]' },
    { kind: "gauge bank", board: "local-gallery-collection-control", widget: "source-freshness", selector: 'button[aria-label^="Inspect value"]' },
    { kind: "metric pie", board: "local-gallery-signal-kit", widget: "node-ratio-shares", selector: 'g[data-pie-index="0"]', pie: true },
    { kind: "status history", board: "local-gallery-service-pulse", widget: "states", selector: 'button[data-history-key]' },
    { kind: "status grid", board: "local-gallery-availability-lab", widget: "monitor-grid", selector: 'button[data-status-index]' },
    { kind: "uptime calendar", board: "local-gallery-availability-lab", widget: "uptime-calendar", selector: 'button[data-uptime-key]' },
    { kind: "uptime timeline", board: "local-gallery-availability-lab", widget: "uptime-timeline", selector: 'button[data-uptime-key]' },
    { kind: "incident calendar", board: "local-gallery-reliability-room", widget: "calendar", selector: '[data-operational-chart="incident-calendar"] button' },
    { kind: "pipeline stage", board: "local-gallery-collection-control", widget: "topology", selector: 'button[aria-label^="Inspect stage"]' },
    { kind: "trace row", board: "local-gallery-service-pulse", widget: "traces", selector: 'button[aria-label^="Inspect trace"]' },
    { kind: "record line", board: "local-gallery-market-lens", widget: "history", selector: '[data-record-mark]', focus: 'svg[role="group"]', mark: true },
    { kind: "record bar", board: recordsBar, widget: "matrix-target", selector: '[data-record-mark]', focus: 'svg[role="group"]', mark: true },
  ]
  browser = await chromium.launch({ headless: true })
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => {
      if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme)
      document.addEventListener("pointermove", event => { window.__tooltipMatrixPointer = { x: event.clientX, y: event.clientY } }, true)
    }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      let currentBoard = ""
      for (const item of cases) {
        if (currentBoard !== item.board) {
          await page.goto(new URL(`/dashboard/insights/?dashboard=${item.board}`, origin).href, { waitUntil: "networkidle" })
          currentBoard = item.board
        }
        const panel = page.locator(`[data-widget-id="${item.widget}"]`)
        await panel.scrollIntoViewIfNeeded()
        const target = panel.locator(item.selector).first()
        await target.waitFor({ state: "visible", timeout: 30000 })
        await target.scrollIntoViewIfNeeded()
        if (item.pie) {
          const point = await target.locator("path").evaluate(path => {
            const bounds = path.getBBox(), matrix = path.getScreenCTM()
            for (let row = 1; row < 10; row++) for (let col = 1; col < 10; col++) {
              const candidate = new DOMPoint(bounds.x + bounds.width * col / 10, bounds.y + bounds.height * row / 10)
              if (path.isPointInFill(candidate)) { const screen = candidate.matrixTransform(matrix); return { x: screen.x, y: screen.y } }
            }
            return null
          })
          assert.ok(point, "A visible pie slice must have a hit point")
          await page.mouse.move(point.x, point.y)
        } else await target.hover({ force: !!item.mark })
        const tip = page.locator('[data-tooltip-pointer="true"]')
        await tip.waitFor({ state: "visible", timeout: 10000 })
        await page.waitForFunction(element => {
          const box = element.getBoundingClientRect(), pointer = window.__tooltipMatrixPointer
          return pointer && Math.min(Math.abs(box.top - pointer.y - 16), Math.abs(box.bottom - pointer.y + 16)) <= 2
        }, await tip.elementHandle())
        const placement = await tip.evaluate(element => {
          const box = element.getBoundingClientRect(), pointer = window.__tooltipMatrixPointer
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, pointer, pointerEvents: getComputedStyle(element).pointerEvents, width: innerWidth, height: innerHeight }
        })
        assert.equal(placement.pointerEvents, "none", `${item.kind}: transient tooltip blocks pointer`)
        assert.ok(placement.left >= -1 && placement.top >= -1 && placement.right <= width + 1 && placement.bottom <= placement.height + 1, `${item.kind}: tooltip leaves viewport`)
        // Move inside the same mark when possible: previews must follow even
        // when the selected observation itself does not change.
        const point = placement.pointer
        const within = await target.evaluate((element, point) => { const next = document.elementFromPoint(point.x + 1, point.y + 1); return !!next && element.contains(next) }, point)
        if (within) {
          await page.mouse.move(point.x + 1, point.y + 1)
          await page.waitForFunction(element => {
            const box = element.getBoundingClientRect(), pointer = window.__tooltipMatrixPointer
            return pointer && Math.min(Math.abs(box.top - pointer.y - 16), Math.abs(box.bottom - pointer.y + 16)) <= 2
          }, await tip.elementHandle())
        }
        const keyboard = item.focus ? panel.locator(item.focus).first() : target
        await keyboard.focus(); await page.keyboard.press("Shift")
        await page.waitForFunction(element => element.dataset.tooltipPointer !== "true", await tip.elementHandle())
        await keyboard.press("Enter")
        const pinned = page.locator('[role="tooltip"], [role="region"][aria-label="Observation details"]').filter({ visible: true }).last()
        await pinned.waitFor({ state: "visible" })
        assert.notEqual(await pinned.evaluate(element => getComputedStyle(element).pointerEvents), "none", `${item.kind}: pinned tooltip should remain interactive`)
        await page.keyboard.press("Escape"); await pinned.waitFor({ state: "hidden" })
        console.log(`PASS ${theme} ${width}px ${item.kind}: pointer, keyboard, pin and dismiss`)
      }
      assert.deepEqual(errors, [])
    } finally { await context.close() }
  }
} finally {
  await browser?.close()
  for (const { id, etag } of fixtures) await api(`/api/insights/dashboards/${id}`, { method: "DELETE", headers: { "If-Match": etag } })
}
