import assert from "node:assert/strict"
import { chartFixtureCollections, chartFixtures } from "./rich-chart-data.ts"
import { routeAnonymousAuthConfiguration } from "../anonymous-auth-fixture.mjs"

const providers = [
  { id: "example-prometheus", name: "Test metric fixtures", type: "prometheus", capabilities: ["metrics"] },
  { id: "example-tempo", name: "Test trace fixtures", type: "tempo", capabilities: ["traces"] },
  { id: "example-records", name: "Test record fixtures", type: "shorted", capabilities: ["records"] },
]
// The route only accepts the fixture expressions authored alongside these records.
// It is test infrastructure, not a query parser or a simulated production provider.
function result(request) {
  assert.ok(!request.query.includes("{{"), "The app must resolve saved-query parameters before issuing a query")
  const metric = request.kind === "records" ? JSON.parse(request.query).fixture : request.kind === "traces" ? JSON.parse(request.query.match(/resource\.paprika\.fixture = ("(?:\\.|[^"\\])*")/)[1]) : request.query.slice(0, request.query.indexOf("{"))
  const fixture = chartFixtures.find(item => item.metric === metric)
  assert.ok(fixture, `Unknown chart test fixture: ${request.query}`)
  if (request.kind === "records") {
    const { filters } = JSON.parse(request.query), frame = structuredClone(fixture.records)
    frame.rows = frame.rows.filter(row => Object.entries(filters).every(([key, value]) => row[frame.columns.findIndex(column => column.key === key)] === value))
    return { records: frame }
  }
  if (request.kind === "traces") {
    const service = JSON.parse(request.query.match(/resource\.service\.name = ("(?:\\.|[^"\\])*")/)[1])
    return { traces: fixture.traces.filter(trace => trace.service === service).map(({ offsetSeconds, ...trace }) => ({ ...trace, startTime: (request.end - offsetSeconds) * 1000 })) }
  }
  const labels = [...request.query.matchAll(/([A-Za-z_]+)=("(?:\\.|[^"\\])*")/g)].map(match => [match[1], JSON.parse(match[2])])
  return { series: fixture.series.flatMap((source, index) => {
    if (!labels.every(([key, value]) => source.labels[key] === value)) return []
    return [{ name: source.name, labels: { ...source.labels, __name__: fixture.metric }, points: Array.from({ length: 61 }, (_, point) => {
      const fraction = point / 60
      const missing = source.base === null || source.gaps?.some(gap => fraction >= gap.from && fraction <= gap.to)
      return { timestamp: (request.start + (request.end - request.start) * fraction) * 1000, value: missing ? null : source.base + (source.variation ?? 0) * Math.sin(fraction * 2 * Math.PI + index) + (source.trend ?? 0) * fraction }
    }) }]
  }) }
}

/** HTTP fixture only; application rendering, query binding and editor code are unmodified. */
export async function installRichChartFixtureAPI(page, base) {
  const origin = new URL(base).origin
  const documents = new Map(chartFixtureCollections.flatMap(collection => collection.sample.dashboards).map(board => [board.id, structuredClone(board)]))
  const savedQueries = new Map(chartFixtureCollections.flatMap(collection => collection.sample.savedQueries).map(query => [query.id, structuredClone(query)]))
  const versions = new Map([...documents.keys(), ...savedQueries.keys()].map(id => [id, 1]))
  const calls = [], failures = []
  const etag = id => `"chart-fixture-${id}-${versions.get(id)}"`
  await routeAnonymousAuthConfiguration(page)
  await page.route(`${origin}/api/insights/**`, async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace("/api/insights", "")
    calls.push({ method: request.method(), path, ...(request.postData() ? { document: request.postDataJSON() } : {}) })
    let body, status = 200, revision = '"chart-fixture-list"'
    try {
      if (path === "/providers") body = { providers }
      else if (path === "/provider-configs") body = { providers: [] }
      else if (path === "/observe-connection") body = { configured: false, connected: false, transport: "mcp", tools: [], providerCount: 0 }
      else if (path === "/dashboards") body = { dashboards: [...documents.values()] }
      else if (path === "/saved-queries") body = { queries: [...savedQueries.values()].map(query => ({ ...query, etag: etag(query.id) })) }
      else if (path.startsWith("/dashboards/") || path.startsWith("/saved-queries/")) {
        const id = decodeURIComponent(path.split("/").at(-1)), store = path.startsWith("/dashboards/") ? documents : savedQueries
        if (request.method() === "PUT") {
          if (store.has(id) && request.headers()["if-match"] !== etag(id)) { status = 412; body = { error: "The fixture changed. Reload before saving." } }
          else { store.set(id, request.postDataJSON()); versions.set(id, (versions.get(id) ?? 0) + 1) }
        }
        if (!body) { body = store.get(id); if (!body) { status = 404; body = { error: "Fixture not found" } } }
        revision = etag(id)
      }
      else if (path.endsWith("/metadata")) body = { values: [] }
      else if (path === "/query") body = result(request.postDataJSON())
      else { status = 404; body = { error: `Unexpected chart test API route ${path}` } }
    } catch (error) { status = 500; body = { error: error.message }; failures.push(error.stack) }
    await route.fulfill({ status, contentType: "application/json", headers: { ETag: revision }, body: JSON.stringify(body) })
  })
  return { documents, savedQueries, calls, failures, etag }
}
