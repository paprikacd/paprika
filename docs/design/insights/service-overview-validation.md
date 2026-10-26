# Service overview dashboard

Created through Paprika Observe MCP on 2026-10-26.

[Open Service overview](https://paprika.benebsworth.com/dashboard/insights/?dashboard=service-overview).

## Saved dashboard

The **Services / Service overview** dashboard contains eight widgets backed by
seven saved queries. A single **Service** variable binds every query, including
the trace search. It defaults to `uptime-api`, uses a rolling one-hour range and
refreshes every minute. Stat values and tooltips use two decimal places; each
stat's sparkline shows the same query history as its value.

| Saved query | Widget usage | Meaning |
| --- | --- | --- |
| `service-http-request-rate` | Request rate stat and trend | HTTP requests per second over a five-minute rate window |
| `service-http-client-error-ratio` | 4xx responses stat | Percentage of observed requests returning 4xx |
| `service-http-server-error-ratio` | 5xx errors stat | Percentage of observed requests returning 5xx |
| `service-http-latency-p95` | p95 latency stat | Estimated p95 from five-minute histogram bucket rates, in native milliseconds |
| `service-http-error-ratios` | HTTP response errors trend | Separate 4xx and 5xx percentages |
| `service-http-latency-percentiles` | Latency trend | Estimated p50, p95 and p99, in milliseconds |
| `service-traces` | Matching traces | Bounded TraceQL search for the selected service and dashboard time range |

Each saved query includes descriptions, tags, metadata and a typed `service`
parameter. Queries were created before the dashboard through
`create_saved_query` and `create_dashboard`, then read back through MCP to
verify exact documents and versions. The request trend's final title was
updated with `update_dashboard` and the current ETag. Existing queries were
not replaced.

## Discovered coverage and semantics

The Cuttlefish Prometheus provider exposes `http_request_count_total` and
`http_request_duration_milliseconds_bucket` for `otel_scope_name="uptime-api"`
in the `service="telesis"` dataset. Metadata confirms a counter and a histogram
whose duration is already milliseconds. Tempo exposes matching
`resource.service.name="uptime-api"` traces.

The shared filter uses the same string value in those two different label
selectors. `brandbrain-api` is also a discovered API trace service, but has no
corresponding HTTP metrics in the configured providers. It is included as a
second service choice, with that coverage gap explicitly stated in the
dashboard description. Selecting it clears all HTTP values/charts and displays
its matching traces. Worker trace services are excluded from this HTTP view.

The 4xx and 5xx percentages remain separate. An absent error-class series can
become zero only relative to an observed total request rate. There is no
`or vector(0)` fallback: missing telemetry stays empty, and a zero-traffic
denominator leaves the percentage undefined. Latency quantiles are histogram
estimates; no milliseconds-to-seconds scaling is applied. Trace results are
bounded at 100 rows and the UI displays the provider-limit notice. A trace
sample is not used as a request count, nor described as an exhaustive list.

## Validation

The focused read-only validator is
`ui/e2e/insights-service-overview.e2e.mjs`. It passed seven scenarios against an
isolated real service/MCP fixture, then seven against the live dashboard.
The final live receipt is timestamped **2026-10-26T07:05:16Z** (18:05 Melbourne).
It recorded 40 metric-tool calls and five trace-tool calls, with no data-tool
errors, no legacy data calls and no browser errors.

- All eight widgets resolve their saved references to the expected provider,
  service literal, one-hour range and query step.
- Live metrics returned 301 samples. Stat values, precision and sparkline
  history match those samples; chart inspectors match exact observations.
- Both services returned matching Tempo traces. Selecting the trace-only
  service clears every prior metric value and sparkline.
- Light and dark themes passed at 1512px and 390px, without horizontal overflow.
  Rapid service changes settle on the final selection.
- The test makes no document writes. Dashboard/query bodies, ETags and saved
  service defaults remain unchanged during validation.
- Gateway counters confirm actual `query_metrics` and `query_traces` calls,
  with no legacy dashboard REST data calls and no browser errors.

Canonical documents, authoring receipts, query evidence, browser report and
screenshots are retained in `artifacts/insights/service-overview/`. This task
created saved workspace content; it required no application deployment.
