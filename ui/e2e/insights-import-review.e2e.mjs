// Real durable Go services, actual Prometheus requests, and explicit import choices.
// The fixture gateway injects only bounded write/acknowledgement faults.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { stringify as stringifyYAML } from "yaml"
import { selectGammaOption } from "./gamma-controls.mjs"
import { portableEnvironment, until } from "./insights-portable-fixture.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = join(repository, "artifacts/insights/import-review")
const reports = [], screenshots = [], metrics = [], pageErrors = []
const serviceLiteral = 'checkout"blue\\west\n{{literal}}'
const observedLiteral = 'api"blue\\west\n{{literal}}'
const welcome = { schemaVersion: 1, id: "welcome", title: "Import review workspace", timeRange: "1h", refreshInterval: 0, widgets: [] }
const incomingQuery = { schemaVersion: 1, id: "review-query", name: "Incoming service query", description: "Reviewed live definition", providerId: "origin-metrics", kind: "metrics", query: "portable_main{service={{service}}} > {{minimum}} + 1", parameters: [{ name: "service", type: "string", defaultValue: "api" }, { name: "minimum", type: "number", defaultValue: 0 }] }
const incomingBoard = {
  schemaVersion: 1, id: "review-board", title: "Incoming health", description: "", folder: "Imported/Health", timeRange: "1h", customTimeRange: { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }, refreshInterval: 0,
  variables: [{ name: "selected_service", label: "Service", defaultValue: serviceLiteral }],
  widgets: [{ id: "health", title: "Reviewed health", type: "heatmap", providerId: "dormant-source", query: "retained_custom_query", unit: "%", layout: { x: 0, y: 0, w: 12, h: 6 }, queryRef: { id: incomingQuery.id, bindings: [{ parameter: "service", source: "variable", variable: "selected_service" }, { parameter: "minimum", source: "constant", value: 0 }] }, options: { showLegend: false, decimals: 0, tooltipView: { type: "stat", title: "Shared tooltip query", height: 200, source: { type: "saved", ref: { id: incomingQuery.id, bindings: [{ parameter: "service", source: "label", label: "service" }, { parameter: "minimum", source: "field", field: "value" }] } } } } }],
}
const bundle = { kind: "PaprikaDashboardLibrary", schemaVersion: 1, dashboards: [incomingBoard], savedQueries: [incomingQuery] }
let environment, browser, context, page, destination, scenario = 0
const importer = () => page.getByRole("region", { name: "Portable dashboard import", exact: true })
const dashboardAction = (title = incomingBoard.title) => importer().getByRole("combobox", { name: `Import dashboard ${title}`, exact: true })
const queryAction = (name = incomingQuery.name) => importer().getByRole("combobox", { name: `Import query ${name}`, exact: true })
const clone = value => structuredClone(value)
function mappedQuery(query = incomingQuery) { return { ...query, providerId: destination.ids.metrics } }
function savedQuery() { return { ...mappedQuery(), name: "Saved service query", description: "Previous definition", query: "portable_main{service={{service}}} > {{minimum}}", parameters: [{ name: "service", type: "string", defaultValue: "api" }, { name: "minimum", type: "number", defaultValue: 5 }] } }
function savedBoard() {
  const document = clone(incomingBoard)
  document.title = "Saved health"; document.description = "Previous description"; document.folder = "Existing"
  document.widgets[0].options.showLegend = true; document.widgets[0].options.decimals = 2; document.widgets[0].layout.h = 5
  return document
}
function puts(path) { return destination.requests.filter(item => item.method === "PUT" && (!path || item.path === `/api/${path}`)) }
async function get(path) { return destination.api(path) }
async function seed(path, document) { return destination.api(path, "PUT", document, { "If-None-Match": "*" }) }
async function screenshot(name) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const path = join(output, name); await page.screenshot({ path }); screenshots.push(path)
}
async function contained(locator) {
  const box = await locator.evaluate(element => new Promise(resolve => {
    let previous; const started = performance.now()
    function measure() {
      const rect = element.getBoundingClientRect(), next = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      const stable = previous && Object.keys(next).every(key => Math.abs(next[key] - previous[key]) < .5)
      const inside = rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1
      if ((stable && inside) || performance.now() - started > 2000) resolve({ ...next, inside, stable: !!stable })
      else { previous = next; requestAnimationFrame(measure) }
    }
    requestAnimationFrame(measure)
  }))
  assert.ok(box.inside && box.stable, `Contained stable menu/tooltip: ${JSON.stringify(box)}`)
  return box
}
async function open(document = welcome, width = 1512) {
  await context?.close()
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1050 }, reducedMotion: "reduce", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  page = await context.newPage(); page.setDefaultTimeout(12_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("dialog", dialog => { pageErrors.push(`Unexpected native ${dialog.type()}`); void dialog.dismiss() })
  await page.goto(`${destination.gatewayURL}/dashboard/insights/?dashboard=${document.id}`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: document.title, exact: true }).waitFor()
}
async function fresh(name, width = 1512, { existing = true, external = false } = {}) {
  await context?.close(); context = undefined; await destination?.close()
  destination = await environment.fixture(name)
  await seed(`dashboards/${welcome.id}`, welcome)
  let query, board
  if (existing) {
    query = await seed(`saved-queries/${incomingQuery.id}`, savedQuery())
    board = await seed(`dashboards/${incomingBoard.id}`, savedBoard())
  }
  if (external) await seed("dashboards/outside", { ...savedBoard(), id: "outside", title: "Outside this import" })
  await open(welcome, width)
  return { query, board }
}
async function review(document = bundle, { format = "json", code = false } = {}) {
  if (code) {
    await page.getByRole("button", { name: "Code", exact: true }).click()
    const path = join(output, `incoming-${scenario}.${format}`)
    await writeFile(path, format === "json" ? JSON.stringify(document) : stringifyYAML(document))
    await page.getByRole("region", { name: "Dashboard source editor", exact: true }).getByLabel("Import dashboard document", { exact: true }).setInputFiles(path)
  } else {
    await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
    await selectGammaOption(page, importer().getByRole("combobox", { name: "Library import format", exact: true }), format.toUpperCase())
    await importer().getByRole("textbox", { name: "Library import source", exact: true }).fill(format === "json" ? JSON.stringify(document) : stringifyYAML(document))
    await importer().getByRole("button", { name: "Review import", exact: true }).click()
  }
  await dashboardAction(document.dashboards[0].title).waitFor()
  await until(async () => !await dashboardAction(document.dashboards[0].title).isDisabled(), "Authoritative dashboard comparison must finish loading")
}
async function connect() {
  const source = importer().getByRole("combobox", { name: "Connect origin-metrics", exact: true })
  if (await source.count()) await selectGammaOption(page, source, `${destination.name} metrics`)
}
async function chooseDashboard(action, title) { await selectGammaOption(page, dashboardAction(title), new RegExp(`^${action}(?:\\s|$)`)) }
async function chooseQuery(action, name) { await selectGammaOption(page, queryAction(name), new RegExp(`^${action}(?:\\s|$)`)) }
async function apply() { await importer().getByRole("button", { name: /^(Apply import choices|Import \d+ as new)$/ }).click() }
async function complete(count = 1) { await importer().getByRole("status").filter({ hasText: new RegExp(`^${count} dashboard decisions? completed\\.`) }).waitFor() }
async function refresh() {
  await importer().getByRole("button", { name: "Refresh comparison", exact: true }).click()
  await importer().getByRole("status").filter({ hasText: /^Comparison refreshed/ }).waitFor()
}
async function expand(name) {
  const button = importer().getByRole("button", { name: new RegExp(`^Compare changes for ${name}`) })
  await button.click(); assert.equal(await button.getAttribute("aria-expanded"), "true")
  return page.locator(`[id=${JSON.stringify(await button.getAttribute("aria-controls"))}]`)
}
async function disabledOption(trigger, name) {
  await trigger.click(); const option = page.getByRole("listbox").getByRole("option", { name: new RegExp(`^${name}(?:\\s|$)`) })
  assert.equal(await option.getAttribute("aria-disabled"), "true")
  await page.keyboard.press("Escape")
  assert.equal(await trigger.evaluate(element => document.activeElement === element), true)
}
async function live(document, expectedValue = 43) {
  const before = environment.providerRequests.length
  await open(document, page.viewportSize().width)
  const query = `portable_main{service=${JSON.stringify(serviceLiteral)}} > 0${expectedValue === 43 ? " + 1" : ""}`
  await until(() => environment.providerRequests.slice(before).some(item => item.path.startsWith(`/${destination.name}/`) && item.params.query === query), "The saved query must execute its exact current typed/escaped definition")
  const cell = page.locator('[data-widget-id="health"]').getByRole("group").getByRole("button").first()
  await cell.scrollIntoViewIfNeeded()
  if (page.viewportSize().width < 600) await cell.tap(); else await cell.hover()
  const tip = page.getByRole("tooltip"), child = tip.locator('[data-tooltip-widget="stat"]')
  await child.locator(`[data-metric-value="${expectedValue}"]`).waitFor()
  const tooltipQuery = `portable_main{service=${JSON.stringify(observedLiteral)}} > ${expectedValue}${expectedValue === 43 ? " + 1" : ""}`
  await until(() => environment.providerRequests.slice(before).some(item => item.path.startsWith(`/${destination.name}/`) && item.params.query === tooltipQuery), "Tooltip reference must use the same live replacement and quoted labels exactly once")
  await contained(tip); await screenshot(`live-${scenario}-${page.viewportSize().width}.png`)
  return { query, tooltipQuery }
}
async function check(name, run) {
  scenario++; const started = Date.now()
  try { const evidence = await run(); reports.push({ name, passed: true, milliseconds: Date.now() - started, evidence }); console.log(`PASS ${name}`) }
  catch (error) { await screenshot(`failure-${scenario}.png`).catch(() => {}); reports.push({ name, passed: false, error: error.message, stack: error.stack }); throw error }
}

try {
  await mkdir(output, { recursive: true }); environment = await portableEnvironment(repository, baseURL); browser = await chromium.launch({ headless: true })
  await check("Desktop Code JSON review shows typed changes and replaces shared query/dashboard IDs conditionally", async () => {
    const before = await fresh("replace-json", 1512, { external: true })
    await review(bundle, { code: true }); await connect()
    const dashboardDiff = await expand(incomingBoard.title)
    for (const path of ["description", "widgets[id=health].layout.h", "widgets[id=health].options.decimals", "widgets[id=health].options.showLegend"]) await dashboardDiff.getByText(path, { exact: true }).waitFor()
    assert.ok((await dashboardDiff.getByLabel("Incoming value", { exact: true }).allTextContents()).includes("false"))
    assert.ok((await dashboardDiff.getByLabel("Incoming value", { exact: true }).allTextContents()).includes("0"))
    await dashboardDiff.getByText("widgets[id=health].options.showLegend", { exact: true }).scrollIntoViewIfNeeded(); await screenshot("dashboard-diff-1512.png")
    const queryDiff = await expand(incomingQuery.name); await queryDiff.getByText("query", { exact: true }).waitFor()
    await queryDiff.getByText("parameters[name=minimum].defaultValue", { exact: true }).waitFor()
    await queryDiff.getByText("query", { exact: true }).scrollIntoViewIfNeeded(); await screenshot("query-diff-1512.png")
    await chooseDashboard("Replace existing"); await chooseQuery("Replace existing")
    const impact = importer().getByRole("note", { name: `Replacement impact for ${incomingQuery.name}`, exact: true })
    await impact.getByText("Outside this import", { exact: true }).waitFor(); await impact.scrollIntoViewIfNeeded(); await screenshot("replacement-impact-1512.png")
    await apply(); await complete()
    assert.deepEqual((await get(`dashboards/${incomingBoard.id}`)).document, incomingBoard)
    assert.deepEqual((await get(`saved-queries/${incomingQuery.id}`)).document, mappedQuery())
    assert.equal(puts(`dashboards/${incomingBoard.id}`)[0].headers["if-match"], before.board.etag)
    assert.equal(puts(`saved-queries/${incomingQuery.id}`)[0].headers["if-match"], before.query.etag)
    assert.equal((await get("dashboards")).document.dashboards.length, 3)
    const outside = (await get("dashboards/outside")).document
    assert.equal(outside.widgets[0].queryRef.id, incomingQuery.id); assert.equal(outside.widgets[0].options.tooltipView.source.ref.id, incomingQuery.id)
    await context.close(); context = undefined; await destination.restart()
    assert.deepEqual((await get(`saved-queries/${incomingQuery.id}`)).document, mappedQuery())
    await open(welcome); return live(incomingBoard)
  })
  await check("Mobile YAML Keep skips the incoming dashboard and all of its query/provider dependencies", async () => {
    const before = await fresh("keep-yaml", 390)
    await review(bundle, { format: "yaml" }); await chooseDashboard("Keep existing")
    assert.equal(await queryAction().count(), 0); assert.equal(await importer().getByRole("combobox", { name: "Connect origin-metrics", exact: true }).count(), 0)
    await dashboardAction().scrollIntoViewIfNeeded(); await screenshot("keep-dashboard-390.png")
    await apply(); await complete()
    assert.equal(puts().length, 0); assert.equal((await get(`dashboards/${incomingBoard.id}`)).etag, before.board.etag); assert.equal((await get(`saved-queries/${incomingQuery.id}`)).etag, before.query.etag)
    return { writes: 0, keptDashboard: incomingBoard.id }
  })
  await check("Keeping a different compatible saved query needs no incoming-provider mapping and rewrites no definition", async () => {
    const before = await fresh("keep-query")
    await review(); await chooseQuery("Keep existing")
    assert.equal(await importer().getByRole("combobox", { name: "Connect origin-metrics", exact: true }).count(), 0)
    await apply(); await complete()
    assert.equal(puts(`saved-queries/${incomingQuery.id}`).length, 0)
    const documents = (await get("dashboards")).document.dashboards
    const copy = documents.find(item => item.id !== incomingBoard.id && item.id !== welcome.id)
    assert.ok(copy); assert.equal(copy.widgets[0].queryRef.id, incomingQuery.id); assert.equal(copy.widgets[0].options.tooltipView.source.ref.id, incomingQuery.id)
    assert.equal((await get(`saved-queries/${incomingQuery.id}`)).etag, before.query.etag)
    return live(copy, 42)
  })
  await check("Mobile YAML Copy allocates new dashboard/query IDs and preserves the destination versions", async () => {
    const before = await fresh("copy-yaml", 390)
    const document = clone(bundle)
    document.dashboards[0].widgets[0].drilldowns = [{ id: "self", title: "Open this dashboard", dashboardId: incomingBoard.id, carryTimeRange: true }]
    await review(document, { format: "yaml" }); await connect(); await chooseQuery("Create a copy"); await chooseDashboard("Create a copy")
    await queryAction().scrollIntoViewIfNeeded(); await screenshot("copy-query-390.png")
    await apply(); await complete()
    const copy = (await get("dashboards")).document.dashboards.find(item => item.id !== welcome.id && item.id !== incomingBoard.id)
    assert.ok(copy); assert.notEqual(copy.widgets[0].queryRef.id, incomingQuery.id); assert.equal(copy.widgets[0].queryRef.id, copy.widgets[0].options.tooltipView.source.ref.id)
    assert.equal(copy.widgets[0].drilldowns[0].dashboardId, copy.id)
    assert.equal((await get(`dashboards/${incomingBoard.id}`)).etag, before.board.etag); assert.equal((await get(`saved-queries/${incomingQuery.id}`)).etag, before.query.etag)
    for (const write of puts()) { assert.equal(write.headers["if-none-match"], "*"); assert.equal(write.headers["if-match"], undefined) }
    return live(copy)
  })
  await check("Stale dashboard review aborts before query writes, refresh clears Replace, and both decisions can be reselected", async () => {
    const before = await fresh("stale-dashboard")
    const other = { ...savedBoard(), id: "second", title: "Saved second" }; const second = await seed("dashboards/second", other)
    const document = clone(bundle); document.dashboards.push({ ...clone(incomingBoard), id: "second", title: "Incoming second" })
    await open(); await review(document); await connect(); await chooseDashboard("Keep existing"); await chooseDashboard("Replace existing", "Incoming second"); await chooseQuery("Replace existing")
    await destination.api("dashboards/second", "PUT", { ...other, description: "Changed after review" }, { "If-Match": second.etag })
    await apply(); await importer().getByRole("alert").filter({ hasText: /changed after review/ }).waitFor()
    assert.equal(puts().length, 0); await screenshot("stale-dashboard-1512.png")
    await refresh(); assert.match(await dashboardAction("Incoming second").innerText(), /Keep existing/)
    // A Keep decision from an aborted preflight must not become an invisible receipt.
    await chooseDashboard("Replace existing"); await chooseDashboard("Replace existing", "Incoming second"); await chooseQuery("Replace existing")
    await apply(); await complete(2)
    assert.equal((await get(`dashboards/${incomingBoard.id}`)).document.title, incomingBoard.title); assert.equal((await get("dashboards/second")).document.title, "Incoming second")
    assert.equal(puts(`dashboards/${incomingBoard.id}`)[0].headers["if-match"], before.board.etag)
    return { bothReplacedAfterRefresh: true }
  })
  await check("Stale query review requires a fresh explicit Replace choice before any dashboard can persist", async () => {
    const before = await fresh("stale-query", 390)
    await review(); await connect(); await chooseDashboard("Replace existing"); await chooseQuery("Replace existing")
    const concurrent = { ...savedQuery(), name: "Concurrent saved version" }
    const changed = await destination.api(`saved-queries/${incomingQuery.id}`, "PUT", concurrent, { "If-Match": before.query.etag })
    await apply(); await importer().getByRole("alert").filter({ hasText: /changed after review/ }).waitFor()
    assert.equal(puts().length, 0); await screenshot("stale-query-390.png")
    await refresh(); assert.match(await dashboardAction().innerText(), /Keep existing/)
    await chooseDashboard("Replace existing"); assert.doesNotMatch(await queryAction().innerText(), /Replace existing/)
    await chooseQuery("Replace existing"); await apply(); await complete()
    assert.equal(puts(`saved-queries/${incomingQuery.id}`)[0].headers["if-match"], changed.etag)
    return { conditionalTagRefreshed: true }
  })
  await check("In-use parameter changes block replacement in the UI and service while Copy remains available", async () => {
    const before = await fresh("incompatible-query", 390, { external: true })
    const document = clone(bundle)
    document.savedQueries[0].parameters[0] = { name: "service", type: "number", defaultValue: 1 }
    document.dashboards[0].widgets[0].queryRef.bindings[0] = { parameter: "service", source: "constant", value: 1 }
    document.dashboards[0].widgets[0].options.tooltipView.source.ref.bindings[0] = { parameter: "service", source: "field", field: "value" }
    await review(document); await connect(); await disabledOption(queryAction(), "Replace existing")
    await importer().getByText(/Replace unavailable:.*changes from string to number/).waitFor(); await queryAction().scrollIntoViewIfNeeded(); await screenshot("in-use-replace-blocked-390.png")
    await destination.api(`saved-queries/${incomingQuery.id}`, "PUT", mappedQuery(document.savedQueries[0]), { "If-Match": before.query.etag }, 409)
    assert.equal((await get(`saved-queries/${incomingQuery.id}`)).etag, before.query.etag)
    await chooseQuery("Create a copy"); await apply(); await complete()
    const copy = (await get("dashboards")).document.dashboards.find(item => ![welcome.id, incomingBoard.id, "outside"].includes(item.id))
    assert.ok(copy); assert.notEqual(copy.widgets[0].queryRef.id, incomingQuery.id)
    return { blockedExistingContract: true, copiedQuery: copy.widgets[0].queryRef.id }
  })
  await check("Different provider/kind identities disable Replace and incompatible Keep without hiding Copy", async () => {
    await fresh("identity-conflict", 320, { existing: false })
    const existing = { schemaVersion: 1, id: incomingQuery.id, name: "Existing traces", providerId: destination.ids.traces, kind: "traces", query: "{ true }" }
    const before = await seed(`saved-queries/${incomingQuery.id}`, existing)
    await open(welcome, 320); await review(); await connect()
    await disabledOption(queryAction(), "Replace existing"); await disabledOption(queryAction(), "Keep existing")
    await importer().getByText(/Replace unavailable:.*data source and kind/).waitFor(); await screenshot("identity-conflict-320.png")
    await chooseQuery("Create a copy"); await apply(); await complete()
    assert.equal((await get(`saved-queries/${incomingQuery.id}`)).etag, before.etag)
    return { copied: (await get("saved-queries")).document.queries.length === 2 }
  })
  await check("Lost replacement acknowledgements recover exact saved revisions without creating duplicates", async () => {
    await fresh("replace-lost-ack")
    await review(); await connect(); await chooseDashboard("Replace existing"); await chooseQuery("Replace existing")
    destination.faults.push({ mode: "after", method: "PUT", path: /\/api\/saved-queries\/review-query$/, remaining: 1 }, { mode: "after", method: "PUT", path: /\/api\/dashboards\/review-board$/, remaining: 1 })
    await apply(); await complete()
    assert.deepEqual((await get(`saved-queries/${incomingQuery.id}`)).document, mappedQuery()); assert.deepEqual((await get(`dashboards/${incomingBoard.id}`)).document, incomingBoard)
    assert.equal((await get("saved-queries")).document.queries.length, 1); assert.equal((await get("dashboards")).document.dashboards.length, 2)
    assert.equal(destination.requests.filter(item => item.acknowledgementLost).length, 2); assert.equal(puts().length, 2)
    return { exactRecovery: true }
  })
  await check("Partial replacement retries the dashboard only and retains the successful query revision", async () => {
    const before = await fresh("replace-partial", 390)
    await review(); await connect(); await chooseDashboard("Replace existing"); await chooseQuery("Replace existing")
    destination.faults.push({ mode: "before", method: "PUT", path: /\/api\/dashboards\/review-board$/, remaining: 1 })
    await apply(); await importer().getByRole("alert").filter({ hasText: /interruption/ }).waitFor()
    const query = await get(`saved-queries/${incomingQuery.id}`); assert.notEqual(query.etag, before.query.etag); assert.equal((await get(`dashboards/${incomingBoard.id}`)).etag, before.board.etag)
    await screenshot("replacement-partial-390.png")
    await apply(); await complete()
    assert.equal(puts(`saved-queries/${incomingQuery.id}`).length, 1); assert.equal(puts(`dashboards/${incomingBoard.id}`).length, 2)
    assert.equal((await get(`saved-queries/${incomingQuery.id}`)).etag, query.etag)
    return { preservedQueryTag: query.etag }
  })
  await check("A concurrent edit after preflight makes the real conditional replacement fail without overwriting it", async () => {
    const before = await fresh("replace-cas")
    await review(); await connect(); await chooseDashboard("Replace existing"); await chooseQuery("Replace existing")
    let release
    destination.faults.push({ mode: "hold", method: "PUT", path: /\/api\/saved-queries\/review-query$/, remaining: 1, wait: () => new Promise(resolve => { release = resolve }) })
    await apply(); await until(() => !!release, "Conditional query write must reach the controlled gateway")
    const concurrent = { ...savedQuery(), name: "Concurrent write during import" }
    try {
      await destination.api(`saved-queries/${incomingQuery.id}`, "PUT", concurrent, { "If-Match": before.query.etag })
      assert.equal(await dashboardAction().isDisabled(), true); assert.equal(await queryAction().isDisabled(), true)
    } finally { release() }
    await importer().getByRole("alert").filter({ hasText: /changed|reload/ }).waitFor()
    assert.equal(puts(`saved-queries/${incomingQuery.id}`)[0].status, 412); assert.equal(puts(`dashboards/${incomingBoard.id}`).length, 0)
    assert.deepEqual((await get(`saved-queries/${incomingQuery.id}`)).document, concurrent)
    await screenshot("conditional-race-1512.png")
    return { serverRejectedStaleWrite: true }
  })
  await check("Narrow typed diffs distinguish null, false, zero and strings with keyboard-accessible Gamma actions", async () => {
    await fresh("typed-diff", 320)
    const previous = savedBoard(), next = clone(incomingBoard)
    const plugin = { id: "typed-config", title: "External plugin configuration", type: "plugin", pluginId: "external-review-fixture", dataKind: "metrics", providerId: destination.ids.metrics, query: "up", unit: "", layout: { x: 0, y: 6, w: 12, h: 4 }, config: { enabled: true, amount: 1, nullable: "before", text: 0 } }
    previous.widgets.push(plugin); next.widgets.push({ ...clone(plugin), config: { enabled: false, amount: 0, nullable: null, text: "0" } })
    const saved = await get(`dashboards/${incomingBoard.id}`); await destination.api(`dashboards/${incomingBoard.id}`, "PUT", previous, { "If-Match": saved.etag })
    await open(welcome, 320); await review({ ...bundle, dashboards: [next] }); await connect()
    await dashboardAction().click(); const menu = await contained(page.getByRole("listbox")); await screenshot("dashboard-action-menu-320.png")
    await page.keyboard.press("Escape"); assert.equal(await dashboardAction().evaluate(element => document.activeElement === element), true)
    await queryAction().click(); await contained(page.getByRole("listbox")); await screenshot("query-action-menu-320.png"); await page.keyboard.press("Escape")
    const disclosure = importer().getByRole("button", { name: new RegExp(`^Compare changes for ${incomingBoard.title}`) })
    await disclosure.focus(); await page.keyboard.press("Enter"); assert.equal(await disclosure.getAttribute("aria-expanded"), "true")
    const diff = page.locator(`[id=${JSON.stringify(await disclosure.getAttribute("aria-controls"))}]`)
    for (const [key, value] of [["enabled", "false"], ["amount", "0"], ["nullable", "null"], ["text", '"0"']]) {
      const path = `widgets[id=typed-config].config.${key}`
      const row = diff.getByRole("listitem").filter({ has: page.getByText(path, { exact: true }) })
      assert.equal(await row.getByLabel("Incoming value", { exact: true }).innerText(), value)
      await row.scrollIntoViewIfNeeded()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      await screenshot(`typed-${key}-320.png`)
    }
    const controls = await importer().getByRole("combobox").evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height).map(element => ({ label: element.getAttribute("aria-label"), height: element.getBoundingClientRect().height, width: element.getBoundingClientRect().width })))
    assert.ok(controls.every(item => item.height >= 44), JSON.stringify(controls)); metrics.push({ viewport: 320, controls, menu })
    assert.equal(puts().length, 0, "Expanding review details must never write resources")
    return { typedValues: [null, false, 0, "0"], controls }
  })
  assert.deepEqual(pageErrors, [])
  console.log(`${reports.length} real-service import review scenarios passed.`)
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ buildId: process.env.INSIGHTS_BUILD_ID, baseURL, reports, pageErrors, screenshots, metrics, providerRequests: environment?.providerRequests, serviceRequests: environment?.requestEvidence(), harness: "Actual Go service and durable store, real Prometheus/Tempo adapters, test-only local static/API gateway with explicit write faults. Chromium desktop/mobile emulation; no physical device claim." }, null, 2)).catch(() => {})
  await context?.close(); await browser?.close(); await environment?.close()
}
