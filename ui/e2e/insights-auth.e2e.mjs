// Read-only live sign-in handoff. Uses the same private configuration as the
// service-overview validator; never automates Google consent or writes documents.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { chromium } from "playwright"

assert.ok(process.env.INSIGHTS_SERVICE_OVERVIEW_CONFIG, "Set INSIGHTS_SERVICE_OVERVIEW_CONFIG")
const config = JSON.parse(await readFile(process.env.INSIGHTS_SERVICE_OVERVIEW_CONFIG, "utf8"))
const origin = new URL(config.baseURL)
assert.ok(["http:", "https:"].includes(origin.protocol) && !origin.username && !origin.password)
const token = (await readFile(config.tokenFile, "utf8")).trim()
const output = resolve(config.outputDir)
const service = config.services[0]
const target = `/dashboard/insights/?${new URLSearchParams({ dashboard: config.dashboardId, vars: JSON.stringify({ service }) })}`
const reports = [], errors = [], writes = []
const browser = await chromium.launch({ headless: true })
let context, page
async function open(storedToken) {
  await context?.close()
  context = await browser.newContext()
  if (storedToken) await context.addInitScript(value => localStorage.setItem("paprika_id_token", value), storedToken)
  page = await context.newPage()
  page.setDefaultTimeout(30_000)
  page.on("pageerror", error => errors.push(error.message))
  page.on("request", request => {
    if (/^\/api\/insights\/(dashboards|saved-queries)(\/|$)/.test(new URL(request.url()).pathname) && !["GET", "HEAD"].includes(request.method())) writes.push(request.method())
  })
}
async function check(name, action) {
  try { await action(); reports.push({ name, passed: true }); console.log(`PASS ${name}`) }
  catch (error) { reports.push({ name, passed: false, error: error.message }); throw error }
}
try {
  await mkdir(output, { recursive: true })
  await check("Signed-out dashboard links reach login and retain the dashboard and service", async () => {
    await open()
    await page.goto(new URL(target, origin).href, { waitUntil: "domcontentloaded" })
    await page.waitForURL(new URL("/login/", origin).href)
    await page.getByRole("button", { name: /Google/i }).waitFor()
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika_return_to")), target)
  })
  await check("An authenticated login returns to the saved dashboard and service", async () => {
    // Match persistAuth's two records after a successful authentication. A bare
    // bearer token authorizes API calls but does not restore the console user.
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString())
    await page.evaluate(({ token, user }) => {
      localStorage.setItem("paprika_id_token", token)
      localStorage.setItem("paprika_auth_user", JSON.stringify(user))
    }, { token, user: { sub: claims.sub, email: claims.email ?? "", name: claims.name ?? "" } })
    await page.reload({ waitUntil: "domcontentloaded" })
    await page.waitForURL(new URL(target, origin).href)
    await page.getByRole("heading", { name: config.expectedDocument?.title ?? "Service overview", exact: true }).waitFor()
    const filter = page.getByRole("form", { name: "Dashboard variables", exact: true }).getByRole("combobox", { name: "Service", exact: true })
    assert.ok((await filter.innerText()).includes(service))
    await page.locator('[data-widget-id="request-rate"] [data-metric-value]').waitFor({ timeout: 45_000 })
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika_return_to")), null)
  })
  await check("An invalid stored session returns to login without losing the destination", async () => {
    await open("invalid-validation-session")
    await page.goto(new URL(target, origin).href, { waitUntil: "domcontentloaded" })
    await page.waitForURL(new URL("/login/", origin).href)
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika_return_to")), target)
  })
  await check("Anonymous example mode remains available without login", async () => {
    await open()
    const target = new URL("/dashboard/insights/?example=1", origin)
    await page.goto(target.href, { waitUntil: "domcontentloaded" })
    await page.locator("[data-widget-id]").first().waitFor()
    const current = new URL(page.url())
    assert.equal(current.origin, target.origin)
    assert.equal(current.pathname, target.pathname)
    assert.equal(current.searchParams.get("example"), "1")
    assert.equal(await page.evaluate(() => localStorage.getItem("paprika_return_to")), null)
  })
  assert.deepEqual(errors, [])
  assert.deepEqual(writes, [])
} catch (error) { console.error(error.stack ?? error.message); process.exitCode = 1 }
finally {
  await mkdir(output, { recursive: true })
  await writeFile(join(output, "login-return.json"), JSON.stringify({ timestamp: new Date().toISOString(), reports, errors, writes, target, note: "Authenticated handoff uses an isolated validation credential; Google consent is not exercised." }, null, 2))
  await browser.close()
}
