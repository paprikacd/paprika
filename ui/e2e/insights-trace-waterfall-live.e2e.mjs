// Optional isolated real-provider flow: the harness token remains local and is
// never printed. Set PAPRIKA_TRACE_CONNECTION to its private ready file.
import assert from "node:assert/strict"
import { readFile, mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"

const ready = process.env.PAPRIKA_TRACE_CONNECTION
if (!ready) throw Error("Set PAPRIKA_TRACE_CONNECTION to the local harness ready file")
const fixture = JSON.parse(await readFile(ready, "utf8")), base = new URL(fixture.baseURL)
assert.equal(base.hostname, "127.0.0.1")
const headers = { Authorization: `Bearer ${fixture.token}`, "Content-Type": "application/json" }
const providerResponse = await fetch(new URL("/api/insights/providers", base), { headers })
assert.equal(providerResponse.status, 200)
const provider = (await providerResponse.json()).providers.find(item => item.providerRef === "observability/gallery-tempo")
assert.ok(provider)
const id = `trace-waterfall-e2e-${Date.now()}`
const query = '{ resource.service.name = {{service}} }'
const savedQuery = { schemaVersion: 1, id, name: "Checkout traces", providerId: provider.id, kind: "traces", query, parameters: [{ name: "service", type: "string", defaultValue: "checkout" }] }
const querySaved = await fetch(new URL(`/api/insights/saved-queries/${id}`, base), { method: "PUT", headers: { ...headers, "If-None-Match": "*" }, body: JSON.stringify(savedQuery) })
assert.equal(querySaved.status, 200)
const queryETag = querySaved.headers.get("x-paprika-document-etag") ?? querySaved.headers.get("etag")
assert.ok(queryETag, "Created saved query must have a revision for safe cleanup")
const document = { schemaVersion: 1, id, title: "Trace waterfall validation", timeRange: "1h", refreshInterval: 0, variables: [{ name: "service", label: "Service", defaultValue: "checkout", options: ["checkout", "payments"] }], widgets: [{ id: "traces", title: "Checkout traces", type: "traces", providerId: provider.id, query, queryRef: { id, bindings: [{ parameter: "service", source: "variable", variable: "service" }] }, unit: "", layout: { x: 0, y: 0, w: 4, h: 9 }, options: { showTooltip: true, decimals: 2 } }] }
const saved = await fetch(new URL(`/api/insights/dashboards/${id}`, base), { method: "PUT", headers: { ...headers, "If-None-Match": "*" }, body: JSON.stringify(document) })
assert.equal(saved.status, 200)
const dashboardETag = saved.headers.get("x-paprika-document-etag") ?? saved.headers.get("etag")
assert.ok(dashboardETag, "Created dashboard must have a revision for safe cleanup")
const output = resolve(fileURLToPath(new URL("../../artifacts/insights/trace-waterfall-axis-live", import.meta.url)))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, reducedMotion: "reduce" })
    await context.addInitScript(({ origin, token, theme }) => { if (location.origin === origin) { localStorage.setItem("paprika_id_token", token); localStorage.setItem("paprika-insights-theme", theme) } }, { origin: base.origin, token: fixture.token, theme })
    const page = await context.newPage(), errors = [], detailRequests = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("request", request => {
      if (new URL(request.url()).pathname !== "/api/insights/query" || request.method() !== "POST") return
      try { if (request.postDataJSON()?.traceId) detailRequests.push(request) } catch { /* Ignore unrelated non-JSON requests. */ }
    })
    try {
      await page.goto(`${base.origin}/dashboard/insights/?dashboard=${id}`, { waitUntil: "networkidle" })
      const widget = page.locator('[data-widget-id="traces"]')
      const row = widget.getByRole("row").filter({ hasText: "checkout" }).first()
      const opener = row.getByRole("button", { name: "View waterfall" })
      await opener.click({ timeout: 30000 })
      const dialog = page.getByRole("dialog", { name: "Trace detail" })
      await dialog.waitFor()
      const waterfall = dialog.getByRole("region", { name: /^Trace .* waterfall$/ })
      await waterfall.waitFor({ timeout: 30000 })
      await waterfall.getByText("catalog-service").waitFor()
      await waterfall.getByText("payment-service").waitFor()
      await waterfall.getByText("order-store").waitFor()
      assert.equal(await waterfall.locator("[data-span-id]").count(), 4)
      assert.equal(await waterfall.locator("[data-parent-span-id]").count(), 3)
      const initialDetailRequests = detailRequests.length
      assert.equal(initialDetailRequests, 1, "Opening the waterfall must fetch one real trace")
      const response = await detailRequests[0].response()
      assert.ok(response?.ok(), "The trace detail request must succeed")
      const detail = await response.json()
      const from = Math.min(...detail.spans.map(span => span.startTime))
      const extent = Math.max(...detail.spans.map(span => span.startTime + span.durationMs)) - from
      for (const span of detail.spans) {
        const row = waterfall.locator(`[data-span-id="${span.spanId}"]`)
        const bar = row.locator("[data-span-status]")
        const geometry = await bar.evaluate(node => ({ left: parseFloat(node.style.left), width: parseFloat(node.style.width) }))
        assert.ok(Math.abs(geometry.left - (span.startTime - from) / extent * 100) < 0.0001, `Span ${span.spanId} must start at its recorded time`)
        assert.ok(Math.abs(geometry.width - span.durationMs / extent * 100) < 0.0001, `Span ${span.spanId} must show its recorded duration`)
        if (span.parentSpanId) {
          const branch = row.locator("[data-trace-branch]")
          const stem = waterfall.locator(`[data-span-id="${span.parentSpanId}"] [data-trace-stem]`)
          assert.equal(await branch.count(), 1, "A recorded child has a parent branch")
          const [branchBox, stemBox] = await Promise.all([branch.boundingBox(), stem.boundingBox()])
          assert.ok(branchBox && stemBox && Math.abs(branchBox.x - stemBox.x) < 1, "Parent stem and child branch must share an aligned connector")
        }
      }
      const root = detail.spans.find(span => !span.parentSpanId)
      const child = detail.spans.find(span => span.parentSpanId === root.spanId && detail.spans.some(descendant => descendant.parentSpanId === span.spanId))
      const grandchild = detail.spans.find(span => span.parentSpanId === child?.spanId)
      assert.ok(root && child && grandchild && detail.spans.some(span => span.parentSpanId === root.spanId && span.spanId !== child.spanId), "Fixture must include a grandchild followed by a sibling")
      const guide = waterfall.locator(`[data-span-id="${grandchild.spanId}"] [data-trace-guide]`)
      const branch = waterfall.locator(`[data-span-id="${child.spanId}"] [data-trace-branch]`)
      assert.equal(await guide.count(), 1, "The ancestor guide continues through the grandchild row")
      const [guideBox, branchBox] = await Promise.all([guide.boundingBox(), branch.boundingBox()])
      const [guideColor, branchColor] = await Promise.all([guide.evaluate(node => getComputedStyle(node).backgroundColor), branch.evaluate(node => getComputedStyle(node).borderLeftColor)])
      assert.ok(guideBox && branchBox && Math.abs(guideBox.x - branchBox.x) < 1 && Math.abs(guideBox.y - (branchBox.y + branchBox.height)) < 2, "The ancestor guide must align and connect to the preceding branch")
      assert.equal(guideColor, branchColor, "Ancestor guides must remain as visible as parent branches")
      const filter = waterfall.getByRole("searchbox", { name: "Filter trace spans" })
      await filter.fill("postgresql")
      assert.equal(await waterfall.locator("[data-span-id]").count(), 3, "A match retains its two recorded ancestors")
      assert.equal(await waterfall.locator("[data-parent-context]").count(), 2)
      await waterfall.getByText(/1 matching span of 4 returned/).waitFor()
      await filter.fill("")
      assert.equal(await waterfall.locator("[data-span-id]").count(), 4)
      await waterfall.getByRole("button", { name: "Errors only" }).click()
      const errorCount = detail.spans.filter(span => span.status === "error").length
      if (errorCount === 0) await waterfall.getByText("No matching spans. Clear the filter to see the trace.").waitFor()
      else await waterfall.getByText(new RegExp(`${errorCount} matching ${errorCount === 1 ? "span" : "spans"} of 4 returned`)).waitFor()
      await waterfall.getByRole("button", { name: "Errors only" }).click()
      assert.equal(await waterfall.locator("[data-span-id]").count(), 4)
      assert.equal(detailRequests.length, initialDetailRequests, "Local filtering must not query Tempo again")
      const axis = waterfall.getByRole("img", { name: `Trace duration axis from 0 milliseconds to ${extent} milliseconds` })
      await axis.waitFor()
      await waterfall.getByText("Time from first recorded span").waitFor()
      assert.equal(await axis.locator("span").count(), 5, "The shared axis has five aligned time ticks")
      const bounds = await axis.evaluate(node => {
        const labels = [...node.querySelectorAll("span")].filter(item => getComputedStyle(item).display !== "none")
        const rects = labels.map(item => item.getBoundingClientRect())
        const track = node.querySelector("div").getBoundingClientRect()
        return { labels: rects.length, contained: rects.every(rect => rect.left >= track.left - 1 && rect.right <= track.right + 1), separated: rects.every((rect, index) => index === 0 || rects[index - 1].right + 2 <= rect.left) }
      })
      assert.ok(bounds.labels > 0 && bounds.contained && bounds.separated, "Axis bounds must not overlap or escape the narrow card")
      const timeline = waterfall.getByRole("region", { name: "Trace timeline" })
      if (width === 390) {
        const overflow = await timeline.evaluate(node => node.scrollWidth > node.clientWidth)
        assert.equal(overflow, true, "A narrow viewport keeps the full shared time axis scrollable")
        await timeline.focus(); for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight")
        await page.waitForFunction(node => node.scrollLeft > 0, await timeline.elementHandle())
        for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowLeft")
      }
      const spanDetail = waterfall.getByRole("img", { name: /catalog-service Lookup products/ })
      await spanDetail.focus()
      const catalog = detail.spans.find(span => span.service === "catalog-service")
      assert.ok((await spanDetail.getAttribute("title")).includes(`Duration ${catalog.durationMs.toFixed(2)} ms`), "Tooltip reports the actual recorded duration")
      const details = waterfall.getByRole("button", { name: /^Span details for order-store SELECT orders \(/ })
      await details.click()
      const info = waterfall.getByRole("region", { name: "Details for order-store SELECT orders" })
      await info.getByText("postgresql", { exact: true }).waitFor()
      assert.ok(await info.getByText("db.system.name", { exact: true }).count())
      assert.ok(await info.getByText("SELECT", { exact: true }).count())
      await waterfall.getByRole("button", { name: /^Span details for catalog-service Lookup products \(/ }).click()
      const rpcInfo = waterfall.getByRole("region", { name: "Details for catalog-service Lookup products" })
      await rpcInfo.getByText("rpc.grpc.status_code", { exact: true }).waitFor()
      assert.equal(await rpcInfo.getByText("0", { exact: true }).count(), 1)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      assert.deepEqual(errors, [])
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`), animations: "disabled" })
      await dialog.getByRole("button", { name: "Close trace detail" }).click()
      assert.equal(await waterfall.count(), 0)
      assert.equal(await opener.evaluate(node => node === document.activeElement), true, "Closing restores focus to the trace")
      console.log(`PASS ${theme} ${width}px: real Tempo parent/child waterfall opens and closes`)
    } finally { await context.close() }
  }
} finally {
  await browser.close()
  // Clean up only these test-created documents, and only if untouched since
  // creation. A concurrent edit prevents deletion instead of losing work.
  for (const [kind, etag] of [["dashboards", dashboardETag], ["saved-queries", queryETag]]) {
    const response = await fetch(new URL(`/api/insights/${kind}/${id}`, base), { method: "DELETE", headers: { ...headers, "If-Match": etag } })
    if (!response.ok) console.error(`Cleanup of ${kind}/${id} was skipped (HTTP ${response.status})`)
  }
}
