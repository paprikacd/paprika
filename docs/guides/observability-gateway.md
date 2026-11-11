# Observability Gateway

The observability gateway is Paprika's MCP surface for querying observability
backends — **logs, metrics, and traces** — through pluggable connectors. It runs
as its own microservice (its own Deployment in split mode, its own `--mode` in
the shared binary) and exposes:

```
https://<paprika-host>/observe/mcp
```

on the same hostname and TLS identity as the console (`/mcp` keeps serving the
fleet surface). Gateway tokens carry the **`paprika-observability`** audience and
the **`paprika:observe`** scope for reads. When Insights is configured, the separate
**`paprika:insights:write`** scope enables saved-query and dashboard authoring,
subject to the user's Insights RBAC permissions. A token minted for the console
or fleet MCP surface is not replayable here and vice versa — even though all
surfaces share the deployment's HMAC token secret.

For request budgets, scope boundaries, repeatable local checks, profiling and live
acceptance, see [validation guidance](observability-validation.md).

## Architecture

```
Claude/Codex → https://paprika.example.com/observe/mcp     (HTTPRoute, /observe)
                     │ h2c
                     ▼
       Deployment/<release>-observability-gateway
                     │  mcp.Server (RoutePrefix /observe, ScopeObserve + optional authoring,
                     │  console resource extensions disabled, own embedded
                     │  consent page at /observe/consent)
                     ▼
       internal/observabilitygateway.Backend
                     │  per call: get ObservabilityProvider CR
                     │  (namespace/name) → resolve credentialsSecretRef
                     ▼
       connector.New(type).Query(...)  (stateless; config travels per-request)
                     │
                     ▼
       prometheus / loki / tempo / otlp  (plain HTTP, no vendor SDKs)
```

- `internal/observabilitygateway/connector` — the connector framework:
  `Connector` interface (`Descriptor` / `ValidateConfig` /
  `Query`), a dup-rejecting `Registry`, signal/state/sentinel vocabulary that
  deliberately parallels `internal/clusterprovider` and `internal/dataprovider`
  (state strings OK/NotConfigured/NotAvailable/Error/Forbidden; sentinels
  `ErrForbidden` / `ErrNotConfigured` / `ErrUnsupported` / `ErrNotAvailable`).
- Connector errors never echo endpoints, credentials, or response bodies into
  tool results — users get fixed sentences, detail goes to the gateway log
  (clusterprovider sanitize discipline).
- Unsupported query shapes return a `StateNotAvailable` result plus an error
  wrapping `ErrUnsupported`; the backend returns the result and logs the error.

## Query backpressure and provider bulkheads

Paprika Observe now admits short bursts through bounded queues instead of
rejecting every query when execution is busy:

- MCP per-principal token buckets (50 requests/s, burst 100) permit up to 8
  queued requests per authenticated user and 64 globally, each waiting at most
  2 seconds. A canceled MCP call does not execute after disconnect.
- The observability backend permits **4 concurrent queries globally** and
  **2 concurrent queries per provider**, with at most 32 global waiters and 8
  per-provider waiters. Admission waits no longer than 5 seconds, while each
  execution retains its 30-second budget and any earlier caller deadline.
  These are the defaults. The `--observability-query-*` flags and the
  `observabilityGateway.capacity` chart values change them, and the gateway
  refuses to start on a combination that cannot work (see below).
- Insights permits **16 concurrent query executions** and up to **64 queued
  requests** waiting at most 2 seconds. `query_dashboard` executes distinct
  saved queries once and propagates the request deadline to providers.
- Overfull queues still return an explicit capacity error (429 / resource
  exhausted); holding a connection indefinitely would consume worker memory,
  create head-of-line blocking and hide provider outages.
- All limits are per process. Multiple replicas do not provide a single global
  cluster-wide queue; shared ordering across pods requires a separate durable
  scheduler, which is not appropriate for synchronous MCP requests.

Query results are returned synchronously. Queuing does not change OAuth scopes,
provider RBAC, saved dashboard versions or query timeout/error semantics.

### End-to-end capacity

A dashboard query passes eight hops between the browser and the provider. Each
row gives the hop's default limit, where it is configured, and what a caller
sees when the hop is full. The defaults are the values in code. A changed flag
or chart value replaces them, and the gateway validates the combination at
startup.

| # | Hop | Limit (default) | Configured in | When full, the caller sees | Retry |
|---|---|---|---|---|---|
| 1 | Browser scheduler (`createQueryScheduler`, `ui/src/features/insights/query.ts`) | 4 queries in flight per viewer, maximum 16 | Code only | Nothing is sent; further widgets wait in the local queue | n/a |
| 2 | Browser replay (`capacityRetryDelay`, `ui/src/features/insights/client.ts`) | A 429 on `/query`, a read or a conditional write is replayed up to 3 times, waiting Retry-After seconds. A wait over 10 s is not retried | Code only | After the replays fail the widget shows "Query failed" with a Retry button (`ui/src/features/insights/charts.tsx`) | Manual |
| 3 | Console API proxy (`insightsProxyRequestHandler`, `internal/api/insights_proxy.go`) | No admission limit. Response-header timeout 25 s (transport) and a 28 s request budget (`insightsProxyRequestHandler`); the header timeout cuts in first if Insights sends no headers. The console's connection cap is `--api-max-conns` (128) | Code; `--api-max-conns` | An unreachable or slow Insights gets **502** "Insights service is unavailable" | Yes, with backoff |
| 4 | Insights admission (`acquireQuery`, `internal/insights/server.go`) | 16 executing, 64 waiting, 2 s wait | Code only; a later slice adds flags | `/query`: **429** "too many active queries; retry shortly" with `Retry-After: 1`. Dashboard queries: a per-signal `rate_limited` error inside a 200 response, not an HTTP 429 (`dashboardProviderError`) | Yes, after Retry-After |
| 5 | Gateway HTTP admission (`observabilityAdmissionPool`, `limitObservabilityProtocolRequestsWith`) | Intake 8 (waiters cover all pool capacity), MCP work 4 (up to 32 waiting, the budget queue), catalog 4 and dashboards 2 (each up to its own size waiting). One deadline of 1 s covers the intake and pool waits | `--observability-http-*` flags; chart `observabilityGateway.capacity.http*` | **429** "observability gateway is at its request limit; retry later", `Retry-After: 1`, `Cache-Control: no-store` | Yes, after Retry-After |
| 6 | Gateway MCP rate limit (`mcpRatePerSecond`, `mcpRateBurst`, `mcpRateQueueWait` in `internal/api/mcp/ratelimit.go`) | 50 requests/s, burst 100 per principal. Queue: 8 per principal, 64 in total, each waiting at most 2 s | Code only | **429** "rate limit queue is full; retry shortly", `Retry-After: 1` | Yes, after Retry-After |
| 7 | Gateway execution budget (`DefaultBudgetConfig`, `executionBudget.begin`, `internal/observabilitygateway/budget.go`) | 4 executing across providers, 2 per provider. Queued: 32 across providers, 8 per provider. The admission cap is 36 (concurrency + queue). Per provider, the budget holds 2 running and 8 waiting, so 36 is reachable only across at least four providers (see below). A waiter holds its place for at most 5 s. Each execution has a 30 s budget that starts when it is admitted | `--observability-query-*` flags; chart `observabilityGateway.capacity.query*` | Queue full, reported as `resource_exhausted`. On REST (`/observe/api/query`) that is **429** `temporarily_unavailable` with `Retry-After: 1` (`writeDashboardError`). On MCP it is an error result with code `resource_exhausted` and no retry hint, text from `operationalToolErrorText`. Queue wait expired, or the 30 s budget used up, is a deadline error: **504** on REST, "tool execution timed out" on MCP | 429: yes, after Retry-After. 504: yes, with backoff, since the earlier attempt may have used provider time |
| 8 | Backend connector (`internal/observabilitygateway/connector/…`) | Per-connector client timeouts: Shorted `queryTimeout` 10 s (`connector/shorted`), Uptime `queryTimeout` 20 s (`connector/uptime`), PostgreSQL connect 5 s (`connector/postgresql`). The 30 s budget applies to all of them | Code only | A provider failure is a sanitized error state in the result, or **502** `server_error` on REST. Insights passes a gateway 504 through as 504 without Retry-After (`observeHTTPError`) | Yes, with backoff |

**What each hop's wait costs.**

- **Edge (hops 5 and 6).** The intake and pool waits share one deadline of
  `--observability-http-admission-wait` (1 s by default), measured from the start
  of the handler. A request that is refused there has waited at most that long.
  The MCP rate queue (hop 6) runs after edge admission and adds at most 2 s.
- **Budget (hop 7).** A query waits at most `--observability-query-queue-wait`
  (5 s) for a slot. The 30 s execution budget starts when the query is admitted,
  so after a wait its execution time is still a full 30 s. Over REST the dashboard
  handler applies its 30 s to the whole request, queue wait included.
- **Per MCP request, worst case:** admission wait + 2 s rate queue + queue wait +
  30 s execution. At defaults that is 38 s. The validator requires the sum to
  stay at or below 40 s, which leaves 5 s to read, serialise and write the
  response before the 45 s HTTP write timeout.
- **Per Insights `/query`, worst case:** the console proxy ends a UI query at
  28 s, whatever the gateway is doing, and its 25 s response-header timeout cuts
  in earlier when Insights has sent no headers. Insights' own write timeout is
  30 s (`cmd/paprika-insights/main.go`), so the proxy's 28 s decides. Inside that
  budget Insights holds a query for at most 2 s at hop 4, and each provider
  connection it opens has a 20 s budget (`observe_mcp.go`).
- **Disconnects.** Once a request's body has been read, a client that leaves
  while the request waits for its pool is noticed at once, because the server
  then watches the connection. A request that is still waiting for an intake
  slot, before its body is read, is noticed only when that wait ends, which is
  at most the admission wait. A body larger than the classification limit is
  read only in part, so the same applies to it. REST POST bodies
  (`/observe/api/query`, `/observe/api/explore`) are read the same way as MCP
  bodies, so a departed client is noticed at the same point for both.

**What is coupled to what.**

- **Dashboard pool** is `min(2, --observability-query-concurrency)`. It serves
  `query_dashboard` and `render_dashboard`, which run nested data requests, and
  it does not follow the per-provider flag.
- **36 is not one provider's capacity.** The edge admits 36 data requests, but
  the budget holds 2 running and 8 waiting per provider. With one provider, 10
  are admitted and the rest get `resource_exhausted`. The budget holds all 36
  only when load spreads across at least four providers (4 x 10 = 40).
- **Listing shares a bulkhead.** Every Insights Observe query first lists
  providers, under one shared `catalog` bulkhead (2 running and 8 waiting, plus
  a global slot). So 36 simultaneous listings run 10 and refuse 26.
- **Provider listing** (`ListProviders`) runs under the `catalog` pseudo-provider's
  bulkhead, which is sized by the per-provider flag. Setting
  `--observability-query-provider-concurrency=1` therefore also runs listings one
  at a time.
- **Catalog pool** is the work pool's size by default. Each Insights provider
  query opens two MCP connections, resolve and data (`observability_provider.go`).
  Each connection's `initialize`, `notifications/initialized` and `tools/list`
  requests, and the `list_observability_providers` call, are classified as
  catalog requests (`isObservabilityCatalogEnvelope`). Only the data `tools/call`
  uses the work pool. Keep the catalog pool large enough for handshakes while
  queries run.
- **Intake** is held only while a request body is read and classified, then
  released before the pool wait. It is not a cap on all in-flight requests. Its
  default is twice the work pool.
- **Work pool and its edge queue.** The work pool may be sized up to query
  concurrency + queue, beyond which the budget would refuse first. Its edge
  waiters equal the budget queue. A request that arrives while 4 are running and
  32 are waiting is refused at once, which is the edge's 37th. Intake's waiters
  cover all pool capacity, so intake does not refuse first. Each request still
  waits at most `--observability-http-admission-wait` (1 s) for a slot. The
  experiment behind this (the Insights-shaped burst) models only this HTTP edge,
  with a fixed 500 ms provider time and no execution budget, so it shows the edge
  admitting 36 queries in time. Real provider times and per-provider limits
  turn part of a burst into 429s, as the listing and per-provider notes above
  describe. With the queue at 0 the work
  pool fails fast, which matches the budget. Catalog and dashboard pools keep
  waiters equal to their size.

**Sizing a board.** Let N be the number of distinct queries on a dashboard,
R the refresh interval in seconds and T the mean provider time per query in
seconds (measure T on your provider). The board asks for about N / R queries per
second. One provider can serve about (provider concurrency) / T of those per
second, which is 2 / T at defaults, and all providers together about 4 / T.
Keep N / R comfortably below the capacity of the providers the board uses. Each
viewer can run 4 queries at once (hop 1), so several viewers multiply the demand
on the shared gateway. Duplicate queries on one dashboard run once
(`query_dashboard` executes distinct saved queries once), so N counts distinct
queries.

**Changing capacity.** Raise the budget first, then the pools, or set pools to 0
and let them follow. The gateway refuses these combinations at startup, naming
the flag to change:

- query concurrency between 1 and 1024; provider concurrency between 1 and query
  concurrency (0 means min(2, concurrency));
- queue between 0 and 65536; provider queue between 0 and the queue. With queue
  0, set the provider queue to 0 too, because its default of 8 would exceed it;
- queue wait above 0 and below the 30 s request timeout;
- admission wait between 0 and 5 s, and no longer than the queue wait;
- admission wait + 2 s + queue wait + 30 s at most 40 s, leaving 5 s before the
  45 s write timeout;
- queue wait and admission wait are either zero or at least 1 ms;
- work pool no larger than query concurrency + queue;
- dashboard pool no larger than query concurrency;
- every pool between 0 and 65536, where 0 follows its rule.

**Units in config files.** Flags, environment variables and the chart use
duration strings such as `5s`. A `--config` file uses the flag names as keys:

```yaml
observability-query-queue-wait: 5s
observability-http-admission-wait: 1s
```

A bare integer such as `5` is read as nanoseconds, so it is refused at startup
(below 1 ms) with a message that suggests a unit. In the chart, `httpAdmissionWait`
accepts `0`, `"0s"` or a unit-bearing string; `0` rejects at once.

The gateway logs the resolved budget and pools at startup, with the source of
each derived value (`Observability gateway capacity`). The chart renders these
values as `--observability-*` arguments on the gateway container
(`charts/chart/templates/observability-gateway/deployment.yaml`).

## The MCP surface

Fifteen provider tools, all read-only and requiring `paprika:observe`:

| Tool | Purpose |
|---|---|
| `list_observability_providers` | List `ObservabilityProvider` CRs (name, type, state) |
| `get_observability_provider` | One provider's descriptor (signals it supplies) |
| `query_logs` | LogQL query (loki/otlp connectors) |
| `query_metrics` | PromQL instant/range query (prometheus/otlp) |
| `query_traces` | TraceQL search or `trace_id` fetch (tempo/otlp) |
| `query_records` | Bounded typed rows from Shorted, Uptime or read-only PostgreSQL |
| `list_metric_names` | Enumerate a metrics provider's metric names (`prefix`/`limit` filters) |
| `list_metric_series` | Bounded metric series/label sets in a time range; supports approximate cardinality inspection |
| `list_label_names` | Label names — globally or on one `metric` (prometheus/loki/tempo tags) |
| `list_label_values` | One `label`'s values, optionally constrained to a `metric` |
| `get_metric_metadata` | One metric's type/help/unit (prometheus `/api/v1/metadata`) |
| `list_trace_services` | Service names a tempo provider has spans for |
| `list_provider_types` | The provider-type catalog (library view) |
| `describe_provider_type` | One type's config schema + onboarding walkthrough |
| `validate_provider` | Offline syntax validation of prospective provider configuration |

Metric, label and trace-service exploration accepts optional RFC 3339 `start`
and `end` bounds. Series enumeration defaults to the trailing thirty minutes;
explicit windows are limited to 31 days. A bounded series sample is not a
global active-series count. Insights consumes the supported Prometheus/Tempo
tools through this MCP endpoint using the signed-in user's delegated access.

Insights also uses `query_records` for application and SQL dashboards. These
providers can project numeric columns through `query_metrics`; inventories do
not become historical series unless the source supplies timestamps. See the
[repository example library](dashboard-repository-examples.md) and the
[Shorted](shorted-provider.md), [Uptime](uptime-provider.md) and
[PostgreSQL](postgresql-provider.md) adapter contracts.

When Insights is configured, the same MCP endpoint additionally exposes:

| Tool | Required scope | Purpose |
|---|---|---|
| `list_insights_providers` | `paprika:observe` | Discover provider IDs used in saved UI documents |
| `get_insights_schema` | `paprika:observe` | Discover canonical dashboard, widget or saved-query JSON Schema and examples |
| `list_saved_queries`, `get_saved_query` | `paprika:observe` | Read saved queries and their ETags |
| `list_dashboards`, `get_dashboard` | `paprika:observe` | Read shared dashboards and their ETags |
| `query_dashboard` | `paprika:observe` | Execute a saved dashboard and read compact, versioned live signals with optional variable overrides |
| `create_saved_query`, `create_dashboard` | `paprika:observe` + `paprika:insights:write` | Create a new shared document without replacing an existing ID |
| `update_saved_query`, `update_dashboard` | `paprika:observe` + `paprika:insights:write` | Update a document using the exact ETag from its latest read |
| `patch_saved_query`, `patch_dashboard` | `paprika:observe` + `paprika:insights:write` | Edit selected fields and dashboard widgets by ID, atomically against the current ETag |

All document tools also enforce the user's global `insights` read/write RBAC.
The authoring scope grants no fleet operations or provider configuration.
Existing `paprika:observe` tokens remain read-only, including on refresh;
authoring requires a fresh native OAuth grant that explicitly requests the new
scope. An omitted-scope authorization request retains the read-only default.
Create saved queries before dashboards that reference them, and preserve typed
parameters and bindings. A stale update returns a conflict: reread the document
and reconcile the intended edit instead of issuing a wildcard overwrite.

Start authoring with `get_insights_schema` (`kind`: `dashboard`, `widget`, or
`saved_query`). It returns the deployed Insights service's full JSON Schema,
examples and semantic-validation notes. For small changes, prefer
`patch_saved_query` or `patch_dashboard`: nested objects merge, `null` removes a
field, and arrays replace in full. Dashboard widgets use `widget_edits` with
`add`, `update` or `remove` operations addressed by stable widget ID. A batch is
validated and persisted once; any invalid edit or ETag conflict leaves the
document unchanged. See the [targeted authoring contract](../design/insights/targeted-authoring.md).

The tools use the same persistent Insights service as the UI. Open workspaces
refresh externally saved changes while protecting unsaved local drafts.
Provider credentials and the Insights service token never enter tool responses.
`query_dashboard` resolves the same saved-query bindings as the UI and executes
identical panel queries once. Its structured result contains latest readings,
range summaries, a bounded trace sample, document ETags and explicit
missing/error/truncation states. History is opt-in; service overrides never
modify saved defaults. Data availability is not a service-health verdict.
See the [dashboard query contract](../design/insights/dashboard-query.md) for
limits, examples and interpretation.
See the [Observe plugin](../../plugins/paprika-observe/README.md) for connection
and authoring guidance.

The five exploration tools answer in the backend's own JSON envelope
(`{"status":"success","data":[...]}` for prometheus/loki, `{"tagNames":[...]}`
/ `{"tagValues":[...]}` for tempo) so a caller can explore a backend and then
query what it found without learning a gateway dialect. Exploration is an
optional connector capability (`connector.Explorer`) implemented per provider,
each mapping the generic kinds onto its own native discovery mechanism:

| Provider | metric_names | label_names | label_values | metric_metadata | trace_services |
|---|---|---|---|---|---|
| prometheus | `/api/v1/label/__name__/values` (+ prefix/limit) | global `/api/v1/labels`, or per-metric via `/api/v1/series` union | global or per-metric series union | `/api/v1/metadata` | — |
| loki | — | `/loki/api/v1/labels` | `/loki/api/v1/label/x/values` | — | — |
| tempo | — | `/api/search/tags` | `/api/search/tag/x/values` | — | `service.name` tag values |
| aws-cloudwatch-metrics | `ListMetrics` (optional `namespace` arg; paginated) | dimension-name union from ListMetrics | dimension-value union for a label | — (no metadata API) | — |
| aws-cloudwatch-logs | `DescribeMetricFilters` | — | — | — | — |
| aws-xray | — | — | — | — | `GetServiceGraph` (trailing 30 min) |
| aws-cloudtrail | — | static LookupAttributes catalog | — | — | — |
| gcp-cloudmonitoring | `metricDescriptors.list` (`starts_with` prefix filter) | descriptor `labels[].key` union | — (values not enumerable) | exact descriptor passthrough | — |
| gcp-cloudlogging | `logMetrics.list` | — | — | — | — |
| vultr-monitoring | static catalog (`account_bandwidth`, `instance_bandwidth_in/outgoing_bytes`) | static `instance_id/label/region/status` | live `GET /v2/instances` union | static type/help/unit per catalog metric | — |
| gcp-cloudtrace, otlp, mock* | — → `StateNotAvailable` | — | — | — | — |

\* mock implements every kind from a fixed synthetic catalog (e2e stays
hermetic). A provider type answering `StateNotAvailable` returns a fixed
sentence naming the missing capability — data, not an error. The optional
`namespace` argument is read by the CloudWatch metrics connector only.

Tool args take `provider` as `namespace/name`. `start`/`end` are RFC3339
(default: last 30 minutes); `limit` defaults vary by connector.

OAuth 2.1 + PKCE, RFC 7591 dynamic client registration, and RFC 9728/8414
discovery all work exactly like the fleet MCP surface, under `/observe/*`:

- `GET /.well-known...` — served at `/observe/.well-known/oauth-protected-resource`
  and `/observe/.well-known/oauth-authorization-server` (the 401 challenge's
  `resource_metadata` points there; the host-root well-knowns remain the
  console surface's).
- Consent: browsers are redirected to `/observe/consent`, a minimal
  self-contained page embedded in the gateway binary. Unifying it with the
  branded console consent page is follow-up work.

## Configuring providers

`ObservabilityProvider` is a namespaced CR (group
`observability.paprika.io`):

```yaml
apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: prometheus
  namespace: paprika-e2e
spec:
  type: prometheus                     # prometheus | loki | tempo | otlp |
                                       # gcp-cloudlogging | gcp-cloudmonitoring | gcp-cloudtrace |
                                       # aws-cloudwatch-logs | aws-cloudwatch-metrics |
                                       # aws-xray | aws-cloudtrail
  config:
    endpoint: http://kube-prometheus-stack-prometheus.monitoring:9090
  # credentialsSecretRef:             # optional
  #   name: grafana-cloud-token       # namespace/key optional (default: CR ns, "credentials")
```

- `spec.config` is opaque per-connector JSON, validated at admission by the
  connector itself (webhook `rejectInlineCredentials` refuses literal
  token/password keys anywhere in the document; put credentials in a Secret).
- `spec.credentialsSecretRef` document: nil = no auth; otherwise the secret
  `data[key]` is sent as `Authorization: Bearer <value>`, or HTTP Basic when it
  contains `user:password`.
- The referenced Secret must be labelled
  `observability.paprika.io/credentials=true`. The gateway's service account
  can read far more than provider credentials, and whoever writes a provider
  chooses both the Secret and the endpoint it is sent to, so only Secrets
  opted in by label are ever read; any other reference reports
  `NotConfigured`. `CreateObservabilityProvider` labels the Secret it creates;
  label Secrets you create yourself:
  `kubectl label secret <name> -n <ns> observability.paprika.io/credentials=true`.
- A Secret in another namespace (`credentialsSecretRef.namespace`) is read only
  for a caller authorized for providers in that namespace. The status prober
  acts for no caller, so such a provider reports `NotConfigured` in status
  while authorized queries still work.
- `endpoint` (absolute http(s) URL) is the one universal config key; unknown
  keys fail validation (typo fail-fast). Optional keys:
  - `headers` — map of extra request headers (≤16 entries, ≤4 KiB combined):
    vendor tenancy like Loki/Grafana/Mimir `X-Scope-OrgID`. Operator-declared
    headers win `Authorization` collisions (documented + tested).
  - `insecureSkipTLS` — bool, for self-signed in-cluster backends only (never
    off-cluster; per-config client so verified/unverified TLS sessions never
    share connection pools).
  - `step` — prometheus-only range-query step override (Go duration, >0, ≤1h;
    otherwise derived as max(10s, span/250)).

### Connector specifics

| type | signals | query behavior |
|---|---|---|
| `prometheus` | metrics | PromQL; range (start+end) → `/api/v1/query_range` with computed step, instant otherwise |
| `loki` | logs | LogQL → `/loki/api/v1/query_range`; limit default 100, max 1000 |
| `tempo` | traces | `trace_id` → `/api/traces/<id>`; TraceQL → `/api/search` |
| `otlp` | logs, metrics, traces | Generic OTLP/HTTP retrieval proxy: `GET <endpoint>/v1/{logs,metrics,traces}` with `trace_id`/`start`/`end`/`limit` params when set |
| `gcp-cloudlogging` | logs | Query = Cloud Logging [advanced filter](https://cloud.google.com/logging/docs/view/logging-query-language); empty → probe (`entries:list`, 1 entry) |
| `gcp-cloudmonitoring` | metrics | Query = [Monitoring filter](https://cloud.google.com/monitoring/api/v3/filters); window required (defaults to trailing hour); empty → probe (`metricDescriptors`, 1 row) |
| `gcp-cloudtrace` | traces | `trace_id` → one trace; Query = optional list filter; empty → probe (1 trace) |
| `aws-cloudwatch-logs` | logs | Query = CloudWatch [filter pattern](https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/FilterAndPatternSyntax.html) (empty = all events); config `logGroup` required; probe = 1 event |
| `aws-cloudwatch-metrics` | metrics | Query = metric name in config `namespace` (required); period derived from window (clamped 60–3600s, Average/Sum/Maximum); empty → probe (`ListMetrics`) |
| `aws-xray` | traces | `trace_id` → `BatchGetTraces`; Query = X-Ray [filter expression](https://docs.aws.amazon.com/xray/latest/devguide/xray-console-filters.html) (empty = all); probe = summaries, trailing 10 min |
| `aws-cloudtrail` | audit | Query = comma-separated `Key=Value` lookup attributes (e.g. `EventName=RunInstances,EventCategory=Activity`), empty = all; limit ≤ 50; probe = 1 event |
| `mock` | metrics, logs, traces | Synthetic in-process backend for load tests, demos and e2e — no network egress. Config knobs (all optional, bounded): `series`, `pointsPerSeries`, `labelsPerSeries`, `logEntries`, `traces`, `spansPerTrace` (payload shape), `latencyMs` (context-aware synthetic latency), `failEvery` (deterministic stable error subset — every Nth distinct query string), `seed` (deterministic generator seed; identical query + seed = identical data) |

### Perf testing with the mock connector

`hack/obsloadgen` drives the gateway's MCP surface with N concurrent clients
(one self-signed `paprika-observability` token each — distinct subjects so
the per-subject rate limiter binds no client but its own), and
`task perf:obs-*` wraps the loop for the kind perf stack:

```sh
task perf:obs-seed COUNT=50        # seed varied mock providers (idempotent)
task perf:obs-load SECS=60 CLIENTS=32 RPS=5
task perf:obs-profile SECS=30      # combined load + pprof capture
task perf:obs-metrics              # gateway /metrics + kubectl top
```

**Grafana Cloud** uses the same three native connectors with the Grafana Cloud
endpoint and an API token as `credentials`, e.g.:

```yaml
spec:
  type: prometheus
  config:
    endpoint: https://prometheus-prod-01-us-west1.grafana.net/api/prom
  credentialsSecretRef:
    name: grafana-cloud   # Secret labelled observability.paprika.io/credentials=true
```

### Cloud connectors (GCP and AWS)

The seven cloud connectors share the same CR shape; what changes is the
credential document and the config keys:

- **AWS** (`aws-cloudwatch-logs`, `aws-cloudwatch-metrics`, `aws-xray`,
  `aws-cloudtrail`) — `spec.credentialsSecretRef` holds the same snake_case
  JSON the EKS cluster provider accepts:
  `{"access_key_id": "...", "secret_access_key": "...", "session_token": "..."}`.
  Omit the ref entirely to use the ambient SDK chain (IRSA / IMDS /
  environment). Config keys: `region` (required), plus the connector's
  required selector (`logGroup` for logs, `namespace` for metrics), plus
  optional `endpoint` (VPC endpoints / in-cluster emulators — the SDK
  sends to it verbatim) and `insecureSkipTLS`.
- **GCP** (`gcp-cloudlogging`, `gcp-cloudmonitoring`, `gcp-cloudtrace`) —
  the secret holds a Google credential JSON restricted to `service_account`,
  `external_account` or `impersonated_service_account` (type-checked before
  loading, same as the GKE cluster provider); omit it for ambient identity
  (GKE Workload Identity / metadata server). Config keys: optional
  `projectId` (defaults to the credential's project), optional `endpoint`
  (private proxies / fakes — replaces the `*.googleapis.com` base),
  `insecureSkipTLS`.
  - Ambient identity is the gateway's own, so it is sent only to an `https`
    `*.googleapis.com` endpoint with TLS verification on. A provider with no
    credential Secret and any other `endpoint`, or `insecureSkipTLS`, reports
    `NotConfigured` and sends nothing; give such a provider its own
    credential Secret.
  - In `external_account` and `impersonated_service_account` documents,
    `token_url`, `token_info_url` and `service_account_impersonation_url` must
    be `https` `*.googleapis.com` URLs, `universe_domain` must be empty or
    `googleapis.com`, and `credential_source.executable` is refused. These
    fields decide where x/oauth2 posts subject and access tokens; it does not
    validate them itself.

Empty connector queries are used internally for small health reads. Prospective
`validate_provider` and the console's **Validate configuration** action only check
syntax and never send credentials or make backend requests. Establish connectivity
by querying an approved provider with explicit bounds.

E2E coverage runs in kind: LocalStack serves CloudWatch Logs + Metrics
(X-Ray and CloudTrail are license-gated there, so those two run against a
canned nginx responder), and a JWT-issuing nginx fake serves the GCP REST
shapes with a runtime-generated service-account key — see
`test/e2e/observabilitycloud_test.go`.

## Enabling the gateway

Check the installed release and source chart versions before upgrading the main
release. When the installed chart is newer, use the separate
[gateway-only Helm add-on](observability-addon.md) to preserve its controllers
and resources. Its render-only helper emits three resources and keeps public
routing disabled unless explicitly requested and approved.

```sh
helm upgrade paprika-e2e charts/chart/ \
  --namespace paprika-e2e --values deploy/test-values.yaml \
  --values deploy/omega-values.yaml \
  --set observabilityGateway.enabled=true --wait --timeout 5m
```

Preconditions enforced at render time (`helm template` fails otherwise):
`deploymentMode: split`, `auth.enabled`, a non-empty
`PAPRIKA_AUTH_TOKEN_SECRET` via `observabilityGateway.extraEnv(From)`, and
`mcp.publicURL`. A preconfigured OAuth client is optional for the gateway: leave
both `mcp.oauth.clientId` and `mcp.oauth.redirectUris` empty for dynamic
registration only, or provide both for an approved static client. Partial
configuration is rejected. Rendering and DCR-only startup configure no persistent
client; native OAuth sign-in and client-access approval are separate actions.
The shared `mcp` configuration fields do not require `mcp.enabled`: that switch
controls the independent fleet MCP surface and may remain disabled.
Public exposure reuses the api-server's Gateway/hostname:

```yaml
observabilityGateway:
  enabled: true
  ingress:
    enabled: true     # HTTPRoute: path prefix /observe → gateway Service
```

Verify:

```sh
curl -s https://paprika.benebsworth.com/.well-known/oauth-protected-resource/observe/mcp | jq .
# { "resource": "https://paprika.benebsworth.com/observe/mcp",
#   "authorization_servers": ["https://paprika.benebsworth.com/observe"],
#   "scopes_supported": ["paprika:observe", "paprika:insights:write"] }
# The authoring scope is present only when Insights is configured.
```

For providers signed by a CA outside the system trust bundle, configure
`observabilityGateway.additionalCACertificates` as a map of `.crt` or `.pem`
filenames to public PEM CA certificates (one certificate per file). The chart
creates a ConfigMap, mounts it read-only at
`/etc/paprika/additional-ca-certificates`, and includes its contents in the
gateway pod checksum so certificate updates roll out automatically. This is
gateway-wide trust for all its connectors; include only CAs approved for that
scope. Provider hostname verification remains enabled.

`SSL_CERT_DIR` includes `/etc/ssl/certs`, `/etc/pki/tls/certs`, and the added
directory. The default system certificate file is unchanged. Do not also set
`SSL_CERT_DIR` in `observabilityGateway.extraEnv`; the chart rejects ambiguous
configuration. Private keys and provider credentials belong in their existing
Secret references, never in this public certificate map. Omitting the map leaves
the gateway's default trust configuration unchanged.

## Autodiscovery from in-cluster Services

Backends running in the same cluster can register themselves without anyone
hand-writing provider YAML. The provider-discovery controller
(`internal/controller/observe`) watches Services carrying the opt-in
annotation and materializes each as an `ObservabilityProvider` CR in the
Service's namespace. It runs in the observability gateway pod itself (a
dedicated controller-runtime manager alongside the MCP server, single
replica with leader election off), so discovery works even where only the
observability microservice is installed; the pipeline manager also
registers the reconciler, and dual-running converges safely:

```yaml
metadata:
  annotations:
    observability.paprika.io/discover: "true"
```

Type and endpoint are inferred from the Service: the connector type comes
from the Service name (`prometheus`, `loki`, `tempo`, `otel` substrings — so
`prometheus-operated`, `loki-gateway`, `tempo-query-frontend`, and
`otel-collector` all just work), the port from each type's well-known port
names (`http-web`/`web`/`http`, `http-metrics`, `otlp-http`, …) falling back
to the first declared port, and the endpoint is
`http://<service>.<ns>.svc:<port>`. Inference overrides:

| Annotation | Effect |
|---|---|
| `observability.paprika.io/type` | explicit connector type (`prometheus`/`loki`/`tempo`/`otlp`) when the name matches nothing |
| `observability.paprika.io/port` | explicit port number (invalid values hard-reject the Service) |
| `observability.paprika.io/path` | base path appended to the endpoint (e.g. Prometheus behind `/prometheus`) |

Ownership rules keep the CR-as-system-of-record invariant:

- Discovered CRs are labeled `observability.paprika.io/discovered: service`
  and owned by the Service — deleting the Service or removing the
  annotation garbage-collects the provider.
- The controller converges type/endpoint drift on labeled CRs but **never
  touches a CR without the label** — dropping the label from a discovered
  provider hands it to the operator permanently, and an operator-written CR
  of the same name is never deleted or modified.
- Discovered providers have no credentials (in-cluster backends are usually
  unauthenticated); edit the CR to add `credentialsSecretRef` (to a labelled
  Secret) and it still converges endpoint changes around your edit.

Example — everything kube-prometheus-stack + loki + tempo need:

```sh
kubectl annotate svc prometheus-operated -n monitoring observability.paprika.io/discover=true
kubectl annotate svc loki-gateway -n monitoring observability.paprika.io/discover=true
kubectl annotate svc tempo-query-frontend -n tracing observability.paprika.io/discover=true
kubectl get observabilityproviders -A
```

## Provider status

The gateway is also the writer behind the provider board's STATE column: its
status prober re-runs the catalog's per-type health probe — the cheapest read
each backend accepts, the same probe the onboarding wizard's **Test
connection** runs — against every registered provider on
`--obs-provider-probe-interval` (chart `observabilityGateway.probeInterval`,
default `5m`; `0` disables status writes) and patches the verdict onto each
CR's `status`: `state` (`OK`/`NotConfigured`/`NotAvailable`/`Error`/
`Forbidden`), a fixed-sentence `reason` that never carries credential or
endpoint detail, `observedGeneration`, and a `Ready` condition mirroring the
state. The probe resolves credentials through the same path a query does, so
status shows what a query would experience right now; `kubectl get
observabilityproviders` and the console's provider board read the same
fields.

## Managing providers in the console

The dashboard's **Observability** page (`/dashboard/observability/`, listed
under *Sources* in the sidebar) renders three boards:

- **Provider library** — every provider type the gateway can connect to
  (OSS + GCP + AWS), served from the gateway's catalog: vendor, category,
  signals, and a one-line summary per type.
- **Providers** — every `ObservabilityProvider` (name, type, signals,
  endpoint, state, discovery provenance). Discovered providers carry a
  DISCOVERED pill; states map to the console's status tones.
- **Tool usage** — per-tool call/error counters maintained by the gateway's
  usage tracker and served from its authenticated `/observe/api/usage`
  endpoint. The api-server proxies it over `GetObservabilityUsage` (minting
  a short-lived `paprika-observability` token per call); when the gateway is
  not deployed the board renders the canonical "not configured" sentence
  instead of zeros.

Selecting **Set up** on a library card opens the onboarding wizard. Its
**Validate configuration** action calls `ValidateObservabilityProvider` for offline
syntax checks and does not establish backend access. **Create provider** is a
separate administrative operation that creates the provider CR and, when explicitly
supplied through the secure administration flow, its credential Secret. Creation
requires the console's `write` action on `observabilityproviders` in the target
namespace. Workload identity avoids a static credential document.

The same data is available programmatically:
`PaprikaService.ListObservabilityProviderTypes`,
`GetObservabilityProviderType`, `ValidateObservabilityProvider`,
`CreateObservabilityProvider`, `ListObservabilityProviders`, and
`GetObservabilityUsage`. On the MCP surface, agents get `list_provider_types`,
`describe_provider_type`, and `validate_provider` alongside the query tools.

## Linking providers to Applications (future)

The v1 CRD is deliberately shaped for a follow-up binding CR
(`DataProviderBinding`-style scope precedence: application > namespace >
cluster) that will attach providers to Applications so the console view layer
and deployment pages can surface logs/metrics/traces per app. The gateway
itself is agnostic to that: tools already accept any `namespace/name` provider.

## Files

- `cmd/main_observability_gateway.go` — the `--mode=observability-gateway` runner
- `internal/observabilitygateway/` — backend (CR + credential resolution), MCP tools, catalog/validate HTTP handlers, consent page, `New(providerType)` connector registry
- `internal/observabilitygateway/connector/` — connector framework + registry
- `internal/observabilitygateway/connector/{prometheus,loki,tempo,otlp}/` — the OSS connectors
- `internal/observabilitygateway/connector/{awscommon,awscloudwatchlogs,awscloudwatchmetrics,awsxray,awscloudtrail}/` — AWS connectors (SDK v2, snake_case key JSON or ambient chain)
- `internal/observabilitygateway/connector/{gcpcommon,gcpcloudlogging,gcpcloudmonitoring,gcpcloudtrace}/` — GCP connectors (x/oauth2 service-account/external_account/impersonated JSON or ambient, hand-rolled REST)
- `internal/observabilitygateway/catalog/` — the provider-type library (metadata, config-field specs, onboarding steps, probes)
- `internal/api/mcp/` — the shared MCP server (route prefix / audience / scope generalization lives here)
- `api/observability/v1alpha1/` — the `ObservabilityProvider` CRD
- `internal/webhook/observability/v1alpha1/` — admission validation
- `charts/chart/templates/observability-gateway/` — Deployment/Service/HTTPRoute/HPA/VPA/PDB

## Dashboard and query integration

Paprika Insights consumes the same authorized provider backend as the MCP tools.
The gateway exposes `GET /observe/api/providers`, `POST /observe/api/query` and
`POST /observe/api/explore` for this integration. These routes require an
Observe-audience bearer token and `paprika:observe`, then enforce the caller's
namespace RBAC before reading providers or credential Secrets. HTTP and MCP
requests share the connector concurrency budget and bounded response limits.

The query route accepts a canonical `namespace/name` provider, signal, native
query, RFC3339 start/end, optional `stepSeconds`, limit and supported pagination
fields. Windows are bounded to 31 days; metrics steps must be at least one
second and produce at most 11,000 points. `query_metrics` accepts the equivalent
`step_seconds` argument. Native response JSON and explicit provider outcome
states are preserved. Exploration adds bounded metric series and Tempo tags,
including truncation indicators, for label cardinality and editor completion.

Insights only advertises Prometheus and Tempo adapters, maintains stable IDs
from the full provider namespace/name, and normalizes results for existing
widgets. Its API proxy mints a 30-second token for the authenticated human;
it never queries as a shared service account. OAuth authorization and refresh
also retain exact group membership. See the
[Insights integration guide](../design/insights/README.md#shared-observability-mcp-providers).
