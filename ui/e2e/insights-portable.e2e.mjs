// Portable bundles cross two independent, real Go services. The local gateway
// injects acknowledgement loss and write failures, never application responses.
import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { parse as parseYAML, stringify as stringifyYAML } from "yaml"
import { selectGammaOption } from "./gamma-controls.mjs"
import { portableEnvironment, until } from "./insights-portable-fixture.mjs"

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const output = join(repository, "artifacts/insights/portable")
const reports = [], screenshots = [], pageErrors = [], controlMetrics = []
const serviceLiteral = 'checkout"blue\\west\n{{literal}}'
const observedLiteral = 'api"blue\\west\n{{literal}}'
const range = { from: "2026-10-20T12:00:00.000Z", to: "2026-10-20T13:00:00.000Z" }
let environment, browser, context, page, destination, source, scenario = 0, downloads

const metricQuery = {
  schemaVersion: 1, id: "shared-metric", name: "Shared portable metric", description: "One definition used by a widget and its tooltip", providerId: "source-metrics", kind: "metrics",
  query: "portable_main{service={{service}}}@{{at}} > {{minimum}}",
  parameters: [{ name: "service", label: "Service", type: "string", defaultValue: "api" }, { name: "at", label: "At", type: "number", defaultValue: 1792497600 }, { name: "minimum", label: "Minimum", type: "number", defaultValue: -7.25 }],
}
const traceQuery = { schemaVersion: 1, id: "shared-trace", name: "Portable trace", providerId: "source-traces", kind: "traces", query: "{ resource.service.name = {{service}} }", parameters: [{ name: "service", type: "string", defaultValue: serviceLiteral }] }
const unusedQuery = { ...metricQuery, id: "unused-metric", name: "Unreferenced private query", query: "up", parameters: [] }
const metricDashboard = {
  schemaVersion: 1, id: "portable-metrics", title: "Portable signals", folder: "Portable/Services", description: "Preserve live query references and typed values", timeRange: "1h", customTimeRange: range, refreshInterval: 0,
  variables: [{ name: "selected_service", label: "Selected service", defaultValue: serviceLiteral }, { name: "threshold", label: "Threshold", defaultValue: "-7.25" }],
  widgets: [{ id: "portable-host", title: "Portable health", type: "heatmap", providerId: "dormant-custom-source", query: "dormant_custom_query", unit: "%", layout: { x: 0, y: 0, w: 12, h: 5 },
    queryRef: { id: metricQuery.id, bindings: [{ parameter: "service", source: "variable", variable: "selected_service" }, { parameter: "at", source: "constant", value: 1792501199.75 }, { parameter: "minimum", source: "variable", variable: "threshold" }] },
    options: { tooltipView: { type: "stat", height: 200, title: "Context from shared query", source: { type: "saved", ref: { id: metricQuery.id, bindings: [{ parameter: "service", source: "label", label: "service" }, { parameter: "at", source: "field", field: "timestamp" }, { parameter: "minimum", source: "field", field: "value" }] } } } },
  }],
}
const traceDashboard = { schemaVersion: 1, id: "portable-traces", title: "Portable traces", timeRange: "1h", customTimeRange: range, refreshInterval: 0, widgets: [{ id: "trace-host", title: "Portable trace operations", type: "traces", providerId: "dormant-traces", query: "dormant_trace_query", unit: "ms", layout: { x: 0, y: 0, w: 12, h: 5 }, queryRef: { id: traceQuery.id } }] }
const bundle = { kind: "PaprikaDashboardLibrary", schemaVersion: 1, dashboards: [metricDashboard, traceDashboard], savedQueries: [metricQuery, traceQuery] }
const welcome = { schemaVersion: 1, id: "welcome", title: "Destination workspace", timeRange: "1h", refreshInterval: 0, widgets: [] }
const manager = () => page.getByRole("region", { name: "Manage dashboards", exact: true })
const editor = () => page.getByRole("region", { name: "Dashboard source editor", exact: true })
const importer = () => page.getByRole("region", { name: "Portable dashboard import", exact: true })
const tooltip = () => page.getByRole("tooltip")
function cleanQuery(entry) { const document = { ...entry }; delete document.etag; return document }
function remapped(query, fixture = destination) { return { ...query, providerId: query.kind === "metrics" ? fixture.ids.metrics : fixture.ids.traces } }
function canonical(value) { return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item) }
async function frames() { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))) }
async function screenshot(name) { await frames(); const path = join(output, name); await page.screenshot({ path }); screenshots.push(path) }
async function contained(locator) {
  const box = await locator.evaluate(element => new Promise(resolve => {
    let previous; const start = performance.now()
    function measure() {
      const rect = element.getBoundingClientRect(), box = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      const stable = previous && Object.keys(box).every(key => Math.abs(previous[key] - box[key]) < .5)
      const inside = rect.left >= -1 && rect.top >= -1 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1
      if ((stable && inside) || performance.now() - start > 2000) resolve({ ...box, inside, stable: !!stable })
      else { previous = box; requestAnimationFrame(measure) }
    }
    requestAnimationFrame(measure)
  }))
  assert.ok(box.inside && box.stable, `Uncontained or unsettled control: ${JSON.stringify(box)}`)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "No document overflow")
  return box
}
async function open(fixture, dashboard, width = 1512) {
  await context?.close()
  context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1050 }, reducedMotion: "reduce", timezoneId: "UTC", ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  page = await context.newPage(); page.setDefaultTimeout(12_000)
  page.on("pageerror", error => pageErrors.push(error.message))
  page.on("dialog", dialog => { pageErrors.push(`Unexpected native ${dialog.type()}`); void dialog.dismiss() })
  await page.goto(`${fixture.gatewayURL}/dashboard/insights/?dashboard=${dashboard.id}`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor()
}
async function fresh(name, width = 1512) {
  await context?.close()
  context = undefined
  await destination?.close()
  destination = await environment.fixture(name)
  await destination.api(`dashboards/${welcome.id}`, "PUT", welcome, { "If-None-Match": "*" })
  await open(destination, welcome, width)
  return destination
}
async function library(fixture = destination) { return (await fixture.api("saved-queries")).document.queries }
async function dashboards(fixture = destination) { return (await fixture.api("dashboards")).document.dashboards }
async function savedDocument(id, fixture = destination) { return fixture.api(`saved-queries/${id}`) }
async function seedQuery(query, fixture = destination) { return fixture.api(`saved-queries/${query.id}`, "PUT", query, { "If-None-Match": "*" }) }
async function download(action, format) {
  const waiting = page.waitForEvent("download")
  await action()
  const result = await waiting
  const path = join(output, result.suggestedFilename())
  await result.saveAs(path)
  const text = await readFile(path, "utf8")
  return { text, document: format === "json" ? JSON.parse(text) : parseYAML(text), path }
}
function assertBundle(document, expectedDashboards, expectedQueries) {
  assert.equal(document.kind, "PaprikaDashboardLibrary")
  assert.equal(document.schemaVersion, 1)
  assert.deepEqual(document.dashboards.map(item => item.id).sort(), expectedDashboards.map(item => item.id).sort())
  assert.deepEqual(document.savedQueries.map(item => item.id).sort(), expectedQueries.map(item => item.id).sort())
  for (const query of document.savedQueries) assert.equal(canonical(query), canonical(expectedQueries.find(item => item.id === query.id)))
  assert.equal(JSON.stringify(document).includes('"etag"'), false)
  assert.equal(JSON.stringify(document).includes("Unreferenced private query"), false)
  assert.equal(JSON.stringify(document).includes("127.0.0.1"), false, "Exports contain definitions, never provider endpoints or credentials")
}
async function check(name, action) {
  scenario++; const started = Date.now()
  try { const evidence = await action(); reports.push({ name, passed: true, milliseconds: Date.now() - started, evidence }); console.log(`PASS ${name}`) }
  catch (error) { await screenshot(`failure-${scenario}.png`).catch(() => {}); reports.push({ name, passed: false, error: error.message, stack: error.stack }); throw error }
}

async function review(document, { format = "json", file, code = false } = {}) {
  let sourceDraft
  if (code) {
    await page.getByRole("button", { name: "Code", exact: true }).click()
    sourceDraft = await editor().getByRole("textbox", { name: "Dashboard source", exact: true }).inputValue()
    await editor().getByLabel("Import dashboard document", { exact: true }).setInputFiles(file)
    await importer().waitFor()
    await editor().getByRole("heading", { name: "Review dashboard import", exact: true }).waitFor()
    await until(() => editor().getByRole("heading", { name: "Review dashboard import", exact: true }).evaluate(element => document.activeElement === element), "Opening bundle review must focus its heading")
    await editor().getByRole("heading", { name: "Review dashboard import", exact: true }).scrollIntoViewIfNeeded()
    const back = await editor().getByRole("button", { name: "Back to source", exact: true }).boundingBox()
    const heading = await importer().getByRole("heading", { name: "Import dashboards", exact: true }).boundingBox()
    const gap = heading.y - back.y - back.height
    assert.ok(gap >= 16, `Code review section must be separated from Back to source (gap ${gap}px)`)
    controlMetrics.push({ name: "Code import hierarchy", width: page.viewportSize().width, gap, backHeight: back.height })
    await screenshot(`code-review-top-${page.viewportSize().width}.png`)
  } else {
    await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
    if (file) await importer().getByLabel("Choose dashboard bundle", { exact: true }).setInputFiles(file)
    else {
      await selectGammaOption(page, importer().getByRole("combobox", { name: "Library import format", exact: true }), format.toUpperCase())
      await importer().getByRole("textbox", { name: "Library import source", exact: true }).fill(format === "json" ? JSON.stringify(document) : stringifyYAML(document))
      await importer().getByRole("button", { name: "Review import", exact: true }).click()
    }
  }
  await importer().getByText(document.dashboards?.[0]?.title ?? document.title, { exact: true }).waitFor()
  assert.equal(await importer().getByRole("combobox", { name: "Connect dormant-custom-source", exact: true }).count(), 0, "Dormant custom provider is not an active import dependency")
  return sourceDraft
}
async function connectSources() {
  for (const [id, kind] of [["source-metrics", "metrics"], ["source-traces", "traces"]]) {
    const trigger = importer().getByRole("combobox", { name: `Connect ${id}`, exact: true })
    if (await trigger.count()) {
      await trigger.click()
      const list = page.locator(`[id=${JSON.stringify(await trigger.getAttribute("aria-controls"))}]`)
      await list.getByRole("option", { name: `${destination.name} ${kind}`, exact: true }).click()
      await list.waitFor({ state: "hidden" })
      // Mapping can reveal an identical query, whose Keep default removes the
      // incoming provider requirement and therefore its trigger.
      if (await trigger.count()) assert.equal(await trigger.getAttribute("aria-expanded"), "false")
    }
  }
}
async function importNow(count) {
  await importer().getByRole("button", { name: `Import ${count} as new`, exact: true }).click()
}
async function importedMessage(count) {
  await importer().getByRole("status").filter({ hasText: new RegExp(`^${count} dashboard decisions? completed\\.`) }).waitFor()
}
async function importedDocuments(expectedCount) {
  const documents = (await dashboards()).filter(item => item.id !== welcome.id)
  assert.equal(documents.length, expectedCount)
  return documents
}
function conditionalCreates() {
  const writes = destination.requests.filter(item => item.method === "PUT" && item.path.startsWith("/api/saved-queries/"))
  for (const write of writes) {
    assert.equal(write.headers["if-none-match"], "*", "These copy/keep scenarios must conditionally create new saved queries")
    assert.equal(write.headers["if-match"], undefined, "These copy/keep scenarios must not replace an existing saved query")
  }
  return writes
}
function verifiedDependenciesBeforeWrites() {
  for (const [index, request] of destination.requests.entries()) {
    if (request.method !== "PUT" || !request.path.startsWith("/api/dashboards/")) continue
    const references = new Set(request.document.widgets.flatMap(widget => [widget.queryRef?.id, widget.options?.tooltipView?.source?.type === "saved" ? widget.options.tooltipView.source.ref.id : undefined]).filter(Boolean))
    for (const id of references) assert.ok(destination.requests.slice(0, index).some(item => item.method === "GET" && item.path === `/api/saved-queries/${id}` && item.status === 200), `Dependency ${id} must be verified before dashboard ${request.document.id} is persisted`)
  }
}
async function assertImported(expectedQueries, count = 1) {
  const documents = await importedDocuments(count)
  const queries = await library()
  for (const expected of expectedQueries) assert.equal(canonical(cleanQuery(queries.find(item => item.id === expected.id))), canonical(expected))
  const metrics = documents.find(item => item.title === metricDashboard.title)
  if (metrics) {
    assert.notEqual(metrics.id, metricDashboard.id)
    assert.deepEqual(metrics.variables, metricDashboard.variables)
    assert.equal(metrics.widgets[0].queryRef.id, metrics.widgets[0].options.tooltipView.source.ref.id, "One shared definition must remain shared by top-level and tooltip refs")
    assert.equal(metrics.widgets[0].providerId, "dormant-custom-source")
    assert.equal(metrics.widgets[0].query, "dormant_custom_query")
  }
  conditionalCreates()
  verifiedDependenciesBeforeWrites()
  return documents
}
async function liveImported(document, width = 1512) {
  const before = environment.providerRequests.length
  await open(destination, document, width)
  const expected = `portable_main{service=${JSON.stringify(serviceLiteral)}}@1792501199.75 > -7.25`
  await until(() => environment.providerRequests.slice(before).some(item => item.path.startsWith(`/${destination.name}/`) && item.params.query === expected), "Imported widget must query the remapped real provider using exact escaped and typed literals")
  const tile = page.locator('[data-widget-id="portable-host"]')
  await tile.scrollIntoViewIfNeeded()
  const cell = tile.getByRole("group").getByRole("button").first()
  if (width < 600) await cell.tap(); else await cell.hover()
  await tooltip().locator('[data-tooltip-widget="stat"]').waitFor()
  const child = `portable_main{service=${JSON.stringify(observedLiteral)}}@1792501199.75 > 42`
  await until(() => environment.providerRequests.slice(before).some(item => item.path.startsWith(`/${destination.name}/`) && item.params.query === child), "Imported tooltip must resolve the shared saved definition with observation fields exactly once")
  await until(async () => await tooltip().locator('[data-tooltip-widget="stat"] [data-metric-value="42"]').count() > 0, "Imported tooltip must render the actual response")
  await contained(tooltip())
  await screenshot(`live-import-${width}.png`)
  return { expected, child }
}

try {
  await mkdir(output, { recursive: true })
  environment = await portableEnvironment(repository, baseURL)
  browser = await chromium.launch({ headless: true })
  source = await environment.fixture("source", { metrics: "source-metrics", traces: "source-traces" })
  for (const query of [metricQuery, traceQuery, unusedQuery]) await seedQuery(query, source)
  for (const document of bundle.dashboards) await source.api(`dashboards/${document.id}`, "PUT", document, { "If-None-Match": "*" })
  await check("Code exports an actual JSON file with one shared top-level/tooltip query and typed parameters", async () => {
    await open(source, metricDashboard)
    await page.getByRole("button", { name: "Dashboard as code", exact: true }).click()
    await editor().getByRole("button", { name: "JSON", exact: true }).click()
    const exported = await download(() => editor().getByRole("button", { name: "Export", exact: true }).click(), "json")
    assertBundle(exported.document, [metricDashboard], [metricQuery])
    assert.equal(exported.document.dashboards[0].widgets[0].queryRef.id, exported.document.dashboards[0].widgets[0].options.tooltipView.source.ref.id)
    assert.equal(exported.document.savedQueries[0].parameters[2].defaultValue, -7.25)
    assert.deepEqual(exported.document.dashboards[0].variables, metricDashboard.variables)
    downloads = { json: exported }
    await screenshot("code-export-1512.png")
    return { path: exported.path, queryCount: exported.document.savedQueries.length }
  })
  await check("Manage exports an actual YAML library with referenced Prometheus and Tempo queries only", async () => {
    await editor().getByRole("button", { name: "Close source editor", exact: true }).click()
    await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
    const exported = await download(() => manager().getByRole("button", { name: "YAML", exact: true }).click(), "yaml")
    assertBundle(exported.document, bundle.dashboards, [metricQuery, traceQuery])
    assert.equal(exported.document.savedQueries[1].kind, "traces")
    downloads.yaml = exported
    await manager().getByRole("heading", { name: "Export your library", exact: true }).scrollIntoViewIfNeeded()
    await screenshot("manage-export-1512.png")
    await context.close(); context = undefined
    await source.close()
    return { path: exported.path, queryCount: exported.document.savedQueries.length }
  })
  await check("A downloaded Code JSON bundle imports into a fresh service with one live shared definition", async () => {
    await fresh("json-destination")
    const original = await review(downloads.json.document, { file: downloads.json.path, code: true })
    await connectSources()
    await importer().getByRole("button", { name: "Import 1 as new", exact: true }).scrollIntoViewIfNeeded()
    await screenshot("code-import-review-1512.png")
    let release
    destination.faults.push({ mode: "hold", method: "PUT", path: /\/api\/saved-queries\//, remaining: 1, wait: () => new Promise(resolve => { release = resolve }) })
    await importNow(1)
    await until(() => !!release, "The real import write must reach the test gateway")
    try {
      assert.equal(await editor().getByRole("button", { name: "Back to source", exact: true }).isDisabled(), true)
      assert.equal(await editor().getByRole("button", { name: "Close source editor", exact: true }).isDisabled(), true)
      assert.equal(await importer().getByRole("combobox", { name: "Connect source-metrics", exact: true }).isDisabled(), true)
    } finally { release() }
    await importedMessage(1)
    await editor().getByRole("button", { name: "Back to source", exact: true }).click()
    await until(() => editor().getByRole("textbox", { name: "Dashboard source", exact: true }).evaluate(element => document.activeElement === element), "Back to source must focus the preserved source draft")
    assert.equal(await editor().getByRole("textbox", { name: "Dashboard source", exact: true }).inputValue(), original, "Bundle review/import must preserve the single-dashboard source draft")
    const [document] = await assertImported([remapped(metricQuery)])
    assert.equal((await library()).length, 1)
    await destination.restart()
    assert.equal((await library()).length, 1)
    const live = await liveImported(document)
    return { id: document.id, queryId: document.widgets[0].queryRef.id, live }
  })
  await check("A downloaded Manage YAML library imports on mobile with typed defaults and both provider kinds", async () => {
    await fresh("yaml-destination", 390)
    const draft = await review(downloads.json.document, { file: downloads.json.path, code: true })
    await editor().getByRole("button", { name: "Back to source", exact: true }).click()
    await until(() => editor().getByRole("textbox", { name: "Dashboard source", exact: true }).evaluate(element => document.activeElement === element), "Mobile Back to source must focus the preserved draft")
    assert.equal(await editor().getByRole("textbox", { name: "Dashboard source", exact: true }).inputValue(), draft)
    await editor().getByRole("button", { name: "Close source editor", exact: true }).click()
    await review(downloads.yaml.document, { file: downloads.yaml.path })
    await connectSources()
    await importer().getByRole("button", { name: "Import 2 as new", exact: true }).scrollIntoViewIfNeeded()
    await screenshot("manage-import-review-390.png")
    await importNow(2); await importedMessage(2)
    const documents = await assertImported([remapped(metricQuery), remapped(traceQuery)], 2)
    const live = await liveImported(documents.find(item => item.title === metricDashboard.title), 390)
    await open(destination, documents.find(item => item.title === traceDashboard.title), 390)
    const trace = page.getByRole("button", { name: "Inspect trace fedcba9876543210fedcba9876543210", exact: true })
    await trace.waitFor()
    assert.match(await trace.innerText(), /GET \/portable-import/)
    const expectedTrace = `{ resource.service.name = ${JSON.stringify(serviceLiteral)} }`
    assert.ok(environment.providerRequests.some(item => item.path.startsWith(`/${destination.name}/`) && item.params.q === expectedTrace))
    await screenshot("imported-traces-390.png")
    return { queryCount: (await library()).length, expectedTrace, live }
  })
  await check("Conflicting IDs and provider kinds copy the definition and rewrite every reference without overwriting destination data", async () => {
    await fresh("conflict-destination")
    const existing = { ...remapped(traceQuery), id: metricQuery.id, name: "Existing destination trace query", query: "{ true }", parameters: [] }
    const saved = await seedQuery(existing)
    await open(destination, welcome)
    await review(downloads.json.document); await connectSources()
    await importer().getByText("This ID belongs to a different query. Compare the definitions before choosing.", { exact: true }).waitFor()
    await screenshot("query-conflict-1512.png")
    await importNow(1); await importedMessage(1)
    const [document] = await importedDocuments(1), id = document.widgets[0].queryRef.id
    assert.notEqual(id, metricQuery.id)
    assert.equal(document.widgets[0].options.tooltipView.source.ref.id, id)
    assert.equal(canonical((await savedDocument(metricQuery.id)).document), canonical(existing))
    assert.equal((await savedDocument(metricQuery.id)).etag, saved.etag)
    assert.equal(canonical((await savedDocument(id)).document), canonical({ ...remapped(metricQuery), id }))
    assert.equal((await library()).length, 2)
    conditionalCreates()
    return { preserved: metricQuery.id, copied: id }
  })
  await check("An identical definition is reused by default, while an explicit copy creates an independent live reference", async () => {
    await fresh("reuse-destination", 390)
    const existing = remapped(metricQuery)
    const saved = await seedQuery(existing)
    await open(destination, welcome, 390)
    await review(downloads.json.document); await connectSources()
    const choice = importer().getByRole("combobox", { name: `Import query ${metricQuery.name}`, exact: true })
    assert.match(await choice.innerText(), /Keep existing/)
    await importNow(1); await importedMessage(1)
    assert.equal(conditionalCreates().length, 0, "Reusing an identical query must not write it")
    const [first] = await importedDocuments(1)
    assert.equal(first.widgets[0].queryRef.id, metricQuery.id)
    await open(destination, welcome, 390)
    await review(downloads.json.document); await connectSources()
    await selectGammaOption(page, importer().getByRole("combobox", { name: `Import query ${metricQuery.name}`, exact: true }), /^Create a copy/)
    await screenshot("query-copy-choice-390.png")
    await importNow(1); await importedMessage(1)
    const second = (await importedDocuments(2)).find(item => item.id !== first.id)
    assert.notEqual(second.widgets[0].queryRef.id, metricQuery.id)
    assert.equal(second.widgets[0].queryRef.id, second.widgets[0].options.tooltipView.source.ref.id)
    assert.equal((await savedDocument(metricQuery.id)).etag, saved.etag)
    assert.equal((await library()).length, 2)
    conditionalCreates()
    return { reusedId: metricQuery.id, copiedId: second.widgets[0].queryRef.id }
  })
  await check("A query created after review cannot be overwritten or silently reused", async () => {
    await fresh("create-race")
    await review(downloads.json.document); await connectSources()
    const concurrent = { ...remapped(metricQuery), query: "concurrent_query", parameters: [] }
    await seedQuery(concurrent)
    await importNow(1)
    await importer().getByRole("alert").filter({ hasText: /changed|review again|different definition/i }).waitFor()
    assert.equal((await importedDocuments(0)).length, 0)
    assert.equal(canonical((await savedDocument(metricQuery.id)).document), canonical(concurrent))
    conditionalCreates()
    await screenshot("create-race-1512.png")
    assert.equal(destination.requests.filter(item => item.method === "PUT" && item.path.startsWith("/api/dashboards/")).length, 0)
    await importer().getByRole("button", { name: "Refresh comparison", exact: true }).click()
    await importer().getByRole("status").filter({ hasText: /Comparison refreshed/ }).waitFor()
    await importer().getByText("This ID belongs to a different query. Compare the definitions before choosing.", { exact: true }).waitFor()
    await importNow(1); await importedMessage(1)
    const [recovered] = await importedDocuments(1)
    assert.notEqual(recovered.widgets[0].queryRef.id, metricQuery.id)
    assert.equal(canonical((await savedDocument(metricQuery.id)).document), canonical(concurrent))
    conditionalCreates()
    return { originalPreserved: true, recoveredCopyId: recovered.widgets[0].queryRef.id }
  })
  await check("An identical reuse candidate changed after review fails before importing any dashboard", async () => {
    await fresh("reuse-race")
    const saved = await seedQuery(remapped(metricQuery))
    await open(destination, welcome)
    await review(downloads.json.document); await connectSources()
    const concurrent = { ...remapped(metricQuery), query: `${metricQuery.query} + 1` }
    await destination.api(`saved-queries/${metricQuery.id}`, "PUT", concurrent, { "If-Match": saved.etag })
    await importNow(1)
    await importer().getByRole("alert").filter({ hasText: /changed|identical|review again/i }).waitFor()
    await importedDocuments(0)
    assert.equal(canonical((await savedDocument(metricQuery.id)).document), canonical(concurrent))
    assert.equal(conditionalCreates().length, 0)
    await screenshot("reuse-race-1512.png")
    return { verifiedBeforeDashboard: true }
  })
  await check("Partial query creation leaves no broken dashboard and retries the same query identities", async () => {
    await fresh("query-partial")
    await review(downloads.yaml.document); await connectSources()
    destination.faults.push({ mode: "before", method: "PUT", path: /\/api\/saved-queries\/shared-trace$/, remaining: 1 })
    await importNow(2)
    await importer().getByRole("alert").filter({ hasText: /interruption/ }).waitFor()
    await importedMessage(1)
    const [completed] = await importedDocuments(1)
    assert.equal(completed.title, metricDashboard.title, "Only a dashboard with successfully persisted dependencies may be imported")
    assert.equal(completed.widgets[0].queryRef.id, metricQuery.id)
    const first = await savedDocument(metricQuery.id)
    assert.equal((await library()).length, 1)
    assert.match(await importer().getByRole("combobox", { name: "Connect source-traces", exact: true }).innerText(), /query-partial traces/, "Retry retains the remaining dependency's provider mapping")
    assert.equal(await importer().getByRole("combobox", { name: "Connect source-metrics", exact: true }).count(), 0, "Completed dependencies should not require remapping again")
    await screenshot("partial-query-1512.png")
    await importNow(1); await importedMessage(2)
    await assertImported([remapped(metricQuery), remapped(traceQuery)], 2)
    assert.equal((await savedDocument(metricQuery.id)).etag, first.etag)
    assert.equal(destination.requests.filter(item => item.method === "PUT" && item.path === `/api/saved-queries/${metricQuery.id}`).length, 1, "A successfully created dependency must not be written again on retry")
    assert.equal((await library()).length, 2)
    return { ids: (await library()).map(item => item.id), preservedTag: first.etag }
  })
  await check("A lost query-write acknowledgement is recovered by exact GET without duplicate resources", async () => {
    await fresh("query-lost-ack", 390)
    await review(downloads.json.document); await connectSources()
    destination.faults.push({ mode: "after", method: "PUT", path: /\/api\/saved-queries\/shared-metric$/, remaining: 1 })
    await importNow(1); await importedMessage(1)
    await assertImported([remapped(metricQuery)])
    assert.equal((await library()).length, 1)
    const lost = destination.requests.find(item => item.acknowledgementLost)
    assert.equal(lost.path, `/api/saved-queries/${metricQuery.id}`)
    assert.ok(destination.requests.some(item => item.method === "GET" && item.path === lost.path && item.status === 200))
    assert.equal(conditionalCreates().length, 1)
    await screenshot("lost-query-ack-390.png")
    return { recoveredId: metricQuery.id }
  })
  await check("Unknown query-write outcome survives a failed confirmation and retry with stable references", async () => {
    await fresh("query-unknown")
    await review(downloads.json.document); await connectSources()
    destination.faults.push({ mode: "after", method: "PUT", path: /\/api\/saved-queries\/shared-metric$/, remaining: 1 })
    destination.faults.push({ mode: "before", method: "GET", path: /\/api\/saved-queries\/shared-metric$/, remaining: 1 })
    await importNow(1)
    await importer().getByRole("alert").waitFor()
    await importedDocuments(0)
    const persisted = await savedDocument(metricQuery.id)
    assert.equal((await library()).length, 1)
    await importNow(1); await importedMessage(1)
    const [document] = await assertImported([remapped(metricQuery)])
    assert.equal((await savedDocument(metricQuery.id)).etag, persisted.etag)
    assert.equal(document.widgets[0].queryRef.id, metricQuery.id)
    assert.equal((await library()).length, 1)
    return { recoveredId: document.id, queryId: metricQuery.id }
  })
  await check("A partial dashboard import retries only pending identities and preserves all shared query links", async () => {
    await fresh("dashboard-partial")
    await review(downloads.yaml.document); await connectSources()
    destination.faults.push({ mode: "before", method: "PUT", path: /\/api\/dashboards\//, match: request => request.document?.title === traceDashboard.title, remaining: 1 })
    await importNow(2)
    await importedMessage(1)
    await importer().getByRole("alert").filter({ hasText: /interruption/ }).waitFor()
    const [first] = await importedDocuments(1)
    const queryTags = (await library()).map(item => [item.id, item.etag])
    await screenshot("partial-dashboard-1512.png")
    await importNow(1); await importedMessage(2)
    const documents = await assertImported([remapped(metricQuery), remapped(traceQuery)], 2)
    assert.ok(documents.some(item => item.id === first.id))
    const attempts = destination.requests.filter(item => item.method === "PUT" && item.path.startsWith("/api/dashboards/") && item.document?.title === traceDashboard.title)
    assert.equal(attempts.length, 2)
    assert.equal(attempts[0].path, attempts[1].path, "Retries must keep the failed dashboard identity")
    assert.deepEqual((await library()).map(item => [item.id, item.etag]), queryTags)
    assert.equal(conditionalCreates().length, 2)
    return { firstId: first.id, retriedId: attempts[0].document.id }
  })
  await check("A persisted dashboard with a lost acknowledgement is confirmed on retry without a duplicate", async () => {
    await fresh("dashboard-unknown")
    await review(downloads.json.document); await connectSources()
    destination.faults.push({ mode: "after", method: "PUT", path: /\/api\/dashboards\//, remaining: 1 })
    destination.faults.push({ mode: "before", method: "GET", path: /\/api\/dashboards\/(?!welcome$)/, remaining: 1 })
    await importNow(1)
    await importer().getByRole("alert").waitFor()
    const [persisted] = await importedDocuments(1)
    await importNow(1); await importedMessage(1)
    const [confirmed] = await importedDocuments(1)
    assert.equal(confirmed.id, persisted.id)
    assert.equal((await library()).length, 1)
    conditionalCreates()
    return { recoveredId: confirmed.id }
  })
  await check("Legacy references resolve only against existing destination definitions, while incomplete bundles are rejected", async () => {
    await fresh("legacy-destination", 390)
    await seedQuery(remapped(metricQuery))
    await open(destination, welcome, 390)
    await review(metricDashboard)
    await importer().getByText(/Legacy document: saved query definitions are not included/).waitFor()
    await importNow(1); await importedMessage(1)
    assert.equal(conditionalCreates().length, 0)
    const [document] = await importedDocuments(1)
    assert.equal(document.widgets[0].queryRef.id, metricQuery.id)
    await fresh("missing-legacy-destination", 390)
    await review(metricDashboard)
    await importNow(1)
    await importer().getByRole("alert").filter({ hasText: /saved query|not found|unavailable/i }).waitFor()
    await importedDocuments(0)
    assert.equal((await library()).length, 0)
    await fresh("incomplete-destination", 390)
    await page.getByRole("button", { name: "Manage dashboards", exact: true }).click()
    await selectGammaOption(page, importer().getByRole("combobox", { name: "Library import format", exact: true }), "JSON")
    await importer().getByRole("textbox", { name: "Library import source", exact: true }).fill(JSON.stringify({ ...downloads.json.document, savedQueries: [] }))
    await importer().getByRole("button", { name: "Review import", exact: true }).click()
    await importer().getByRole("alert").waitFor()
    assert.equal(await importer().getByRole("button", { name: /^Import \d+ as new$/ }).count(), 0)
    await importedDocuments(0)
    assert.equal((await library()).length, 0)
    await screenshot("incomplete-bundle-390.png")
    await manager().getByRole("button", { name: "Close dashboard manager", exact: true }).click()
    await page.getByRole("button", { name: "Code", exact: true }).click()
    await editor().getByRole("button", { name: "JSON", exact: true }).click()
    const invalidSource = JSON.stringify({ ...downloads.json.document, savedQueries: [] })
    await editor().getByRole("textbox", { name: "Dashboard source", exact: true }).fill(invalidSource)
    await editor().getByRole("button", { name: "Validate document", exact: true }).click()
    await editor().getByRole("alert").filter({ hasText: /shared-metric.*missing from the bundle/ }).waitFor()
    assert.equal(await editor().getByRole("textbox", { name: "Dashboard source", exact: true }).inputValue(), invalidSource)
    await screenshot("incomplete-code-bundle-390.png")
    return { legacyReused: metricQuery.id, incompleteRejected: true }
  })
  await check("Provider remapping and identical-query choices remain usable at 320px with actual Gamma menus", async () => {
    await fresh("narrow-destination", 320)
    await seedQuery(remapped(metricQuery))
    await open(destination, welcome, 320)
    await review(downloads.json.document)
    const provider = importer().getByRole("combobox", { name: "Connect source-metrics", exact: true })
    await provider.click()
    const menu = page.getByRole("listbox")
    const providerMenu = await contained(menu)
    assert.equal(await menu.getByRole("option", { name: `${destination.name} traces`, exact: true }).count(), 0, "Provider remapping offers only compatible metrics providers")
    await screenshot("provider-menu-320.png")
    await menu.getByRole("option", { name: `${destination.name} metrics`, exact: true }).click()
    const choice = importer().getByRole("combobox", { name: `Import query ${metricQuery.name}`, exact: true })
    await choice.click()
    const queryMenu = await contained(page.getByRole("listbox"))
    await screenshot("query-choice-menu-320.png")
    await page.getByRole("option", { name: /^Keep existing/ }).click()
    await importer().getByRole("button", { name: "Import 1 as new", exact: true }).scrollIntoViewIfNeeded()
    await screenshot("import-review-320.png")
    const controls = await importer().getByRole("combobox").evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height).map(element => ({ label: element.getAttribute("aria-label"), height: element.getBoundingClientRect().height })))
    assert.ok(controls.every(item => item.height >= 44), `Phone controls: ${JSON.stringify(controls)}`)
    await importNow(1); await importedMessage(1)
    await importedDocuments(1)
    return { providerMenu, queryMenu, controls }
  })
  assert.deepEqual(pageErrors, [])
  console.log(`${reports.length} real-service portable import scenarios passed.`)
} finally {
  await writeFile(join(output, "report.json"), JSON.stringify({ buildId: process.env.INSIGHTS_BUILD_ID, baseURL, reports, pageErrors, screenshots, controlMetrics, providerRequests: environment?.providerRequests, serviceRequests: environment?.requestEvidence(), harness: "Independent source/destination Go processes with actual durable storage and Prometheus/Tempo adapters. Gateway faults simulate failed writes and lost acknowledgements. Chromium desktop/mobile emulation." }, null, 2)).catch(() => {})
  await context?.close()
  await browser?.close()
  await environment?.close()
}
