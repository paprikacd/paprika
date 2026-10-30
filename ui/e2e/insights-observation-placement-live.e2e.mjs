// Shared cell/value/table placement against real local Prometheus observations.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}: ${await response.clone().text()}`)
  return response
}
const source = await (await api("/api/insights/saved-queries/local-ab-edge-watch-flow")).json()
const geo = await (await api("/api/insights/saved-queries/local-edge-geo-events")).json()
const query = source.query.replace("{{gateway}}", '"omega"'), id = `tooltip-position-${Date.now()}`
const path = `/api/insights/dashboards/${id}`
const widget = (type, y) => ({ id: type, title: `${type} placement`, type, providerId: source.providerId, query, unit: "Mb/s", layout: { x: 0, y, w: 12, h: 4 } })
const document = { schemaVersion: 1, id, title: "Tooltip positioning validation", timeRange: "30m", refreshInterval: 0, variables: [], widgets: [widget("stat", 0), widget("table", 4), widget("heatmap", 8), { id: "map", title: "Map placement", type: "plugin", pluginId: "connection-map", dataKind: "records", providerId: geo.providerId, query: geo.query.replace("{{gateway}}", '"omega"'), unit: "", config: { latitude: "latitude", longitude: "longitude", label: "label", value: "requests", display: "markers", showLocations: false, maxPoints: 1 }, layout: { x: 0, y: 12, w: 12, h: 4 } }] }
const created = await api(path, { method: "PUT", headers: { "content-type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(document) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => {
      if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme)
      document.addEventListener("pointermove", event => { window.__lastTestPointer = { x: event.clientX, y: event.clientY } }, true)
    }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.goto(new URL(`/dashboard/insights/?dashboard=${id}`, origin).href, { waitUntil: "networkidle" })
      for (const type of ["stat", "table", "heatmap", "map"]) {
        const tile = page.locator(`[data-widget-id="${type}"]`)
        await tile.scrollIntoViewIfNeeded()
        const trigger = type === "stat" ? tile.getByRole("button", { name: /Inspect value for/ }) : type === "table" ? tile.getByRole("button", { name: /Inspect series/ }).first() : type === "heatmap" ? tile.getByRole("group", { name: /heatmap/ }).getByRole("button").first() : tile.locator("[data-map-plane] button").first()
        await trigger.waitFor()
        await trigger.hover()
        const tooltip = page.getByRole("tooltip"); await tooltip.waitFor()
        await page.waitForFunction(element => element.dataset.tooltipPointer === "true", await tooltip.elementHandle())
        await page.waitForFunction(element => {
          const box = element.getBoundingClientRect(), pointer = window.__lastTestPointer
          return pointer && Math.min(Math.abs(box.top - pointer.y - 16), Math.abs(box.bottom - pointer.y + 16)) <= 2
        }, await tooltip.elementHandle())
        const hovered = await tooltip.boundingBox(), pointer = await page.evaluate(() => window.__lastTestPointer)
        assert.ok(hovered && pointer)
        const pointerY = pointer.y
        assert.ok(Math.min(Math.abs(hovered.y - pointerY - 16), Math.abs(hovered.y + hovered.height - pointerY + 16)) <= 2, `${type} preview should follow the mouse with a gap`)
        assert.equal(await tooltip.evaluate(node => getComputedStyle(node).pointerEvents), "none", `${type} preview cannot block pointer interaction`)
        if (type !== "map") {
          await trigger.focus(); await page.keyboard.press("Shift")
          await page.waitForFunction(element => element.dataset.tooltipPointer !== "true", await tooltip.elementHandle())
          await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
        }
        const geometry = await tooltip.evaluate((node, widgetId) => {
          const a = node.getBoundingClientRect(), b = document.querySelector(`[data-widget-id="${widgetId}"]`).getBoundingClientRect()
          return { left: a.left, top: a.top, right: a.right, bottom: a.bottom, width: innerWidth, height: innerHeight,
            overlapsOwner: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top,
            declaredOverlap: node.dataset.tooltipOverlap === "true", followsPointer: node.dataset.tooltipPointer === "true", pointer: getComputedStyle(node).pointerEvents }
        }, type)
        assert.ok(geometry.left >= -1 && geometry.top >= -1 && geometry.right <= geometry.width + 1 && geometry.bottom <= geometry.height + 1, `${type}: ${JSON.stringify(geometry)}`)
        if (type === "map") {
          assert.equal(geometry.followsPointer, true, "A hovered map marker follows the pointer")
          assert.equal(geometry.pointer, "none", "A hovered map marker cannot block the map")
          assert.ok(Math.min(Math.abs(geometry.top - pointerY - 16), Math.abs(geometry.bottom - pointerY + 16)) <= 2, "The map tooltip keeps a gap to the pointer")
        } else if (!geometry.declaredOverlap) assert.equal(geometry.overlapsOwner, false, `${type} should not cover its widget`)
        else assert.equal(geometry.pointer, "none", `${type} hover should not block interaction`)
        if (type === "map") await trigger.click(); else await trigger.press("Enter")
        assert.equal(await trigger.getAttribute("aria-pressed"), "true")
        assert.notEqual(await tooltip.evaluate(node => getComputedStyle(node).pointerEvents), "none")
        await page.keyboard.press("Escape"); await tooltip.waitFor({ state: "hidden" })
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: stat, table, built-in heatmap and map tooltip placement`)
    } finally { await context.close() }
  }
  const current = await api(path)
  assert.equal(current.headers.get("x-paprika-document-etag") ?? current.headers.get("etag"), etag)
} finally {
  await browser.close()
  await api(path, { method: "DELETE", headers: { "If-Match": etag } })
}
