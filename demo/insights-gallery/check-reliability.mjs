// Check that the Reliability Room's recorded incidents correspond to actual Prometheus
// error-rate spikes, and that its SLO card and services card agree with independent PromQL.
// This only talks to the isolated loopback demo harness.
import assert from "node:assert/strict"
const origin = new URL(process.argv[2] || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only a loopback gallery is supported")
const json = { "Content-Type": "application/json" }
async function request(path, options = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const response = await fetch(new URL(path, origin), { ...options, signal: AbortSignal.timeout(30000) })
    const body = await response.json()
    if (response.status === 429 && attempt < 7) { await new Promise(done => setTimeout(done, 300 * (attempt + 1))); continue }
    assert.equal(response.status, 200, `${path}: ${body.error ?? response.status}`)
    return body
  }
  throw Error("Provider remained rate limited")
}
const saved = (await request("/api/insights/saved-queries")).queries
const burn = saved.find(q => q.id === "local-ab-reliability-room-burn")
const events = saved.find(q => q.id === "local-reliability-events")
assert.ok(burn && events, "The Reliability burn and incident saved queries must exist")
const end = Math.floor(Date.now() / 1000), start = end - 30 * 86400
const window = { start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString() }
const finite = points => points.filter(p => Number.isFinite(p.value))
const lastValue = series => finite(series?.points ?? []).at(-1)?.value

// An independent PromQL ratio: one evaluation at the range end, over the dashboard's 30-day period.
const providerId = burn.providerId
async function promql(query) {
  const response = await request("/api/insights/query", { method: "POST", headers: json, body: JSON.stringify({ providerId, kind: "metrics", query, start, end, step: end - start }) })
  return response.series
}
const bad = selector => `sum by (service)(increase(paprika_demo_requests_total{${selector},code="5xx"}[30d]))`
const total = selector => `sum by (service)(increase(paprika_demo_requests_total{${selector}}[30d]))`
const independentAvailability = selector => `100 * (1 - ${bad(selector)} / ${total(selector)})`
const independentBudget = selector => `100 * (1 - (${bad(selector)} / ${total(selector)}) / 0.001)`

// The card reads its objective and period from the same config the dashboard stores.
function assertObjective(slo, label) {
  assert.equal(slo.objective, 99.9, `${label}: objective`)
  assert.equal(slo.period, "30d", `${label}: period`)
}
// Budget remaining is not clamped: an overspent objective reads below zero, and the card must show it.
const tolerance = { availability: 0.005, budget: 0.05 }

const dashboardQuery = async service => request("/api/insights/query-dashboard", { method: "POST", headers: json, body: JSON.stringify({ id: "local-gallery-reliability-room", variables: { service }, ...window, max_series: 8, max_traces: 3, history_points: 8 }) })
const widgetSLO = (bundle, id) => {
  const widget = bundle.widgets.find(item => item.id === id)
  assert.ok(widget?.slo, `${id}: the SLO card must return a reading`)
  return widget.slo
}

for (const service of ["checkout", "payments"]) {
  const bundle = await dashboardQuery(service)
  const slo = widgetSLO(bundle, "slo")
  assertObjective(slo, `${service} SLO card`)
  assert.equal(slo.groups.length, 1, `${service}: a single-mode card has one group`)
  const group = slo.groups[0]
  const selector = `cluster="omega",service="${service}"`
  const [availabilitySeries] = await promql(independentAvailability(selector))
  const [budgetSeries] = await promql(independentBudget(selector))
  const expectedAvailability = lastValue(availabilitySeries), expectedBudget = lastValue(budgetSeries)
  assert.ok(Number.isFinite(expectedAvailability) && Number.isFinite(expectedBudget), `${service}: independent PromQL must return values`)
  assert.ok(Math.abs(group.availability - expectedAvailability) < tolerance.availability, `${service}: availability ${group.availability} does not match PromQL ${expectedAvailability}`)
  assert.ok(Math.abs(group.budgetRemaining - expectedBudget) < tolerance.budget, `${service}: budget ${group.budgetRemaining} does not match PromQL ${expectedBudget}`)
  // The card's own state must follow from the budget it reports.
  assert.equal(group.budgetRemaining <= 0, group.reasons.includes("budget_exhausted"), `${service}: budget_exhausted must follow from the budget`)
  console.log(`PASS ${service} SLO card: availability ${group.availability.toFixed(3)}%, budget ${group.budgetRemaining.toFixed(2)}% (PromQL ${expectedAvailability.toFixed(3)}%, ${expectedBudget.toFixed(2)}%)`)

  // Recorded incidents must coincide with error-rate spikes, and the 1h and 6h burn rates must diverge.
  const history = await request("/api/insights/query", { method: "POST", headers: json, body: JSON.stringify({ providerId: burn.providerId, kind: burn.kind, query: burn.query.replaceAll("{{service}}", JSON.stringify(service)), start, end, step: 1800 }) })
  const incident = (await request("/api/insights/query", { method: "POST", headers: json, body: JSON.stringify({ providerId: events.providerId, kind: events.kind, query: events.query.replaceAll("{{service}}", JSON.stringify(service)), start, end, step: 1800 }) })).records
  const index = key => incident.columns.findIndex(column => column.key === key)
  const row = incident.rows.find(row => row[index("label")] === "Synthetic elevated request errors")
  assert.ok(row, `${service}: a recorded synthetic incident is required`)
  const from = Date.parse(row[index("date")]), to = Date.parse(row[index("ended_at")])
  assert.ok(Number.isFinite(from) && to > from, `${service}: invalid recorded interval`)
  const one = history.series.find(series => series.labels.window === "1h")
  const six = history.series.find(series => series.labels.window === "6h")
  assert.ok(one && six, `${service}: both rolling rates must be returned`)
  const within = finite(one.points).filter(p => p.timestamp >= from && p.timestamp <= to)
  const outside = finite(one.points).filter(p => p.timestamp >= from - 6 * 3600_000 && p.timestamp < from - 3600_000)
  assert.ok(within.length >= 4 && outside.length >= 4, `${service}: insufficient recorded observations`)
  const peak = Math.max(...within.map(p => p.value)), baseline = Math.max(...outside.map(p => p.value))
  assert.ok(peak > 2 && peak > baseline + 0.5, `${service}: recorded incident does not coincide with an error-rate spike (${peak} vs ${baseline})`)
  const other = new Map(finite(six.points).map(p => [p.timestamp, p.value]))
  assert.ok(within.some(p => other.has(p.timestamp) && Math.abs(p.value - other.get(p.timestamp)) > 0.1), `${service}: 1h and 6h burn rates must diverge during the event`)
  console.log(`PASS ${service}: incident ${new Date(from).toISOString()}–${new Date(to).toISOString()}, 1h burn peak ${peak.toFixed(2)}×`)
}

// The services card lists every demo service with traffic. Each group must match its own PromQL ratio,
// and the groups must be complete: the matcher bounds them, so none may be omitted.
const services = widgetSLO(await dashboardQuery("checkout"), "services-attention")
assertObjective(services, "services card")
assert.equal(services.groupsOmitted, 0, "The services card must list every bounded group")
assert.deepEqual(services.groups.map(group => group.labels.service).sort(), ["catalog", "checkout", "payments", "worker"], "Every service must have a group")
const selector = `cluster="omega",service=~"checkout|payments|catalog|worker"`
const availabilities = await promql(independentAvailability(selector))
const budgets = await promql(independentBudget(selector))
for (const group of services.groups) {
  const service = group.labels.service
  const expectedAvailability = lastValue(availabilities.find(series => series.labels.service === service))
  const expectedBudget = lastValue(budgets.find(series => series.labels.service === service))
  assert.ok(Number.isFinite(expectedAvailability) && Number.isFinite(expectedBudget), `${service}: independent PromQL must return values`)
  assert.ok(Math.abs(group.availability - expectedAvailability) < tolerance.availability, `${service}: services availability ${group.availability} does not match PromQL ${expectedAvailability}`)
  assert.ok(Math.abs(group.budgetRemaining - expectedBudget) < tolerance.budget, `${service}: services budget ${group.budgetRemaining} does not match PromQL ${expectedBudget}`)
}
console.log(`PASS services card: ${services.groups.length} groups match independent PromQL`)

// The card text is what a reader sees. Open the Reliability Room in a browser and check the SLO card and the services
// card against the same query_dashboard readings: the displayed values must agree with the readings, and an overspent
// budget must be shown below zero rather than clamped. The visible budget text is read, not the accessible label.
const visibleNumber = text => Number.parseFloat(text.replaceAll("\u2212", "-").replace(/[^0-9.-]/g, ""))
const { chromium } = await import(new URL("../../ui/node_modules/playwright/index.mjs", import.meta.url))
const browser = await chromium.launch({ headless: true })
try {
  const openRoom = async (width, colorScheme) => {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme })
    const page = await context.newPage()
    const url = new URL("/dashboard/insights/", origin)
    url.searchParams.set("dashboard", "local-gallery-reliability-room")
    url.searchParams.set("from", window.start)
    url.searchParams.set("to", window.end)
    await page.goto(url.href, { waitUntil: "networkidle" })
    return { context, page }
  }
  const { context, page } = await openRoom(1512, "light")
  const sloCard = page.locator('[data-widget-id="slo"]'), servicesCard = page.locator('[data-widget-id="services-attention"]')
  await sloCard.scrollIntoViewIfNeeded()
  await sloCard.locator("[data-slo-availability]").waitFor()
  const bundle = await dashboardQuery("checkout")
  const group = widgetSLO(bundle, "slo").groups[0]
  const shownAvailability = visibleNumber(await sloCard.locator("[data-slo-availability]").textContent())
  const shownBudget = visibleNumber(await sloCard.locator("[data-slo-budget-value]").first().textContent())
  assert.ok(Math.abs(shownAvailability - group.availability) < 0.1, `SLO card shows availability ${shownAvailability}; the reading is ${group.availability}`)
  assert.ok(Math.abs(shownBudget - group.budgetRemaining) < 0.1, `SLO card shows budget ${shownBudget}; the reading is ${group.budgetRemaining}`)
  const header = (await sloCard.locator("header").textContent()) ?? ""
  assert.ok(header.includes("over 30d window"), `The live SLO header reads "${header}", not "over 30d window"`)
  assert.ok(!header.includes("ending"), `A live SLO header must not name a range end: "${header}"`)
  await servicesCard.scrollIntoViewIfNeeded()
  await servicesCard.locator("[data-slo-rows]").getByText("checkout", { exact: true }).first().waitFor()
  const services = widgetSLO(await dashboardQuery("checkout"), "services-attention")
  const shownBudgets = (await servicesCard.locator("[data-slo-rows] [data-slo-budget-value]").evaluateAll(nodes => nodes.map(node => node.textContent))).map(visibleNumber).sort((a, b) => a - b)
  const readBudgets = services.groups.map(item => item.budgetRemaining).sort((a, b) => a - b)
  assert.equal(shownBudgets.length, readBudgets.length, `The services card shows ${shownBudgets.length} budgets for ${readBudgets.length} groups`)
  shownBudgets.forEach((value, index) => assert.ok(Math.abs(value - readBudgets[index]) < 0.1, `Services budget ${value} does not match the reading ${readBudgets[index]}`))
  console.log(`PASS card text: header "${header.trim()}"; SLO card shows ${shownAvailability}% and budget ${shownBudget}%; services card shows ${shownBudgets.length} budgets`)
  await context.close()

  // Services rows must fit completely inside the card at both widths and both schemes. No row may be cut, and the
  // footer must count the groups the card shows and the groups it hides for space or by its row cap.
  const groupTotal = services.groups.length + services.groupsOmitted
  for (const [width, scheme] of [[1512, "light"], [1512, "dark"], [390, "light"], [390, "dark"]]) {
    const probe = await openRoom(width, scheme)
    try {
      const card = probe.page.locator('[data-widget-id="services-attention"]')
      await card.scrollIntoViewIfNeeded()
      await card.locator("[data-slo-footer]").waitFor()
      const geometry = await card.evaluate(panel => {
        const region = panel.querySelector("[data-slo-scroll]")
        const box = region.getBoundingClientRect()
        const rows = [...region.querySelectorAll("[data-slo-rows] tbody tr:not([hidden])")].map(row => row.getBoundingClientRect())
        return {
          top: box.top, bottom: box.bottom, cardBottom: panel.getBoundingClientRect().bottom,
          overflows: region.scrollHeight > region.clientHeight + 1,
          rows: rows.map(row => ({ top: row.top, bottom: row.bottom })),
          footer: panel.querySelector("[data-slo-footer]").textContent,
        }
      })
      const label = `${width}px ${scheme}`
      assert.ok(geometry.rows.length > 0, `${label}: the services card shows no rows`)
      geometry.rows.forEach((row, index) => {
        assert.ok(row.top >= geometry.top - 0.5 && row.bottom <= geometry.bottom + 0.5, `${label}: row ${index + 1} is cut by its region (${row.top}-${row.bottom} in ${geometry.top}-${geometry.bottom})`)
      })
      assert.ok(!geometry.overflows, `${label}: the services region scrolls internally`)
      assert.ok(geometry.bottom <= geometry.cardBottom + 0.5, `${label}: the services region leaves the card`)
      const match = /Showing (\d+) of (\d+) groups/.exec(geometry.footer)
      const shownCount = match ? Number(match[1]) : Number.parseInt(geometry.footer, 10)
      const totalCount = match ? Number(match[2]) : groupTotal
      assert.equal(shownCount, geometry.rows.length, `${label}: the footer counts ${shownCount} shown groups but ${geometry.rows.length} rows are rendered: "${geometry.footer}"`)
      assert.equal(totalCount, groupTotal, `${label}: the footer counts ${totalCount} groups, the reading has ${groupTotal}: "${geometry.footer}"`)
      console.log(`PASS services fit ${label}: ${geometry.rows.length} of ${groupTotal} rows whole, footer "${geometry.footer}"`)
    } finally {
      await probe.context.close()
    }
  }
} finally {
  await browser.close()
}
