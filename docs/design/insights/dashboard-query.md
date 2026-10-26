# Query a dashboard through Observe MCP

`query_dashboard` makes a saved dashboard a reusable read interface for machines.
It executes the same saved queries and explicit parameter bindings that feed the
UI, then returns a bounded snapshot instead of a dashboard definition or hundreds
of raw samples per panel. It is available when Insights is configured.

```json
{
  "name": "query_dashboard",
  "arguments": {
    "id": "service-overview",
    "variables": { "service": "uptime-api" }
  }
}
```

Use `list_dashboards` to discover IDs and `get_dashboard` to inspect the saved
definition. This call needs `paprika:observe`, global Insights read permission
and the caller's provider access. It does not need `paprika:insights:write`.
Neither variable overrides nor executing a query modifies saved documents.

## Machine contract

The tool advertises an output schema. Its `structuredContent` is authoritative;
the text content is a short synopsis, not a second copy of the JSON. The version
1 result contains:

| Field | Meaning |
|---|---|
| `schemaVersion` | Contract version, currently 1 |
| `dashboard` | Saved dashboard ID, title and exact ETag |
| `observedAt` | When this execution snapshot started |
| `range` | Resolved RFC3339 start/end and `stepSeconds` |
| `variables` | Saved defaults with this call's declared overrides applied |
| `widgets` | ID, title, type, unit, optional decimals and signal reference or resolution error |
| `savedQueries` | Referenced saved-query IDs and exact ETags captured with the dashboard |
| `signals` | Deduplicated query results, indexed by `q1`, `q2`, … |
| `queryCount` | Unique planned queries, provider calls begun and duplicate widget queries avoided |
| `state` | `ok`, `empty` or `partial`; availability, not service health |

Metric series report their original provider `index`, bounded name/labels,
`samples`, `valid`, `missing`, first/last finite points and min/max. Point
timestamps are Unix milliseconds. `firstAt`/`lastAt` bound valid timestamps even
when their values are missing. Invalid timestamps are counted separately.
`primarySeries` points to the original index of the first series with a finite
observation, matching the UI single-value card. The latest finite value retains
its full numeric precision; widget `decimals` only describes display formatting.
`tailMissing` explicitly marks missing values after that last finite observation.
Do not describe an old reading as current just because it is the latest finite
point.

Trace results include `returned`, `statusCounts` and a few examples with IDs,
service, operation, duration in milliseconds and start time. Counts describe the
bounded provider sample, never total requests. Unknown status stays unknown.
Malformed numeric trace fields are omitted and marked with `invalidFields`.

Missing saved-query references and invalid bindings are widget errors. Provider
failures are signal errors with fixed, sanitized codes/messages. Empty successful
queries remain empty; no synthetic zero or health judgment is introduced. A
dashboard is `partial` when a widget fails or a signal is partial/error. Sampling
and size omissions have explicit truncation flags; they are not automatically
provider failures. Check `truncated`, `providerTruncated`, `seriesTruncated`,
`metadataTruncated`, `historyTruncated` and `examplesTruncated` where present.

## Targeted drilldown

Default responses omit histories, layouts and query expressions. Ask for a widget
subset and bounded history when a trend matters:

```json
{
  "name": "query_dashboard",
  "arguments": {
    "id": "service-overview",
    "widget_ids": ["request-rate", "service-traces"],
    "variables": { "service": "uptime-api" },
    "start": "2026-10-26T10:00:00Z",
    "end": "2026-10-26T11:00:00Z",
    "history_points": 12,
    "max_series": 3,
    "max_traces": 3
  }
}
```

History points are `[unixMilliseconds, valueOrNull]` tuples. The bounded sample
prioritizes endpoints, extrema and gaps as the requested size permits; aggregate
counts/min/max always summarize the full normalized series. Inspect truncation
flags rather than treating the sampled history as every observation.

| Input/budget | Limit |
|---|---|
| Arguments | 32 KiB; unknown fields rejected |
| Variables | Declared names only; at most 20 string overrides |
| Widgets | All by default, or 1–48 unique existing widget IDs |
| Time | Both RFC3339 bounds or neither; maximum 31 days |
| Default range | Saved custom range, otherwise saved rolling range |
| Step | Same as UI: `max(1, ceil(rangeSeconds / 300))` |
| History | 0 by default, or 2–32 points per included series |
| Series | 3 by default, 1–8 supported |
| Trace examples | 3 by default, 1–10 supported |
| Structured result | 128 KiB; narrow widget/series/history selection if exceeded |
| Text synopsis | At most 8 KiB |
| Execution | 22-second shared budget, partial timeout results when possible |

Repeated identical queries execute once within a call. Results are not cached
across callers. All widgets use one resolved range; the dashboard and saved
query ETags are captured together before provider I/O. Later document edits do
not alter an in-flight snapshot. Saved references never fall back to dormant
custom query text. Tooltip queries require a hovered observation and are not
executed. Plugin panels expose their underlying query data, not arbitrary plugin
rendering semantics.

## Execution and admission

The read travels through Observe MCP → authenticated API Insights proxy →
Insights runtime → Observe MCP → provider. The fixed POST route
`/api/insights/query-dashboard` is authorized as a read; other POST routes retain
their write rules. Delegated provider requests preserve caller identity and
provider permissions.

Dashboard orchestration has two dedicated admission slots. Its nested provider
calls use the normal four-slot data pool, while discovery retains its existing
four-slot reserve. This prevents outer dashboard requests from holding every
data slot while waiting for their own inner calls. A third simultaneous dashboard
request is bounded by admission instead of allowing unbounded fan-out.
The HTTP layer marks orchestration admission in trusted request context. A
dashboard envelope exceeding its 36 KiB inspection budget cannot execute from
ordinary work slots; larger existing authoring requests remain supported.

## Verification

Focused Go tests exercise substitution parity, missing references, document
snapshots, query deduplication, range limits, partial failure, summary bounds,
read-only proxy authorization and nested admission under concurrent dashboards.

The browser integration test runs the actual MCP server, API proxy, Insights
stores, provider adapters and UI renderer against native Prometheus/Tempo test
fixtures. It compares both service selections' exact readings, timestamps,
301-point sparklines and traces with the compact machine result; verifies byte
reduction and no repeated full JSON in text; and checks scoped access, failure
states, bounded history and unchanged document versions.

```sh
cd ui
node e2e/run-insights.mjs e2e/insights-dashboard-query.e2e.mjs
```

Evidence is written to `artifacts/insights/dashboard-query/` (git-ignored).
`ui/e2e/insights-dashboard-query-live.e2e.mjs` repeats the comparison against
deployed providers using the private `INSIGHTS_SERVICE_OVERVIEW_CONFIG` format
documented by the service-overview browser test. It reads existing documents,
executes their queries over a shared fixed range and verifies document ETags are
unchanged. No telemetry is mocked and no saved documents are written.

### Omega acceptance — 26 October 2026

Deployed and verified at 22:40 Melbourne time (11:40 UTC):

- Source: `d4b6f354f2126cc0bfa46400bad7e92907e1a9b2`.
- [Linux amd64 build](https://github.com/paprikacd/paprika/actions/runs/40314288403)
  succeeded; immutable image
  `ghcr.io/paprikacd/paprika@sha256:ecf761f8411d36346887d273951a28c7043bacbe1540412cd4772fb7a6034f88`.
- Helm revision 50 is deployed. Helm 3.21.2 lint, render and server-side dry run
  passed. All 65 managed objects and six hooks were reviewed; only API, Insights
  and Observe deployment images changed. Controller placement, both MCP client
  registries and the original Bound Insights PVC were preserved.
- All six running components are ready with zero restarts. System-health warnings
  are unchanged from the pre-deployment baseline: one degraded application and
  three applications with exhausted retries. Reconcile generations are current.

The real [Service overview](https://paprika.benebsworth.com/dashboard/insights/?dashboard=service-overview)
returned eight widgets from seven unique provider executions, avoiding the
duplicate stat/chart query. Four live machine checks and seven live browser
checks passed, including light/dark layouts at 1512px and 390px, rapid service
switching, sparklines, exact observations and persisted-document integrity.
The machine comparison used `2026-10-26T10:36:00Z`–`11:36:00Z`, step 12 seconds.

| Service | Raw normalized provider results | Complete MCP result | Reduction |
|---|---:|---:|---:|
| `uptime-api` | 150,006 bytes | 6,393 bytes | 96% |
| `brandbrain-api` | 16,842 bytes | 3,364 bytes | 80% |

These are measured JSON byte counts, not tokenizer estimates. The compact size
includes both structured content and the text synopsis. Uptime's metric readings,
timestamps, extrema and sample counts match the provider responses exactly.
Brandbrain's six metric signals correctly remain empty. Both services return a
100-trace provider sample with three compact examples, explicit truncation and
100 unknown statuses; none is interpreted as healthy. A one-widget drilldown
returned 12 history points. All eight dashboard/saved-query documents retained
their exact content and ETags. The browser recorded no page errors or document
writes.

Local validation also passed required Go build/vet and engine/pipeline tests,
full Insights/gateway/API/MCP/cmd tests, race/admission tests, pre-commit lint,
seven machine-query browser scenarios, and 15 existing authoring scenarios.
The reusable live validator additionally runs against populated and empty local
provider fixtures to cover omitted empty result arrays.

Receipts and screenshots are in the git-ignored
`artifacts/insights/dashboard-query-live-20261026/`; local fixture evidence is in
`artifacts/insights/dashboard-query/`. Temporary read-only validation tokens were
removed after acceptance. The test used scoped machine credentials, not an
interactive OAuth sign-in test.
