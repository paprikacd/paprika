import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const patches = JSON.parse(await readFile(new URL("./queries.json", import.meta.url), "utf8"))
const catalog = JSON.parse(await readFile(new URL("../../ui/src/features/insights/repository-examples/catalog.json", import.meta.url), "utf8"))
const sourceQueries = new Map(catalog.slice(0, 2).flatMap(entry => entry.live.savedQueries).map(query => [query.id, query]))
const image = "prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62"
const expectedIDs = [
  "src-shorted-operations-p1-t0", "src-shorted-operations-p5-t0",
  "src-shorted-stealth-scraping-p2-t0", "src-shorted-stealth-scraping-p3-t0", "src-shorted-stealth-scraping-p4-t0",
  "src-shorted-stealth-scraping-p5-t0", "src-shorted-stealth-scraping-p5-t1", "src-shorted-stealth-scraping-p7-t0", "src-shorted-stealth-scraping-p8-t0",
]
test("only confirmed native metrics receive replacements with new saved-query identities", () => {
  assert.deepEqual(Object.keys(patches).sort(), expectedIDs.sort())
  const replacements = new Set()
  for (const [sourceId, patch] of Object.entries(patches)) {
    const source = sourceQueries.get(sourceId)
    assert.ok(source)
    assert.notEqual(patch.id, sourceId)
    assert.match(patch.id, /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/)
    assert.equal(replacements.has(patch.id), false); replacements.add(patch.id)
    assert.equal(patch.metadata.sourceSavedQuery, sourceId)
    assert.equal(patch.metadata.sourceProvider, "Shorted Grafana Cloud")
    assert.deepEqual([...patch.query.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]), [...source.query.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]))
    assert.notEqual(patch.query, source.query)
    assert.ok(patch.description)
    assert.equal(Object.hasOwn(patch, "providerId"), false, "A caller must explicitly choose the verified Grafana Cloud provider")
  }
})

const promSeries = (name, labels, increment) => ({ series: `${name}{${Object.entries(labels).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}`, values: `0+${increment}x1440` })
const sample = (value, labels = "{}") => ({ labels, value })
const resource = { job: "news-aggregator", http_host: "example.test", stealth_engine: "native" }
const metricInput = [
  promSeries("rpc_server_duration_milliseconds_count", { deployment_environment: "production", job: "shorted-api", service_name: "shorted-api", rpc_method: "GetTopShorts", rpc_service: "shorts.v1alpha1.ShortService", rpc_system: "connect_rpc" }, 60),
  promSeries("shorted_stealth_fetch_total", { ...resource, status: "success" }, 48),
  promSeries("shorted_stealth_fetch_total", { ...resource, status: "error" }, 12),
  promSeries("shorted_stealth_fetch_errors_total", resource, 12),
  promSeries("shorted_stealth_fetch_bytes_total", resource, 6000),
  ...[["0.1", 30], ["0.2", 60], ["+Inf", 60]].map(([le, increment]) => promSeries("shorted_stealth_fetch_duration_seconds_bucket", { ...resource, le }, increment)),
]
const resourceLabels = '{http_host="example.test",job="news-aggregator",stealth_engine="native"}'
const expected = {
  "src-shorted-operations-p1-t0": [sample(1, '{job="shorted-api",rpc_method="GetTopShorts"}')],
  "src-shorted-operations-p5-t0": [sample(86400)],
  "src-shorted-stealth-scraping-p2-t0": [sample(.2, resourceLabels)],
  "src-shorted-stealth-scraping-p3-t0": [sample(.19, resourceLabels)],
  "src-shorted-stealth-scraping-p4-t0": [sample(360000, resourceLabels)],
  "src-shorted-stealth-scraping-p5-t0": [sample(.1, '{http_host="example.test"}')],
  "src-shorted-stealth-scraping-p5-t1": [sample(.19, '{http_host="example.test"}')],
  "src-shorted-stealth-scraping-p7-t0": [sample(.2, '{http_host="example.test"}')],
  "src-shorted-stealth-scraping-p8-t0": [sample(100, '{stealth_engine="native"}')],
}
function expressions(values = expected, { evalTime = "24h", service = "shorted-api", ids = expectedIDs } = {}) {
  return ids.map(id => ({ expr: patches[id].query.replaceAll("{{service}}", JSON.stringify(service)), eval_time: evalTime, exp_samples: values[id] }))
}
test("native Prometheus evaluates confirmed Shorted metrics, units, matching and missing windows", async () => {
  assert.deepEqual(Object.keys(patches).sort(), expectedIDs.sort())
  const directory = await mkdtemp(join(tmpdir(), "paprika-shorted-promql-"))
  try {
    const empty = Object.fromEntries(expectedIDs.map(id => [id, []]))
    const secondWorkload = { ...resource, job: "other-news-worker" }
    const document = { evaluation_interval: "1m", tests: [
      { name: "Confirmed native metrics and label matching", interval: "1m", input_series: metricInput, promql_expr_test: expressions() },
      { name: "Absent metrics remain empty", interval: "1m", input_series: [], promql_expr_test: expressions(empty) },
      { name: "Insufficient samples do not invent rates or increases", interval: "1m", input_series: metricInput.map(series => ({ ...series, values: "10" })), promql_expr_test: expressions(empty, { evalTime: "0m" }) },
      { name: "Expired range history stays empty", interval: "1m", input_series: metricInput, promql_expr_test: expressions(empty, { evalTime: "49h" }) },
      { name: "RPC service filter excludes unrelated services", interval: "1m", input_series: metricInput, promql_expr_test: expressions(empty, { service: "missing-api", ids: expectedIDs.filter(id => id.includes("operations")) }) },
      { name: "Stealth error metric absence remains empty even when fetch counts exist", interval: "1m", input_series: metricInput.filter(series => !series.series.startsWith("shorted_stealth_fetch_errors_total")), promql_expr_test: expressions(empty, { ids: ["src-shorted-stealth-scraping-p2-t0", "src-shorted-stealth-scraping-p7-t0"] }) },
      { name: "No fetches leave the error ratio undefined", interval: "1m", input_series: metricInput.map(series => ({ ...series, values: "0+0x1440" })), promql_expr_test: expressions(empty, { ids: ["src-shorted-stealth-scraping-p2-t0"] }) },
      { name: "Error ratios retain independent workload identity at a shared host", interval: "1m", input_series: [...metricInput,
        promSeries("shorted_stealth_fetch_total", { ...secondWorkload, status: "success" }, 114),
        promSeries("shorted_stealth_fetch_total", { ...secondWorkload, status: "error" }, 6),
        promSeries("shorted_stealth_fetch_errors_total", secondWorkload, 6),
      ], promql_expr_test: expressions({ "src-shorted-stealth-scraping-p2-t0": [...expected["src-shorted-stealth-scraping-p2-t0"], sample(.05, '{http_host="example.test",job="other-news-worker",stealth_engine="native"}')] }, { ids: ["src-shorted-stealth-scraping-p2-t0"] }) },
    ] }
    await writeFile(join(directory, "test.json"), JSON.stringify(document))
    const result = process.env.PROMTOOL
      ? spawnSync(process.env.PROMTOOL, ["test", "rules", join(directory, "test.json")], { encoding: "utf8" })
      : spawnSync("docker", ["run", "--rm", "--network=none", "--entrypoint=/bin/promtool", "-v", `${directory}:/tests:ro`, image, "test", "rules", "/tests/test.json"], { encoding: "utf8" })
    assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
