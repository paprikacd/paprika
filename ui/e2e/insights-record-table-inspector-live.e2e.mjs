// Real PostgreSQL table cells: pointer-following and accessible exact details.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated local gallery is permitted")
const endpoint = new URL("/api/insights/dashboards/local-gallery-edge-watch", origin)
const before = await fetch(endpoint), document = await before.text()
const etag = before.headers.get("x-paprika-document-etag") ?? before.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) for (const touch of width === 390 ? [false, true] : [false]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme, reducedMotion: "reduce", hasTouch: touch, isMobile: touch })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-edge-watch", origin).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="risks"]'), row = panel.locator("tbody tr").first()
      await panel.scrollIntoViewIfNeeded(); await row.waitFor()
      const risk = row.locator('[data-record-cell-column="3"]'), history = row.locator('[data-record-cell-column="2"]')
      await risk.scrollIntoViewIfNeeded()
      const bar = risk.locator('[data-cell-display="bar-segments"]')
      const exact = await bar.getAttribute("aria-label")
      assert.ok(exact?.includes("risk"), `Expected a real numeric bar label: ${exact}`)
      assert.equal(await bar.getAttribute("title"), null, "Browser-native titles should not compete with the custom inspector")
      if (!touch) {
        const box = await risk.boundingBox()
        const first = { x: box.x + box.width * .30, y: box.y + box.height * .55 }
        await page.mouse.move(first.x, first.y)
        const tip = page.getByRole("tooltip").filter({ hasText: exact })
        await tip.waitFor()
        const placement = await tip.evaluate(element => { const b = element.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, panelWidth: b.width, pointer: getComputedStyle(element).pointerEvents, width: innerWidth, height: innerHeight } })
        assert.ok(placement.panelWidth <= 231, `Cell inspection should stay compact: ${placement.panelWidth}px`)
        assert.equal(placement.pointer, "none")
        assert.ok(placement.left >= 0 && placement.top >= 0 && placement.right <= placement.width + 1 && placement.bottom <= placement.height + 1)
        assert.ok(Math.min(Math.abs(placement.top - first.y - 16), Math.abs(placement.bottom - first.y + 16)) <= 2, "Hover is offset from the mouse")
        await risk.focus(); await risk.press("ArrowLeft")
        assert.equal(await history.evaluate(element => element === document.activeElement), true, "Keyboard moves to the actual previous cell")
        await history.press("Enter")
        const pinned = page.getByRole("region", { name: "Record cell details" })
        await pinned.waitFor()
        assert.match(await pinned.innerText(), /recorded samples/)
        assert.match(await pinned.innerText(), /Color by risk/)
        await history.press("Tab")
        await page.keyboard.press("Escape")
        await pinned.waitFor({ state: "hidden" })
        assert.equal(await history.evaluate(element => element === document.activeElement), true, "Dismissal restores cell focus")
      } else {
        const box = await risk.boundingBox()
        await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
        const pinned = page.getByRole("region", { name: "Record cell details" })
        await pinned.waitFor(); assert.match(await pinned.innerText(), /Recorded value:/)
        await pinned.getByRole("button", { name: "Close", exact: true }).click()
        await pinned.waitFor({ state: "hidden" })
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px ${touch ? "touch" : "pointer/keyboard"}: exact table inspection`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
const after = await fetch(endpoint)
assert.equal(await after.text(), document)
assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag)
