// Saved-query dropdowns must not guess query language from result kind.
// Uses a real PostgreSQL provider and removes the one test query by ETag.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const app = new URL(process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:1")
const api = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
for (const url of [app, api]) assert.equal(url.hostname, "127.0.0.1")
async function request(path, options) {
  const response = await fetch(new URL(path, api), options)
  assert.ok(response.ok, `${path}: HTTP ${response.status}`)
  return response
}
const queries = (await (await request("/api/insights/saved-queries")).json()).queries
const original = queries.find(item => item.id === "local-stress-records")
assert.ok(original && original.kind === "records")
const id = `query-kind-label-${Date.now()}`
const query = { ...original, id, name: "SQL records without description", description: undefined, tags: undefined, metadata: undefined }
delete query.etag
const path = `/api/insights/saved-queries/${id}`
const created = await request(path, { method: "PUT", headers: { "Content-Type": "application/json", "If-None-Match": "*" }, body: JSON.stringify(query) })
const etag = created.headers.get("x-paprika-document-etag") ?? created.headers.get("etag")
assert.ok(etag)
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, colorScheme: theme, reducedMotion: "reduce" })
    await context.addInitScript(theme => localStorage.setItem("paprika-insights-theme", theme), theme)
    const page = await context.newPage(), errors = []
    page.on("pageerror", error => errors.push(error.message))
    await page.route(url => ["/api/", "/auth/"].some(prefix => url.pathname.startsWith(prefix)), async route => {
      const original = new URL(route.request().url()), headers = { ...route.request().headers() }
      delete headers.origin; delete headers.host
      const response = await route.fetch({ url: new URL(original.pathname + original.search, api).href, headers })
      await route.fulfill({ response })
    })
    try {
      page.setDefaultTimeout(30000)
      await page.goto(new URL("/dashboard/insights/?dashboard=local-gallery-stress-lab", app).href, { waitUntil: "networkidle" })
      const nav = page.locator("#insights-navigation")
      if (!await nav.isVisible()) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
      await nav.getByRole("button", { name: /^Explore\b/ }).click()
      const explorer = page.getByRole("region", { name: "Data source explorer", exact: true }).last()
      await selectGammaOption(page, explorer.getByRole("combobox", { name: "Explore data source", exact: true }), "observability/gallery-postgresql")
      await explorer.getByRole("combobox", { name: "Open saved query", exact: true }).click()
      const option = page.getByRole("option", { name: query.name, exact: true })
      await option.waitFor()
      assert.match(await option.innerText(), /Records · 1 parameter\b/)
      assert.doesNotMatch(await option.innerText(), /PromQL|TraceQL/)
      await option.click()
      const results = explorer.getByRole("region", { name: "Explore query results" })
      await results.getByRole("button", { name: "Run query", exact: true }).click()
      await results.getByLabel("Result summary").getByText(/1,000 rows · 5 columns/).waitFor()
      assert.deepEqual(errors, [])
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
      console.log(`PASS ${theme} ${width}px: PostgreSQL records are correctly labelled and execute`)
    } finally { await page.unrouteAll({ behavior: "ignoreErrors" }); await context.close() }
  }
  const after = await request(path)
  assert.equal(after.headers.get("x-paprika-document-etag") ?? after.headers.get("etag"), etag)
} finally {
  await browser.close()
  await request(path, { method: "DELETE", headers: { "If-Match": etag } })
}
