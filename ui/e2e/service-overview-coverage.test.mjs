import assert from "node:assert/strict"
import test from "node:test"
import { assertCoverage } from "./service-overview-coverage.mjs"

const base = { kind: "metrics", service: "brandbrain-api", widget: { id: "request-rate", type: "stat", options: { showSparkline: true } }, body: { series: [{ points: [{ timestamp: 1000, value: 0.5 }, { timestamp: 2000, value: 0.7 }] }] } }
test("every configured service requires real data by default", () => {
  assert.throws(() => assertCoverage({ ...base, body: { series: [] } }), /must have data for brandbrain-api/)
  assert.throws(() => assertCoverage({ ...base, body: { series: [{ points: [{ timestamp: 1000, value: null }] }] } }), /must have data/)
})
test("sparkline and all chart series need at least two finite observations", () => {
  assert.throws(() => assertCoverage({ ...base, body: { series: [{ points: [{ timestamp: 1000, value: 0.5 }] }] } }), /finite observations/)
  assert.throws(() => assertCoverage({ ...base, widget: { id: "latency", type: "timeseries" }, body: { series: [...base.body.series, { points: [] }] } }), /finite observations/)
  assert.equal(assertCoverage(base), true)
})
test("an explicitly configured missing-service test still verifies empty data", () => {
  assert.equal(assertCoverage({ ...base, expected: { state: "empty" }, body: { series: [] } }), false)
  assert.throws(() => assertCoverage({ ...base, expected: { state: "empty" } }), /must be empty/)
})
test("trace rows must exist and belong to the selected service", () => {
  const traces = { ...base, kind: "traces", widget: { id: "traces", type: "traces" } }
  assert.throws(() => assertCoverage({ ...traces, body: { traces: [] } }), /must have data/)
  assert.throws(() => assertCoverage({ ...traces, body: { traces: [{ service: "uptime-api" }] } }), /wrong service/)
  assert.equal(assertCoverage({ ...traces, body: { traces: [{ service: "brandbrain-api" }] } }), true)
})
