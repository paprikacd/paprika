// Unit tests for the playground's query fixture server. Run from ui/: npm run test:lab
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { startQueryFixtureServer, referenceQueryResolver } from "./query-fixture-server.mjs"
import { polishDashboards, polishQuery, polishRange } from "./dashboard-polish.mjs"

async function post(url, body, headers = { "content-type": "application/json" }) {
  const response = await fetch(`${url}/query`, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) })
  return { status: response.status, text: await response.text(), type: response.headers.get("content-type") }
}

const providerId = "provider-metrics"
const request = query => ({ providerId, kind: "metrics", query, start: Date.parse(polishRange.from) / 1000, end: Date.parse(polishRange.to) / 1000, step: 60 })

describe("query fixture server", () => {
  it("answers the reference dashboard queries deterministically", async () => {
    const server = await startQueryFixtureServer()
    try {
      const queries = ["fixture_requests", "fixture_p95", "fixture_errors", "fixture_percentiles", "fixture_cpu"]
      for (const query of queries) {
        const first = await post(server.url, request(query))
        const second = await post(server.url, request(query))
        assert.equal(first.status, 200, query)
        assert.equal(first.type, "application/json")
        assert.equal(first.text, second.text, `${query} must be stable across requests`)
        assert.deepEqual(JSON.parse(first.text), polishQuery(request(query)), `${query} must equal the Playwright resolver output`)
      }
      const percentiles = JSON.parse((await post(server.url, request("fixture_percentiles"))).text)
      assert.deepEqual(percentiles.series.map(series => series.name), ["p50", "p95", "p99"])
      assert.equal(percentiles.series[0].points.length, 61)
      assert.equal(percentiles.series[0].points[0].timestamp, Date.parse(polishRange.from))
      assert.equal(percentiles.series[1].points[26].value, null, "the configured gap stays a missing observation")
    } finally { await server.close() }
  })

  it("keeps the reference dashboards' query shapes resolvable", async () => {
    const server = await startQueryFixtureServer()
    try {
      const queries = polishDashboards(providerId).flatMap(board => board.widgets.map(widget => widget.query)).filter(query => query.startsWith("fixture_"))
      assert.ok(queries.length >= 5)
      for (const query of queries) {
        const response = await post(server.url, request(query.split("{")[0]))
        assert.equal(response.status, 200, query)
      }
    } finally { await server.close() }
  })

  it("reports unknown fixture queries as errors instead of empty data", async () => {
    const server = await startQueryFixtureServer()
    try {
      const response = await post(server.url, request("unknown_fixture"))
      assert.equal(response.status, 500)
      assert.match(JSON.parse(response.text).error, /Unknown local polish fixture/)
    } finally { await server.close() }
  })

  it("rejects malformed requests before resolving", async () => {
    let calls = 0
    const server = await startQueryFixtureServer(() => { calls += 1; return { series: [] } })
    try {
      assert.equal((await post(server.url, "{not json")).status, 400)
      assert.equal((await post(server.url, { query: "fixture_requests" })).status, 400)
      assert.equal((await post(server.url, { providerId, query: 3 })).status, 400)
      assert.equal((await post(server.url, "[]")).status, 400)
      assert.equal(calls, 0)
      const oversized = await post(server.url, JSON.stringify({ providerId, query: "x".repeat(40 * 1024) }))
      assert.equal(oversized.status, 413)
      assert.equal(calls, 0)
    } finally { await server.close() }
  })

  it("serves only POST /query and a health check", async () => {
    const server = await startQueryFixtureServer()
    try {
      assert.equal((await fetch(`${server.url}/query`)).status, 404)
      assert.equal((await fetch(`${server.url}/elsewhere`, { method: "POST", body: "{}" })).status, 404)
      assert.deepEqual(await (await fetch(`${server.url}/healthz`)).json(), { status: "ok" })
    } finally { await server.close() }
  })

  it("binds to loopback only", async () => {
    const server = await startQueryFixtureServer()
    try {
      assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/)
    } finally { await server.close() }
  })

  it("hands the injected resolver the parsed request body", async () => {
    let seen
    const server = await startQueryFixtureServer(query => { seen = query; return { series: [] } })
    try {
      await post(server.url, request("fixture_requests"))
      assert.deepEqual(seen, request("fixture_requests"))
      assert.equal(typeof referenceQueryResolver, "function")
    } finally { await server.close() }
  })
})
