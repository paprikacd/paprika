// Exercise real dashboard controls against the repository's attributed sample records.
import assert from "node:assert/strict"
import { chromium } from "playwright"

const base = process.env.INSIGHTS_E2E_URL || "http://localhost:61091"
const fixture = "paprika_example_shorted_my_dashboard_top_shorts"
const common = { type: "plugin", providerId: "example-records", dataKind: "records", unit: "" }
const dashboard = { schemaVersion: 1, id: "selection-validation", title: "Selection validation", timeRange: "1h", refreshInterval: 0,
  variables: [{ name: "company", label: "Company", defaultValue: "CBA", options: ["CBA", "BHP", "CSL", "WBC", "ANZ"] }, { name: "scope", label: "Scope", defaultValue: "original" }],
  widgets: [
    { ...common, id: "companies", title: "Companies", pluginId: "record-treemap", query: JSON.stringify({ fixture }), config: { label: "product_code", value: "short_position" }, layout: { x: 0, y: 0, w: 6, h: 6 }, selectionBindings: [{ variable: "company", source: "label", value: "product_code" }] },
    { ...common, id: "detail", title: "Company detail", pluginId: "record-table", query: `{"fixture":"${fixture}","filters":{"product_code":{{company}}}}`, config: { columns: ["product_code", "name"] }, layout: { x: 6, y: 0, w: 6, h: 6 } },
  ] }
const browser = await chromium.launch({ headless: true })
try {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
    await context.addInitScript(({ origin, dashboard, theme }) => {
      if (location.origin !== origin) return
      localStorage.setItem("paprika-insights-example-v1", JSON.stringify({ dashboards: [dashboard], activeId: dashboard.id }))
      localStorage.setItem("paprika-insights-theme", theme)
    }, { origin: new URL(base).origin, dashboard, theme })
    const page = await context.newPage()
    const errors = []
    page.on("pageerror", e => errors.push(e.message))
    await page.goto(`${base}/dashboard/insights/?example=1&dashboard=${dashboard.id}`)
    const source = page.locator('[data-widget-id="companies"]')
    const detail = page.locator('[data-widget-id="detail"]')
    await detail.getByText("Commonwealth Bank").waitFor({ timeout: 10000 }).catch(async error => { console.error("browser errors", errors, "body", await page.locator("body").innerText(), "url", page.url()); throw error })
    const bhp = source.getByRole("button", { name: /^BHP:/ })
    await bhp.hover()
    assert.equal(await detail.getByText("Commonwealth Bank").count(), 1, "Hover must not change filters")
    await bhp.focus()
    await bhp.press("Enter")
    await detail.getByText("BHP Group").waitFor()
    assert.equal(await detail.getByText("Commonwealth Bank").count(), 0)
    assert.ok((await page.url()).includes("BHP"), "Selection must be shareable in the dashboard URL")
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("paprika-insights-example-v1")))
    assert.equal(stored.dashboards[0].variables[0].defaultValue, "CBA", "Selection must not save the runtime value")
    assert.deepEqual(errors, [])
    console.log(`PASS ${theme}: hover is inert, keyboard selection updates the detail and preserves saved defaults`)
    await context.close()
  }
} finally { await browser.close() }
