// A severity calendar uses recorded incident ranks, not inferred healthy days.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated local gallery is permitted")
async function get(path, init) {
  const response = await fetch(new URL(path, origin), init)
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`)
  return response
}
const saved = (await (await get("/api/insights/saved-queries")).json()).queries.find(query => query.id === "local-reliability-severity")
assert.ok(saved)
const observed = {}
for (const service of ["checkout", "payments"]) {
  const end = Math.floor(Date.now() / 1000), start = end - 30 * 86400
  const result = await (await get("/api/insights/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: saved.providerId, kind: "records", query: saved.query.replaceAll("{{service}}", JSON.stringify(service)), start, end, step: 1800 }) })).json()
  const frame = result.records, col = name => frame.columns.findIndex(column => column.key === name)
  assert.ok(col("date") >= 0 && col("value") >= 0)
  const maxByDay = new Map()
  const valuesByDay = new Map()
  for (const row of frame.rows) {
    const day = new Date(row[col("date")]).toISOString().slice(0, 10), value = row[col("value")]
    valuesByDay.set(day, [...(valuesByDay.get(day) ?? []), value])
    const previous = maxByDay.get(day)
    // A null severity prevents a truthful maximum, even with other records.
    maxByDay.set(day, value === null || previous === null ? null : Math.max(previous ?? 0, value))
  }
  observed[service] = maxByDay
  assert.ok([...maxByDay.values()].includes(1) && [...maxByDay.values()].includes(2), `${service}: both recorded severities are required`)
  const unknownPresent = [...maxByDay.values()].includes(null)
  if (unknownPresent) assert.ok([...valuesByDay.values()].some(values => values.length === 1 && values[0] === null), `${service}: the synthetic unknown must not mask a known incident`)
  else {
    // The seed never invents a future date or places an unknown on top of an
    // existing incident. Near month start there may be no free past UTC day.
    const today = new Date(), month = today.toISOString().slice(0, 7)
    const knownDays = [...maxByDay.keys()].filter(day => day.startsWith(month) && Number(day.slice(-2)) <= today.getUTCDate())
    assert.equal(knownDays.length, today.getUTCDate(), `${service}: missing unknown sample despite an available past UTC day`)
  }
}
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    try {
      const response = await get("/api/insights/dashboards/local-gallery-reliability-room")
      const before = await response.text(), etag = response.headers.get("x-paprika-document-etag") ?? response.headers.get("etag")
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-reliability-room", origin).href, { waitUntil: "networkidle" })
      const panel = page.locator('[data-widget-id="calendar"]')
      async function check(service) {
        await panel.scrollIntoViewIfNeeded()
        await panel.getByText("Incident severity by day · UTC").waitFor()
        await panel.getByText("No observations", { exact: true }).waitFor()
        const month = await panel.locator("section[aria-label]").first().getAttribute("aria-label")
        const yearMonth = new Date(`${month.replace(/ (\d{4})$/, " 1, $1")} 00:00:00 UTC`).toISOString().slice(0, 7)
        for (const rank of [1, 2]) {
          const day = [...observed[service]].find(([date, value]) => date.startsWith(yearMonth) && value === rank)?.[0]
          // A new UTC month may not yet have a record of every severity.
          if (!day) { console.log(`N/A ${service}: no severity ${rank} record in the displayed UTC month`); continue }
          const label = rank === 1 ? "Warning" : "Critical"
          const button = panel.getByRole("button", { name: new RegExp(`^${day}:.*${label}$`) })
          await button.waitFor()
          assert.equal(await button.locator("..").getAttribute("data-threshold"), label)
          await button.focus()
          await page.getByRole("tooltip").getByText(label, { exact: true }).waitFor()
          await page.keyboard.press("Escape")
        }
        const unknownDay = [...observed[service]].find(([date, value]) => date.startsWith(yearMonth) && value === null)?.[0]
        const missing = panel.getByRole("button", { name: /No observations$/ }).first()
        assert.equal(await missing.locator("..").getAttribute("data-observed"), "false")
        assert.equal(await missing.locator("..").evaluate(element => getComputedStyle(element).borderStyle), "dashed", "No observations remain visually distinct")
        if (unknownDay) {
          const unknown = panel.getByRole("button", { name: new RegExp(`^${unknownDay}:.*Unknown value$`) })
          await unknown.waitFor()
          assert.equal(await unknown.locator("..").getAttribute("data-unknown"), "true")
          const unknownStyle = await unknown.locator("..").evaluate(element => ({ pattern: getComputedStyle(element).backgroundImage, borderStyle: getComputedStyle(element).borderStyle }))
          assert.match(unknownStyle.pattern, /repeating-linear-gradient/, "Recorded unknowns need the neutral pattern")
          assert.equal(unknownStyle.borderStyle, "solid")
          await unknown.focus()
          await page.getByRole("tooltip").getByText("Unknown value", { exact: true }).waitFor()
          await page.keyboard.press("Escape")
        } else console.log(`N/A ${service}: no unoccupied past UTC day is available for the synthetic unknown sample`)
      }
      await check("checkout")
      await selectGammaOption(page, page.getByRole("combobox", { name: "Service", exact: true }), "payments")
      await check("payments")
      const after = await get("/api/insights/dashboards/local-gallery-reliability-room")
      assert.equal(await after.text(), before)
      assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag)
      assert.deepEqual(errors, [])
      console.log(`PASS severity calendar ${theme} ${width}px: provider values, unknown days, tooltip and service filter`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
