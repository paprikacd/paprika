// Verify source requirements in the shipped gallery against a real Insights store.
// This test reviews mappings only; it does not claim source telemetry is present.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"
import { portableEnvironment, until } from "./insights-portable-fixture.mjs"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = join(root, "artifacts/insights/source-provenance")
const catalog = JSON.parse(await readFile(join(root, "ui/src/features/insights/repository-examples/catalog.json"), "utf8"))
const welcome = { schemaVersion: 1, id: "welcome", title: "Source requirements", timeRange: "1h", refreshInterval: 0, widgets: [] }
const reports = [], errors = []
let environment, destination, browser, context, page

try {
  await mkdir(output, { recursive: true })
  environment = await portableEnvironment(root, base)
  destination = await environment.fixture("independent-sources")
  await destination.api("dashboards/welcome", "PUT", welcome, { "If-None-Match": "*" })
  browser = await chromium.launch({ headless: true })
  for (const theme of ["light", "dark"]) {
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce" })
    await context.addInitScript(value => localStorage.setItem("paprika-insights-theme", value), theme)
    page = await context.newPage()
    page.on("pageerror", error => errors.push(error.message))
    page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
    // Keep Next's development assets on their own origin; only API traffic is
    // forwarded to the durable Go fixture, with its response preserved verbatim.
    await page.route("**/api/insights/**", async route => {
      const url = new URL(route.request().url())
      const response = await route.fetch({ url: `${destination.gatewayURL}${url.pathname}${url.search}` })
      await route.fulfill({ response })
    })
    await page.goto(`${base}/dashboard/insights/?dashboard=welcome`)
    await page.getByRole("heading", { name: welcome.title, exact: true }).waitFor()
    await page.getByRole("button", { name: new RegExp(`^Examples ${catalog.length}$`) }).click()
    const gallery = page.getByRole("region", { name: "Repository examples", exact: true })
    for (const entry of catalog.slice(0, 5)) {
      await gallery.getByRole("textbox", { name: "Find an example" }).fill(entry.title)
      await gallery.getByRole("button").filter({ has: page.getByText(entry.title, { exact: true }) }).click()
      const source = entry.providers[0]
      const mapping = gallery.getByRole("combobox", { name: `Connect ${source.name}`, exact: true })
      await until(async () => await mapping.count() > 0 && !await mapping.isDisabled(), "Source review must finish loading")
      assert.match(await mapping.innerText(), /Choose a data source/, "Each template needs its own explicit mapping")
      const description = await mapping.evaluate(element => document.getElementById(element.getAttribute("aria-describedby"))?.textContent)
      assert.equal(description, source.description)
      assert.equal(await gallery.getByRole("button", { name: "Import 1 as new", exact: true }).isDisabled(), true)
      await selectGammaOption(page, mapping, `${destination.name} metrics`)
      assert.equal(await gallery.getByRole("button", { name: "Import 1 as new", exact: true }).isDisabled(), false)
      await mapping.scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false)
      await page.screenshot({ path: join(output, `${entry.id}-${theme}.png`) })
      reports.push({ name: `${theme}: ${entry.id} requires an explicit ${source.id} mapping`, passed: true })
      await gallery.getByRole("button", { name: "All examples", exact: true }).click()
    }
    await context.close(); context = undefined
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(environment.providerRequests, [], "Reviewing a source must not imply live telemetry validation")
  assert.deepEqual(destination.requests.filter(request => request.method === "PUT"), [], "Reviewing source choices does not persist an import")
  console.log(`PASS ${reports.length} light/dark source mapping reviews; no provider queries or imports`)
} catch (error) {
  await page?.screenshot({ path: join(output, "failure.png"), fullPage: true }).catch(() => {})
  reports.push({ passed: false, error: error.message, stack: error.stack, url: page?.url(), body: await page?.locator("body").innerText().catch(() => "") })
  console.error(error)
  process.exitCode = 1
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ reports, errors }, null, 2))
  await context?.close(); await browser?.close(); await environment?.close()
}
