// A deliberate status-history cell activation connects its observed labels to
// the dashboard's node variable. Provider queries and persistence are real.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
const path = "/api/insights/dashboards/local-gallery-fleet-atlas"
const read = async () => {
  const response = await fetch(new URL(path, origin))
  assert.ok(response.ok)
  return { document: await response.text(), etag: response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag") }
}
const before = await read()
assert.ok(before.etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = [], requests = [], writes = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname
      if (pathname === "/api/insights/query" && request.method() === "POST") {
        try { requests.push(request.postDataJSON()) } catch { /* An unrelated request is not evidence. */ }
      }
      if (/^\/api\/insights\/(dashboards|saved-queries)\//.test(pathname) && ["PUT", "PATCH", "DELETE"].includes(request.method())) writes.push(pathname)
    })
    try {
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-fleet-atlas", origin).href, { waitUntil: "networkidle" })
      const detail = page.locator('[data-widget-id="selected-node-detail"]')
      await detail.scrollIntoViewIfNeeded()
      await detail.getByText("node-01", { exact: true }).waitFor({ timeout: 30000 })
      const source = page.locator('[data-widget-id="states"]')
      await source.scrollIntoViewIfNeeded()
      const lane = source.locator('[data-history-series="node-02"]')
      // The first mark is at the left time boundary; it must remain a real
      // pointer target rather than having its center clipped outside the lane.
      const cell = lane.locator('button[data-history-value]:not([data-history-value="unknown"])').first()
      await cell.waitFor({ timeout: 30000 })
      const last = lane.locator('button[data-history-edge="end"]').last()
      await last.waitFor({ timeout: 30000 })
      await last.hover()
      await cell.hover()
      await cell.focus()
      assert.equal(await detail.getByText("node-01", { exact: true }).count(), 1, "Hover and focus must not change the dashboard variable")
      await cell.press("Enter")
      await detail.scrollIntoViewIfNeeded()
      await detail.getByText("node-02", { exact: true }).waitFor({ timeout: 30000 })
      assert.equal(await detail.getByText("node-01", { exact: true }).count(), 0)
      assert.ok(new URL(page.url()).searchParams.get("vars")?.includes("node-02"), "Selection should be represented in the URL")
      assert.ok(requests.some(item => item.query?.includes('node="node-02"')), "The selected node must be queried against the real provider")
      assert.deepEqual(writes, [])
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: status activation updates selected node; hover and focus are inert`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
assert.deepEqual(await read(), before, "The saved dashboard and its ETag stay unchanged")
