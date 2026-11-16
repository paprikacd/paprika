# Uptime application data provider

The `uptime` provider reads Uptime application dashboards through a fixed
allowlist of Connect RPCs. It supplies typed `records`, or `metrics` made by
explicitly projecting numeric columns. A current inventory or stored report
produces current observations, not synthetic historical telemetry.

The adapter follows the source at Uptime commit
`d2fb0dd85129049c39e64fef4f9620d298ae0371`. The detailed dashboard inventory is
in [repository example sources](../design/insights/repository-examples/uptime-sources.json).

## Configuration and authentication

```yaml
apiVersion: observability.paprika.io/v1alpha1
kind: ObservabilityProvider
metadata:
  name: uptime-application
  namespace: observability
spec:
  type: uptime
  config:
    endpoint: https://uptime-api.example.com
    orgId: 11111111-1111-4111-8111-111111111111
  credentialsSecretRef:
    name: uptime-application-credentials
    key: token
```

The credential Secret must carry the existing gateway credential label
`observability.paprika.io/credentials: "true"`. Its selected key may contain a raw
bearer token without the `Bearer ` prefix, or a Firebase refresh credential:

```json
{"apiKey":"<Firebase Web API key>","refreshToken":"<existing authorized user refresh token>"}
```

Never put credentials in provider config,
query arguments, saved queries, or dashboard documents. The adapter provides no
anonymous or basic-auth fallback.

Use a bearer identity that Uptime authorizes for the configured organization.
Uptime's source supports Firebase user tokens and a separate `upk_` project-token
middleware path, but the protected dashboard handlers check user organization
membership. Project-token access to these handlers has **not** been established;
do not assume a project token works. For durable Firebase access, store the
refresh credential obtained by a supported user login. The connector exchanges
it at the fixed
`https://securetoken.googleapis.com/v1/token` endpoint with verified TLS, no
redirects, no retries, an eight-second deadline and a 32 KiB response cap. Only
the resulting ID token reaches Uptime. If the account revokes access or the
refresh credential stops working, replace the Secret through an approved login
flow. See the [Firebase REST authentication contract](https://firebase.google.com/docs/reference/rest/auth#section-refresh-token).

### Gateway caches

The gateway keeps two process-local caches between queries. Each holds only
successful results, is bounded to 64 entries and 8 MiB (a single value over
256 KiB is never kept. Each skip is logged at debug verbosity
(`--zap-log-level=debug`) by the `observability-uptime` logger, without the
body. The caches are keyed by a digest of the caller's credential, so no caller
sees another caller's result.
An expired entry is dropped the next time its key is read or another value is
stored, and no timer holds it. Neither cache is persisted, and neither is shared
between gateway replicas.

| Cache | Holds | Key | Lifetime |
| --- | --- | --- | --- |
| Firebase ID tokens | The ID token from one refresh | Digest of the credential document | Until five minutes before the token expires (about 55 minutes) |
| Uptime read responses | The response body of one read | Endpoint, procedure, canonical request body, credential digest, configured headers and TLS mode | 15 seconds |

Identical reads that run at the same time share one upstream request while at
least one of their callers is still waiting. A caller whose own context ends
returns at once with its own error. When the last waiting caller leaves, the
upstream request is cancelled and is not left running. Every shared read is also
bounded by the 20-second query deadline. A caller whose context has already
ended starts no upstream read.

`query_dashboard` runs its distinct queries one after another, not at the same
time. For a dashboard, the gain therefore comes from the 15-second read TTL
across those serial calls: the six SLO widgets of one dashboard make one
upstream request, not six. Concurrent sharing matters for callers that issue
identical reads together, such as several Insights queries at once.

A body that does not match the operation's shape is an error and is not kept. A
rejected ID token (HTTP 401 or 403 from Uptime) is dropped from the cache, so the
next query refreshes it.

### Revoking access

- The reliability read's organization-membership check is never served from a
  cache. Removing a member stops reliability reads on the next query.
- Other reads can still return a cached response for up to 15 seconds after
  membership is removed.
- Disabling the Firebase user or revoking its refresh token does not cut off
  access at once. A cached ID token keeps working until it expires, up to about
  55 minutes later. Revocation on the Firebase side therefore takes that long to
  take effect.
- To cut access off at once, replace or delete the credential Secret. Each query
  reads the Secret, so the next query uses the new credential and no cached
  token or response for the old one. Restarting the gateway pods also clears
  both caches.

`orgId` is a required UUID and is fixed by provider configuration. Queries cannot
override it. The only additional config keys are the shared `headers` and
`insecureSkipTLS` HTTP options. Credential headers are rejected. Use verified
HTTPS for remote endpoints; an insecure TLS override is only for explicitly
trusted private infrastructure. Redirects are never followed, including redirects
to the same host. The endpoint may contain an API base path.

## Query contract

```json
{"operation":"slo","args":{"windowDays":30}}
```

Send the query with `signal: "records"` to get a frame:

```json
{
  "columns": [
    {"key":"serviceId","type":"string"},
    {"key":"uptime","type":"number","unit":"percent"}
  ],
  "rows": [["11111111-1111-4111-8111-111111111111",99.95]],
  "truncated": false
}
```

This abbreviated frame illustrates the contract; actual operations return all
their documented columns. Cells are scalar or null, and timestamps are RFC3339.

For `signal: "metrics"`, explicitly choose one numeric value and dimensions:

```json
{
  "operation":"slo",
  "args":{"windowDays":30},
  "projection":{"value":"uptime","labels":["serviceId","serviceName"]}
}
```

The optional projection `time` names a timestamp column. Without it, the query
evaluation time is used. Each label set must uniquely identify an observation at
that timestamp. Missing numeric observations become gaps; missing timestamps
cannot be used as metric times. Narrative content cannot become metric labels.
Records queries must omit `projection`.

Optional arguments:

- `limit`: integer 1–100, further bounded by the gateway query limit.
- `serviceId`: UUID for `services`, `check_summaries`, `security_summaries`,
  `service_signals`, `slo`, and `slo_summary`. Filtering applies to the bounded
  response, so a partial inventory can omit a selected service honestly.
- `windowDays`: 7, 14, 30, 60, or 90, for the two SLO operations only; default 30.
- `breachedOnly`: boolean for `slo` only. When true, return observed services
  whose source SLA is breached; no-data services are excluded.

The SLO window is an explicit source aggregation window, independent of the
dashboard time picker. Inventory, alert and reliability reads return the state
Uptime reports at the time of the read, which may be up to 15 seconds old
because of the read cache. They do not claim the dashboard time range filters
source records. Stored reliability reports expose their actual period
and generation timestamps. Organization-level summary/report operations reject
`serviceId` because their scores and prose cannot be faithfully service-filtered.

## Read operations

| Operation | Data and important columns | Source RPC |
| --- | --- | --- |
| `overview` | Exact `serviceCount`, `monitorCount`, `activeAlertCount`, `securityResultCount`, with separate `loadedServiceCount`, `loadedMonitorCount`, `loadedActiveAlertCount`, `loadedSecurityResultCount` | Four inventory reads below |
| `services` | `serviceId`, `serviceName`, `serviceSlug` | `ServiceService/ListServices` |
| `check_summaries` | Check and service identity, `checkType`, `enabled`, `status`, `observedAt`, nullable `responseTimeMs` | `CheckService/ListCheckSummaries` |
| `security_summaries` | Service/check identity, `enabled`, `status`, `observedAt`, nullable `score`, `riskLevel`, finding and signal counts | `CheckResultService/ListSecuritySummaries` |
| `alert_events` | Triggered `eventId`, `alertId`, `alertName`, `checkId`, `status`, `triggeredAt`, `resolvedAt` | `AlertService/ListAlertEvents` with triggered status filter |
| `service_signals` | Service identity, availability state, enabled/reporting counts, maximum latest `responseTimeMs`, latest `securityScore` and `securityRisk` | Services, checks and security reads |
| `slo` | Service identity, `slaTarget`, nullable `uptime`, budget minutes/percentage, nullable breach state, check counts, window, normalized `burnRate`/`burnStatus`, `observed` | `ServiceService/GetSLODashboard` |
| `slo_summary` | Service, observed/unobserved, on-track/breached and critical-burn counts; average observed uptime, window and loaded count | Same SLO RPC |
| `reliability_insights` | Insight/report IDs, category, severity, title, description, recommendation, affected service names and generated time | `ReliabilityInsightsService/GetReliabilityInsights` |
| `reliability_summary` | Report ID, summary, health score, insight/severity counts, period start/end and generated time | Same reliability read |

Every method has the fixed `/uptimeapi.v1.` Connect service prefix. No method
name, HTTP path, arbitrary body, or mutation is accepted from a query. In
particular, `GenerateReliabilityInsights` is excluded.

Use `{"operation":"services","args":{"limit":1}}` with records for a health
probe. A successful empty inventory is valid and distinct from credential denial.

## Missing data, bounds and fidelity

One query has a 20-second aggregate deadline and a 2 MiB response cap per RPC.
It reads at most one inventory page, produces at most 100 record rows, and has a
16 KiB query limit. The current source does not consistently implement cursor
pagination; the adapter rejects continuation tokens rather than repeating a page.
All responses pass the shared bounded-frame validator.

Uptime's `ListServices.totalCount` can be the loaded page plus one sentinel. The
adapter does not present it as an exact total. When a source page is incomplete,
the frame has `truncated: true`; overview totals requiring that complete page are
null, while explicitly named loaded counts remain available. A partial service
inventory never becomes an unqualified healthy service state.

Availability distinguishes no monitors, paused monitoring, waiting for data,
partial data, loaded signals only, needs attention, and healthy. Security score,
latest status, response time and result timestamps preserve missing values. Raw
check configuration, service URLs, alert-channel credentials, security payloads
and findings bodies never enter the frame.

An SLO service with no observed checks has null uptime, breach, remaining budget
and burn values. Summary uptime averages only observed services. The configured
target and total budget remain available. Burn follows Uptime's normalization:
`(100 - errorBudgetPercentage) / windowDays * 30`, with sustainable through 100,
elevated through 200, and critical above 200. These are source UI semantics, not
a claim of a standard SRE burn-rate definition.

A missing stored reliability report is an empty frame. Affected service names
are displayed as a comma-separated text column, not executable queries or a
structured service selector. Reliability reads first call `ListServices` with a
one-row limit to enforce organization membership independently. That check is
uncached and runs on every query. The adapter then verifies the returned
report's organization. This compensates for the surveyed reliability
handler checking a membership lookup error without checking its boolean result.

Backend errors expose fixed messages only. HTTP 401/403 becomes `Forbidden`;
missing procedures become `NotAvailable`; transport, size, malformed data and
other failures become `Error`. Provider and credential authorization remain the
gateway's responsibility in addition to Uptime's source checks.

## Validation

```sh
go test -race ./internal/observabilitygateway/connector/uptime -count=1
```

The suite checks all ten operation paths, exact Connect request bodies and
headers, organization denial, report organization matching, hidden source-field
exclusion, read-only query allowlisting, optional nulls, timestamp projections,
SLO no-data semantics, row/response caps, partial counts, redirect refusal,
missing credentials, fixed-endpoint Firebase refresh, revocation, and cancellation.
It also checks read coalescing (six identical concurrent reads make one upstream
request), the 15-second read TTL, and the read key, which separates credentials
and the TLS mode. Error and wrong-shape responses are never kept. Expiry is lazy:
an expired value is dropped on its next access or insert, and an evicted value
is unreachable. Byte and entry bounds hold, and an oversized value is not kept.
When the last waiter leaves, the upstream read is cancelled. A caller whose
context has already ended starts nothing, and a waiter that leaves does not
cancel the shared read for the others. The shared read's own timeout bounds it.
A caller never joins an abandoned flight, so a later caller starts a fresh read.
A rejected token is forgotten, so the next query refreshes it. A shared token
refresh survives its first caller leaving, and a token is reused until near
expiry. A panicking fetch becomes an error for every waiter and is logged.
The application integration runner also exercises actual Observe MCP and Insights
with a real disposable PostgreSQL reader. Optional live Uptime validation uses
the existing E2E account's supported Firebase login and a refresh credential
passed to the local fixture through stdin and held only in process memory; it
performs no application writes.
