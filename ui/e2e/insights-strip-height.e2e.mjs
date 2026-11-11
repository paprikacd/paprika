// Attention strip height sweep. The strip's height is fixed by construction, so this suite does not reserve space by
// measurement: it checks the real strip at every canvas width from 288 to 1100 px, in light and dark, for the longest
// copy (flagged on all four reasons, a 12-minute age, a half-hour-zone sample time, a refresh interval and a count still
// loading) and for a calm dashboard. Viewport changes do not reload the page; the same dashboard is resized. Each band is
// checked against the canvas width measured at that viewport, not the viewport itself.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { routeAnonymousAuthConfiguration } from "./anonymous-auth-fixture.mjs"

const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
// Viewport widths in 16px steps. The sidebar takes part of the viewport, so 1400 px gives a canvas past the 1040 px band.
const WIDTHS = Array.from({ length: 71 }, (_, index) => 288 + index * 16)
const TWELVE_MINUTES = 12 * 60_000
const providers = [{ id: "strip-metrics", name: "Strip metrics", type: "prometheus", capabilities: ["metrics"] }]

function stat(id, query, options, index) {
  return { id, title: `Strip ${id}`, type: "stat", providerId: "strip-metrics", query, unit: "req/s", layout: { x: (index % 3) * 4, y: Math.floor(index / 3) * 3, w: 4, h: 3 }, options: { decimals: 2, ...options } }
}
// Fourteen tiles, so the counts read with two digits. The last never answers, so one count stays not loaded. The flagged
// variant puts four reasons on the first five tiles; the calm variant has the same tiles, all answering normally.
function dashboardOf(variant) {
  const flagged = [
    stat("crit", "s_crit", { thresholds: [{ value: 5, status: "critical", label: "Breached" }] }, 0),
    stat("warn", "s_warn", { thresholds: [{ value: 2, status: "warning", label: "Elevated" }] }, 1),
    stat("fail-a", "s_fail_a", {}, 2),
    stat("fail-b", "s_fail_b", {}, 3),
    stat("stale", "s_stale", { staleAfterSeconds: 60 }, 4),
  ]
  const calm = Array.from({ length: 5 }, (_, index) => stat(`calm-${index}`, `s_ok_${index}`, {}, index))
  const oks = Array.from({ length: 8 }, (_, index) => stat(`ok-${index}`, `s_ok_${index + 5}`, {}, index + 5))
  const head = variant === "flagged" ? flagged : calm
  return { schemaVersion: 1, id: `strip-${variant}`, title: `Strip ${variant}`, timeRange: "1h", refreshInterval: 30, timeZone: "Asia/Kolkata", widgets: [...head, ...oks, stat("hang", "s_hang", {}, 13)] }
}

async function openDashboard(browser, variant, colorScheme) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, colorScheme, reducedMotion: "reduce", timezoneId: "Asia/Kolkata" })
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  await routeAnonymousAuthConfiguration(page)
  const dashboard = dashboardOf(variant)
  await page.route("**/api/insights/**", async route => {
    const request = route.request(), url = new URL(request.url())
    let body = {}, status = 200
    if (url.pathname === "/api/insights/providers") body = { providers }
    else if (url.pathname === "/api/insights/dashboards") body = { dashboards: [dashboard] }
    else if (url.pathname === "/api/insights/saved-queries") body = { queries: [] }
    else if (url.pathname.startsWith("/api/insights/dashboards/")) body = dashboard
    else if (url.pathname.endsWith("/metadata")) body = { values: [] }
    else if (url.pathname === "/api/insights/query") {
      const query = request.postDataJSON().query
      if (query === "s_hang") return
      if (query.startsWith("s_fail")) { status = 502; body = { error: "Strip backend failed. Retry this query." } }
      else {
        const timestamp = query === "s_stale" ? Date.now() - 300_000 : Date.now() - 1000
        body = { series: [{ name: query, labels: { service: query }, points: [{ timestamp, value: query === "s_crit" ? 7 : query === "s_warn" ? 3 : 1 }] }] }
      }
    } else { status = 404; body = { error: "unexpected" } }
    await route.fulfill({ status, contentType: "application/json", headers: { ETag: `"strip-${variant}"` }, body: JSON.stringify(body) })
  })
  await page.goto(`${baseURL}/dashboard/insights/?dashboard=strip-${variant}`, { waitUntil: "load" })
  await page.getByRole("heading", { name: `Strip ${variant}`, exact: true }).waitFor()
  await page.waitForSelector("[data-attention-strip]")
  // Bring every queried tile into view once, so the results load; the last tile never answers.
  for (const widget of dashboard.widgets.slice(0, 13)) {
    await page.locator(`[data-widget-id="${widget.id}"]`).scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => /not loaded yet/.test(document.querySelector("[data-attention-strip]").innerText), null, { timeout: 20_000 })
  // Age the results by twelve minutes; the clock keeps ticking, so the age text follows.
  const browserNow = await page.evaluate(() => Date.now())
  await page.clock.setFixedTime(new Date(browserNow + TWELVE_MINUTES))
  await page.waitForFunction(() => /Updated 12 min ago/.test(document.querySelector("[data-attention-strip]").innerText), null, { timeout: 10_000 })
  return { context, page }
}

const measure = (page) => page.evaluate(() => {
  const box = element => element.getBoundingClientRect()
  const strip = document.querySelector("[data-attention-strip]")
  const text = strip.firstElementChild
  const chips = strip.querySelector("[class*='__chips']")
  const counts = strip.querySelector("p")
  const buttons = [...chips.querySelectorAll("button")]
  const tiles = [...document.querySelectorAll("article[data-widget-id]")]
  return {
    canvasW: Math.round(box(document.querySelector('[data-testid="dashboard-canvas"]')).width),
    stripH: Math.round(box(strip).height * 100) / 100,
    stripScrollH: strip.scrollHeight, stripClientH: strip.clientHeight,
    textH: Math.round(box(text).height * 100) / 100, textTitle: text.title,
    chipsTops: [...new Set(buttons.map(button => Math.round(box(button).top)))].length,
    chipsScrollbar: chips.offsetHeight - chips.clientHeight,
    countsText: counts.textContent,
    textInner: text.innerText,
    // The first tile's page position, so the flagged and calm dashboards are compared at the same place on the page.
    firstTileTop: tiles.length ? Math.round((box(tiles[0]).top + window.scrollY) * 100) / 100 : null,
    buttons: buttons.length,
  }
})

// Real scrollbars: Chromium's headless default hides them, which would let a scrollbar's height go unseen.
const browser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] })
const results = {}
try {
  for (const colorScheme of ["light", "dark"]) {
    for (const variant of ["flagged", "calm"]) {
      const { context, page } = await openDashboard(browser, variant, colorScheme)
      results[`${colorScheme}-${variant}`] = {}
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 })
        await page.evaluate(() => window.scrollTo(0, 0))
        await page.waitForTimeout(200)
        results[`${colorScheme}-${variant}`][width] = await measure(page)
      }
      await context.close()
    }
  }
} finally {
  await browser.close()
}

const bandOf = canvasW => canvasW >= 1040 ? "wide" : "narrow"
const summary = {}
let failures = 0
for (const colorScheme of ["light", "dark"]) {
  for (const width of WIDTHS) {
    const flagged = results[`${colorScheme}-flagged`][width]
    const calm = results[`${colorScheme}-calm`][width]
    const band = bandOf(flagged.canvasW)
    const expected = band === "wide" ? 36 : 56
    for (const [name, m] of [["flagged", flagged], ["calm", calm]]) {
      const where = `${colorScheme} ${name} viewport ${width} (canvas ${m.canvasW}px)`
      try {
        assert.equal(m.stripH, expected, `${where}: strip height must be exactly ${expected}`)
        assert.ok(m.stripScrollH <= m.stripClientH + 1, `${where}: the strip must not scroll (${m.stripScrollH} > ${m.stripClientH})`)
        assert.ok(m.textH <= 17.5, `${where}: the text must stay one line (${m.textH}px)`)
        assert.ok(m.chipsTops <= 1, `${where}: the chips must share one line`)
        assert.equal(m.chipsScrollbar, 0, `${where}: a chip scrollbar must not take height (${m.chipsScrollbar}px)`)
      } catch (error) {
        failures++
        console.error(`FAIL ${error.message}`)
      }
      const key = `${colorScheme} ${name} ${band}`
      const bucket = summary[key] ?? (summary[key] = { min: Infinity, max: -Infinity, canvasMin: Infinity, canvasMax: -Infinity })
      bucket.min = Math.min(bucket.min, m.stripH); bucket.max = Math.max(bucket.max, m.stripH)
      bucket.canvasMin = Math.min(bucket.canvasMin, m.canvasW); bucket.canvasMax = Math.max(bucket.canvasMax, m.canvasW)
    }
    try {
      assert.equal(flagged.firstTileTop, calm.firstTileTop, `${colorScheme} viewport ${width}: the first tile must sit at the same page position with and without flags`)
    } catch (error) {
      failures++
      console.error(`FAIL ${error.message}`)
    }
  }
}
console.log("SUMMARY", JSON.stringify(summary))
const sample = results["light-flagged"][390] ?? results["light-flagged"][WIDTHS[0]]
console.log("SAMPLE", JSON.stringify(sample))
assert.match(sample.textInner, /^Updated \d+ min ago · Newest sample \d\d:\d\d GMT\+5:30 · Refreshes every 30 s$/, "The text row must read as one sentence with its separators")
assert.equal(failures, 0, `${failures} strip height checks failed`)
console.log(`strip height sweep passed: ${WIDTHS.length} canvas widths (viewport 288 to 1400) in light and dark, flagged and calm.`)
