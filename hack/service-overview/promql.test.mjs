import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

const patches = JSON.parse(await readFile(new URL("./queries.json", import.meta.url), "utf8"))
const image = "prom/prometheus@sha256:6927e0919a144aa7616fd0137d4816816d42f6b816de3af269ab065250859a62"
const series = (name, labels, increment) => ({ series: `${name}{${Object.entries(labels).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(",")}}`, values: `0+${increment}x10` })
const sample = (value, labels = "{}") => ({ labels, value })
function metricInput(service, stable = false, extra = {}) {
  const labels = stable ? { job: "brandbrain-api", service: "brandbrain", service_name: service, ...extra } : { service: "telesis", otel_scope_name: service, ...extra }
  const metric = stable ? "http_server_request_duration_seconds" : "http_request_duration_milliseconds"
  const count = stable ? `${metric}_count` : "http_request_count_total"
  const status = stable ? "http_response_status_code" : "status_code"
  return [series(count, { ...labels, [status]: "200" }, 48), series(count, { ...labels, [status]: "404" }, 12),
    ...[[stable ? "0.1" : "100", 30], [stable ? "0.2" : "200", 60], ["+Inf", 60]].map(([le, step]) => series(`${metric}_bucket`, { ...labels, le }, step))]
}
function expectations(service, values = {}) {
  const expected = {
    "service-http-request-rate": [sample(1)],
    "service-http-client-error-ratio": [sample(20)],
    "service-http-server-error-ratio": [sample(0)],
    "service-http-latency-p95": [sample(190)],
    "service-http-error-ratios": [sample(20, '{status_class="4xx"}'), sample(0, '{status_class="5xx"}')],
    "service-http-latency-percentiles": [sample(100, '{quantile="p50"}'), sample(190, '{quantile="p95"}'), sample(198, '{quantile="p99"}')],
    ...values,
  }
  return Object.entries(patches).map(([id, patch]) => ({ expr: patch.query.replaceAll("{{service}}", JSON.stringify(service)), eval_time: "10m", exp_samples: expected[id] }))
}
test("saved HTTP queries evaluate both metric schemas, units, error classes and absent services", async () => {
  const directory = await mkdtemp(join(tmpdir(), "paprika-service-promql-"))
  try {
    const allEmpty = Object.fromEntries(Object.keys(patches).map(id => [id, []]))
    const serverErrors = metricInput("brandbrain-api", true)
    serverErrors[0].values = "0+42x10"
    serverErrors.push(series("http_server_request_duration_seconds_count", { job: "brandbrain-api", service: "brandbrain", service_name: "brandbrain-api", http_response_status_code: "500", http_route: "/fail" }, 6))
    const zeroTraffic = expectations("brandbrain-api", { ...allEmpty, "service-http-request-rate": [sample(0)] }).map(item => ({ ...item,
      // Prometheus NaN is undefined, not a zero percentage or latency. Filter it
      // by comparison with itself because JSON cannot encode a NaN expectation.
      expr: item.exp_samples.length ? item.expr : `(${item.expr}) == (${item.expr})`,
    }))
    const document = { evaluation_interval: "1m", tests: [
      { name: "Uptime legacy metrics retain native milliseconds", interval: "1m", input_series: metricInput("uptime-api"), promql_expr_test: expectations("uptime-api") },
      { name: "Brandbrain stable metrics become milliseconds", interval: "1m", input_series: metricInput("brandbrain-api", true), promql_expr_test: expectations("brandbrain-api") },
      { name: "A missing service stays missing", interval: "1m", input_series: [...metricInput("uptime-api"), ...metricInput("brandbrain-api", true)], promql_expr_test: expectations("missing-api", allEmpty) },
      { name: "Different scrape jobs cannot substitute for Brandbrain", interval: "1m", input_series: metricInput("brandbrain-api", true, { job: "unrelated-api" }), promql_expr_test: expectations("brandbrain-api", allEmpty) },
      { name: "Schema overlap cannot double count a service", interval: "1m", input_series: [...metricInput("uptime-api"), ...metricInput("uptime-api", true)], promql_expr_test: expectations("uptime-api") },
      { name: "Real server errors aggregate across route labels", interval: "1m", input_series: serverErrors, promql_expr_test: expectations("brandbrain-api", { "service-http-server-error-ratio": [sample(10)], "service-http-error-ratios": [sample(20, '{status_class="4xx"}'), sample(10, '{status_class="5xx"}')] }) },
      { name: "Zero traffic keeps ratios and quantiles undefined", interval: "1m", input_series: metricInput("brandbrain-api", true).map(item => ({ ...item, values: "0+0x10" })), promql_expr_test: zeroTraffic },
    ] }
    await writeFile(join(directory, "test.json"), JSON.stringify(document))
    const result = process.env.PROMTOOL
      ? spawnSync(process.env.PROMTOOL, ["test", "rules", join(directory, "test.json")], { encoding: "utf8" })
      : spawnSync("docker", ["run", "--rm", "--network=none", "--entrypoint=/bin/promtool", "-v", `${directory}:/tests:ro`, image, "test", "rules", "/tests/test.json"], { encoding: "utf8" })
    assert.equal(result.status, 0, result.error?.message ?? `${result.stdout}\n${result.stderr}`)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
