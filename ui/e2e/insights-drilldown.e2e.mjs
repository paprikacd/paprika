// Real Insights service + deterministic Prometheus, bridged into the static UI.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createServer } from "node:http"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption, respondToGammaConfirmation } from "./gamma-controls.mjs"

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const base = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = join(root, "artifacts/insights")
const temporary = await mkdtemp(join(tmpdir(), "paprika-drilldown-"))
const requests = [], reports = [], errors = []
let service, browser, page, logs = ""
async function listen(server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening"); return server.address().port
}
const provider = createServer((request, response) => {
  const url = new URL(request.url, "http://localhost")
  requests.push(Object.fromEntries(url.searchParams))
  const end = Number(url.searchParams.get("end")) || Math.floor(Date.now() / 1000)
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify({ status: "success", data: { resultType: "matrix", result: [
    { metric: { service: "checkout-api", instance: "pod-a" }, values: [[end - 60, "1"], [end, "1"]] },
    { metric: { service: "worker", instance: "pod-b" }, values: [[end - 60, "0"], [end, "0"]] },
  ] } }))
})
const range = { from: "2026-10-01T01:00:00.000Z", to: "2026-10-01T02:00:00.000Z" }
const source = {
  schemaVersion: 1, id: "fleet", title: "Fleet health", folder: "Production", timeRange: "1h", refreshInterval: 0, customTimeRange: range,
  widgets: [{ id: "health", title: "Service health", type: "heatmap", providerId: "metrics", query: "up", unit: "", layout: { x: 0, y: 0, w: 12, h: 4 }, options: { thresholds: [
    { value: 0, color: "#c0644f", label: "Unavailable" }, { value: 1, color: "#648b76", label: "Healthy" },
  ] } }],
}
const target = { ...source, id: "service-detail", title: "Service detail", customTimeRange: undefined,
  variables: [{ name: "service", label: "Service", defaultValue: "default" }],
  widgets: [{ ...source.widgets[0], id: "detail", title: "Selected service", type: "timeseries", query: "up{service={{service}}}", options: {} }],
}
async function check(name, run) {
  try { const evidence = await run(); reports.push({ name, passed: true, evidence }); console.log(`PASS ${name}`) }
  catch (error) { reports.push({ name, passed: false, error: error.message }); await page?.screenshot({ path: join(output, "drilldown-failure.png"), fullPage: true }).catch(() => {}); throw error }
}
async function stop(child) {
  if (!child || child.exitCode !== null) return
  const exit = once(child, "exit"); child.kill("SIGTERM")
  const forced = setTimeout(() => child.kill("SIGKILL"), 5000)
  await exit; clearTimeout(forced)
}
try {
  await mkdir(output, { recursive: true })
  const providerPort = await listen(provider)
  const reservation = createServer()
  const port = await listen(reservation)
  await new Promise(resolve => reservation.close(resolve))
  const api = `http://127.0.0.1:${port}`
  const binary = join(temporary, "insights")
  const build = spawn("rtk", ["proxy", "go", "build", "-o", binary, "./cmd/paprika-insights"], { cwd: root, stdio: "inherit" })
  assert.equal((await once(build, "exit"))[0], 0)
  await writeFile(join(temporary, "providers.json"), JSON.stringify({ providers: [{ id: "metrics", name: "Prometheus", type: "prometheus", url: `http://127.0.0.1:${providerPort}` }] }))
  service = spawn(binary, ["--dev", `--listen=127.0.0.1:${port}`, `--data-dir=${join(temporary, "data")}`, `--providers=${join(temporary, "providers.json")}`], { cwd: root, env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: "" }, stdio: ["ignore", "pipe", "pipe"] })
  service.stdout.on("data", data => { logs += data }); service.stderr.on("data", data => { logs += data })
  const deadline = Date.now() + 15000
  while (true) {
    try { if ((await fetch(`${api}/readyz`)).ok) break } catch { /* service startup */ }
    assert.ok(Date.now() < deadline, logs); await new Promise(resolve => setTimeout(resolve, 100))
  }
  for (const document of [source, target]) {
    const saved = await fetch(`${api}/api/dashboards/${document.id}`, { method: "PUT", headers: { "content-type": "application/json", "if-none-match": "*" }, body: JSON.stringify(document) })
    assert.ok(saved.ok, await saved.text())
  }
  const get = async id => (await fetch(`${api}/api/dashboards/${id}`)).json()
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1512, height: 1050 }, reducedMotion: "reduce", timezoneId: "UTC" })
  page = await context.newPage(); page.setDefaultTimeout(15000)
  page.on("pageerror", error => errors.push(error.message))
  page.on("dialog", dialog => { errors.push(`Unexpected native dialog: ${dialog.message()}`); void dialog.dismiss() })
  await page.route("**/api/insights/**", async route => {
    const url = new URL(route.request().url())
    const response = await route.fetch({ url: `${api}${url.pathname.replace(/^\/api\/insights/, "/api")}${url.search}`, maxRedirects: 0 })
    await route.fulfill({ response })
  })
  const editor = () => page.getByRole("region", { name: "Widget editor" })
  await page.goto(`${base}/dashboard/insights/?dashboard=fleet`, { waitUntil: "networkidle" })
  await check("configure a persistent dashboard link through Gamma controls", async () => {
    await page.getByRole("heading", { name: "Fleet health", exact: true }).waitFor()
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit Service health", exact: true }).click()
    await editor().getByRole("tab", { name: "Links", exact: true }).click()
    await editor().getByRole("button", { name: "Add dashboard link", exact: true }).click()
    await editor().getByLabel("Link 1 title", { exact: true }).fill("Open service detail")
    await selectGammaOption(page, editor().getByRole("combobox", { name: "Link 1 destination", exact: true }), /^Service detail/)
    await editor().getByRole("button", { name: "Add variable binding to link 1", exact: true }).click()
    await editor().getByRole("button", { name: "Apply widget", exact: true }).click()
    await editor().getByRole("button", { name: "Close widget editor" }).click()
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByText("All changes saved", { exact: true }).waitFor()
    const saved = await get("fleet")
    assert.equal(saved.widgets[0].drilldowns[0].dashboardId, "service-detail")
    assert.deepEqual(saved.widgets[0].drilldowns[0].bindings, [{ variable: "service", source: "label", value: "service" }])
    return { persisted: true, nativeSelects: await page.locator("select").count() }
  })
  await check("heatmap drilldown carries selected labels and exact time to the real provider", async () => {
    await page.getByRole("group", { name: "Service health heatmap" }).getByRole("button", { name: /checkout-api.*: 1/ }).click()
    await page.getByRole("button", { name: "Open related dashboard from Service health", exact: true }).click()
    await page.getByRole("menuitem", { name: /^Open service detail/ }).click()
    await page.getByRole("heading", { name: "Service detail", exact: true }).waitFor()
    await page.getByLabel("Service", { exact: true }).waitFor()
    assert.equal(await page.getByLabel("Service", { exact: true }).inputValue(), "checkout-api")
    await page.waitForFunction(() => !document.querySelector('[role="status"]')?.textContent?.includes("Loading"))
    const limit = Date.now() + 5000
    while (!requests.some(item => item.query === 'up{service="checkout-api"}')) { assert.ok(Date.now() < limit); await page.waitForTimeout(50) }
    const request = requests.find(item => item.query === 'up{service="checkout-api"}')
    assert.equal(Number(request.start), Date.parse(range.from) / 1000)
    assert.equal(Number(request.end), Date.parse(range.to) / 1000)
    assert.equal(new URL(page.url()).searchParams.get("from"), range.from)
    assert.equal((await get("service-detail")).customTimeRange, undefined)
    await page.screenshot({ path: join(output, "drilldown-destination.png"), fullPage: true })
    return { providerQuery: request.query, fixedRange: range, savedTargetUnchanged: true }
  })
  await check("reload, view variables, browser Back and Forward restore the correct context", async () => {
    await page.reload({ waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Service detail", exact: true }).waitFor()
    assert.equal(await page.getByLabel("Service", { exact: true }).inputValue(), "checkout-api")
    const before = requests.length
    await page.getByLabel("Service", { exact: true }).fill('worker"quoted')
    await page.waitForTimeout(150)
    assert.equal(requests.length, before, "Typing a draft variable must not issue provider queries")
    await page.getByRole("button", { name: "Apply values", exact: true }).click()
    await page.waitForTimeout(250)
    assert.ok(requests.some(item => item.query === 'up{service="worker\\"quoted"}'))
    await page.goBack({ waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Fleet health", exact: true }).waitFor()
    await page.goForward({ waitUntil: "networkidle" })
    await page.getByRole("heading", { name: "Service detail", exact: true }).waitFor()
    assert.equal(await page.getByLabel("Service", { exact: true }).inputValue(), 'worker"quoted')
    assert.equal((await get("service-detail")).variables[0].defaultValue, "default")
  })
  await check("dirty navigation is cancellable and saving keeps carried view settings transient", async () => {
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByLabel("Dashboard title", { exact: true }).fill("Service detail revised")
    await page.getByRole("button", { name: "Fleet health", exact: true }).click()
    await respondToGammaConfirmation(page, "Cancel")
    assert.equal(await page.getByLabel("Dashboard title", { exact: true }).inputValue(), "Service detail revised")
    assert.equal(new URL(page.url()).searchParams.get("dashboard"), "service-detail")
    await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
    await page.getByRole("heading", { name: "Service detail revised", exact: true }).waitFor()
    const saved = await get("service-detail")
    assert.equal(saved.customTimeRange, undefined)
    assert.equal(saved.variables[0].defaultValue, "default")
  })
  await check("Gamma dropdowns support keyboard selection and stay inside a narrow viewport", async () => {
    await page.getByRole("button", { name: "Fleet health", exact: true }).click()
    await page.getByRole("heading", { name: "Fleet health", exact: true }).waitFor()
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit Service health", exact: true }).click()
    await editor().getByRole("tab", { name: "Links", exact: true }).click()
    const destination = editor().getByRole("combobox", { name: "Link 1 destination", exact: true })
    await destination.click()
    await page.getByRole("combobox", { name: "Search link 1 destination", exact: true }).fill("revised")
    await page.keyboard.press("Enter")
    assert.equal(await destination.getAttribute("aria-expanded"), "false")
    assert.equal(await destination.evaluate(element => element === document.activeElement), true)
    await page.setViewportSize({ width: 320, height: 740 })
    await destination.click()
    const panel = page.locator('[data-gamma-portal="select"]')
    await panel.waitFor()
    const bounds = await panel.boundingBox()
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 320)
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 740)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.screenshot({ path: join(output, "gamma-drilldown-mobile.png"), fullPage: true })
    await page.keyboard.press("Escape")
    assert.equal(await destination.evaluate(element => element === document.activeElement), true)
    assert.equal(await page.locator("select").count(), 0)
    return { viewport: 320, portaledOptions: true, keyboardFocusRestored: true }
  })
  assert.deepEqual(errors, [])
} catch (error) { console.error(error); process.exitCode = 1 }
finally {
  await writeFile(join(output, "drilldown-e2e.json"), JSON.stringify({ reports, pageErrors: errors }, null, 2))
  await browser?.close(); await stop(service)
  await new Promise(resolve => provider.close(resolve)); await rm(temporary, { recursive: true, force: true })
}
