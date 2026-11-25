// Responsive check of the Insights surfaces the review-rest change adds or alters, at 1512, 1024, 768 and 390 px in
// light and dark: the Kubernetes widgets in narrow and wide tiles, baseline and event overlays, benign and refused
// states, the variable bar with several values, Revision history, Build with AI review and the agent handoff, the
// dashboard manager and variables editor, the widget editor's presets and thresholds, the starter picker, saved-query
// search, the data inspector and embed mode. Real Go documents and providers (reference-dashboard-environment);
// query results are deterministic fixtures.
//
// Every surface is judged by one generic probe (layoutProblems): no page overflow, nothing drawn past the viewport,
// no text clipped by an overflow box without an ellipsis, no ellipsis without a title, no wrapped label inside a
// control, no overlapping controls and no internal scrollbar on a stat.
//
// Run after `npm run build` from ui/: node e2e/insights-review-rest-responsive.e2e.mjs
// Screenshots go to $REVIEW_REST_RESPONSIVE_OUTPUT (default artifacts/insights/review-rest-responsive).
import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { registerHooks } from "node:module"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createReferenceDashboardEnvironment } from "./fixtures/reference-dashboard-environment.mjs"

// The Kubernetes fixtures are TypeScript with extensionless relative imports; resolve those to .ts files.
registerHooks({
  resolve(specifier, context, next) {
    try { return next(specifier, context) } catch (error) {
      if (/^\.\.?\//.test(specifier) && !/\.[a-z]+$/.test(specifier)) return next(`${specifier}.ts`, context)
      throw error
    }
  },
})
const { kubernetesFixture } = await import("../src/features/insights/plugins/kubernetes-fixtures.ts")
const queries = await import("../src/features/insights/plugins/kubernetes-queries.ts")

const repository = resolve(fileURLToPath(new URL("../../", import.meta.url)))
const output = resolve(process.env.REVIEW_REST_RESPONSIVE_OUTPUT || join(repository, "artifacts/insights/review-rest-responsive"))
const only = process.env.REVIEW_REST_ONLY ? new Set(process.env.REVIEW_REST_ONLY.split(",")) : undefined
const viewports = [
  { width: 1512, height: 982 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
].filter(viewport => !process.env.REVIEW_REST_WIDTHS || process.env.REVIEW_REST_WIDTHS.split(",").includes(String(viewport.width)))
const themes = ["light", "dark"].filter(theme => !process.env.REVIEW_REST_THEMES || process.env.REVIEW_REST_THEMES.split(",").includes(theme))
const failures = [], passes = []

/**
 * Every layout problem inside the elements `rootSelector` matches, and on the page. Runs in the browser, so it is
 * self-contained. Generic on purpose: any widget, panel or dialog root can be passed.
 */
function layoutProblems({ rootSelector, label }) {
  const problems = []
  const viewport = document.documentElement.clientWidth
  if (document.documentElement.scrollWidth > viewport + 1) {
    // Name the element that reaches furthest, so the report says what to fix.
    const widest = [...document.body.querySelectorAll("*")].reduce((best, element) => element.getBoundingClientRect().right > (best?.getBoundingClientRect().right ?? 0) ? element : best, undefined)
    problems.push(`${label}: page overflows by ${document.documentElement.scrollWidth - viewport} px (${widest?.tagName.toLowerCase()}.${String(widest?.className).split(" ")[0]} "${(widest?.textContent ?? "").trim().slice(0, 30)}")`)
  }
  const shown = element => {
    if (typeof element.checkVisibility === "function" && !element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false
    const box = element.getBoundingClientRect()
    // A visually hidden (sr-only) element is 1 px square.
    return box.width > 2 && box.height > 2
  }
  // The nearest ancestor below root that clips vertically, if any.
  const verticalClip = (element, root) => {
    for (let parent = element.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowY
      // Content inside a scroller can be scrolled to: it is not cut off.
      if (["auto", "scroll"].includes(overflow) && parent.scrollHeight > parent.clientHeight + 1) return undefined
      if (["hidden", "clip"].includes(overflow)) {
        const box = parent.getBoundingClientRect()
        // Inside a visually hidden (sr-only) box: not drawn at all.
        return box.width <= 2 || box.height <= 2 ? undefined : parent
      }
    }
    return undefined
  }
  const describe = element => {
    const text = (element.getAttribute("aria-label") || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)
    return `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.split(" ")[0]}` : ""} "${text}"`
  }
  // An ancestor (below root) that scrolls or clips sideways: content past it is not drawn past the viewport.
  const horizontallyContained = (element, root) => {
    for (let parent = element.parentElement; parent && parent !== root.parentElement; parent = parent.parentElement) {
      const overflow = getComputedStyle(parent).overflowX
      if (overflow !== "visible") return true
    }
    return false
  }
  // The full text of a truncated label is reachable: a title or accessible name on it, or (as for a chart row whose
  // marks open an observation tooltip) a control in the same widget whose accessible name holds the full text.
  const titled = (element, root) => {
    for (let node = element, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      if (node.getAttribute("title") || node.getAttribute("aria-label") || node.getAttribute("aria-describedby")) return true
    }
    const full = element.textContent.trim()
    return !!full && [...root.querySelectorAll("[aria-label]")].some(other => other !== element && other.getAttribute("aria-label").includes(full))
  }
  const ownText = element => [...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
  // A card-like control (a heading over a description) wraps by design; a one-line control must not.
  const cardLike = element => {
    const blocks = [...element.querySelectorAll("*")].filter(child => ["block", "grid", "flex", "-webkit-box"].includes(getComputedStyle(child).display) && child.textContent.trim())
    const column = getComputedStyle(element).flexDirection === "column" || getComputedStyle(element).display === "grid"
    return blocks.length > 1 || (column && element.children.length > 1)
  }
  const wrapped = element => {
    for (const node of element.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      const tops = new Set([...range.getClientRects()].filter(rect => rect.width > 0).map(rect => Math.round(rect.top)))
      if (tops.size > 1) return true
    }
    return false
  }
  // Controls whose label is one line: buttons, tabs, options, menu items and chips.
  const oneLine = "button, [role=button], [role=tab], [role=option], [role=menuitem], [role=combobox]"
  const controls = "button, a[href], [role=button], [role=tab], [role=combobox], [role=option], [role=menuitem], [role=switch], [role=checkbox], input, select, textarea, summary"
  for (const root of document.querySelectorAll(rootSelector)) {
    if (!shown(root)) continue
    const name = `${label} ${root.dataset.widgetId ?? root.getAttribute("aria-label") ?? root.dataset.testid ?? root.tagName.toLowerCase()}`
    const rootBox = root.getBoundingClientRect()
    if (rootBox.left < -1 || rootBox.right > viewport + 1) problems.push(`${name}: root spans ${Math.round(rootBox.left)}..${Math.round(rootBox.right)} in a ${viewport} px viewport`)
    let reported = 0
    const report = message => { if (reported++ < 8) problems.push(`${name}: ${message}`) }
    for (const element of root.querySelectorAll("*")) {
      if (!shown(element)) continue
      const box = element.getBoundingClientRect()
      const style = getComputedStyle(element)
      if (style.position !== "fixed" && (box.right > viewport + 1 || box.left < -1) && !horizontallyContained(element, root))
        report(`${describe(element)} drawn at ${Math.round(box.left)}..${Math.round(box.right)}, past the viewport`)
      const clamped = style.webkitLineClamp && style.webkitLineClamp !== "none"
      if (ownText(element) && ["hidden", "clip"].includes(style.overflowX) && element.scrollWidth > element.clientWidth + 1) {
        if (style.textOverflow !== "ellipsis" && !clamped) report(`${describe(element)} text clipped without an ellipsis (${element.scrollWidth} > ${element.clientWidth})`)
        else if (!titled(element, root)) report(`${describe(element)} truncated without a title`)
      }
      if (ownText(element) || element.matches(controls)) {
        const clip = verticalClip(element, root)
        const edge = clip?.getBoundingClientRect()
        if (edge && (box.bottom > edge.bottom + 2 || box.top < edge.top - 2)) report(`${describe(element)} is cut off vertically (${Math.round(box.top)}..${Math.round(box.bottom)} inside ${Math.round(edge.top)}..${Math.round(edge.bottom)})`)
      }
      if (element instanceof SVGTextElement && element.textContent.trim()) {
        const svg = element.ownerSVGElement
        const frame = svg?.getBoundingClientRect()
        if (frame && getComputedStyle(svg).overflow !== "visible" && (box.top < frame.top - 1 || box.bottom > frame.bottom + 1 || box.left < frame.left - 1 || box.right > frame.right + 1))
          report(`chart text "${element.textContent.trim().slice(0, 30)}" is clipped by its plot`)
      }
      if (element.matches(oneLine) && !cardLike(element)) {
        if (wrapped(element)) report(`${describe(element)} wraps inside a control`)
        for (const child of element.querySelectorAll("span, strong")) if (shown(child) && wrapped(child)) report(`${describe(child)} wraps inside a control`)
      }
    }
    // Interactive controls must not overlap one another (a control inside another is nesting, not overlap).
    // A sticky or fixed bar covers content scrolled under it by design, so its controls are not compared.
    const pinned = element => {
      for (let node = element; node; node = node.parentElement) if (["sticky", "fixed"].includes(getComputedStyle(node).position)) return true
      return false
    }
    const boxes = [...root.querySelectorAll(controls)].filter(shown).filter(element => !element.closest("[aria-hidden=true]") && getComputedStyle(element).pointerEvents !== "none" && !pinned(element))
      .map(element => ({ element, box: element.getBoundingClientRect() }))
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j]
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue
      const x = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left)
      const y = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)
      if (x > 2 && y > 2) report(`${describe(a.element)} overlaps ${describe(b.element)} by ${Math.round(x)}x${Math.round(y)} px`)
    }
    // A compact KPI never scrolls inside its tile.
    if (root.matches("[data-widget-id]") && root.querySelector("[data-stat], [data-widget-type=stat]")) {
      for (const element of root.querySelectorAll("*")) {
        const style = getComputedStyle(element)
        if (["auto", "scroll"].includes(style.overflowY) && element.scrollHeight > element.clientHeight + 1) report(`${describe(element)} scrolls inside a stat`)
      }
    }
  }
  return problems
}

async function settle(page) {
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
}

/** Scrolls every tile into view so lazy widgets mount, then waits until none is loading. */
async function settleTiles(page) {
  const count = await page.locator("[data-widget-id]").count()
  for (let index = 0; index < count; index++) await page.locator("[data-widget-id]").nth(index).scrollIntoViewIfNeeded()
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => !document.querySelector('[data-widget-id] [aria-busy=true], [role=status][aria-label="Loading widget"]'), null, { timeout: 30_000 })
    .catch(() => {})
  await settle(page)
}

async function audit(page, rootSelector, label) {
  if (!(await page.locator(rootSelector).count())) {
    failures.push(`${label}: nothing matched ${rootSelector}`)
    return []
  }
  const problems = await page.evaluate(layoutProblems, { rootSelector, label })
  for (const problem of problems) failures.push(problem)
  if (!problems.length) passes.push(label)
  // A close-up of each widget with a problem, for a person to look at.
  for (const id of new Set(problems.map(problem => /^\S+ \S+ (\S+):/.exec(problem)?.[1]).filter(Boolean))) {
    const tile = page.locator(`[data-widget-id="${id}"]`)
    if (await tile.count() === 1) await tile.screenshot({ path: join(output, `problem-${label.replaceAll(" ", "-")}-${id}.png`), animations: "disabled" }).catch(() => {})
  }
  return problems
}

async function shot(page, name, locator) {
  const path = join(output, `${name}.png`)
  if (locator) await locator.screenshot({ path, animations: "disabled" })
  else await page.screenshot({ path, fullPage: true, animations: "disabled" })
  return path
}

const scene = name => !only || only.has(name)

// ---- Fixtures ----------------------------------------------------------------------------------------------------

const environment = await createReferenceDashboardEnvironment(repository, process.env.INSIGHTS_E2E_URL)
const metrics = environment.providerIds.metrics
const records = environment.providerIds.records
const k8s = id => kubernetesFixture(id, "ready")
const pluginWidget = (id, pluginId, query, layout, config = {}) => ({ id, title: k8s(pluginId).widget.title.replace("kubernetes-", "").replaceAll("-", " "), type: "plugin", pluginId, dataKind: "metrics", providerId: metrics, query, unit: "", config: { ...k8s(pluginId).widget.config, ...config }, layout })
const ids = queries.KUBERNETES_PLUGIN_IDS
const namespaceVariable = { name: "namespace", label: "Namespace", defaultValue: "shop" }
const k8sBoard = {
  schemaVersion: 1, id: "qa-kubernetes", title: "Kubernetes capacity", timeRange: "1h", refreshInterval: 0,
  variables: [namespaceVariable],
  widgets: [
    pluginWidget("placement-2", ids.placement, queries.PLACEMENT_QUERY, { x: 0, y: 0, w: 2, h: 6 }),
    pluginWidget("throttle-3", ids.throttle, queries.THROTTLE_BY_POD_QUERY, { x: 2, y: 0, w: 3, h: 6 }),
    pluginWidget("bars-3", ids.bars, queries.RESOURCE_BARS_BY_POD_QUERY, { x: 5, y: 0, w: 3, h: 6 }),
    pluginWidget("trend-4", ids.trend, queries.RESOURCE_TREND_QUERY, { x: 8, y: 0, w: 4, h: 6 }),
    pluginWidget("placement-4", ids.placement, queries.PLACEMENT_QUERY, { x: 0, y: 6, w: 4, h: 6 }),
    pluginWidget("throttle-4", ids.throttle, queries.THROTTLE_BY_POD_QUERY, { x: 4, y: 6, w: 4, h: 6 }),
    pluginWidget("bars-4", ids.bars, queries.RESOURCE_BARS_BY_POD_QUERY, { x: 8, y: 6, w: 4, h: 6 }),
    pluginWidget("throttle-12", ids.throttle, queries.THROTTLE_BY_POD_QUERY, { x: 0, y: 12, w: 12, h: 5 }),
  ],
}
// The query arrives with {{namespace}} resolved, so each template is matched with the namespace put in.
const resolved = template => template.replaceAll("{{namespace}}", JSON.stringify(namespaceVariable.defaultValue))
const familyOf = query => query === resolved(queries.PLACEMENT_QUERY) ? ids.placement : query === resolved(queries.THROTTLE_BY_POD_QUERY) ? ids.throttle
  : query === resolved(queries.RESOURCE_BARS_BY_POD_QUERY) ? ids.bars : query === resolved(queries.RESOURCE_TREND_QUERY) ? ids.trend : undefined

const eventsQuery = { schemaVersion: 1, id: "qa-deploys", name: "Deploys and incidents", providerId: records, kind: "records", query: '{"fixture":"deploys"}' }
const latencyQuery = { schemaVersion: 1, id: "qa-latency-p95", name: "Checkout p95 latency by route and service, with a long name", providerId: metrics, kind: "metrics", query: "histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))" }
const signalsBoard = {
  schemaVersion: 1, id: "qa-signals", title: "Checkout service signals with a long dashboard title for narrow headers", timeRange: "1h", refreshInterval: 0,
  description: "Request rate, errors and latency for checkout, with deploy events and a baseline from the previous window.",
  annotationSource: { queryRef: { id: eventsQuery.id }, timestampColumn: "time", labelColumn: "label", severityColumn: "severity" },
  variables: [
    { name: "cluster", label: "Cluster", multi: true, allowAll: true, defaultValue: ["omega-east-1", "delta-west-2"], options: ["omega-east-1", "delta-west-2", "eu-central-3-long-cluster-name", "ap-southeast-2"] },
    { name: "service", label: "Service", defaultValue: "checkout", source: { type: "labelValues", providerId: metrics, label: "service" } },
    { name: "region", label: "Region", multi: true, allowAll: true, defaultValue: [], options: ["us-east-1", "eu-west-1"] },
    namespaceVariable,
  ],
  widgets: [
    { id: "requests", title: "Requests", type: "stat", providerId: metrics, query: "sum(rate(http_requests_total{cluster=~{{cluster}}}[5m]))", unit: "req/s", options: { showSparkline: true }, layout: { x: 0, y: 0, w: 3, h: 2 } },
    { id: "errors", title: "Error ratio", type: "stat", providerId: metrics, query: "sum(rate(http_errors_total[5m]))", unit: "%", options: { showSparkline: true, decimals: 2, thresholds: [{ value: 0, status: "ok" }, { value: 1, status: "warning" }, { value: 5, status: "critical" }] }, layout: { x: 3, y: 0, w: 3, h: 2 } },
    { id: "latency-stat", title: "p95 latency", type: "stat", providerId: metrics, query: "latency_seconds", unit: "s", options: { showSparkline: true }, layout: { x: 6, y: 0, w: 2, h: 2 } },
    { id: "saturation", title: "CPU saturation across the whole checkout fleet", type: "stat", providerId: metrics, query: "cpu_saturation", unit: "percent", options: { showSparkline: true }, layout: { x: 8, y: 0, w: 2, h: 2 } },
    { id: "unavailable", title: "Gateway down", type: "stat", providerId: metrics, query: "qa_gateway_unavailable", unit: "req/s", layout: { x: 10, y: 0, w: 2, h: 2 } },
    { id: "traffic", title: "Traffic against the previous window", type: "timeseries", providerId: metrics, query: "sum by (route) (rate(http_requests_total[5m]))", unit: "req/s", options: { baseline: { window: "previous" }, showLegend: true }, layout: { x: 0, y: 2, w: 8, h: 5 } },
    { id: "refused", title: "Refused by the query limit", type: "timeseries", providerId: metrics, query: "qa_rate_limited", unit: "req/s", layout: { x: 8, y: 2, w: 4, h: 5 } },
    { id: "latency", title: "Latency p95 with rolling baseline", type: "timeseries", providerId: metrics, query: "latency_seconds by route", unit: "s", options: { baseline: { window: "rolling", band: "p10p90" } }, layout: { x: 0, y: 7, w: 6, h: 5 } },
    { id: "empty", title: "Retries", type: "timeseries", providerId: metrics, query: "qa_empty", unit: "req/s", layout: { x: 6, y: 7, w: 3, h: 5 } },
    { id: "throttle-narrow", title: "CPU throttling", type: "plugin", pluginId: ids.throttle, dataKind: "metrics", providerId: metrics, query: queries.THROTTLE_BY_POD_QUERY, unit: "", config: {}, layout: { x: 9, y: 7, w: 3, h: 5 } },
  ],
  covers: { applications: [{ namespace: "shop", name: "checkout" }], summaryWidget: "requests" },
}

/** Deterministic series that move over the requested range. */
function seriesFor(request, name, base, labels = {}, amplitude = 0.2) {
  const step = Math.max(request.step || 60, 15)
  const count = Math.max(2, Math.min(240, Math.floor((request.end - request.start) / step) + 1))
  return {
    name, labels,
    points: Array.from({ length: count }, (_, index) => ({
      timestamp: (request.start + index * step) * 1000,
      value: base * (1 + amplitude * Math.sin(index / 6 + name.length) + 0.03 * Math.cos(index * 1.7)),
    })),
  }
}

function resolveQuery(request) {
  const family = familyOf(request.query)
  if (!family && request.query.includes("signal")) throw new Error(`Unmatched Kubernetes query: ${request.query.slice(0, 200)}`)
  if (family) {
    // The fixture is recorded at a fixed time; move it so its last sample is the end of the requested range.
    const result = structuredClone(k8s(family).result)
    const last = Math.max(...result.series.flatMap(series => series.points.map(point => point.timestamp)))
    const shift = request.end * 1000 - last
    for (const series of result.series) for (const point of series.points) point.timestamp += shift
    return result
  }
  if (request.kind === "records") {
    const now = request.end * 1000
    return { records: {
      columns: [{ key: "time", type: "timestamp", label: "Time" }, { key: "label", type: "string", label: "Event" }, { key: "severity", type: "string", label: "Severity" }],
      rows: [
        [new Date(now - 40 * 60_000).toISOString(), "Deploy checkout v2026.11.24-rc.3 to production-eu-central-1", "info"],
        [new Date(now - 18 * 60_000).toISOString(), "Error budget burn alert", "warning"],
      ],
    } }
  }
  if (request.query === "qa_empty") return { series: [] }
  if (request.query.includes("by (route)") || request.query.includes("by route")) {
    const routes = ["/checkout", "/cart", "/payments/authorize", "/api/v2/orders/{id}/items"]
    return { series: routes.map((route, index) => seriesFor(request, route, request.query.includes("latency") ? 0.12 + index * 0.07 : 42 / (index + 1), { route })) }
  }
  if (request.query.includes("latency")) return { series: [seriesFor(request, "p95", 0.2345678)] }
  if (request.query.includes("errors")) return { series: [seriesFor(request, "errors", 1.23456, {}, 0.5)] }
  if (request.query.includes("saturation")) return { series: [seriesFor(request, "saturation", 87.65432)] }
  return { series: [seriesFor(request, "requests", 12345.6789)] }
}

async function installFixtures(page) {
  await environment.installQueryFixture(page, resolveQuery)
  // Refused queries: a gateway outage and a provider-scoped limit whose retry is longer than the replay cap.
  await page.route(`${environment.baseURL}/api/insights/query`, async route => {
    const body = route.request().postDataJSON()
    if (body?.query === "qa_gateway_unavailable") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ code: "gateway_unavailable", error: "unavailable" }) })
    if (body?.query === "qa_rate_limited") return route.fulfill({ status: 429, contentType: "application/json", headers: { "Retry-After": "600" }, body: JSON.stringify({ code: "rate_limited", error: "busy", limitScope: "principal" }) })
    return route.fallback()
  })
}

async function seed() {
  await environment.api(`saved-queries/${eventsQuery.id}`, "PUT", eventsQuery)
  await environment.api(`saved-queries/${latencyQuery.id}`, "PUT", latencyQuery)
  for (let index = 0; index < 12; index++) {
    const query = { schemaVersion: 1, id: `qa-saved-${index}`, name: `${["Checkout", "Payments", "Inventory"][index % 3]} ${["request rate", "error ratio", "p99 latency by route and pod"][index % 3]} ${index}`, providerId: metrics, kind: "metrics", query: `sum(rate(http_requests_total{job="svc-${index}"}[5m]))`, tags: index % 2 ? ["checkout", "slo"] : ["platform"] }
    await environment.api(`saved-queries/${query.id}`, "PUT", query).catch(() => environment.api(`saved-queries/${query.id}`, "PUT", { ...query, tags: undefined }))
  }
  await environment.api(`dashboards/${k8sBoard.id}`, "PUT", k8sBoard, { "If-None-Match": "*" })
  // Several revisions, so History has a list and a preview with changes.
  const first = { ...signalsBoard, widgets: signalsBoard.widgets.slice(0, 4) }
  const created = await environment.api(`dashboards/${signalsBoard.id}`, "PUT", first, { "If-None-Match": "*" })
  let etag = created.etag ?? created.headers?.etag
  const second = { ...signalsBoard, title: "Checkout signals", widgets: signalsBoard.widgets.slice(0, 7) }
  const updated = await environment.api(`dashboards/${signalsBoard.id}`, "PUT", second, etag ? { "If-Match": etag } : {})
  etag = updated.etag ?? updated.headers?.etag
  await environment.api(`dashboards/${signalsBoard.id}`, "PUT", signalsBoard, etag ? { "If-Match": etag } : {})
}


async function open(browser, viewport, theme) {
  const context = await browser.newContext({ viewport, colorScheme: theme, reducedMotion: "reduce", timezoneId: "UTC" })
  await context.addInitScript(value => localStorage.setItem("paprika-insights-theme", value), theme)
  const page = await context.newPage()
  page.setDefaultTimeout(20_000)
  const errors = []
  page.on("pageerror", error => errors.push(error.message))
  await installFixtures(page)
  return { context, page, errors }
}

async function goto(page, path, tiles = true) {
  await page.goto(`${environment.baseURL}${path}`, { waitUntil: "domcontentloaded" })
  if (tiles) {
    await page.locator("[data-widget-id]").first().waitFor()
    await settleTiles(page)
  } else await settle(page)
}

/** A dashboard action: its button where the header shows one, otherwise the Dashboard actions menu (phones, compact). */
async function action(page, button, menuItem = button) {
  const direct = page.getByRole("button", { name: button, exact: true })
  if (await direct.isVisible().catch(() => false)) return direct.click()
  await page.getByRole("button", { name: "Dashboard actions", exact: true }).click()
  await page.getByRole("menuitem", { name: menuItem, exact: true }).click()
}

// ---- Scenes ------------------------------------------------------------------------------------------------------

const emptyBoard = { schemaVersion: 1, id: "qa-empty", title: "New dashboard", timeRange: "1h", refreshInterval: 0, widgets: [] }
const edits = { widget_edits: [
  { op: "update", id: "errors", patch: { title: "Error ratio across every checkout route and region", options: { decimals: 3, showSparkline: true, thresholds: [{ value: 0, status: "ok" }, { value: 2, status: "warning" }, { value: 10, status: "critical" }] } } },
  { op: "update", id: "traffic", patch: { options: { baseline: { window: "1d" }, showLegend: true } } },
  { op: "remove", id: "empty" },
] }

const scenes = {
  // The two dashboards: every widget in narrow and wide tiles and the phone stack.
  async kubernetes(page, key) {
    await goto(page, `/dashboard/insights/?dashboard=${k8sBoard.id}`)
    await audit(page, "[data-widget-id]", `kubernetes ${key}`)
    await shot(page, `kubernetes-${key}`)
  },
  async signals(page, key) {
    await goto(page, `/dashboard/insights/?dashboard=${signalsBoard.id}`)
    if (process.env.REVIEW_REST_DEBUG) console.log(key, await page.evaluate(process.env.REVIEW_REST_DEBUG))
    await audit(page, "[data-widget-id]", `signals ${key}`)
    await shot(page, `signals-${key}`)
    await shot(page, `signals-top-${key}`, undefined, true)
  },
  // The several-value variable picker (chips, All) and a variable whose options come from the server.
  async variables(page, key) {
    await goto(page, `/dashboard/insights/?dashboard=${signalsBoard.id}`)
    const cluster = page.getByRole("combobox", { name: "Cluster" }).first()
    if (!(await cluster.isVisible().catch(() => false))) await page.getByRole("button", { name: /variables|filters/i }).first().click()
    await cluster.click()
    await page.locator("[role=listbox][aria-multiselectable=true]").waitFor()
    await settle(page)
    await audit(page, "[role=listbox][aria-multiselectable=true]", `variables cluster list ${key}`)
    await shot(page, `variables-cluster-${key}`, undefined, true)
    await page.keyboard.press("Escape")
    const service = page.getByRole("combobox", { name: "Service" }).first()
    await service.click()
    if (!(await page.locator("[role=listbox]").first().isVisible().catch(() => false))) await page.keyboard.press("ArrowDown")
    await page.locator("[role=listbox]").first().waitFor()
    await settle(page)
    await audit(page, "[role=listbox]", `variables service list ${key}`)
    await shot(page, `variables-service-${key}`, undefined, true)
    await page.keyboard.press("Escape")
  },
  async inspector(page, key) {
    await goto(page, `/dashboard/insights/?dashboard=${signalsBoard.id}`)
    const button = page.getByRole("button", { name: "Inspect chart data for Traffic against the previous window", exact: true })
    await button.scrollIntoViewIfNeeded()
    await button.click()
    await page.locator("dialog[open]").waitFor()
    await settle(page)
    await audit(page, "dialog[open]", `inspector ${key}`)
    await shot(page, `inspector-${key}`, undefined, true)
  },
  async history(page, key) {
    await goto(page, `/dashboard/insights/?dashboard=${signalsBoard.id}`)
    await action(page, "History", "Revision history")
    const panel = page.getByTestId("dashboard-history")
    const list = panel.getByRole("list", { name: "Revisions, newest first" })
    await list.waitFor()
    await list.getByRole("button").last().click()
    await panel.getByText(/Preview of revision/).waitFor()
    await settle(page)
    await audit(page, '[data-testid="dashboard-history"]', `history ${key}`)
    await shot(page, `history-${key}`, undefined, true)
  },
  // Build with AI: widget edits reviewed field by field with their checks, and the agent handoff.
  async ai(page, key) {
    await goto(page, `/dashboard/insights/?dashboard=${signalsBoard.id}`)
    await action(page, "Build with AI")
    const panel = page.locator('section[aria-label="Build with AI"]')
    await panel.getByRole("button", { name: "JSON", exact: true }).click()
    await panel.getByLabel("AI-generated definition").fill(JSON.stringify(edits, null, 2))
    await panel.getByRole("button", { name: "Review definition", exact: true }).click()
    await panel.locator('section[aria-label="Field changes"]').waitFor()
    for (const trigger of await panel.locator("button[aria-expanded=false][aria-controls]").all()) await trigger.click({ timeout: 3000 }).catch(() => {})
    await settle(page)
    await audit(page, 'section[aria-label="Build with AI"]', `ai ${key}`)
    await shot(page, `ai-${key}`, undefined, true)
    await shot(page, `ai-changes-${key}`, panel.locator('section[aria-label="Field changes"]'))
  },
  async manage(page, key) {
    await goto(page, `/dashboard/insights/?dashboard=${signalsBoard.id}`)
    await action(page, "Manage dashboards")
    const panel = page.locator('section[aria-label="Manage dashboards"]')
    await panel.locator('[aria-label="Dashboard variable declarations"]').waitFor()
    await settle(page)
    await audit(page, 'section[aria-label="Manage dashboards"]', `manage ${key}`)
    await shot(page, `manage-${key}`, undefined, true)
    await panel.locator('[aria-label="Dashboard variable declarations"]').scrollIntoViewIfNeeded()
    await shot(page, `manage-variables-${key}`, undefined, true)
  },
  // Widget editor: appearance presets, threshold presets and the threshold list.
  async editor(page, key) {
    await goto(page, `/dashboard/insights/?dashboard=${signalsBoard.id}`)
    await action(page, "Edit dashboard")
    await page.getByRole("textbox", { name: "Dashboard title", exact: true }).waitFor()
    for (const [id, title] of [["errors", "Error ratio"], ["traffic", "Traffic against the previous window"]]) {
      const edit = page.getByRole("button", { name: `Edit ${title}`, exact: true })
      await edit.scrollIntoViewIfNeeded()
      await edit.click()
      const editor = page.getByRole("region", { name: "Widget editor", exact: true })
      await editor.waitFor()
      await editor.getByRole("tab", { name: "Style", exact: true }).click()
      await settle(page)
      await audit(page, 'section[aria-label="Widget editor"]', `editor ${id} ${key}`)
      await shot(page, `editor-${id}-${key}`, undefined, true)
      const thresholds = editor.getByText("Start from a preset", { exact: true })
      if (await thresholds.count()) {
        await thresholds.first().scrollIntoViewIfNeeded()
        await shot(page, `editor-${id}-thresholds-${key}`, undefined, true)
      }
      await editor.getByRole("button", { name: "Back to dashboard", exact: true }).click()
      await editor.waitFor({ state: "hidden" })
    }
  },
  async starters(page, key) {
    await goto(page, `/dashboard/insights/?dashboard=${emptyBoard.id}`, false)
    await page.getByRole("button", { name: "Start from a template" }).click()
    const panel = page.locator('section[aria-label="Start from a template"]')
    await panel.getByRole("list", { name: "Templates" }).waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('section[aria-label="Start from a template"] img')].every(image => image.complete), null, { timeout: 15_000 }).catch(() => {})
    await settle(page)
    await audit(page, 'section[aria-label="Start from a template"]', `starters ${key}`)
    await shot(page, `starters-${key}`, undefined, true)
  },
  // Embed mode as the application page frames it: one tile filling a frame of its saved height.
  async embed(page, key, theme) {
    for (const [board, widget, rows] of [[k8sBoard.id, "throttle-4", 6], [k8sBoard.id, "bars-3", 6], [signalsBoard.id, "requests", 2], [signalsBoard.id, "traffic", 5]]) {
      await page.setViewportSize({ width: page.viewportSize().width, height: Math.min(560, Math.max(120, rows * 74 - 16 + 28)) })
      const search = new URLSearchParams({ dashboard: board, embed: widget, theme })
      await page.goto(`${environment.baseURL}/dashboard/insights/?${search}`, { waitUntil: "domcontentloaded" })
      await page.locator(`[data-widget-id="${widget}"]`).waitFor()
      // The widget's own drawing, not just its frame: Kubernetes renderers load on first use.
      await page.locator(`[data-widget-id="${widget}"] :is([data-kubernetes], svg, [role=alert], [data-widget-state])`).first().waitFor()
      await settleTiles(page)
      await audit(page, "[data-widget-id]", `embed ${widget} ${key}`)
      await shot(page, `embed-${widget}-${key}`)
    }
  },
}

const browser = await chromium.launch({ headless: true })
try {
  await mkdir(output, { recursive: true })
  await seed()
  await environment.api(`dashboards/${emptyBoard.id}`, "PUT", emptyBoard, { "If-None-Match": "*" })
  for (const viewport of viewports) {
    for (const theme of themes) {
      const key = `${viewport.width}-${theme}`
      for (const [name, run] of Object.entries(scenes)) {
        if (!scene(name)) continue
        const { context, page, errors } = await open(browser, viewport, theme)
        try {
          await run(page, key, theme)
        } catch (error) {
          failures.push(`${name} ${key}: ${error.message.split("\n")[0]}`)
          await page.screenshot({ path: join(output, `failed-${name}-${key}.png`) }).catch(() => {})
        } finally {
          for (const error of errors) failures.push(`${name} ${key}: page error ${error}`)
          await context.close()
        }
      }
    }
  }
} finally {
  await browser.close()
  await environment.close()
}
console.log(`${passes.length} surface checks passed. Screenshots: ${output}`)
if (failures.length) console.error(failures.join("\n"))
assert.equal(failures.length, 0, `${failures.length} responsive problems`)
