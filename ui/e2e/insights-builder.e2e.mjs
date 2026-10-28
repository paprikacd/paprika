import { routeAnonymousAuthConfiguration } from "./anonymous-auth-fixture.mjs"
import { queryEditorGeometry, queryEditorValue } from "./query-editor.mjs"
// Builder surface review. Deterministic normalized API fixtures isolate authored
// controls; insights-live.e2e.mjs exercises the real Go provider lifecycle.
import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { selectGammaOption } from "./gamma-controls.mjs"

const baseURL = process.env.INSIGHTS_E2E_URL || "http://127.0.0.1:3015"
const baseline = process.argv.includes("--baseline")
const output = resolve(fileURLToPath(new URL("../../", import.meta.url)), "artifacts/insights/builder")
const phase = baseline ? "baseline" : "final"
const reports = [], pageErrors = [], screenshots = []
const browser = await chromium.launch({ headless: true })
const providers = [{ id: "metrics", name: "Production metrics", type: "prometheus", capabilities: ["metrics"], managed: false }]
const stamp = Date.parse("2026-10-20T12:30:00.000Z")
const dashboard = { schemaVersion: 1, id: "builder-audit", title: "Production overview", timeRange: "1h", refreshInterval: 0, widgets: [
  { id: "traffic", title: "Request traffic", type: "timeseries", providerId: "metrics", query: "http_requests_total", unit: "req/s", layout: { x: 0, y: 0, w: 8, h: 5 } },
  { id: "health", title: "Service health", type: "heatmap", providerId: "metrics", query: "service_health", unit: "%", layout: { x: 8, y: 0, w: 4, h: 5 } },
] }
const data = { series: ["api-east", "worker-west"].map((name, index) => ({ name, labels: { service: name, region: "eu-central-1" }, points: Array.from({ length: 61 }, (_, point) => ({ timestamp: stamp - (60 - point) * 60000, value: point === 30 ? null : 60 + Math.sin(point / 6) * 20 - index * 20 })) })) }

async function open(width, configure = value => value, series = data) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 844 : 1050 }, reducedMotion: "reduce", deviceScaleFactor: 1, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) })
  const page = await context.newPage()
  page.setDefaultTimeout(10_000)
  const documents = new Map([[dashboard.id, configure(structuredClone(dashboard))]])
  let publicProviders = structuredClone(providers)
  const configs = [{ ...providers[0], url: "https://prometheus.example.internal", etag: '"provisioned"' }]
  const queries = [], calls = [], gates = { test: null }, faults = { query: false, test: false }
  page.on("pageerror", error => pageErrors.push({ width, message: error.message }))
  await routeAnonymousAuthConfiguration(page)
  await page.route("**/api/insights/**", async route => {
    const request = route.request(), url = new URL(request.url())
    calls.push({ method: request.method(), pathname: url.pathname })
    let body, status = 200
    if (url.pathname === "/api/insights/providers") body = { providers: publicProviders }
    else if (url.pathname === "/api/insights/provider-configs") body = { providers: configs }
    else if (url.pathname.startsWith("/api/insights/provider-configs/")) {
      const id = url.pathname.split("/").at(-1), index = configs.findIndex(item => item.id === id)
      if (request.method() === "DELETE") { if (index >= 0) configs.splice(index, 1); publicProviders = publicProviders.filter(item => item.id !== id); body = { deleted: true } }
      else { const item = { ...request.postDataJSON(), managed: true, etag: '"managed-1"' }; if (index >= 0) configs[index] = item; else configs.push(item); publicProviders = [...publicProviders.filter(item => item.id !== id), { id, name: item.name, type: item.type, capabilities: [item.type === "tempo" ? "traces" : "metrics"], managed: true }]; body = item }
    }
    else if (url.pathname === "/api/insights/dashboards") body = { dashboards: [...documents.values()] }
    else if (url.pathname === "/api/insights/saved-queries") body = { queries: [] }
    else if (url.pathname.startsWith("/api/insights/dashboards/")) { const id = url.pathname.split("/").at(-1); if (request.method() === "PUT") documents.set(id, request.postDataJSON()); body = documents.get(id) }
    else if (url.pathname.endsWith("/metadata")) body = { values: url.searchParams.get("kind") === "metrics" ? ["http_requests_total", "service_health"] : ["service", "api-east", "worker-west"] }
    else if (url.pathname === "/api/insights/query") { queries.push(request.postDataJSON()); if (faults.query) { status = 502; body = { error: "Prometheus rejected this query. Correct the expression and retry." } } else body = series }
    else if (url.pathname.endsWith("/test")) { await gates.test; body = { ok: !faults.test, message: faults.test ? "The provider connection was refused." : "Provider connection succeeded.", durationMs: 12 } }
    else { status = 404; body = { error: "Unexpected builder audit request" } }
    await route.fulfill({ status, contentType: "application/json", headers: { ETag: '"builder-audit-1"' }, body: JSON.stringify(body) })
  })
  await page.goto(`${baseURL}/dashboard/insights/?dashboard=builder-audit`, { waitUntil: "networkidle" })
  await page.getByRole("heading", { name: dashboard.title, exact: true }).waitFor()
  return { context, page, documents, queries, calls, gates, faults }
}
async function capture(page, name, locator, fullPage = true) {
  const path = resolve(output, `${phase}-${name}.png`)
  if (locator) { await locator.scrollIntoViewIfNeeded(); await locator.screenshot({ path, scale: "css", animations: "disabled" }) }
  else await page.screenshot({ path, fullPage, scale: "css", animations: "disabled" })
  screenshots.push(path)
}
async function metrics(locator) {
  return locator.evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0).map(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect()
    return { text: (element.getAttribute("aria-label") || element.textContent).trim().slice(0, 100), tag: element.tagName, role: element.getAttribute("role"), width: box.width, height: box.height, padding: style.padding, paddingLeft: parseFloat(style.paddingLeft), paddingRight: parseFloat(style.paddingRight), gap: style.gap, minWidth: style.minWidth, minHeight: style.minHeight, fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color, background: style.backgroundColor, outline: style.outline, boxShadow: style.boxShadow, disabled: element.matches(":disabled"), opacity: style.opacity, iconWithText: !!element.querySelector("svg") && !!element.textContent.trim() }
  }))
}
async function switches(panel) {
  return panel.getByRole("switch").evaluateAll(inputs => inputs.map(input => {
    const row = input.closest("label"), track = input.nextElementSibling, thumb = track.firstElementChild
    const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
    return { label: row.innerText.trim(), checked: input.checked, row: rect(row), track: rect(track), thumb: rect(thumb), trackStyle: { padding: getComputedStyle(track).padding, boxSizing: getComputedStyle(track).boxSizing, flexShrink: getComputedStyle(track).flexShrink, outline: getComputedStyle(track).outline }, thumbStyle: { transform: getComputedStyle(thumb).transform, width: getComputedStyle(thumb).width, height: getComputedStyle(thumb).height } }
  }))
}
async function textContrast(panel) {
  return panel.locator("h1,h2,h3,p,label,summary,button,small,strong,legend,code,input,textarea,[contenteditable=true]").evaluateAll(elements => {
    const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1
    const context = canvas.getContext("2d", { willReadFrequently: true })
    const rgb = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data] }
    const luminance = color => color.slice(0, 3).map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
    return elements.filter(element => element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0 && !element.matches(":disabled") && !element.closest("fieldset[disabled]") && (element.textContent.trim() || element.value || element.placeholder)).map(element => {
      const style = getComputedStyle(element), ancestors = []
      for (let parent = element; parent; parent = parent.parentElement) ancestors.push(getComputedStyle(parent))
      let background = [255, 255, 255]
      for (const ancestor of [...ancestors].reverse()) { const color = rgb(ancestor.backgroundColor), alpha = color[3] / 255; background = background.map((value, index) => color[index] * alpha + value * (1 - alpha)) }
      const placeholder = "value" in element && !element.value && element.placeholder
      const color = rgb(placeholder ? getComputedStyle(element, "::placeholder").color : style.color), opacity = color[3] / 255 * ancestors.reduce((value, ancestor) => value * Number(ancestor.opacity), 1)
      const foreground = background.map((value, index) => color[index] * opacity + value * (1 - opacity))
      const a = luminance(foreground), b = luminance(background), font = parseFloat(style.fontSize)
      return { text: (placeholder || element.value || element.textContent).trim().slice(0, 80), foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05), minimum: font >= 24 || (font >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5 }
    })
  })
}
async function surfaceAudit(width) {
  const { page, context } = await open(width)
  const record = { name: "builder surface geometry and control states", width, measurements: {}, contrast: {}, popups: {} }
  try {
    await capture(page, `workspace-${width}`)
    const toolbar = page.getByRole("button", { name: "Manage dashboards", exact: true }).locator("..")
    await capture(page, `toolbar-${width}`, toolbar)
    record.measurements.toolbar = await metrics(toolbar.getByRole("button"))
    record.contrast.toolbar = await textContrast(toolbar)
    const edit = page.getByRole("button", { name: "Edit dashboard", exact: true })
    await edit.hover(); record.measurements.toolbarHover = await metrics(edit)
    await edit.focus(); await page.keyboard.press("Shift+Tab"); await page.keyboard.press("Tab")
    record.measurements.toolbarFocus = await metrics(edit)
    await capture(page, `toolbar-focus-${width}`, toolbar)
    await page.getByRole("button", { name: "Edit dashboard", exact: true }).click()
    await page.getByRole("button", { name: "Edit Request traffic", exact: true }).click()
    const editor = page.getByRole("region", { name: "Widget editor", exact: true })
    await capture(page, `query-editor-${width}`, editor)
    record.measurements.queryControls = await metrics(editor.locator("button,input,textarea,[contenteditable=true]"))
    record.contrast.query = await textContrast(editor)
    await editor.getByText("Guided query builder", { exact: true }).click()
    await capture(page, `query-builder-${width}`, editor)
    const metric = editor.getByRole("combobox", { name: "Metric", exact: true })
    await metric.scrollIntoViewIfNeeded()
    await metric.fill("http")
    await page.getByRole("listbox").waitFor()
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    const input = await metric.boundingBox(), anchor = await metric.locator("..").boundingBox()
    const popup = await inViewport(page, page.locator('[data-gamma-portal="combobox"]'))
    const gap = Math.min(Math.abs(popup.y - anchor.y - anchor.height), Math.abs(anchor.y - popup.y - popup.height))
    record.popups.metric = { input, anchor, popup, gap }
    await capture(page, `query-metric-viewport-${width}`, undefined, false)
    assert.ok(gap <= 12, `Metric popup is detached from its field by ${gap}px`)
    await capture(page, `query-metric-open-${width}`)
    await page.keyboard.press("Escape")
    await editor.getByRole("tab", { name: "Style", exact: true }).click()
    await capture(page, `style-editor-${width}`, editor)
    record.measurements.switchesChecked = await switches(editor)
    const toggle = editor.getByRole("switch", { name: "Show legend", exact: true })
    await capture(page, `switch-checked-${width}`, toggle.locator(".."))
    const track = toggle.locator("+ span"), box = await track.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down()
    record.measurements.switchesPressed = await switches(editor)
    await capture(page, `switch-pressed-${width}`, toggle.locator(".."))
    await page.mouse.up()
    await toggle.uncheck()
    record.measurements.switchesUnchecked = await switches(editor)
    await capture(page, `switch-unchecked-${width}`, toggle.locator(".."))
    await toggle.focus()
    await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab")
    await capture(page, `switch-focused-${width}`, toggle.locator(".."))
    record.measurements.switchFocus = await switches(editor)
    await editor.getByRole("button", { name: "Close widget editor", exact: true }).click()
    for (const [opener, region, close, name] of [
      ["Manage dashboards", "Manage dashboards", "Close dashboard manager", "manage"],
      ["Code", "Dashboard source editor", "Close source editor", "code"],
      ["Build with AI", "Build with AI", "Close AI builder", "ai"],
    ]) {
      await page.getByRole("button", { name: opener, exact: true }).click()
      const panel = page.getByRole("region", { name: region, exact: true })
      await capture(page, `${name}-${width}`, panel)
      record.measurements[name] = await metrics(panel.locator("button,input,textarea,[contenteditable=true]"))
      record.contrast[name] = await textContrast(panel)
      if (!baseline && name === "ai") assert.ok((await panel.getByRole("textbox", { name: "AI-generated definition", exact: true }).boundingBox()).height >= 160)
      if (!baseline && name === "code") assert.ok(parseFloat(await panel.getByRole("textbox", { name: "Dashboard source", exact: true }).evaluate(element => getComputedStyle(element).fontSize)) >= 12)
      await panel.getByRole("button", { name: close, exact: true }).click()
    }
    const sources = page.getByRole("button", { name: /^Data sources/ })
    if (!(await sources.isVisible())) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    await sources.click()
    const panel = page.getByRole("region", { name: "Data sources", exact: true })
    await capture(page, `providers-${width}`, panel)
    await panel.getByRole("button", { name: "Add data source", exact: true }).click()
    await capture(page, `provider-form-${width}`, panel)
    record.measurements.providers = await metrics(panel.locator("button,input,textarea,[contenteditable=true]"))
    record.contrast.providers = await textContrast(panel)
    const type = panel.getByRole("combobox", { name: "Provider type", exact: true })
    await type.click(); await page.getByRole("listbox").waitFor()
    await capture(page, `provider-type-open-${width}`)
    await page.keyboard.press("Escape")
    await selectGammaOption(page, type, /^Tempo/)
    assert.equal(await type.evaluate(element => document.activeElement === element), true)
    record.pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    if (!baseline) {
      assert.ok(record.pageOverflow <= 1)
      assert.match(record.measurements.toolbarFocus[0].outline, /solid 2px/)
      for (const [surface, samples] of Object.entries(record.contrast)) for (const sample of samples) assert.ok(sample.ratio >= sample.minimum, `${surface} low text contrast: ${JSON.stringify(sample)}`)
      for (const [state, samples] of Object.entries(record.measurements)) {
        if (state.startsWith("switch")) {
          for (const { label, row, track, thumb } of samples) {
            assert.ok(thumb.x >= track.x - 0.5 && thumb.y >= track.y - 0.5 && thumb.x + thumb.width <= track.x + track.width + 0.5 && thumb.y + thumb.height <= track.y + track.height + 0.5, `${state} ${label}: switch thumb escapes its track`)
            if (width < 600) assert.ok(row.height >= 44, `${label} touch target is only ${row.height}px`)
          }
        } else for (const sample of samples) {
          if (sample.iconWithText && sample.role !== "combobox") assert.ok(sample.paddingLeft >= 10 && sample.paddingRight >= 10, `${sample.text}: icon+text button lost its padding`)
          if (width < 600 && sample.tag === "BUTTON") assert.ok(sample.width >= 44 && sample.height >= 44, `${sample.text}: ${sample.width}×${sample.height}px touch target`)
        }
      }
    }
    record.passed = true
  } catch (error) {
    record.passed = false; record.error = error.message
    await capture(page, `failure-${width}`).catch(() => {})
  } finally {
    reports.push(record)
    console.log(`${record.passed ? "PASS" : "FAIL"} ${phase} builder surfaces ${width}px${record.error ? `: ${record.error}` : ""}`)
    await context.close()
  }
}
async function check(name, width, run, configure, series) {
  const state = await open(width, configure, series)
  try { const evidence = await run(state); reports.push({ name, width, passed: true, evidence }); console.log(`PASS ${name} ${width}px`) }
  catch (error) { reports.push({ name, width, passed: false, error: error.message }); console.error(`FAIL ${name} ${width}px: ${error.message}`); await capture(state.page, `failure-${reports.length}-${width}`).catch(() => {}) }
  finally { await state.context.close() }
}
async function widgetEditor(page, title) {
  const edit = page.getByRole("button", { name: "Edit dashboard", exact: true })
  if (await edit.isVisible()) await edit.click()
  await page.getByRole("button", { name: `Edit ${title}`, exact: true }).click()
  const panel = page.getByRole("region", { name: "Widget editor", exact: true }); await panel.waitFor(); return panel
}
async function save(page) {
  await page.getByRole("button", { name: "Save dashboard", exact: true }).click()
  await page.getByText("All changes saved", { exact: true }).waitFor()
}
async function inViewport(page, locator) {
  const rect = await locator.boundingBox(), viewport = page.viewportSize()
  assert.ok(rect && rect.x >= -1 && rect.y >= -1 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1, `Overlay escapes viewport: ${JSON.stringify(rect)}`)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth <= 1))
  return rect
}
async function chooseDiscovered(page, panel, label, value) {
  await panel.getByRole("combobox", { name: label, exact: true }).fill(value)
  const option = page.getByRole("option", { name: value, exact: true }); await option.waitFor()
  await inViewport(page, page.getByRole("listbox")); await option.click()
}
async function queryAudit(width) {
  await check("guided query live preview, error recovery and explicit dashboard Save", width, async ({ page, queries, documents, faults }) => {
    const panel = await widgetEditor(page, "Request traffic")
    const raw = panel.getByRole("textbox", { name: /^PromQL query/ })
    const before = queries.length
    faults.query = true
    await panel.getByText("Guided query builder", { exact: true }).click()
    await chooseDiscovered(page, panel, "Metric", "http_requests_total")
    await panel.getByRole("button", { name: "Add label filter", exact: true }).click()
    await chooseDiscovered(page, panel, "Filter 1 label", "service")
    await chooseDiscovered(page, panel, "Filter 1 value", "api-east")
    await selectGammaOption(page, panel.getByRole("combobox", { name: "Function", exact: true }), "Rate per second")
    await panel.getByLabel("Rate window", { exact: true }).fill("5m")
    await selectGammaOption(page, panel.getByRole("combobox", { name: "Aggregation", exact: true }), "sum")
    await panel.getByLabel("Group by labels", { exact: true }).fill("service")
    const generated = 'sum by (service) (rate(http_requests_total{service="api-east"}[5m]))'
    assert.equal(await queryEditorValue(raw), generated)
    assert.ok(await raw.isVisible(), "PromQL editing surface must remain visible")
    assert.ok((await queryEditorGeometry(raw)).height >= 96, "PromQL editor needs a readable multiline working area")
    assert.equal(await raw.evaluate(element => getComputedStyle(element).resize), "none")
    faults.query = true
    await panel.getByRole("button", { name: "Run query", exact: true }).click()
    await panel.getByRole("alert").filter({ hasText: /Prometheus rejected/ }).waitFor()
    assert.equal(documents.get(dashboard.id).widgets[0].query, "http_requests_total")
    assert.equal(await queryEditorValue(raw), generated)
    await capture(page, `query-error-${width}`, panel)
    faults.query = false
    await panel.getByRole("button", { name: "Run query", exact: true }).click()
    await panel.getByLabel("Query preview", { exact: true }).waitFor()
    assert.ok(queries.some(item => item.query === generated))
    await capture(page, `query-preview-${width}`, panel)
    await panel.getByRole("button", { name: "Close widget editor", exact: true }).click()
    await save(page)
    assert.equal(documents.get(dashboard.id).widgets[0].query, generated)
    return { generated, livePreviewRequests: queries.length - before, errorRetainedDraft: true, noApplyRequired: true, saved: true }
  })
}
async function providerAudit(width) {
  await check("provider validation, busy/disabled states, connection failure and CRUD", width, async ({ page, gates, faults, calls }) => {
    const trigger = page.getByRole("button", { name: /^Data sources/ })
    if (!(await trigger.isVisible())) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click()
    await trigger.click()
    const panel = page.getByRole("region", { name: "Data sources", exact: true })
    await panel.getByRole("button", { name: "Add data source", exact: true }).click()
    await panel.getByLabel("Provider ID", { exact: true }).fill("browser-managed")
    await panel.getByLabel("Name", { exact: true }).fill("Browser managed metrics")
    await panel.getByLabel("Endpoint URL", { exact: true }).fill("https://user:secret@metrics.invalid")
    await panel.getByRole("button", { name: "Save data source", exact: true }).click()
    await panel.getByRole("alert").filter({ hasText: /without credentials/ }).waitFor()
    assert.equal(calls.filter(item => item.method === "PUT" && item.pathname.includes("provider-configs")).length, 0)
    await panel.getByLabel("Endpoint URL", { exact: true }).fill("https://metrics.example.internal")
    await panel.getByLabel("Bearer token environment variable", { exact: true }).fill("PAPRIKA_PROVIDER_AUDIT_TOKEN")
    await panel.getByRole("button", { name: "Save data source", exact: true }).click()
    const row = panel.getByRole("article").filter({ has: page.getByText("Browser managed metrics", { exact: true }) })
    await row.waitFor()
    let release
    gates.test = new Promise(resolve => { release = resolve })
    await row.getByRole("button", { name: "Test connection", exact: true }).click()
    try {
      const testing = row.getByRole("button", { name: "Testing…", exact: true })
      assert.equal(await testing.isDisabled(), true)
      assert.equal(await testing.getAttribute("aria-busy"), "true")
      await capture(page, `provider-testing-${width}`, panel)
      faults.test = true
    } finally { release(); gates.test = null }
    await panel.getByRole("alert").filter({ hasText: /connection was refused/ }).waitFor()
    await capture(page, `provider-error-${width}`, panel)
    faults.test = false
    await row.getByRole("button", { name: "Test connection", exact: true }).click()
    await panel.getByRole("status").filter({ hasText: /connection succeeded/ }).waitFor()
    await row.getByRole("button", { name: "Edit", exact: true }).click()
    assert.equal(await panel.getByLabel("Provider ID", { exact: true }).isDisabled(), true)
    assert.equal(await panel.getByLabel("Bearer token environment variable", { exact: true }).inputValue(), "PAPRIKA_PROVIDER_AUDIT_TOKEN")
    await panel.getByRole("button", { name: "Cancel", exact: true }).click()
    await row.getByRole("button", { name: /^Remove / }).click()
    await panel.getByRole("button", { name: "Remove provider", exact: true }).click()
    await row.waitFor({ state: "hidden" })
    return { invalidURLDidNotSubmit: true, busyDisabled: true, failureRecovered: true, managedProviderRemoved: true, integrationCompanion: "insights-live.e2e.mjs covers real provider auth, discovery, ETags and durable restart" }
  })
}
function toOpenUI(document) {
  const args = values => values.map(value => JSON.stringify(value ?? null)).join(", ")
  return `root = Dashboard(${args([document.id, document.title, document.timeRange, document.refreshInterval])}, [${document.widgets.map((_, index) => `widget${index}`).join(", ")}], null)\n` + document.widgets.map((item, index) => `widget${index} = ${item.type === "heatmap" ? "Heatmap" : "TimeSeries"}(${args([item.id, item.title, item.providerId, item.query, item.unit, item.layout, item.description, item.color, item.options])})`).join("\n")
}
async function tooltipAuthoring(width) {
  await check("heatmap tooltip options survive visual authoring, JSON, YAML, OpenUI and reload", width, async ({ page, documents, queries }) => {
    const panel = await widgetEditor(page, "Service health")
    await panel.getByRole("tab", { name: "Tooltips", exact: true }).click()
    await panel.getByRole("button", { name: "Add tooltip widget", exact: true }).click()
    await selectGammaOption(page, panel.getByRole("combobox", { name: "Tooltip chart height", exact: true }), /Expanded/)
    await panel.getByRole("switch", { name: "Show tooltip chart grid", exact: true }).uncheck()
    await panel.getByRole("switch", { name: "Show tooltip chart axes", exact: true }).uncheck()
    await panel.getByRole("switch", { name: "Show tooltips", exact: true }).uncheck()
    assert.equal(await panel.getByRole("combobox", { name: "Tooltip visualization", exact: true }).count(), 0)
    await panel.getByRole("switch", { name: "Show tooltips", exact: true }).check()
    assert.match(await panel.getByRole("combobox", { name: "Tooltip chart height", exact: true }).innerText(), /Expanded/)
    const before = queries.filter(query => query.query === "service_health").length
    await panel.getByRole("button", { name: "Apply widget", exact: true }).click()
    await panel.getByRole("button", { name: "Close widget editor", exact: true }).click()
    await save(page)
    const initial = { type: "timeseries", height: 200, showGrid: false, showAxis: false }
    assert.deepEqual(documents.get(dashboard.id).widgets[1].options.tooltipView, initial)
    assert.equal(queries.filter(query => query.query === "service_health").length, before, "Tooltip style edits must not fetch telemetry")
    await page.getByRole("button", { name: "Code", exact: true }).click()
    const source = page.getByRole("region", { name: "Dashboard source editor", exact: true })
    await source.getByRole("button", { name: "JSON", exact: true }).click()
    const text = source.getByRole("textbox", { name: "Dashboard source", exact: true })
    const json = JSON.parse(await text.inputValue())
    assert.deepEqual(json.widgets[1].options.tooltipView, initial)
    json.widgets[1].options.tooltipView = { type: "timeseries", height: 120, showGrid: true, showAxis: true }
    await text.fill(JSON.stringify(json, null, 2)); await source.getByRole("button", { name: "Apply to canvas", exact: true }).click()
    await source.waitFor({ state: "hidden" })
    await page.getByRole("button", { name: "Code", exact: true }).click()
    await source.getByRole("button", { name: "YAML", exact: true }).click()
    const yaml = await text.inputValue(); assert.match(yaml, /tooltipView:/)
    await text.fill(yaml.replace("height: 120", "height: 200")); await source.getByRole("button", { name: "Apply to canvas", exact: true }).click()
    await source.waitFor({ state: "hidden" }); await save(page)
    assert.equal(documents.get(dashboard.id).widgets[1].options.tooltipView.height, 200)
    const aiDocument = structuredClone(documents.get(dashboard.id)); aiDocument.widgets[1].options.tooltipView.height = 160
    await page.getByRole("button", { name: "Build with AI", exact: true }).click()
    const ai = page.getByRole("region", { name: "Build with AI", exact: true })
    assert.equal(await ai.getByRole("button", { name: "Apply to canvas", exact: true }).isDisabled(), true)
    await ai.getByRole("textbox", { name: "AI-generated definition", exact: true }).fill(toOpenUI(aiDocument))
    await ai.getByRole("button", { name: "Review definition", exact: true }).click()
    await ai.getByRole("button", { name: "Apply to canvas", exact: true }).click()
    if (await ai.isVisible()) await ai.getByRole("button", { name: "Close AI builder", exact: true }).click()
    await save(page); await page.reload({ waitUntil: "networkidle" })
    assert.deepEqual(documents.get(dashboard.id).widgets[1].options.tooltipView, { type: "timeseries", height: 160, showGrid: true, showAxis: true })
    const tile = page.locator('[data-widget-id="health"]'); await tile.scrollIntoViewIfNeeded()
    const cell = tile.getByRole("group").getByRole("button").first()
    await cell.click(); await page.getByRole("tooltip").locator('[data-tooltip-widget="timeseries"]').waitFor()
    const img = page.getByRole("tooltip").getByRole("img", { name: "api-east time series", exact: true })
    assert.equal((await img.getAttribute("viewBox")).trim().split(/\s+/).at(-1), "160")
    assert.ok(await img.locator("text").count() > 0)
    assert.ok(await img.locator('[stroke-dasharray="3 4"]').count() > 0)
    await capture(page, `tooltip-configured-${width}`)
    await capture(page, `tooltip-configured-native-${width}`, page.getByRole("tooltip"))
    return { formats: ["visual", "JSON", "YAML", "OpenUI"], preservesWhileHidden: true, savedHeight: 160, styleRequests: 0 }
  })
}
const withTooltip = (height = 120, showAxis = false, showGrid = false) => document => ({ ...document, widgets: document.widgets.map(widget => widget.type === "heatmap" ? { ...widget, options: { tooltipView: { type: "timeseries", height, showAxis, showGrid } } } : widget) })
async function tooltipInteraction(width) {
  await check("heatmap history uses the entire hovered series without fetching or nesting tooltips", width, async ({ page, queries }) => {
    const tile = page.locator('[data-widget-id="health"]'); await tile.scrollIntoViewIfNeeded()
    const cells = tile.getByRole("group").getByRole("button")
    const first = cells.first(); await first.scrollIntoViewIfNeeded(); await page.waitForLoadState("networkidle")
    const before = queries.length
    if (width < 600) await first.tap(); else await first.hover()
    const tip = page.getByRole("tooltip"), history = tip.locator('[data-tooltip-widget="timeseries"]')
    await history.waitFor(); await inViewport(page, tip)
    assert.equal(await history.getAttribute("aria-label"), "api-east history")
    assert.match(await history.innerText(), /61 samples/)
    const values = data.series[0].points.map(point => point.value).filter(value => value !== null)
    assert.equal(await history.locator("[data-history-min]").getAttribute("data-history-min"), String(Math.min(...values)))
    assert.equal(await history.locator("[data-history-max]").getAttribute("data-history-max"), String(Math.max(...values)))
    assert.deepEqual(await history.locator("time").evaluateAll(nodes => nodes.map(node => node.getAttribute("datetime"))), [new Date(stamp - 3600000).toISOString(), new Date(stamp).toISOString()])
    const chart = history.getByRole("img", { name: "api-east time series", exact: true })
    const inset = await history.evaluate(element => ({ left: parseFloat(getComputedStyle(element).paddingLeft), right: parseFloat(getComputedStyle(element).paddingRight) }))
    const historyBox = await history.boundingBox(), chartBox = await chart.boundingBox()
    assert.ok(inset.left >= 12 && inset.right >= 12, "History content must align with the tooltip's readable inner inset")
    assert.ok(chartBox.x >= historyBox.x + inset.left - 1 && chartBox.x + chartBox.width <= historyBox.x + historyBox.width - inset.right + 1, "History plot must fit within the tooltip's padded content box")
    assert.equal((await chart.getAttribute("viewBox")).trim().split(/\s+/).at(-1), "120")
    assert.equal(await chart.getAttribute("tabindex"), "-1")
    assert.equal(await chart.locator("text").count(), 0)
    assert.equal(await chart.locator('[stroke-dasharray="3 4"]').count(), 0)
    assert.match(await chart.locator("desc").textContent(), /1 missing sample/)
    assert.equal(await chart.getAttribute("aria-describedby"), await chart.locator("desc").getAttribute("id"))
    if (width >= 600) { await first.click(); assert.equal(await first.getAttribute("aria-pressed"), "true") }
    await page.keyboard.press("End"); await inViewport(page, tip)
    await capture(page, `tooltip-history-${width}`)
    await page.keyboard.press("Escape"); await tip.waitFor({ state: "hidden" })
    await first.evaluate(element => element.blur()); await first.focus(); await history.waitFor()
    await page.keyboard.press("Escape"); await tip.waitFor({ state: "hidden" })
    const second = cells.nth(1); await second.click(); await history.waitFor()
    assert.equal(await history.getAttribute("aria-label"), "worker-west history")
    assert.equal(await tip.getByRole("img").count(), 1)
    await second.click(); await tip.waitFor({ state: "hidden" })
    if (width < 600) {
      await first.tap(); await history.waitFor()
      for (const viewport of [{ width: 320, height: 600 }, { width: 844, height: 390 }]) {
        await page.setViewportSize(viewport)
        await page.waitForFunction(() => {
          const tip = document.querySelector('[role="tooltip"]')
          if (!tip) return false
          const r = tip.getBoundingClientRect()
          return r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
        })
        await inViewport(page, tip)
        await page.keyboard.press("Home")
        assert.equal(await tip.evaluate(element => element.scrollTop), 0)
        await capture(page, `tooltip-native-top-${viewport.width}x${viewport.height}`, tip)
        await page.keyboard.press("End")
        const scroll = await tip.evaluate(element => ({ top: element.scrollTop, maximum: element.scrollHeight - element.clientHeight }))
        if (scroll.maximum > 1) assert.ok(Math.abs(scroll.top - scroll.maximum) <= 1, "History content must remain keyboard-reachable in short viewports")
        await capture(page, `tooltip-native-${viewport.width}x${viewport.height}`, tip)
      }
      await page.keyboard.press("Escape"); await tip.waitFor({ state: "hidden" })
    }
    await page.waitForLoadState("networkidle"); assert.equal(queries.length, before)
    return { samples: 61, nullGaps: 1, exactSummary: true, selectedSeriesOnly: true, requestsOnInteraction: 0, height: 120, axesAndGridHidden: true }
  }, withTooltip())
}
async function tooltipBounds() {
  for (const kind of ["bounded", "all-null", "latest-null"]) {
    const series = structuredClone(data)
    if (kind === "bounded") series.series[0].points = Array.from({ length: 601 }, (_, i) => ({ timestamp: stamp - (600 - i) * 6000, value: i === 333 ? null : i }))
    else if (kind === "all-null") series.series[0].points.forEach(point => { point.value = null })
    else series.series[0].points.at(-1).value = null
    await check(`heatmap history ${kind} remains honest and contained`, 390, async ({ page, queries }) => {
      const tile = page.locator('[data-widget-id="health"]'); await tile.scrollIntoViewIfNeeded()
      const cell = tile.getByRole("group").getByRole("button").first()
      await cell.scrollIntoViewIfNeeded(); const before = queries.length
      await cell.tap()
      const tip = page.getByRole("tooltip"), history = tip.locator('[data-tooltip-widget="timeseries"]')
      await history.waitFor(); const bounds = await inViewport(page, tip)
      if (kind === "bounded") { assert.match(await history.innerText(), /601 samples/); assert.match(await history.innerText(), /240|downsampl|simplif/i); assert.equal(await history.locator("[data-history-min]").getAttribute("data-history-min"), "0"); assert.equal(await history.locator("[data-history-max]").getAttribute("data-history-max"), "600") }
      else if (kind === "all-null") { assert.equal(await history.getByRole("img").count(), 0); await history.getByText("No finite observations in this time range.", { exact: true }).waitFor() }
      else { assert.equal(await history.getByRole("img").count(), 1); assert.match(await cell.getAttribute("aria-label"), /No data/) }
      await page.keyboard.press("End"); await capture(page, `tooltip-${kind}-390`)
      assert.equal(queries.length, before)
      return { bounds, requestsOnInteraction: 0 }
    }, withTooltip(200, true, true), series)
  }
}
try {
  await mkdir(output, { recursive: true })
  for (const width of [1512, 390]) await surfaceAudit(width)
  if (!baseline) {
    for (const width of [1512, 390]) { await queryAudit(width); await providerAudit(width); await tooltipAuthoring(width); await tooltipInteraction(width) }
    await tooltipBounds()
  }
} finally {
  await browser.close()
  await writeFile(resolve(output, `${phase}-report.json`), JSON.stringify({ baseURL, phase, reports, pageErrors, screenshots }, null, 2))
}
assert.deepEqual(pageErrors, [])
assert.equal(reports.filter(report => !report.passed).length, 0)
console.log(`${reports.length} ${phase} builder checks passed.`)
