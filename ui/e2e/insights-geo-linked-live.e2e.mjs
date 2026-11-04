// Optional browser flow through the isolated Insights/Observe/PostgreSQL
// gallery. It reads but never writes the seeded dashboard documents.
import assert from "node:assert/strict"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const origin = new URL(process.env.PAPRIKA_GALLERY_BASE_URL || "http://127.0.0.1:1")
assert.equal(origin.hostname, "127.0.0.1", "Only the isolated local gallery is permitted")
const boardId = "local-gallery-edge-watch"
const browser = await chromium.launch({ headless:true })
try {
  for (const theme of ["light", "dark"]) for (const width of [1512, 390]) {
    const context = await browser.newContext({viewport:{width,height:width === 390 ? 844 : 1050},reducedMotion:"reduce"})
    await context.addInitScript(({origin,theme}) => { if (location.origin === origin) localStorage.setItem("paprika-insights-theme",theme) }, {origin:origin.origin,theme})
    try {
      const page = await context.newPage(), errors = []
      page.on("pageerror", error => errors.push(error.message))
      await page.goto(`${origin.origin}/dashboard/insights/?dashboard=${boardId}`)
      const detail = page.locator('[data-widget-id="geo-selected-detail"]')
      await detail.scrollIntoViewIfNeeded()
      await detail.getByText("Melbourne sample 1").waitFor({timeout:30000})
      const honeycomb = page.locator('[data-widget-id="geo-honeycomb"]')
      await honeycomb.scrollIntoViewIfNeeded()
      const target = honeycomb.getByRole("button",{name:/Tokyo sample 2 ·/})
      await target.waitFor({timeout:30000})
      const boundQuery = page.waitForResponse(response => {
        if (!response.url().includes("/api/insights/query") || response.request().method() !== "POST" || !response.ok()) return false
        try { const body = response.request().postDataJSON(); const query = JSON.parse(body.query); return body.kind === "records" && JSON.stringify(query.parameters) === JSON.stringify(["omega","Tokyo sample 2"]) }
        catch { return false }
      })
      await target.hover()
      const tooltip = page.getByRole("tooltip")
      await tooltip.waitFor()
      await boundQuery
      const embedded = tooltip.locator('[data-tooltip-widget="plugin"]')
      await embedded.getByText("Tokyo sample 2").waitFor()
      assert.ok(!page.url().includes("Tokyo"),"Hover must not apply a selection")
      await target.focus()
      assert.ok(!page.url().includes("Tokyo"),"Focus must not apply a selection")
      await target.press("Enter")
      await page.waitForURL(/Tokyo/)
      await detail.scrollIntoViewIfNeeded()
      await detail.getByText("Tokyo sample 2").waitFor({timeout:30000})
      await selectGammaOption(page,page.getByRole("combobox",{name:"Cluster",exact:true}),"delta")
      await detail.scrollIntoViewIfNeeded()
      await detail.getByText("Tokyo sample 2").waitFor({timeout:30000})
      const document = await page.evaluate(async id => (await (await fetch(`/api/insights/dashboards/${id}`)).json()), boardId)
      assert.equal(document.variables.find(variable => variable.name === "location")?.defaultValue,"Melbourne sample 1","Selection must not modify saved defaults")
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),false)
      assert.deepEqual(errors,[])
      console.log(`PASS ${theme} ${width}px: real saved-query tooltip, explicit location selection and shared cluster filter`)
    } finally { await context.close() }
  }
} finally { await browser.close() }
