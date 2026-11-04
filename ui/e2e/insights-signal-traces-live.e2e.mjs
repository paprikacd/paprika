// Real local Tempo coverage of the saved query and shared dashboard filters.
// Synthetic trace status is verified from span details: Tempo search does not
// expose trace-wide status, so the search result must remain "unknown".
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated local gallery is permitted")
async function get(path, init) {
  const response = await fetch(new URL(path, origin), init)
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}: ${await response.text()}`)
  return response
}
const boardResponse = await get("/api/insights/dashboards/local-gallery-signal-kit")
const boardBefore = await boardResponse.text()
const boardETag = boardResponse.headers.get("x-paprika-document-etag") ?? boardResponse.headers.get("etag")
assert.ok(boardETag, "The dashboard must have a document revision")
const board = JSON.parse(boardBefore), tile = board.widgets.find(item => item.id === "cluster-traces")
assert.equal(tile.queryRef.id, "local-signal-cluster-traces")
assert.deepEqual(tile.queryRef.bindings.map(item => [item.parameter, item.variable]).sort(), [["cluster", "cluster"], ["service", "service"]])
const savedResponse = await get("/api/insights/saved-queries/local-signal-cluster-traces")
const savedBefore = await savedResponse.text(), saved = JSON.parse(savedBefore)
const savedETag = savedResponse.headers.get("x-paprika-document-etag") ?? savedResponse.headers.get("etag")
assert.ok(savedETag, "The saved query must have a document revision")
const queryFor = (service, cluster) => saved.query.replaceAll("{{service}}", JSON.stringify(service)).replaceAll("{{cluster}}", JSON.stringify(cluster))
const end = Math.floor(Date.now() / 1000), start = end - 180
async function query(query, traceId) {
  return (await get("/api/insights/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId: saved.providerId, kind: "traces", query, start, end, step: 1, ...(traceId ? { traceId } : {}) }) })).json()
}
const groups = new Map()
for (const service of ["checkout", "payments"]) for (const cluster of ["omega", "delta"]) {
  const scoped = queryFor(service, cluster), result = await query(scoped)
  assert.ok(result.traces?.length > 0, `${service}/${cluster} has recent traces`)
  assert.ok(result.traces.every(trace => trace.service === service && trace.status === "unknown"), "Search must preserve unknown trace-wide status")
  assert.ok(result.traces.every(trace => /^[a-f0-9]{32}$/.test(trace.traceId)), "Search IDs must be canonical so the waterfall can open")
  groups.set(`${service}/${cluster}`, new Set(result.traces.map(trace => trace.traceId)))
  const errors = await query(scoped.replace(/\s*}$/, " && status = error }"))
  assert.ok(errors.traces?.length > 0, `${service}/${cluster} contains a recorded failed root`)
  const failed = errors.traces[0]
  assert.ok(groups.get(`${service}/${cluster}`).has(failed.traceId), "The failed trace must belong to the same filtered result")
  assert.match(failed.traceId, /^[a-fA-F0-9]{32}$/, `Invalid trace ID for ${service}/${cluster}`)
  const detail = await query(scoped, failed.traceId)
  assert.equal(detail.spans?.length, 4)
  assert.equal(detail.spans.filter(span => span.parentSpanId).length, 3)
  const root = detail.spans.find(span => !span.parentSpanId)
  assert.equal(root.service, service)
  assert.equal(root.status, "error")
  assert.ok(detail.spans.some(span => span.parentSpanId && span.status === "error"), "Failed traces have an errored descendant")
}
for (const service of ["checkout", "payments"]) {
  const omega = groups.get(`${service}/omega`), delta = groups.get(`${service}/delta`)
  assert.ok([...omega].every(id => !delta.has(id)), "Clusters must not reuse trace identifiers")
}
const leadingZeroId = process.env.PAPRIKA_TRACE_LEADING_ZERO_ID
if (leadingZeroId) {
  assert.match(leadingZeroId, /^0[a-f0-9]{31}$/)
  const detail = await query(queryFor("payments", "delta"), leadingZeroId)
  assert.equal(detail.spans?.length, 4, "Canonicalized leading-zero trace ID opens its Tempo waterfall")
  assert.equal(detail.spans.find(span => !span.parentSpanId)?.service, "payments")
  console.log("PASS leading-zero Tempo trace resolves to its four recorded spans")
}
const output = resolve(fileURLToPath(new URL("../../artifacts/insights/signal-traces-live", import.meta.url)))
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(({ expected, theme }) => { if (location.origin === expected) localStorage.setItem("paprika-insights-theme", theme) }, { expected: origin.origin, theme })
    const page = await context.newPage(), errors = [], requests = []
    page.on("pageerror", error => errors.push(error.message))
    page.on("request", request => {
      if (new URL(request.url()).pathname !== "/api/insights/query" || request.method() !== "POST") return
      try { const body = request.postDataJSON(); if (body.kind === "traces") requests.push(body) } catch { /* Ignore unrelated requests. */ }
    })
    try {
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=local-gallery-signal-kit`, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="cluster-traces"]')
      const serviceSelect = page.getByRole("combobox", { name: "Service", exact: true })
      const clusterSelect = page.getByRole("combobox", { name: "Cluster", exact: true })
      for (const [service, cluster] of [["checkout", "omega"], ["payments", "delta"]]) {
        if (service !== "checkout") await selectGammaOption(page, serviceSelect, service)
        if (cluster !== "omega") await selectGammaOption(page, clusterSelect, cluster)
        await panel.scrollIntoViewIfNeeded()
        await panel.getByRole("row").filter({ hasText: service }).first().waitFor({ timeout: 30000 })
        const actualQuery = queryFor(service, cluster)
        assert.ok(requests.some(body => body.query === actualQuery && !body.traceId), `Rendered ${service}/${cluster} sends the bound saved query`)
        assert.equal(await panel.getByText("Query failed", { exact: true }).count(), 0)
        const list = panel.getByRole("region", { name: "Service traces · selected cluster traces", exact: true })
        const dimensions = await list.evaluate(node => ({ height: node.clientHeight, content: node.scrollHeight }))
        assert.ok(dimensions.content > dimensions.height + 32, "The fixture must exercise a vertically overflowing trace list")
        {
          const hint = panel.getByText(/Scroll to see all traces/)
          await hint.waitFor()
          assert.equal(await list.getAttribute("aria-describedby"), await hint.getAttribute("id"), "The scroll instruction must be associated with its region")
          await list.focus()
          await page.keyboard.press("End")
          await page.waitForFunction(node => node.scrollTop > 0, await list.elementHandle())
          await page.keyboard.press("Home")
        }
        const row = panel.getByRole("row").filter({ hasText: service }).first()
        const opener = row.getByRole("button", { name: "View waterfall" })
        await opener.click()
        const dialog = page.getByRole("dialog", { name: "Trace detail" })
        await dialog.waitFor()
        const waterfall = dialog.getByRole("region", { name: /^Trace .* waterfall$/ })
        await waterfall.waitFor()
        await waterfall.getByText("payment-service").waitFor()
        assert.equal(await waterfall.locator("[data-span-id]").count(), 4)
        assert.equal(await waterfall.locator("[data-parent-span-id]").count(), 3)
        if (service === "payments") {
          await waterfall.scrollIntoViewIfNeeded()
          await dialog.screenshot({ path: resolve(output, `${theme}-${width}.png`), animations: "disabled" })
        }
        await dialog.getByRole("button", { name: "Close trace detail" }).click()
        await dialog.waitFor({ state: "hidden" })
        assert.equal(await opener.evaluate(node => node === document.activeElement), true, "Closing the modal returns focus to its trigger")
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: real Tempo shared service/cluster query and waterfall`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
for (const [path, before, etag] of [["/api/insights/dashboards/local-gallery-signal-kit", boardBefore, boardETag], ["/api/insights/saved-queries/local-signal-cluster-traces", savedBefore, savedETag]]) {
  const after = await get(path)
  assert.equal(await after.text(), before)
  assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag)
}
console.log("PASS Tempo filter combinations, recorded error details, and unchanged dashboard/query revisions")
