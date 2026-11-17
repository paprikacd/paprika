# Uptime source inventory and mapping

Inspected `/Users/benebsworth/projects/uptime` at
`d2fb0dd85129049c39e64fef4f9620d298ae0371`, with a clean working tree.
No applicable `AGENTS.md` was present. This document records source behavior
and the initial mapping rationale. Both labelled sample examples and live
adapters are implemented; see [implementation notes](implementation-notes.md)
for the final coverage and remaining presentation differences.

The machine-readable companion is [uptime-sources.json](./uptime-sources.json).
Paths in that file are relative to the inspected Uptime checkout. Its proposed
example IDs are new Paprika identities, not IDs found in Uptime.

## Canonical scope

Uptime contains **three primary application dashboard/report screens**:

| Source view | Proposed example | Source content |
| --- | --- | --- |
| Overview, `/dashboard` | `uptime-overview` | Four summary values, service signals, active-alert feed |
| SLO Dashboard, `/slo` | `uptime-slo` | Four summary cards, breach list, budget-consumption comparison, per-service SLO cards |
| Reliability Insights, `/insights` | `uptime-reliability` | Health score, three severity counts, executive summary, recommendation cards |

There are **zero checked-in Grafana or other portable observability dashboard
definitions**. Searches covered source, hidden paths, JSON/YAML, Helm,
Terraform and embedded configuration. There are no existing dashboard UIDs,
PromQL or TraceQL expressions to copy.
`deploy/kubernetes/telesis-platform-monitoring.spec.json` describes four HTTP
checks and is not a dashboard.

Other monitoring routes are tracked separately as feature inspiration or
possible additional examples. They cover services, monitor details/results,
cron monitoring, security, dependencies, incidents and public status. They
are not a blanket requirement to clone all product administration. In
particular, `/services/map` redirects to `/dependencies`; security detail has
two route forms sharing one view family; `/status-page` administers the public
status view. Ignored worktrees and generated Vercel output are duplicates,
not separate sources. Older service heatmap/status-grid components are not
currently mounted by Overview.

## Mapping the primary screens

**Overview:** use four ordinary Single value widgets for counts. The two
remaining panels need structured operational rows: service identity, latest
state, observed time, duration and security evidence; and alert name/state/
start time. These are not four extra Prometheus metrics disguised as labels.
Keep the source's distinction between all configured monitors, loaded rows
and reporting rows. The service panel shows at most eight services and the
alert feed five events. Preserve explicit incomplete-page notices and withhold
Healthy when the scope is incomplete. Source errors suppress the whole
summary instead of displaying partial counts as complete.

**SLO Dashboard:** reuse Single value, Bar chart and the existing trusted
`threshold-gauge` plugin. The gauge already provides the progress track,
numeric bounds, labels, precision and threshold colors needed for error
budgets. A service variable and service-detail drilldown can make one SLO
detail layout reusable; a dynamic repeated-card facility is not required to
represent all the underlying measures. The breach list needs a structured
record view to retain current uptime, target, difference, total and failed
checks in one row.

The source calculation is important: the displayed burn rate is
`(100 - errorBudgetPercentage) / windowDays * 30`, with Sustainable at 100 or
below, Elevated up to 200, and Critical above 200. It is a normalized budget
consumption calculation, not a multiwindow SRE burn-rate implementation.
The source backend initializes uptime to 0 when there are no checks and can
mark that service breached. Examples should identify missing observations
explicitly, not silently teach that no data proves an outage. Record this
departure from the source if the clone improves its empty-state semantics.

**Reliability Insights:** reuse the gauge for a 0–100 score and three stats for
severity counts. A radial gauge is an optional presentation variant inside
the existing plugin's strict config, not a new global widget type. The
executive summary and recommendations need bounded plain-text records.
Preserve report period and generation time as different fields. The source's
7/14/30-day selector configures a **report-generation mutation**, not a read
filter. A clone must not present it as a working historical-report selector
unless the adapter actually supports that operation. Generate Report is
outside analytical cloning scope.

## Smallest useful widget extensions

1. **Structured records:** one trusted plugin with strict table/details/feed
   modes can cover service queues, breach rows, incidents, cron runs, findings,
   executive summaries and recommendations. Configuration selects known
   typed columns and formatting; it cannot execute JavaScript, arbitrary
   templates, HTML or network requests. A metric table is insufficient:
   its columns are currently Series, Latest valid, Min and Max.
2. **Status history:** the current heatmap shows each series' latest state.
   It does not show status across time. A trusted status-history renderer
   should preserve observed timestamps/intervals, state labels and genuine
   gaps. Existing metric samples with a documented state codebook work for
   numeric state histories; application history may require bounded typed
   interval records. Never turn absent observations into success or carry a
   healthy sample indefinitely.
3. **Dependency graph:** a trusted renderer over bounded typed nodes and edges
   can support service identity, current status, relationship and confidence.
   Keep graph layout deterministic and provide the same information in an
   accessible relationship table. Navigation uses host-owned selection and
   dashboard drilldowns. `/services/map` does not need a duplicate example.

Progress requires no new plugin. Rich media previews and a full execution
waterfall are separate optional features: the source's check execution log
is not automatically a distributed trace. Do not invent Tempo trace IDs to
make the Trace explorer accept operational events. A record details/feed
view and timing-phase Bar chart cover their analytical values first.

## Data boundary

Uptime product screens read authenticated ConnectRPC backed by PostgreSQL.
At the start of this survey, Insights supported Prometheus and Tempo, while
Observe had no Uptime RPC or SQL adapter. The implementation adds Uptime,
Shorted and PostgreSQL adapters with one shared typed-record contract. Provider
mapping still requires authorized access to the corresponding source.

Keep numeric measurements in existing `Series` data: counts, rates, durations,
percentages, scores, and status samples with explicit semantics. Labels are
bounded identity/dimensions such as service, check and region. Do not put
serialized report JSON, recommendations, nested findings, arrays or entire
graph payloads in metric labels or fake trace fields.

The chosen boundary is **one bounded records result contract** alongside
metrics and traces, shared across applications: typed columns and rows containing
scalar or null cells, with explicit returned/total/truncated information and
source observation/window metadata. Bound row count, column count, field
length and encoded bytes. Relationship records may distinguish node/edge
rows; narrative records may contain bounded plain text. The renderer must
not fetch data. Adapt Uptime RPC responses at the host/provider boundary,
where organization authorization, pagination and field allowlists belong.

Deterministic sample fixtures implement the same contract through an isolated
example adapter. They are labelled sample data and never replace failed live requests.
Static explanatory copy may live in widget descriptions/config, but report
content and current operating state are observations and should remain data.
Saved-query references, parameters, library metadata, imports/exports and
drilldowns should follow the existing canonical contracts.

Adding records requires coordinated validation, capability checks, builder
and plugin registration, JSON Schema/OpenUI round trips, and compact
`query_dashboard` summaries. The latter must retain bounded record examples,
field types and truncation; UI-only support would leave the machine-readable
dashboard flow incomplete.

## Fixture semantics and limits

The canonical payload references are in Uptime's protobuf sources:

- `proto/uptimeapi/v1/api.proto`: `CheckSummary`, `ServiceOverview`,
  `SecuritySummary`, `ServiceSLO`.
- `proto/uptimetypes/v1/types.proto`: `DependencyNode`, `DependencyEdge`,
  `ReliabilityInsight`, `ReliabilityReport`, `CronMonitor`, `CronRun`.

Preserve optional status, score and response-time fields. Missing score is
not score 0; no scan, disabled monitor, waiting for first result, incomplete
pagination and actual failure are distinct. A selected monitor must be
explicit; service history must never silently stand in for the first check.
All timestamps need units and a deterministic clock/window in fixtures.

Do not copy tokens, token prefixes, raw diagnostic excerpts, raw security
export payloads, response headers/bodies or credential-bearing URLs. A
credential-free fixture should contain only the fields needed to explain
the intended analytical behavior.

The source includes 60/90-day SLO choices, 90-day public status history and
90-day security trends. Paprika currently limits custom/provider query
ranges to 31 days. Preserve the longer source window in the inventory, and
design either an explicitly bounded aggregate/history adapter or a coordinated
range-policy extension. Silently truncating to 31 days is not parity. Keep
record/report coverage windows distinct from the time the snapshot was read.

Mutation controls are outside these examples: create/edit/delete resources,
trigger checks/scans, acknowledge or publish incidents, pause monitors,
rotate credentials, generate reports, and configure/share subscriptions.
Read-only filter controls, service selection, date selection, row details
and drilldown navigation remain useful coverage.

## Separate platform telemetry example

`backend/pkg/observability/metrics.go` declares 11 OTel instruments. Only the
HTTP request recorder has actual recording call sites in this checkout:
`http.request.count`, `http.request.errors` and `http.request.duration` in ms,
with method/path/status-code dimensions. Errors count status>=500. The API
serves `/metrics`; its Helm ServiceMonitor defaults disabled. Trace service
name defaults to `uptime-api` and can be overridden by `OTEL_SERVICE_NAME`.
Discover exported metric names/labels before constructing real queries.

Check-execution, alert and active-check/agent instruments are declared but
have no recording call sites. They cannot supply faithful product inventory,
SLO, incident or alert values. A request-rate/errors/latency/traces example
would be a new Uptime platform dashboard, explicitly separate from the three
application clones.
