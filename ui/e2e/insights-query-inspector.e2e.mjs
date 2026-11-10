// Deterministic API fixtures exercise the real client, scheduler and inspector.
// Service measurements are synthetic; browser timings are actually measured.
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright"
import { routeAnonymousAuthConfiguration } from "./anonymous-auth-fixture.mjs"

const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = process.env.INSIGHTS_QUERY_INSPECTOR_OUTPUT || join(tmpdir(), "paprika-query-inspector")
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, args: ["--disable-features=OverlayScrollbar"], ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) })
const errors = []
let activePage
const providers = [{ id: "checkout-metrics", name: "Checkout fixture", type: "prometheus", capabilities: ["metrics"], managed: false }]
const dashboard = {
  schemaVersion: 1, id: "query-inspector-fixture", title: "Checkout diagnostics · synthetic fixture", timeRange: "1h", refreshInterval: 0,
  // Keep an uncached failure beside the first query, including on narrow views.
  widgets: [1, 8, 2, 3, 4, 5, 6, 7, 1].map((query, index) => ({
    id: `widget-${index}`, title: `Checkout query ${query}${index === 8 ? " shared" : ""}`, type: "stat",
    providerId: "checkout-metrics", query: `fixture_metric_${query}{customer="private-customer-value"}`, unit: "",
    layout: { x: index % 4 * 3, y: Math.floor(index / 4) * 2, w: 3, h: 2 },
  })),
}

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function afterEffects(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  // IntersectionObserver and the React effect it schedules must both settle.
  await page.waitForTimeout(250)
}

async function settleQueries(page, pending, except) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if ([...pending].every(request => request === except)) {
      await afterEffects(page)
      if ([...pending].every(request => request === except)) return
    }
    await page.waitForTimeout(50)
  }
  assert.fail("Fixture queries did not settle before the passivity baseline")
}

async function canvasGeometry(page) {
  return page.getByTestId("dashboard-canvas").evaluate(canvas => {
    const measure = element => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    }
    return { mode: canvas.dataset.layoutMode, canvas: measure(canvas), tiles: [...canvas.querySelectorAll("[data-widget-id]")].map(tile => ({ id: tile.getAttribute("data-widget-id"), ...measure(tile) })) }
  })
}

function assertCanvasUnchanged(before, after) {
  assert.equal(after.mode, before.mode, "Opening an inspector must not change the responsive canvas mode")
  assert.deepEqual(after.tiles.map(tile => tile.id), before.tiles.map(tile => tile.id))
  for (const [original, current] of [[before.canvas, after.canvas], ...before.tiles.map((tile, index) => [tile, after.tiles[index]])]) {
    for (const key of ["x", "y", "width", "height"]) assert.ok(Math.abs(original[key] - current[key]) < 1, `${original.id || "canvas"} ${key} changed: ${original[key]} -> ${current[key]}`)
  }
}

async function assertNativeModal(page, inspector) {
  assert.equal(await inspector.evaluate(element => element.tagName === "DIALOG" && element.open && element.matches(":modal")), true, "Inspector must use the native modal top layer")
  const close = inspector.getByRole("button", { name: "Close query inspector" })
  assert.equal(await close.evaluate(element => element === document.activeElement), true, "Opening focuses the close action")
  await page.keyboard.press("Shift+Tab")
  assert.equal(await inspector.evaluate(element => element.contains(document.activeElement)), true, "Reverse Tab must stay inside the modal")
  await page.keyboard.press("Tab")
  assert.equal(await inspector.evaluate(element => element.contains(document.activeElement)), true, "Tab must stay inside the modal")
}

function receipt(request, query) {
  const duration = query === 7 ? 900 : 160
  const failed = query === 8
  return {
    version: 1, executionId: `synthetic-execution-${query}`, outcome: failed ? "timeout" : query === 6 ? "partial" : "success",
    source: { providerId: request.providerId, providerType: "prometheus", transport: "direct" },
    requested: { start: request.start, end: request.end, step: request.step },
    effective: { dispatched: true, rangeApplied: true, scope: "provider", start: request.start, end: request.end, step: request.step },
    phases: [
      { name: "admission", owner: "insights", clock: "server-monotonic", durationMs: 5, relationship: "exclusive" },
      { name: "upstream", owner: "insights", clock: "server-monotonic", durationMs: duration - 45, relationship: "exclusive" },
      { name: "normalization", owner: "insights", clock: "server-monotonic", durationMs: 40, relationship: "exclusive" },
      { name: "provider", owner: "provider", clock: "unavailable", durationMs: null, relationship: "nested", parent: "upstream" },
    ],
    totalMs: duration, ...(failed ? {} : { counts: { series: 1, points: 2, traces: 0, spans: 0, rows: 0 } }), truncated: query === 6,
  }
}

try {
  for (const width of [1512, 390]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 1050 }, reducedMotion: "reduce", timezoneId: "UTC" })
    const page = await context.newPage()
    activePage = page
    page.setDefaultTimeout(20_000)
    page.on("pageerror", error => errors.push(error.message))
    const consoleErrors = []
    page.on("console", message => {
      // One explicit query timeout is expected; JS/framework errors are not.
      if (message.type() === "error" && !message.text().includes("Failed to load resource")) consoleErrors.push(message.text())
    })
    await page.addInitScript(value => localStorage.setItem("paprika-insights-theme", value), theme)
    await routeAnonymousAuthConfiguration(page)
    const requests = []
    const failedRequests = []
    const pending = new Set()
    let heldQuery
    page.on("requestfailed", request => {
      if (new URL(request.url()).pathname === "/api/insights/query") failedRequests.push(request)
    })
    await page.route("**/api/insights/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname
      let body, status = 200
      if (path === "/api/insights/providers") body = { providers }
      else if (path === "/api/insights/dashboards") body = { dashboards: [dashboard] }
      else if (path === `/api/insights/dashboards/${dashboard.id}`) body = dashboard
      else if (path === "/api/insights/saved-queries") body = { queries: [] }
      else if (path === "/api/insights/observe-connection") body = { configured: false, connected: false, transport: "mcp", tools: [], providerCount: 0 }
      else if (path === "/api/insights/query") {
        const queryRequest = request.postDataJSON()
        const query = Number(/fixture_metric_(\d+)/.exec(queryRequest.query)?.[1])
        requests.push(query)
        pending.add(request)
        if (query === 1 && heldQuery && !heldQuery.request) {
          heldQuery.request = request
          heldQuery.started.resolve()
          await heldQuery.release.promise
        } else await new Promise(resolve => setTimeout(resolve, query === 7 ? 900 : 180))
        const diagnostics = receipt(queryRequest, query)
        if (query === 8) {
          status = 504
          body = { error: "private upstream https://credentials.example/secret", code: "timeout", diagnostics }
        } else body = { series: [{ name: `Checkout ${query}`, labels: { service: "checkout" }, points: [{ timestamp: queryRequest.start * 1000, value: query }, { timestamp: queryRequest.end * 1000, value: query + 1 }] }], truncated: query === 6, diagnostics }
      } else body = { values: [] }
      try {
        await route.fulfill({ status, contentType: "application/json", headers: { ETag: '"query-inspector-fixture"' }, body: JSON.stringify(body) })
      } catch (error) {
        // A cancelled request is asserted below. Avoid masking that assertion
        // with a second route-fulfillment error when its response is released.
        if (!failedRequests.includes(request) && !page.isClosed()) throw error
      } finally { pending.delete(request) }
    })
    await page.goto(`${baseURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" })
    await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor()
    assert.match(page.url(), /dashboard\/insights/)
    assert.ok((await page.title()).length > 0)
    // Narrow canvases intentionally mount offscreen widgets lazily.
    for (const widget of dashboard.widgets) {
      const tile = page.locator(`[data-widget-id="${widget.id}"]`)
      await tile.scrollIntoViewIfNeeded()
      if (widget.query.includes("fixture_metric_8")) await tile.getByText(/query timed out/i).waitFor()
      else await tile.locator("[data-metric-value]").first().waitFor()
    }
    const trigger = page.getByRole("button", { name: "Query inspector", exact: true })
    await trigger.scrollIntoViewIfNeeded()
    await settleQueries(page, pending)
    // A warm 5-second cache can conceal a canvas remount/requery regression.
    await page.waitForTimeout(5_200)
    await settleQueries(page, pending)
    const beforeInspection = [...requests]
    const failuresBeforeInspection = failedRequests.length
    const timeoutsBeforeInspection = requests.filter(query => query === 8).length
    const beforeGeometry = await canvasGeometry(page)
    await trigger.focus()
    await page.keyboard.press("Enter")
    const inspector = page.getByRole("dialog", { name: "Query inspector", exact: true })
    await inspector.getByRole("heading", { name: "Scheduler timeline" }).waitFor()
    await assertNativeModal(page, inspector)
    await afterEffects(page)
    assertCanvasUnchanged(beforeGeometry, await canvasGeometry(page))
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="query-inspector"]')
      return element && ![...element.querySelectorAll('ol button')].some(button => /in progress/.test(button.getAttribute("aria-label") || ""))
    })
    assert.equal(new Set(requests).size, 8, "All eight distinct queries must be represented")
    await inspector.getByRole("button", { name: /Inspect.*Timed out/ }).first().click()
    const detail = inspector.getByRole("complementary", { name: "Selected query receipt" })
    assert.match(await detail.textContent(), /exceeded its execution deadline/)
    assert.match(await detail.textContent(), /No completed result counts/)
    assert.doesNotMatch(await inspector.textContent(), /private-customer-value|credentials\.example|private upstream/)
    await inspector.getByRole("button", { name: /Inspect.*Partial/ }).first().click()
    assert.match(await detail.textContent(), /partial or truncated/)
    assert.match(await detail.textContent(), /Provider execution/)
    assert.match(await detail.textContent(), /Unknown/)
    await detail.getByText("Requested and effective bounds", { exact: true }).click()
    assert.match(await detail.textContent(), /Dispatch attempted/)
    await inspector.getByRole("button", { name: /Inspect/ }).first().focus()
    await page.keyboard.press("Enter")
    await inspector.getByRole("button", { name: /Inspect/ }).first().hover()
    await afterEffects(page)
    assert.deepEqual(requests, beforeInspection, "Inspection, selection and hover must not execute queries after the cache expires")
    assert.equal(failedRequests.length, failuresBeforeInspection, "Opening and inspecting must not cancel transport")
    assert.equal(await inspector.getByRole("button", { name: /Inspect/ }).first().getAttribute("aria-pressed"), "true")
    const overflow = await inspector.evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, document: document.documentElement.scrollWidth, viewport: window.innerWidth }))
    assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow))
    assert.ok(overflow.document <= overflow.viewport + 1, JSON.stringify(overflow))
    await inspector.scrollIntoViewIfNeeded()
    await inspector.screenshot({ path: join(output, `query-inspector-${theme}-${width}.png`), animations: "disabled" })
    await page.keyboard.press("Escape")
    await inspector.waitFor({ state: "hidden" })
    await settleQueries(page, pending)
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true, "Escape restores the opener")
    assertCanvasUnchanged(beforeGeometry, await canvasGeometry(page))
    assert.deepEqual(requests, beforeInspection, "Escape must not replay completed or failed requests")
    assert.equal(requests.filter(query => query === 8).length, timeoutsBeforeInspection, "The uncached timeout must not retry when inspection closes")
    assert.equal(failedRequests.length, failuresBeforeInspection)

    await trigger.press("Enter")
    await inspector.waitFor()
    await assertNativeModal(page, inspector)
    await inspector.getByRole("button", { name: "Close query inspector" }).click()
    await inspector.waitFor({ state: "hidden" })
    await settleQueries(page, pending)
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true)
    assertCanvasUnchanged(beforeGeometry, await canvasGeometry(page))
    assert.deepEqual(requests, beforeInspection, "The close action must not execute queries after effect frames settle")

    // An explicit refresh is authorized here; inspection must neither cancel
    // nor replace its still-running first query, which cannot hit result cache.
    heldQuery = { started: deferred(), release: deferred(), request: undefined }
    await page.getByRole("button", { name: "Refresh data", exact: true }).click()
    await Promise.race([heldQuery.started.promise, page.waitForTimeout(20_000).then(() => assert.fail("The explicit refresh did not start the held query"))])
    await settleQueries(page, pending, heldQuery.request)
    const beforeHeldInspection = [...requests]
    const failuresBeforeHeldInspection = failedRequests.length
    const heldGeometry = await canvasGeometry(page)
    await trigger.click()
    await inspector.waitFor()
    await afterEffects(page)
    const running = inspector.getByRole("button", { name: /Inspect.*Running/ })
    assert.equal(await running.count(), 1, "Exactly the held original request remains in flight")
    const runningLabel = await running.getAttribute("aria-label")
    await running.click()
    assert.match(await detail.textContent(), /fixture_metric_1/)
    assert.doesNotMatch(await inspector.textContent(), /private-customer-value|credentials\.example|private upstream/)
    await page.keyboard.press("Escape")
    await inspector.waitFor({ state: "hidden" })
    await afterEffects(page)
    assertCanvasUnchanged(heldGeometry, await canvasGeometry(page))
    assert.deepEqual(requests, beforeHeldInspection, "Closing must preserve the original in-flight request")
    assert.equal(failedRequests.length, failuresBeforeHeldInspection, "Closing must not abort an in-flight request")
    await trigger.press("Enter")
    await inspector.waitFor()
    await afterEffects(page)
    assert.equal(await inspector.getByRole("button", { name: runningLabel, exact: true }).count(), 1, "The same execution stays Running when reopened")
    assert.equal(await inspector.getByRole("button", { name: /Inspect.*Cancelled/ }).count(), 0)
    heldQuery.release.resolve()
    await settleQueries(page, pending)
    await inspector.getByRole("button", { name: new RegExp(`^${runningLabel.split(", Running,")[0]}, Complete,`) }).waitFor()
    assert.deepEqual(requests, beforeHeldInspection, "The original held response completes without a replacement request")
    assert.equal(failedRequests.length, failuresBeforeHeldInspection)
    await inspector.getByRole("button", { name: "Close query inspector" }).click()
    await inspector.waitFor({ state: "hidden" })
    await afterEffects(page)
    assert.deepEqual(requests, beforeHeldInspection)

    if (width === 1512 && theme === "light") {
      // Exercise the 840px stat-grid boundary with a measured classic gutter.
      // Chromium may still use overlay scrollbars on some hosts; name that gap.
      await page.addStyleTag({ content: "html::-webkit-scrollbar { width: 16px !important; }" })
      await page.setViewportSize({ width: 1100, height: 720 })
      for (let attempt = 0; attempt < 6; attempt++) {
        await afterEffects(page)
        const actual = await page.getByTestId("dashboard-canvas").evaluate(element => element.getBoundingClientRect().width)
        if (Math.abs(actual - 839) < 0.5) break
        await page.setViewportSize({ width: Math.max(390, Math.round(page.viewportSize().width + 839 - actual)), height: 720 })
      }
      await trigger.scrollIntoViewIfNeeded()
      await settleQueries(page, pending)
      const gutter = await page.evaluate(() => window.innerWidth - document.documentElement.clientWidth)
      if (gutter > 0) {
        const thresholdGeometry = await canvasGeometry(page)
        assert.ok(thresholdGeometry.canvas.width < 840 && thresholdGeometry.canvas.width + gutter >= 840, "The measured gutter must straddle the 840px canvas boundary")
        await page.waitForTimeout(5_200)
        await settleQueries(page, pending)
        const thresholdRequests = [...requests], thresholdFailures = failedRequests.length
        await trigger.click()
        await inspector.waitFor()
        await afterEffects(page)
        assertCanvasUnchanged(thresholdGeometry, await canvasGeometry(page))
        await page.keyboard.press("Escape")
        await inspector.waitFor({ state: "hidden" })
        await settleQueries(page, pending)
        assertCanvasUnchanged(thresholdGeometry, await canvasGeometry(page))
        assert.deepEqual(requests, thresholdRequests, "A classic scrollbar must not trigger query replay at a responsive threshold")
        assert.equal(failedRequests.length, thresholdFailures)
        console.log(`PASS query inspector classic-scrollbar threshold: ${thresholdGeometry.canvas.width}px canvas, ${gutter}px gutter`)
      } else console.log("SKIP classic-scrollbar threshold: this Chromium host reports an overlay scrollbar (0px viewport gutter)")
    }
    assert.deepEqual(consoleErrors, [])
    console.log(`PASS query inspector ${theme} ${width}px: eight queries, nested/unknown timing, partial/timeout, redaction, native modal keyboard/Escape, expired-cache passivity, preserved in-flight query, stable canvas, no overflow, focus restoration`)
    await context.close()
  }
  assert.deepEqual(errors, [])
} catch (error) {
  await activePage?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {})
  throw error
} finally {
  await browser.close()
}
