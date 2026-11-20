# Paprika Insights service

Insights is a separate process and deployment. The Paprika UI talks to
`/api/insights/` on the existing API origin; that proxy authenticates the user
with Paprika's existing Basic/OIDC/token authenticators and checks the global
`insights` RBAC resource. It then sends an independent service token to Insights.
Public provider listings omit endpoints and credentials. Administrators can
inspect endpoint URLs and credential environment-variable references; resolved
credentials are never returned to the browser.

## Run

```sh
# Set PAPRIKA_INSIGHTS_TOKEN securely in both service environments (32+ characters).
go run ./cmd/paprika-insights \
  --listen=127.0.0.1:8090 \
  --data-dir=./data/insights \
  --providers=./providers.json

# On the main Paprika API process:
export PAPRIKA_INSIGHTS_URL=http://127.0.0.1:8090
```

`--dev` disables service authentication and requires an explicit loopback listen
address. Use it only for direct local development; the Paprika proxy always
requires a configured service token. Do not put the token in a frontend
environment variable. Health endpoints are `/healthz` and `/readyz`.

Provider configuration:

```json
{
  "providers": [
    {
      "id": "prometheus",
      "name": "Production metrics",
      "type": "prometheus",
      "url": "http://prometheus.monitoring.svc.cluster.local:9090"
    },
    {
      "id": "tempo",
      "name": "Production traces",
      "type": "tempo",
      "url": "http://tempo.monitoring.svc.cluster.local:3200",
      "bearerTokenEnv": "TEMPO_TOKEN",
      "headersEnv": { "X-Scope-OrgID": "TEMPO_TENANT" }
    }
  ]
}
```

Credential environment variables must exist when specified. Both adapters accept
an administrator-configured URL prefix. Redirects are refused. Query errors do
not expose upstream response bodies or internal URLs. Prometheus-compatible
backends can use the `prometheus` adapter; trace search currently targets Tempo's
TraceQL search API.

Set `PAPRIKA_OBSERVABILITY_GATEWAY_ADDR` on the Insights process (or
`Config.ObservabilityURL`, JSON `observabilityUrl`) to the observability
gateway origin to share its Prometheus and Tempo providers with Insights. The
API proxy supplies a fresh caller token in `X-Paprika-Observe-Token`; Insights
uses that token only as the gateway bearer token, independently of its own
service authentication. Missing delegation is denied, including in development
mode. Provider discovery, queries, connection tests, metadata and saved-query
validation all resolve the current caller's authorized catalog through
the gateway's REST routes on the configured origin (`observe_rest.go`):
`GET /observe/api/providers` for the catalog, `POST /observe/api/query` for
queries and `POST /observe/api/explore` for metadata, each with the caller's
delegated bearer. One HTTP request shares a single catalog listing across all of
its operations, so a widget query costs two gateway requests (one listing and one
data call). No catalog is retained across requests, so removing access takes
effect on the next request. Redirects are refused, and bodies are bounded before
decoding. MCP remains only for the Data sources status (`/api/observe-connection`),
which discovers read-only tools and the protocol version. Each shared gateway
request is capped at 20 seconds and at the time left on its request's own deadline, so a
dashboard keeps its 22-second budget. `/providers` has a 20-second budget end to
end, inside the API proxy's 25-second response-header timeout.

A `/query` has one 22-second budget that every phase draws on, in order:

- waiting for one of four catalog phases, up to 5 seconds, at most 16 waiters,
  and only when the query is shared; no admission slot is held while waiting;
- waiting for an admission slot, up to 2 seconds;
- the catalog listing, capped at 10 seconds;
- the data call, capped at 20 seconds.

Each phase is capped by what remains of the budget. A phase that runs out returns
504 `query exceeded its time budget`. A full waiter queue, or a catalog wait that
times out, returns 429 before any listing, with a `Retry-After` that is the pool's
observed hold time, 1 to 10 seconds. Local queries never wait for a catalog phase.

A busy shared catalog is answered 200 with `sharedCatalog.status: "busy"` and
`retryAfter` in seconds (the gateway's Retry-After, or 1). That is the only
retry layer for a busy listing. The page client replays it at most three times,
each after `retryAfter` capped at 10 seconds and spread by +-30%, and stops when
its caller goes away. The render worker does not replay: it waits on the page's
aria-busy tiles under its own readiness and deadline, so a persistent busy spell
costs one client replay cycle and ends in the worker's normal failure, not a
stacked replay. A listing still busy after the client's replays shows the banner
with a manual retry.

A `/query` 429 from the gateway forwards its Retry-After when it is 1 to 10 seconds,
the replay cap, and otherwise defaults to Insights' own estimate, which is at least 1 second. A deadline reads as "query exceeded its time budget"
on the query path and as "request exceeded its time budget" elsewhere.

Measured at the default timeouts against a gateway that never answers or stalls:

- `/providers`: 200 after 20 seconds, with the local providers and
  `sharedCatalog: {status: "unavailable", code: 504}`. A silent gateway does not
  fail the listing, because a 504 there would blank local tiles.
- `/query`, catalog never answers: 504 after 10 seconds (the catalog phase cap).
- `/query`, catalog answers, data call stalls: 504 after 20 seconds, the 20 s
  operation bound, which the gateway transport's response-header wait now equals.
- `/query`, catalog takes 9 seconds, then data stalls: 504 after 22 seconds (the
  overall budget; before this change it was 24 seconds).

Bounded responses, no redirects and no retries.

Shared provider IDs are `observe-` plus the full SHA-256 of their canonical
`namespace/name`, preserving namespace identity within the existing dashboard
and saved-query ID contract. The public listing adds `source:"observability"`
and `providerRef:"namespace/name"`, with `transport:"mcp"`. Shared configurations and tokens are never
persisted in Insights, and provider configuration routes remain local-only.
The `observe-` prefix is reserved when this integration is enabled. Manage
shared providers through the Observability board. Remote metadata caches live
only for the individual authorized request; they are never reused across users.

RBAC example (add to existing rules; do not remove the application's other rules):

```yaml
auth:
  enabled: true
  rbac:
    - subjects: ["group:observability-readers"]
      actions: ["read"]
      resources: ["insights"]
      namespaces: ["*"]
    - subjects: ["group:observability-editors"]
      actions: ["write"]
      resources: ["insights"]
      namespaces: ["*"]
    - subjects: ["group:observability-readers", "group:observability-editors"]
      actions: ["read"]
      resources: ["observabilityproviders"]
      namespaces: ["monitoring"] # namespaces containing the shared providers
```

Dashboards and locally configured providers are global to this Paprika instance. Project-scoped
rules do not grant access (use an omitted projects field or `projects: ["*"]`). Read permission
allows locally configured provider queries and dashboard reads. Shared providers
also require the caller's observability provider permissions. Write permission
also allows dashboard and saved-query mutations.
`admin` permission on `insights` is required to read or mutate provider
configuration. Read permission permits connection tests and metadata discovery.
Tenant/project isolation is not implemented; use separate instances for isolated
trust domains. With Paprika authentication
disabled, the proxy follows that existing development setting.

## HTTP contract

The service routes below are exposed with `/api` replaced by `/api/insights`
through Paprika. All service API routes require `Authorization: Bearer <token>`.

| Method | Route | Result |
| --- | --- | --- |
| GET | `/api/providers` | `{providers:[{id,name,type,capabilities,managed,source?,providerRef?,transport?}]}` |
| GET | `/api/observe-connection` | `{configured,connected,transport:"mcp",tools:[{name,description}],providerCount,protocolVersion?}`; unconfigured returns 200/disconnected, authorization and connection failures return sanitized non-2xx errors |
| GET | `/api/provider-configs` | Admin-only `{providers:[ProviderConfigView]}` |
| PUT | `/api/provider-configs/{id}` | Admin-only saved configuration and `ETag` |
| DELETE | `/api/provider-configs/{id}` | Admin-only 204 |
| POST | `/api/providers/{id}/test` | `{ok:true,message:"Connected",durationMs}` |
| GET | `/api/providers/{id}/metadata?kind=metrics` | `{values:[string],truncated?}` |
| POST | `/api/query` | `{series?,traces?,truncated?}` |
| GET | `/api/saved-queries?providerId={id}` | `{queries:[SavedQuery + etag]}`; provider filter optional |
| GET | `/api/saved-queries/{id}` | SavedQuery and `ETag`; matching `If-None-Match` returns 304 |
| PUT | `/api/saved-queries/{id}` | SavedQuery and `ETag` |
| DELETE | `/api/saved-queries/{id}` | 204; `If-Match` required |
| GET | `/api/dashboards` | `{dashboards:[Dashboard]}` |
| GET | `/api/dashboards/{id}` | Dashboard and `ETag` |
| PUT | `/api/dashboards/{id}` | Saved Dashboard and `ETag`; `?checks=true` adds `checks` (see below) |
| DELETE | `/api/dashboards/{id}` | 204 |
| POST | `/api/dashboards/validate` | Dry run: `{document, execute?, variables?}` in. Without `execute`: `{issues,total,truncated,errorCount,warningCount,infoCount}` out, a schema and lint dry run that never writes. With `execute: true`: the same members plus `widgets`, one `WidgetDataState` per widget in document order (`widgetId`, `pointer`, `state`, `seriesReturned`, `errorCode`). Execute runs each distinct widget query once, read-only, over the dashboard default range (or its custom range) with the given variables (at most 20 string values, each at most 1024 UTF-16 units). A document with a schema or error-severity finding is not executed, and each widget reports `DATA_STATE_NOT_RUN`. `variables` without `execute` is a 400. The MCP gateway runs an executing dry run under its orchestration admission, and refuses it with `resource_exhausted` when that admission is unavailable. `state` is one of `OK`, `EMPTY`, `PARTIAL`, `STALE`, `ERROR`, `UNAVAILABLE` (capacity, timeout or cancellation, a retry clears it) or `NOT_RUN`. |

Query request:

```json
{
  "providerId": "prometheus",
  "kind": "metrics",
  "query": "sum(rate(http_requests_total[5m]))",
  "start": 1792700000,
  "end": 1792703600,
  "step": 30
}
```

`start`, `end`, and `step` are seconds. Metric `point.timestamp` and trace
`startTime` are Unix milliseconds. Prometheus NaN/infinite samples become null
values to preserve gaps. Tempo search metadata does not supply a complete trace
status, so it is `unknown`, never assumed healthy. Empty arrays can be omitted.

PUT accepts the version-1 dashboard document shared with the frontend. Limits:
48 widgets; 256 KiB per document; 100 dashboards and 32 MiB of stored documents.
Widget IDs are unique; layouts stay within a 12-column grid. Use `If-Match` with
the GET ETag for optimistic updates/deletes, or `If-None-Match: *` for creation.
A stale edit returns 412. Clients that omit preconditions choose last-write-wins.

Query limits: 31 days; at least 1-second step; at most 5,000 points per series,
100 series, 100,000 total points, 100 traces, 8 MiB upstream response, 20-second
data timeout (10 seconds for the shared catalog phase), 16 simultaneous query executions and a bounded 64-request queue with up to 2 seconds of cancellable waiting. Overflow still returns 429 with Retry-After; the gateway separately limits concurrent queries globally and per provider. Provider results exceeding count limits
set `truncated:true`; invalid requests fail before contacting a provider.
Client cancellation propagates to providers.
Native warnings and explicit partial-result markers also set `truncated:true`
without exposing raw backend warning text. Non-OK gateway states remain errors:
denied access is 403, missing configuration/capability is 503, and failed queries
are 502; none are converted into successful empty results.

## Saved-query library

Saved queries are global documents associated with one provider and query kind:

```json
{
  "schemaVersion": 1,
  "id": "service-requests",
  "name": "Requests by service",
  "providerId": "prometheus",
  "kind": "metrics",
  "query": "sum(rate(http_requests_total{service={{service}}}[5m])) > {{minimum}}",
  "parameters": [
    {"name":"service","type":"string","label":"Service"},
    {"name":"minimum","type":"number","defaultValue":0}
  ]
}
```

Documents are strict version-1 JSON, at most 32 KiB each and 256 in total, stored
atomically in `saved-queries/` below `--data-dir`. Names are 1–120 characters,
optional descriptions up to 500, and queries 1–8,192 after trimming. At most 20
parameters have unique identifier names, optional labels up to 80 characters,
and type `string` or `number`. Defaults must match that type; strings are bounded
to 1,024 characters and numbers must be finite. Every `{{name}}` placeholder must
be declared and occupy a whole unquoted literal outside comments. String values
are quoted and numeric values remain numbers. Saving validates the template and
configured provider capability but never executes the query. Provider and kind
are immutable after creation.

Replacement also checks all currently persisted widget and tooltip references.
It returns 409 if the changed parameter contract newly removes a bound parameter,
requires an unbound value, invalidates a fixed value or observation field, or changes
the type of a parameter bound to a dashboard variable or observation label. A
reference with a pre-existing unchanged problem does not block harmless query or
metadata edits. Removing an implicit default is permitted when every affected
reference supplies a binding; adding an optional parameter is permitted. Repair
the affected bindings or create a query copy before an incompatible replacement.
The guard applies even to dashboards intended for a later replacement because
individual resource writes are not an atomic transaction.

Use `If-None-Match: *` for creation and the current `ETag` with `If-Match` for
updates. Stale preconditions return 412. PUT without preconditions explicitly
chooses last-write-wins. DELETE requires `If-Match` (428 if omitted); deleting a
query referenced by a persisted dashboard returns 409. A provider used by a saved
query cannot be deleted or changed to a different type (409). Name, endpoint and
credential-reference edits remain available. Dashboard, provider and saved-query
mutations serialize their reference checks and persistence. These are single-
process guarantees under the same single-replica constraint as dashboards.

A widget can carry `queryRef:{id,bindings?}`. Each binding has a unique
`parameter` plus either `source:"variable",variable:<dashboard variable name>`
or `source:"constant",value:<string or finite number>`. At most 20 are allowed.
The existing widget `providerId` and `query` remain required custom-query drafts;
the reference is authoritative and missing references never fall back to them.
Portable dashboards may retain missing library/provider/variable references;
the browser resolves and validates them before invoking the unchanged resolved
`POST /api/query` endpoint. The library remains readable after an operator removes
a provisioned provider from startup configuration; attempting to save a query for
that absent provider is rejected until it is restored or the query is removed.

JSON/YAML exports with saved-query references use a browser-level
`PaprikaDashboardLibrary` envelope containing `schemaVersion: 1`, `dashboards`,
and `savedQueries`. It includes each referenced top-level or tooltip definition
once, without ETags, unrelated queries, provider endpoints, or credentials. An
explicit `savedQueries` array must contain the complete dependency set. Older
documents without that array resolve their references against the destination
library during import. The service continues to accept individual strict
dashboard and saved-query documents; it does not accept the envelope as a PUT
body or expose a transaction endpoint.

The browser compares incoming documents with saved snapshots and offers Keep,
Replace, or Copy independently for existing dashboards and saved queries. Keep
does not write the saved document; a kept dashboard skips its incoming dependencies.
Copy conditionally creates new IDs and rewrites imported references. Explicit
Replace uses the reviewed ETag with `If-Match`, preserving IDs and existing links.
Query replacement affects every dashboard using that ID, so the review shows its
impact and the service enforces the parameter-compatibility rules above. Provider
and kind changes require a query copy. Refreshing a stale comparison clears Replace
choices so the user must select them again.

The browser remaps providers and verifies each dashboard's dependencies before
its conditional write. A lost write acknowledgement is recovered only when GET
returns the exact planned document. The active review session retains IDs across
partial retries and skips completed decisions. This is not an atomic multi-resource
transaction: successful query changes can remain after a later dashboard failure,
and an independent dashboard can succeed while another dashboard's dependency
fails. There is no automatic rollback. Closing or reloading the review ends its
in-memory retry session; a new Copy review allocates new dashboard IDs.

## Managed providers and discovery

Providers from the startup configuration are provisioned and immutable through
the API. Administrators can add managed providers using the same configuration
shape (`id`, `name`, `type`, `url`, optional `bearerTokenEnv` and `headersEnv`).
PUT must match the ID in the path and must omit response-only `managed` and
`etag` fields. Configuration views include both fields. Use their ETag with
`If-Match` for updates/deletes or `If-None-Match: *` for creation; stale edits
return 412 and attempts to change provisioned providers return 409.

Managed credential references must use names beginning `PAPRIKA_PROVIDER_`
followed by uppercase letters, digits, or underscores. Referenced variables must
already exist in the service environment. Raw credentials are not accepted.
Managed configurations persist atomically in `providers/` below `--data-dir`;
the registry supports at most 32 provisioned and managed providers combined.
On startup, a managed ID that collides with a provisioned ID is an error.

Metadata `kind` accepts `metrics`, `labels`, or `values`; `values` requires
`label`. Prometheus also accepts an optional `metric` identifier to scope label
discovery using `match[]`. Tempo supports `labels` and `values` for trace tags.
Discovery searches the last 24 hours, returns at most 1,000 unique sorted values,
limits responses to 1 MiB, and caches successful results for 30 seconds in a
bounded per-provider cache. Editing a provider invalidates its cache. Connection
tests use Prometheus `vector(1)` or Tempo's `/api/echo` endpoint. Tests and discovery
share the query concurrency and timeout limits, and sanitize upstream failures.

## Dashboard checks and layout rules

Every dashboard write (`PUT /api/dashboards/{id}`, including MCP create, update
and patch and the portable import) runs the schema checks and then the lint
rules. A save is rejected with `400 {error,issues,total,truncated}` when a schema
check fails or a lint rule of error severity fires. Today the only error-severity
rule is `layout.overlap`: two widgets whose grid rectangles share a cell. An
overlap is an error when the save creates the dashboard or when it makes a pair
overlap that did not overlap in the stored version. A pair that already overlapped
in the stored dashboard is a warning, so an edit that leaves it in place (a rename,
or a change to another widget) is saved. `error` is the first finding's message,
and `issues` holds the findings, errors first, as a CheckReport (at most 32, with
`total` counting all of them).

Other lint rules are warnings. They never block a save. A successful save returns
them in a `checks` field, but only when the request asks with `?checks=true`:
`PUT /api/dashboards/{id}?checks=true` returns the stored document with `checks`
added after its members. The default body is the document exactly as before, so a
client that stores it never sends back an unknown member. The dry run lists every
finding, warnings included, without writing, and reads the stored dashboard at the
same id so it reports the same overlap warnings a save would.

Saves and dry runs read their bodies through one byte budget of 8 MiB shared by all of them.
The requests that use it are `PUT /api/dashboards/{id}`, with or without `?checks=true`
(the MCP's writes and the portable import use this route too), and `POST /api/dashboards/validate`.
Saved-query and provider-config writes do not use it: their bodies are capped at 32 KiB and 16 KiB.
Each read reserves the bytes it returned. A dry run frees them once its body is read, so
its response is written holding none. An admitted save frees them after its lock is released,
and before its check slot is released and its response is written. A refused save, one whose body is
invalid or whose check slot is taken, frees them before its 400 or 429 is written. A
stalled upload therefore holds only the bytes it has sent, and it holds no check slot. A
request whose read cannot reserve waits up to 2 seconds for bytes to free, with at most 16
requests queued. Past that it gets `429` with `Retry-After: 1` and "too many active dashboard
uploads". Each such refusal is counted in `paprika_insights_dashboard_upload_refusals_total`,
labelled `route="save"` or `route="dry_run"`. The counter appears on Insights' own `/metrics`
endpoint, or over OTLP when telemetry is configured. The chart as it stands does not
scrape Insights. When `insights.enabled` is set and either `insights.networkPolicy.enabled`
or `networkPolicy.enabled` is set (both default to `false`), the Insights NetworkPolicy
admits port 8090 from the API server and the observability gateway, and from the
controller-manager in monolith mode (see "Network policy"). The chart has no
value for an extra ingress rule, so a scrape needs a chart change as well as an operator's
scrape job. The same is true of `paprika_insights_queries_total`.

A principal can fill the budget with stalled uploads. The budget's worth of stalled bytes
(8 MiB) refuses every save and dry run for up to the server's 10-second `ReadTimeout`, the
time the stalled uploads take to end. In a test, 32 connections that each sent 256 KiB of a
larger body (8 MiB in all) got `429` for a dry run and a checked save at 4 seconds, and both
got `200` at 13 seconds. The principal can repeat it, and each refusal shows in the counter
above, so watch `route="dry_run"` and `route="save"` together.

Memory under a flood, measured in a 256 MiB container with 0.5 CPU, with the load generator
in a second container on the same Docker network and 397 KB dry runs (`POST /api/dashboards/validate`)
or 397 KB bodies to a route that never reads them (`POST /api/nonexistent`). Each run lasted 25 seconds.
The budget caps the body bytes that saves and dry runs have reserved. At 8 MiB that is about 21
full reads at once, and the check slots and the waiting queue refuse the rest. A dry run keeps
its raw bytes through decode after its reservation is released, and its check slot bounds them.
The budget does not bound kernel memory. Each accepted connection's receive buffer is capped at 8 KiB by the
listener (`cmd/paprika-insights/listen.go`, Linux doubles it to 16 KiB). The connections that
a refused request leaves closing still hold their buffers for Go's half-second close delay,
so their kernel memory grows with the refusal rate, and the page cache is not counted at all.

The residual is measured. Without the listener's bound, the 8 MiB build peaked at 155 to 212 MiB
of kernel socket memory and was OOM-killed at 768 and 1,024 dry-run workers and at 384 workers
on the 404 route. With the bound, the same floods peaked at 34 to 73 MiB of socket memory, and
no run was OOM-killed:

| Route | Workers | Result with the bound | Peak socket memory | `memory.max` events |
| --- | --- | --- | --- | --- |
| dry run | 384 | alive | 34 MiB | 0 |
| dry run | 768 | alive | 51 MiB | 131 |
| dry run | 1,024 | alive | 55 MiB | 853 |
| 404 route | 384 | alive | 69 MiB | 0 |
| 404 route | 768 | alive | 73 MiB | 0 |

Each row is one run. The build without the bound ran the same floods: 384 dry-run workers
alive (158 MiB of socket memory), 768 workers OOM-killed, 1,024 workers OOM-killed (179 MiB at
the kill). The 404 route at 384 workers was OOM-killed. An intermediate build that allowed 32 KiB per connection
was OOM-killed in one of five runs of the 768-worker dry-run flood, so one run per row is a
sample, not a rate. A `memory.max` event means the kernel reclaimed to hold the container at its
limit, so a run with events is under pressure without being killed. The table's rows and the
reruns below are separate runs, so their `memory.max` counts differ.

**Known limit.** An in-network flood of 768 or more concurrent requests can still hold the
256 MiB pod at its limit. In the review's reruns at this build, 768 dry-run workers peaked at
256.0 MiB with 192 and 653 `memory.max` events, and 1,024 workers with 397 and 449 events. Nothing
was OOM-killed, but the pod is at its limit. The kernel socket buffers dominate at that load, so
the per-connection bound does not cap it. The API proxy transport (`internal/api/insights_proxy.go`)
sets no `MaxConnsPerHost`, and it has no per-principal limit. The fix belongs upstream, as
per-principal limits or a connection cap at that proxy. It is not in this change.

The bound has no setting. Turning it off means a code change in `cmd/paprika-insights/listen.go`.

The bound costs latency whenever a round trip is long. Measured at HEAD (with the 8 KiB bound)
and at the build before it (without the bound), with Insights at 256 MiB and 0.5 CPU and netem
delay on the client's egress, p50 latency was:

| Request | Client delay | With the bound | Without the bound |
| --- | --- | --- | --- |
| 397 KB dry run | none | 9.5 ms | 9.4 ms |
| 397 KB dry run | +1 ms | 68.8 ms | 20.9 ms |
| 397 KB dry run | +5 ms | 320 ms | 60 ms |
| 244 KB save | +1 ms | 43 ms | 8 ms |
| 244 KB save | +5 ms | 196 ms | 14 ms |

Under a concurrent-upload flood, admitted checked saves fell from 411 to 127 with the bound,
and `execute: true` dry runs that returned 200 fell from 613 to 466. The bound trades that
throughput and latency for the memory limit above.

Dry runs and saves with `?checks=true` share four concurrent slots: a dry
run holds one while it decodes its request and builds its report, and a checked save
holds one through its lock wait, its check and the build of its response. The
response is written after the lock and the slot are released, so a client that stops
reading holds neither. A request that finds them all taken gets `429` with
`Retry-After: 1`, and a refused dry run decodes nothing. A dry run with `execute`
releases its slot before its queries run and holds one of four dry-run query slots
instead, so a slow provider never refuses a checked save. A full pool gets the same
`429`. The schema check runs on a bounded part of a document: a widgets array longer
than 48 gets its count error and shape checks on its first 48 widgets only, the
variables array and widget drilldowns are read up to one past their limits, and the
report counts every finding it makes.

Stored documents are read without linting, so a dashboard saved before a rule
existed still loads and renders. Saving it again runs the rules.

Each finding names its rule (`ruleId`), its severity, its source (schema or
lint), its widget, and the exact JSON Pointer of the member at fault. Messages
name widgets by title and id.

The canvas settles every render with react-grid-layout's vertical compactor:
items rise into empty space and an overlap is pushed apart. The UI saves the
layout as the canvas draws it, so a stored overlap is corrected by the next UI
save. The `layout.hole` rule reads the same drawn layout: an empty cell above a
widget, which the canvas would not close, is a hole. The Go port of the compactor
and the TypeScript compactor share the parity fixtures in
[layout-compaction.json](../../docs/design/insights/conformance/layout-compaction.json).

The built-in plugin ids that `plugin.unknown` accepts are listed in
[widget-plugins.json](../../docs/design/insights/widget-plugins.json), regenerated
from the UI registry. A host can register more plugins, which the rule reports as
not built in.

### Data rules (dry run with execute)

A dry run with `execute: true` runs the document's queries and reports what they
returned. The `data.*` findings carry source `SOURCE_DATA`; they never block a save,
because a save executes nothing. Each rule's default severity is in brackets.

- `data.query-error` [warning]: a widget or event query the provider rejected or
  could not resolve. Points at `query`, `queryRef`, `annotationSource`, or
  `providerId` for a provider-setting failure. Capacity, timeout, cancellation,
  and direct-provider 408, 429, 502, 503 and 504 responses are transient: they produce
  no finding and report `UNAVAILABLE`. Upstream response text is never copied.
- `data.no-series` [warning; info for an alert (`ALERTS`) or a comparison filter
  such as `> 0`, whose empty result can be expected]: a metrics query returned no
  series with a value. A partial response is left to `data.series-cap`.
- `data.unit-mismatch` [info]: a value outside the declared `options.min` or
  `options.max`, or a `%` unit whose values all lie in [0, 1] under a declared
  max or threshold of 10 or more (a ratio shown as a percent). Nothing else is
  judged: a percent above 100 with no declared scale is a legitimate multi-core
  reading, and a negative value is a legitimate change.
- `data.stale` [warning]: the newest valid sample is older than
  `options.staleAfterSeconds` when the range ends. Applies to `stat`,
  `timeseries` and the `rich-metrics` plugin over metrics. A stat judges its
  primary series; the others the newest sample of any series. A bar chart
  does not honour the option and is not judged.
- `data.series-cap` [warning]: the provider truncated its response by a row or
  series cap or an incomplete search, so values may miss data.
- `data.many-series` [info]: more than eight series with no
  `options.seriesColors` rules.
- `data.constant-sparkline` [info]: a stat with a sparkline whose primary series
  holds at least two valid samples, all equal.

A widget whose event query failed reports `PARTIAL`, and keeps its finding.

Lint and data rules are listed in one catalogue (rule id, source, severity,
summary). Each rule keeps its own check input, so a lint rule never reads query
results and a data rule never runs on a save. Findings keep the source of the
rule that produced them.

Not implemented: the unnamed-series advisory (series are named by R14, so the
plan dropped it), and the `%` bar and `max` under 10 advisories, which are
deferred. Neither is reported by a dry run.

### Lint CLI

`paprika-insights lint` checks dashboard documents offline with the same findings a
save reports:

```sh
paprika-insights lint [--served-schema-examples] PATH...
```

Each path is a JSON file or a directory of them. A file holds one document, an
array of documents, or a repository-examples catalog, whose sample and live
dashboards are checked. `--served-schema-examples` adds the dashboard and widget
examples that the schema endpoint serves. The exit code is 0 when no finding is
an error, 1 when one is, and 2 for unreadable input or usage. Each finding prints
on one line, followed by a summary. The CI step runs the command over the
repository catalog, the served examples and the gallery export.

## Starter dashboards

`internal/insights/starters/*.json` holds first-party dashboard documents that
an operator can start from. `Starters()` returns them embedded in the binary, in
file-name order; each file's `id` matches its name. `starters_test.go` runs every
starter through the save-time schema and the lint registry, requires zero
findings, and checks that each metric it queries is in the
[metric reference](../../.agents/skills/paprika-dashboard-design/references/paprika-signals.md)
with its type and labels. The starters use the placeholder provider id
`metrics-provider-id`; an import maps it to a real provider.

`paprika-control-plane` shows whether Paprika is keeping up. Its count tiles
read the same gauges as the PrometheusRule alerts, with `max()` over each.
Exhausted release retries turn critical above zero, as their alert does. Stuck
releases and a degraded fleet index turn warning above zero, as their alerts do.
Stale applications turns warning above zero; no alert covers it. Controller liveness is the age of
the slowest controller's last successful reconcile and turns warning after five
minutes, as in [metrics.md](../../docs/guides/metrics.md). The remaining panels
show reconcile lag, reconcile throughput by outcome, and the applications and
releases in each phase as current state.

## Dashboard extensions

Dashboard documents support optional `folder` paths (160 characters, nonempty
segments without `.` or `..`) and `customTimeRange: {from,to}`. Both dates must
include a timezone; the end must follow the start within 31 days. A custom range
overrides the retained preset `timeRange`.

Widgets support `heatmap` and `plugin` as well as the original chart types.
`options` can set line/area display, axis labels, legend/tooltips/grid, decimal
precision, min/max bounds, line width, fill opacity, curve, background/text
colors, and up to 12 strictly ascending thresholds. Colors use `#RRGGBB`.
Heatmaps additionally expose independent `showLabels` and `showValues` booleans
in `options`; both default to visible when omitted. Explicit `false` values are
preserved in stored and exported dashboards.
Single-value widgets and tooltip views can enable a boolean `showSparkline` in
`options` or `options.tooltipView`. Omission or `false` keeps the value-only
presentation. The renderer uses the same loaded series history without another
query; the service preserves either explicit boolean unchanged.
`options.tooltipView` can select any built-in widget type or a registered plugin,
with bounded presentation fields and an optional data source. An omitted source
or `{type:"series"}` uses the hovered series. `{type:"widget"}` reuses the complete
existing parent result without a child request. A query source contains
`{type:"query",providerId,query,bindings?:[...]}`. Each binding uses either
`{variable,label}` with a label key of 1–128 characters, or
`{variable,field:"value"|"timestamp"|"series"}`; the two forms are exclusive.
Variable names are unique across both forms (at most 20). The host resolves finite
values and observation timestamps in Unix seconds as numeric query literals,
and series names and label values as quoted strings. A saved-query source is
`{type:"saved",ref:{id,bindings?}}`; its bindings support the widget reference forms
above plus `source:"label",label:<key>` and
`source:"field",field:"value"|"timestamp"|"series"`. Parameter names stay unique
across all forms. Trace views require a query, saved query, or compatible widget
result source. Plugin ID, data kind, and JSON configuration follow the
same rules as parent widgets; nested tooltip definitions are not accepted.
Provider references remain portable when saving: the query endpoint checks the
currently configured provider and its metrics/traces capability before forwarding
anything upstream. See [tooltip sub-widgets](../../docs/design/insights/tooltip-widgets.md)
for presentation bounds and host-owned query execution.
Plugin widgets require `pluginId` and `dataKind` (`metrics` or `traces`), with an
optional JSON-object `config` bounded to 16 KiB and depth eight. Built-in widgets
reject plugin-only fields. All objects use strict field validation shared with
the frontend; arbitrary code and prototype-sensitive configuration keys are
not accepted.

## Deployment

The normal image now includes `/insights` alongside `/manager`. Helm enables a
separate Deployment and ClusterIP service:

```yaml
insights:
  enabled: true
  token:
    existingSecretName: paprika-insights-token
    existingSecretKey: token
  providers:
    - id: prometheus
      name: Prometheus
      type: prometheus
      url: http://prometheus.monitoring.svc.cluster.local:9090
  persistence:
    enabled: true
    size: 1Gi
```

Create the referenced Secret through your existing secret manager. Configure provider
credentials through `insights.extraEnv`/`extraEnvFrom`. The Insights NetworkPolicy, when
enabled, admits the API server and the observability gateway (and the controller-manager in
monolith mode), and allows the provider ports in `insights.networkPolicy.egress`. Add a port
there before you add a provider that uses it, or its queries time out. See "Network policy"
for the switch and its rules.

The file store uses fsync plus atomic rename on a persistent volume and serves
one writer. Helm uses one replica and `Recreate`; do not increase replica count
or share its data directory across processes. Back up the PVC. Disabling
persistence uses ephemeral storage and loses dashboards, saved queries, and managed providers
on pod replacement.

`/metrics` exposes OTel query counters and latency histograms through the existing
controller-runtime registry. Standard OTEL environment configuration is supported.
No provider credentials, queries, or user IDs are metric labels.

## Network policy

`insights.networkPolicy.enabled` (default `false`) renders the Insights NetworkPolicy alone,
and only when `insights.enabled` is true. The global `networkPolicy.enabled` also renders it,
beside the policies of the other components. The other components' policies, the
controller-manager's included, come from `networkPolicy.enabled`.
`deploy/insights-omega-values.yaml` sets the per-component switch and leaves the global switch
off. The policy is named `<fullname>-insights`. It has the same name as the Insights Service and
Deployment (`paprika.resourceName` with the suffix `insights` in `_helpers.tpl`).

The policy selects the Insights pods and allows only these paths. Every ingress peer is a
pod selector in the release namespace, so no other namespace is admitted. With the default
extras, egress has one namespace peer, kube-system for DNS. Its other rules are the
observability-gateway (when enabled) and the extras, which have no `to` by default, as described
below.

- Ingress on TCP 8090 from the api-server, which proxies `/api/insights`.
- Ingress on TCP 8090 from the observability-gateway, which calls Insights for the Observe
  paths.
- Ingress on TCP 8090 from pods labelled `control-plane: controller-manager`, only when
  `deploymentMode` is `monolith`. In monolith mode the manager serves the console, which
  reaches Insights through this peer. In split mode the API server serves the console, so the
  manager peer is left out.
- Egress on UDP and TCP 53 to kube-system (DNS).
- Egress on TCP 8090 to the observability-gateway, when `observabilityGateway.enabled`.
- The `insights.networkPolicy.egress` extras. The defaults are TCP 80, 443, 9090 and 3200,
  with no `to`, so they reach any destination on those ports, which is how provider queries
  reach their backends. Narrow them with `to` selectors where the destinations are known.
  `deploy/insights-omega-values.yaml` sets `egress: []`. Every Omega provider is shared through
  the gateway, so Insights needs only DNS and the gateway. Any managed provider needs an egress
  entry here before it is added.

The Insights binary makes no Kubernetes API calls, so the policy has no API-server egress.

What it closes: without the policy, the Insights pod has no ingress restriction on
`<fullname>-insights:8090`. About 768 or more in-cluster requests can hold the Insights
pod at its 256Mi memory limit. Only the Insights pod is held; other pods are not affected.

What it does not cover:

- Kubelet probes. The probes are the Deployment's `/readyz` and `/healthz`, and the policy
  does not block them. Calico admits host-to-pod traffic by default, so the probes pass.
  Under another CNI, or with host endpoint policies, check the Insights pod's READY state
  after rollout.
- Metrics. `/metrics` is served on 8090, but the chart does not scrape it: it has no
  ServiceMonitor for Insights. A scraper needs a new ingress rule, which the chart does not
  expose yet.
- Floods from admitted peers. The admitted peers (the api-server, the gateway and, in monolith
  mode, the controller-manager) can still send the load described in "Known limit" above.
- Providers and telemetry on other ports. A managed provider added through
  `PUT /api/provider-configs/{id}` (`/api/insights/provider-configs/{id}` on the public host)
  on a port outside the extras times out, and the Insights readiness check does not report it
  (`/readyz` is static). An OTLP collector set through `insights.extraEnv` needs its port in the
  extras too.

Back out. Set `insights.networkPolicy.enabled: false` in the overlay and deploy again, and
Helm removes the policy. In an emergency, delete the policy directly with
`kubectl -n <ns> delete networkpolicy <fullname>-insights`. The next Helm deploy with the
switch on recreates it, so set the overlay first.

Verify after rollout. Set `<ns>` to the release namespace and `<fullname>-insights` to the
Insights Service name:

```sh
kubectl -n <ns> get networkpolicy <fullname>-insights
kubectl -n <ns> get pods -l app.kubernetes.io/component=insights   # READY 1/1
```

From a pod in another namespace, the positive control must print an HTTP code other than
`000`, and the Insights Service must time out. curl exits with status 28 for a timeout, and the
script prints it:

```sh
kubectl run np-check --rm -i --restart=Never --image=curlimages/curl -n <other-ns> -- sh -c '
  curl -sk -m 5 -o /dev/null -w "control %{http_code}\n" https://kubernetes.default.svc/version
  curl -sS -m 5 http://<fullname>-insights.<ns>.svc.cluster.local:8090/healthz; echo "insights exit $?"'
```

Through the public host, sign in and `GET /api/insights/providers`. The response should list
the shared providers and carry no `sharedCatalog` key. That key appears only when the
Observe listing fails, and then the Insights to gateway path, or the gateway ingress rule, is
the first place to check. This one call exercises the api-server to Insights path and the
Insights to gateway path. Insights' `/readyz` does not check its dependencies, so the Ready
state does not prove that egress works.

The Observe MCP should keep answering through the observability-gateway. If a path fails,
the policy's ingress and egress lists are the first place to check.

## Dashboard revision history

Each save that changes a dashboard's bytes appends a revision below `--data-dir`:

- `revisions/<id>/index.json` is the protojson `DashboardRevisionIndex`: the metadata
  of every kept revision, oldest first, and the next number to use.
- `revisions/<id>/<n>.json` holds the exact bytes of revision `n`.

The current document stays `<id>.json` and is the source of truth. Its revision is
the head and is always the newest kept revision. A save whose bytes equal the head
adds no revision. Revision numbers only grow, so a pruned number is never reused.

Retention is fixed in the binary: the last 20 revisions per dashboard, and 64 MiB of
revision bytes across all dashboards. Over the budget, the oldest non-head revision of
any dashboard is pruned first, and a head is never pruned. Deleting a dashboard
deletes its history.

A failed history write does not fail the save. The failure is logged and counted in
`paprika_insights_revision_write_failures_total`, and the document is kept. Startup repairs
history. For each dashboard with no index it appends a `baseline` revision of the
current document, which is how existing dashboards get revision 1 after an upgrade.
A head that differs from the document, as after a crash between the two writes, also
gets a `baseline` revision. Files a crash left unreferenced are removed.

A corrupt `index.json` does not stop startup. After startup succeeds, the directory,
with its revision files, moves to `quarantine/revisions/<id>.<unix-nanos>/` and the
history restarts from the current document. Until then the dashboard's history reads as
empty and writes to it are refused and counted, so the save still succeeds. If that move
fails, the failure is counted and the history stays refused until the next start; startup
does not fail. An index that exists but cannot be read is not moved, because its files
may be the only copy.

A revision directory left on disk with no loaded dashboard, such as after a quarantined
document or a failed delete, is moved aside when the same id is created again, so the new
history never writes over it.

Baseline revisions record their saved-query pins once the saved-query store opens, at the
same startup, so restoring a baseline reports saved-query drift like any other revision.

The store records each revision's author, source and message when a caller passes
them to `PutRevision`. The author is the principal's subject and display name, never
an email. `Put` passes none of them.

## Startup quarantine and downgrades

When the store opens, a dashboard or saved query that fails validation no longer
stops Insights. Startup moves the file to `<data-dir>/quarantine/<kind>/<id>.<unix-nanos>.json`,
where `<kind>` is `dashboard` or `saved_query`, logs a warning with the kind, id and
reason, increments `paprika_insights_store_quarantined_total{kind}`, and serves the
valid documents. A corrupt revision index moves the same way to `quarantine/revisions/`
(see [Dashboard revision history](#dashboard-revision-history)). The quarantine tree is never read as store entries. A second start
does not quarantine anything again, because the invalid file has already left the
store directory. A create with a quarantined id is a new document; the quarantined
copy is kept and never overwritten.

Startup is two-phase. The loaders only find invalid documents. The process binds its
listen address first, so a taken or invalid address stops startup before the store is
read. `NewServer` then finishes the whole startup (the dashboard and saved-query stores,
and the managed provider configs) and only then moves the invalid documents. Insights
serves on the listener it bound. A fatal error anywhere earlier leaves every document
where it was, so the build that can still read them finds them on the next start.
Documents quarantined by a startup that succeeded stay moved. Rolling forward again
does not restore them; this build no longer serves them and does not move them back.

Anything that fails validation as this build reads it is quarantined. That includes a
document a newer build wrote (a newer `schemaVersion`, or a field this build does not
know) and a document over its size limit. These stay fatal, and nothing moves when
they occur: a symlink or other non-regular entry in a store directory, an invalid
file name, a store over its capacity (100 dashboards, 32 MiB of documents, 256 saved
queries), an I/O error reading a file, a managed provider config this build cannot
decode (an unknown field or provider type), and a listen address that cannot be bound
(already in use, or not a valid address).

A quarantine move that fails also stops startup, for example when a file sits where the
`quarantine` directory belongs. The moves are renames, one document at a time. Documents
moved before the failure stay in quarantine, and the others stay in the store. Once the
blocker is removed, a restart moves the rest. It never duplicates a document that already
moved, because a moved file is no longer in the store directory.

Quarantine is an operator signal, and on `paprika-e2e` the logs are the only one. Nothing
scrapes Insights there, and the `paprika_insights_store_quarantined_total` counter exists
only in the process that quarantined the documents. Each quarantined document logs a WARN
line with its kind, id, reason and new path. A startup that moved anything also logs one
WARN line, `quarantined invalid stored documents at startup`, with `count`, `kinds` and
`quarantine_path`. Check the Insights logs after every downgrade and every upgrade:

```sh
kubectl -n paprika-e2e logs deploy/paprika-e2e-insights | grep quarantined
```

Then check the quarantine tree after every deploy and after every rollback:

```sh
kubectl -n paprika-e2e exec deploy/paprika-e2e-insights -- \
  find /var/lib/paprika-insights/quarantine -name '*.json'
```

To restore a quarantined document, first confirm no current document has the same id.
Then move the copy back inside the running container, which runs as uid 65532 and
keeps the file's ownership. A `cp` run as root would leave a file the process cannot
read. Then restart so the store reloads:

```sh
# list the copies, then pick one and check the id is free
kubectl -n paprika-e2e exec deploy/paprika-e2e-insights -- \
  ls /var/lib/paprika-insights /var/lib/paprika-insights/saved-queries

# dashboard
kubectl -n paprika-e2e exec deploy/paprika-e2e-insights -- \
  mv /var/lib/paprika-insights/quarantine/dashboard/<id>.<unix-nanos>.json /var/lib/paprika-insights/<id>.json
# saved query
kubectl -n paprika-e2e exec deploy/paprika-e2e-insights -- \
  mv /var/lib/paprika-insights/quarantine/saved_query/<id>.<unix-nanos>.json /var/lib/paprika-insights/saved-queries/<id>.json

kubectl -n paprika-e2e rollout restart deploy/paprika-e2e-insights
```

Do not scale the deployment to zero to restore a file. The volume is ReadWriteOnce
and no container exists to run `mv` at zero replicas. Moving onto an existing id
replaces the current document, so check first. If this build still rejects the file,
it is quarantined again and the log gives the reason; correct the JSON by hand or run
a build that accepts it. Quarantined copies are never pruned automatically. Delete
them yourself once they are recovered or no longer needed.

Downgrades: quarantine applies only to builds that include this section. Released
builds that predate it still refuse to open a store that holds any document they
cannot validate. A dashboard refusal exits with `open Insights store: invalid saved
dashboard <id>: ...`, and a saved query refusal with `configure Insights server:
invalid saved query <id>: ...`. Before rolling back to such a build, restore a
snapshot of the data directory taken before the upgrade, or remove the newer fields
from the stored documents.

## Verification

```sh
go test -race ./internal/insights ./cmd/paprika-insights
go test ./internal/api -run TestInsights -count=1
helm lint charts/chart --set insights.enabled=true \
  --set insights.token.existingSecretName=insights-token
```

Tests cover HTTP CRUD through the authenticated proxy to the actual service,
restart persistence, compare-and-swap contention, reader authorization,
credential stripping, mock Prometheus/Tempo HTTP providers, malformed data,
query cancellation, redirect refusal, response bounds, and validation errors.

For browser-to-service coverage, start the Next development server on port 3015
and run `node e2e/insights-live.e2e.mjs` from `ui/`. The script builds and starts
the real Go service with temporary storage and deterministic HTTP providers,
then tests visual configuration, live queries, saving, service restart, error
states, provider management/discovery, custom time ranges, and concurrent editing.
Its Playwright route bridge only replaces the
missing reverse proxy in the static Next development server; Go integration
tests independently exercise the production proxy's authentication and RBAC.
The script cleans up its service, providers, and temporary files and saves its
report and screenshots in `artifacts/insights/`.

## Capacity

Insights admits up to 16 query executions at once and holds up to 64 more for
at most 2 seconds, and admits 4 shared-catalog phases with 16 waiting for up to 5
seconds. These are the defaults in `internal/insights/capacity.go`. Each one is
configurable: `--query-concurrency`, `--query-queue`, `--query-queue-wait`,
`--catalog-concurrency`, `--catalog-queue` and `--catalog-queue-wait` on
`paprika-insights`, or the chart's `insights.capacity.*` values. A value left
unset takes the default, and the chart emits a flag only when its value is set.
Setting queue counts to zero is not possible: zero means the default.

A dashboard read runs its queries with bounded parallelism. `--dashboard-query-parallelism`
(chart: `insights.capacity.dashboardQueryParallelism`) sets how many run at once for one
read: 2 by default, 1 to 4, and 1 runs them one at a time. The process shares
one fewer extra slot than the limit among all reads, so the most queries from one
process at once is the number of reads plus the limit minus one. The read's own
slot is always its first. Stat comparisons run under the same limit after the main
queries. Each signal reports `latencyMs`, from asking for Insights admission to the gateway's answer.
With the chart and the gateway enabled, an effective parallelism above 1 (unset is 2)
that exceeds the gateway's `queryProviderConcurrency`, or one where `httpDashboardSlots`
plus parallelism minus one reaches the gateway's `httpWorkSlots`, fails the render.
Parallelism 1 is not checked.

A query to an Observe-backed provider then passes the gateway's HTTP pools and its
execution budget, so the gateway's own limits, not Insights' 16, usually bind
first. At defaults a single provider runs 2 queries at once. With the chart,
`insights.capacity.catalogConcurrency` above the gateway's per-provider concurrency
plus provider queue, or the effective `queryConcurrency` plus `catalogConcurrency`
above the gateway's concurrency plus queue, fails the render, because the gateway
would refuse that load. The two queue waits must also sum to less than the 22 second
query budget, or the binary refuses to start. The full chain, with each
hop's default, configuration and what a caller sees when it is full, is in
[docs/guides/observability-gateway.md](../../docs/guides/observability-gateway.md#end-to-end-capacity).

**Cost per widget.** Each widget query makes two gateway requests: one catalog
listing (`GET /observe/api/providers`) and one data call (`POST /observe/api/query`).
Over MCP it made four. A board of 12 widgets refreshed every 15 seconds therefore
sends 96 gateway requests a minute per viewer (12 widgets × 2 × 4 refreshes). Halving
the refresh interval doubles that. Widgets that share a provider and query share one
in-flight request, but each refresh still lists the catalog once per request. For
boards with many widgets, prefer a refresh of 30 seconds or longer; the gateway's
per-provider limit of 2 running queries is the constraint these numbers protect.

**What bursts measured.** On the local fixture, whose upstream answers in about
0 to 10 ms, a burst of 36 concurrent queries was admitted in full. With a 1 second
upstream the gateway's per-provider bulkhead refuses the excess first: 26 of 36
first attempts got a 429 with Retry-After, with or without the per-widget change.
Repeat the burst against your real provider before raising any capacity value.
