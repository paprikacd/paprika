// Bound range references use the actual request window through Insights,
// Observe and PostgreSQL. The fixtures and harness are loopback-only.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1")
async function api(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.ok(response.ok, `${path}: ${response.status}`)
  return response
}
const queries = (await (await api("/api/insights/saved-queries")).json()).queries
const saved = queries.find(query => query.id === "local-reliability-attention")
assert.ok(saved)
const before = await api("/api/insights/dashboards/local-gallery-reliability-room")
const etag = before.headers.get("x-paprika-document-etag") ?? before.headers.get("etag")
const now = Math.floor(Date.now() / 1000)
const request = async (query, start, end) => (await (await api("/api/insights/query", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ providerId: saved.providerId, kind: "records", query, start, end, step: 60 }),
})).json()).records

// Use real recorded timestamps so the boundary assertion is independent of
// the demo's seed time. Neither range value is interpolated into SQL.
const latest = await request("SELECT DISTINCT observed_at FROM gallery.service_probe_samples ORDER BY observed_at DESC LIMIT 4", now - 86400, now)
assert.ok(latest.rows.length >= 4)
const times = latest.rows.map(row => Date.parse(row[0]) / 1000).sort((a, b) => a - b)
assert.ok(times.every(Number.isFinite) && times[1] > times[0])
const bounded = JSON.stringify({ sql: "SELECT DISTINCT observed_at FROM gallery.service_probe_samples WHERE observed_at >= $1::timestamptz AND observed_at <= $2::timestamptz ORDER BY observed_at", parameters: [{ range: "start" }, { range: "end" }] })
const boundary = await request(bounded, times[0], times[1])
assert.deepEqual(boundary.rows.map(row => Date.parse(row[0]) / 1000), [times[0], times[1]])
const present = await request(saved.query, now - 86400, now)
const historical = await request(saved.query, 1577836800, 1577923200)
assert.ok(present.rows.length > 0)
assert.equal(historical.rows.length, 0, "A historical range without probes must not return today's summary")

// Exercise a real seeded interval at its exact endpoints and in its interior.
// It has since ended, but should still be active when the selected end falls
// inside it; duration must be as of that end, not the current wall clock.
const incidentTimes = await request("SELECT started_at, ended_at FROM gallery.incidents WHERE id='reliability-omega-checkout-1'", now - 86400, now)
assert.equal(incidentTimes.rows.length, 1)
const [incidentStart, incidentEnd] = incidentTimes.rows[0].map(value => Date.parse(value) / 1000)
assert.ok(incidentEnd > incidentStart + 120)
const incidents = queries.find(query => query.id === "local-ab-reliability-room-incidents")
const events = queries.find(query => query.id === "local-reliability-events")
const severity = queries.find(query => query.id === "local-reliability-severity")
const signalIncidents = queries.find(query => query.id === "local-signal-incidents")
assert.ok(incidents && events && severity && signalIncidents)
const bind = (query, cluster = "omega") => query.query.replaceAll("{{service}}", JSON.stringify("checkout")).replaceAll("{{cluster}}", JSON.stringify(cluster))
const label = "Synthetic elevated request errors"
const find = (frame, labelColumn) => frame.rows.find(row => row[labelColumn] === label)
const atStart = await request(bind(incidents), incidentStart - 60, incidentStart)
assert.deepEqual(find(atStart, 2)?.slice(3, 6), [0, "critical", "Active"])
const halfway = incidentStart + (incidentEnd - incidentStart) / 2
const inProgress = await request(bind(incidents), halfway - 60, halfway)
assert.equal(find(inProgress, 2)?.[5], "Active")
assert.equal(find(inProgress, 2)?.[3], (halfway - incidentStart) / 60)
const atEnd = await request(bind(incidents), incidentEnd - 60, incidentEnd)
assert.equal(find(atEnd, 2)?.[5], "Resolved")
assert.equal(find(atEnd, 2)?.[3], (incidentEnd - incidentStart) / 60)
const afterEnd = await request(bind(incidents), incidentEnd + 1, incidentEnd + 60)
assert.equal(find(afterEnd, 2), undefined)
const activeAnnotation = find(await request(bind(events), halfway - 60, halfway), 2)
assert.ok(activeAnnotation, "Annotation intervals overlap the selected range")
assert.equal(Date.parse(activeAnnotation[1]) / 1000, halfway, "An incident active at the selected end extends to that end")
assert.equal(find(await request(bind(events), incidentEnd + 1, incidentEnd + 60), 2), undefined)
assert.ok(find(await request(bind(severity), incidentStart - 60, incidentStart), 1), "Calendar includes an incident beginning at the end boundary")
assert.equal(find(await request(bind(severity), halfway - 60, halfway), 1), undefined, "Calendar represents incident start dates, not interval continuation")
const scoped = await request(bind(signalIncidents), halfway - 60, halfway)
assert.equal(find(scoped, 3)?.[6], "Active")
assert.equal(find(scoped, 3)?.[4], (halfway - incidentStart) / 60)
assert.equal(find(await request(bind(signalIncidents, "delta"), incidentStart - 60, incidentStart), 3)?.[2], "delta")

const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 950 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      for (const [start, end, empty] of [[now - 86400, now, false], [1577836800, 1577923200, true]]) {
        const url = new URL("/dashboard/insights/", origin)
        url.searchParams.set("dashboard", "local-gallery-reliability-room")
        url.searchParams.set("from", new Date(start * 1000).toISOString())
        url.searchParams.set("to", new Date(end * 1000).toISOString())
        await page.goto(url.href, { waitUntil: "networkidle" })
        const tile = page.locator('[data-widget-id="services-attention"]')
        await tile.scrollIntoViewIfNeeded()
        if (empty) await tile.getByText(/no data|no records/i).first().waitFor()
        else await tile.getByText("checkout", { exact: true }).waitFor()
      }
      assert.deepEqual(errors, [])
      console.log(`PASS ${theme} ${width}px: real PostgreSQL current vs historical dashboard range`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
const after = await api("/api/insights/dashboards/local-gallery-reliability-room")
assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag)
console.log("PASS PostgreSQL bound start/end values include both selected boundary observations and preserve ETag")
console.log("PASS incident intervals include touching boundaries; historical status and duration use selected end; calendar uses start time")
