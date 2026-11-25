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
The initial live receipt is timestamped **2026-10-26T07:05:16Z** (18:05 Melbourne).
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

## Omega recovery and deployment, 26 October 2026

A subsequent master deployment (Helm revision 45, commit `2b2e2b47`) used a
chart without Insights and removed its Deployment, Service and PVC. The 10Gi
volume remained under its Retain policy. It was recovered by creating a claim
pinned to that exact volume and conditionally replacing the old claim UID.
The original four dashboards and thirteen saved queries were recovered;
the Service overview and its seven queries matched their original documents.

Revision 46 deployed the feature branch merged with master's login fix,
commit `4c718a95`. The existing volume is now mounted through
`insights.persistence.existingClaim`, outside Helm's deletion inventory.
Chart-created Insights PVCs also receive `helm.sh/resource-policy: keep`.
The Omega deployment workflow loads the Insights overlay and rejects a missing
or unbound claim before modifying the release. These workflow changes are on
the feature branch and must reach master to protect future master deployments.

Live testing also found that anonymous shared links stopped at an unavailable
screen without a sign-in action. Commit `5cc99039` adds a host authentication
callback: a current-session 401 clears stale credentials and returns through
login to the original dashboard, variables, time range and fragment. Concurrent
401s navigate once; a late response cannot sign out a newer session; 403 remains
a local permissions error. Standalone clients and anonymous examples retain
their existing behavior.

**Final Helm revision: 47, deployed.** All six components are ready. Its
manifest changes only the API/UI image from revision 46. OAuth registrations,
the original bound volume, and persisted documents remain intact.

| Component | Immutable image |
| --- | --- |
| API/UI (`5cc99039`) | `ghcr.io/paprikacd/paprika@sha256:fa848ce962d13f5e1d160d9fa2d3cbcda10db63d56cdf16a9fddc0e02f1e16bb` |
| Insights and Observe (`4c718a95`) | `ghcr.io/paprikacd/paprika@sha256:b7f52d75c86837b04c35890902b9984926522243abff47d47c8189704bf41b6b` |
| Manager, repo server, webhook (preserved) | `ghcr.io/paprikacd/paprika@sha256:2173b30a99a64c976aba5b609cd7d50875e90cc02868e8ed47d50e8645b0844c` |

Both full linux/amd64 builds passed:
[recovery build](https://github.com/paprikacd/paprika/actions/runs/40306746765)
and [sign-in fix](https://github.com/paprikacd/paprika/actions/runs/40308721872).

Final live acceptance completed at **21:45 Melbourne** (10:45 UTC):

- Seven service-overview E2E scenarios passed again on revision 47. This run
  recorded 42 real metric-tool calls and five trace-tool calls, zero legacy
  data calls, zero browser errors, and no document writes. All eight document
  bodies, ETags and saved variable defaults remained unchanged during testing.
- Four sign-in E2E scenarios passed: anonymous dashboard links, authenticated
  return with the service parameter, invalid stored sessions, and anonymous
  example mode. The authenticated handoff uses an isolated validation
  credential; it does not exercise Google's consent screen.
- 1,385 UI tests across 143 files and TypeScript checks passed. Go build/vet,
  required engine/pipeline tests, Insights/Observe/Prometheus/Tempo tests and
  API/MCP tests passed. Helm 3.21.2 lint/render checks, CRD generation/copy,
  workflow lint and positive/negative storage checks passed.

The control-plane health RPC remains degraded for the same pre-existing
application warnings seen before recovery: one degraded application and three
applications with exhausted release retries. Controller readiness and current
observed generations pass; this deployment did not address those workloads.

Receipts and screenshots are in
`artifacts/insights/service-overview-deploy-20261026/`, including
`deployment.json`, `report.json`, `login-return.json` and before-recovery
evidence. The reusable read-only sign-in validator is
`ui/e2e/insights-auth.e2e.mjs`, using the same private configuration as the
service-overview validator. Temporary validation credentials were removed.
