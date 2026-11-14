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
| `widgets` | ID, title, type, unit, optional decimals, the declared band (`threshold`, with `bandSeries` for multi-series bands), the latest sample's age and limit (`sample`), the first-contract `freshness` where an explicit option judges it, breach intervals (`breaches`), the widget's `attention` reason when it needs one, and its signal reference or resolution error; `sample`, `freshness`, `bandSeries` and the listed intervals may be omitted under the result cap (see `omitted`); saved-query and annotation references identify the captured query revisions; plugin widgets include their registered `pluginId` and `dataKind` |
| `savedQueries` | Referenced saved-query IDs and exact ETags captured with the dashboard |
| `signals` | Deduplicated query results, indexed by `q1`, `q2`, …; each identifies the query kind and, when provider lookup is authorized, its resolved provider ID |
| `queryCount` | Unique planned queries, provider calls begun and duplicate widget queries avoided |
| `state` | `ok`, `empty` or `partial`; availability, not service health |
| `attention` | Dashboard-level count of widgets that need attention, with `checked` and the `basis` it counts; see below. Not a health verdict. Optional on the wire, so an older client's schema still accepts the result |
| `omitted` | Optional. Names, in the order applied, the optional detail dropped so the result fits 128 KiB: `breachIntervals`, `breaches`, `bandSeries`, `sample`. Absent when nothing was dropped. The step definitions are under Omitted detail below |

### Compatibility

Insights and the observability gateway deploy separately, and MCP clients validate
`structuredContent` against the schema the gateway advertises. The wire change is
therefore additive in both directions. `attention` is not required. The first
contract's `freshness.state` values (`fresh`, `stale`, `unknown`) and its required
`thresholdSeconds` are unchanged, and `freshness` appears only where an explicit
`staleAfterSeconds` judges the widget. The judgement for every metric widget is in
`sample`, whose states (`fresh`, `stale`, `unknown`, `no_threshold`) live in a new
field. A band's series index sits in `bandSeries`, beside `threshold`, which keeps
the first-contract shape with `additionalProperties: false`. The tests validate
the first contract's output against the new schema and the new output against the
first schema (`dashboard_query_schema_dfad989c.json`, `TestDashboardQuerySchemaIsSkewSafeWithTheFirstContract`).
A capped result keeps every stat's `freshness`, the first contract's object, because
a stat's stale judgement predates this release. Only the time-series `freshness`
this release added is dropped under the cap, and `omitted` names `sample` when it is.

### Attention summary

`attention` counts widgets, each under its single most severe reason, in this
order: `critical` and `warning` (an author-declared status that currently applies
to a stat, gauge, status view or heatmap, or, for a time series, a breach at that
level inside the returned window; the text says "in window" for a time-series
breach that is not the newest sample), `failed` (the widget's query or planning
failed), and `stale` (its sample is older than the limit in effect; see `sample`). Counts are `critical`, `warning`, `failed`, `stale`, the
number of `widgets` selected and `checked`, the widgets whose query returned
usable data (`state` `ok`). Empty, partial and failed widgets are unchecked but
only failures are counted as failed. An undeclared, `info`, `unknown` or
colour-only band never counts. The text fallback begins with the same counts,
for example `Attention: 2 critical, 1 warning, 1 failed, 1 stale; 9 of 13 widgets
checked.`, or `Attention: none; 9 of 13 widgets checked.` when nothing is counted,
and names the widgets with their reasons. It is a count of declared
statuses, failures and staleness, not a health verdict: a widget absent from the
attention count may still be unhealthy, and a counted widget may be a stale value
the author chose to alarm on. The rules are shared with `conformance/attention.json`.

Plugin visualization identity is attached to each widget even when its query is
deduplicated with other widgets. The bounded text fallback identifies the first
widget's view and the number of widgets sharing its signal; use structured
content for all widget identities. Annotation column mappings include the
optional interval end column when configured.

`savedQueryId` and `annotationSavedQueryId` identify the references authored on
each widget, including references that fail resolution. A corresponding entry in
`savedQueries` supplies the exact captured ETag when the query exists. Signals
include their normalized `kind` even on an empty result or provider error; their
`providerId` is included only after the caller is authorized to resolve that
provider. Neither field contains a query expression or credentials. Multiple
widgets can share a signal while referencing distinct saved-query documents.

Metric series report their original provider `index`, bounded name/labels,
`samples`, `valid`, `missing`, first/last finite points, min/max and `mean`. The
mean is the unweighted arithmetic average of finite returned observations with
valid timestamps; it is omitted when no finite observations exist. Duplicate
timestamps count separately, so it is not a time-weighted or source-wide
average. A provider-truncated result summarizes only the returned sample. Point
timestamps are Unix milliseconds. `firstAt`/`lastAt` bound valid timestamps even
when their values are missing. Invalid timestamps are counted separately.
`duplicateObservations`, when present, counts additional returned samples that
share an already-seen valid timestamp in that series, including missing-valued
samples. It does not alter statistics or establish source-wide duplication.
Some rich charts reject duplicate timestamps because choosing or combining values
would invent an aggregation; adjust the query if that visualization needs a
single observation per timestamp. The text fallback totals this count only over
the summarized series, so check `seriesOmitted` before assuming full coverage.
`primarySeries` points to the original index of the first series with a finite
observation, matching the UI single-value card. The latest finite value retains
its full numeric precision; widget `decimals` only describes display formatting.
`tailMissing` explicitly marks missing values after that last finite observation.
Declared bands (`threshold`) report the author's band that the displayed value
falls in: `boundary`, the band's `status` (`ok`, `info`, `warning`, `critical` or
`unknown`) and/or hex `color`, each present only when the threshold names it, and
an optional `label`. The first threshold is the fallback below its boundary,
matching the UI. An explicit text color can override the visible text color. A
colour-only threshold names no status and declares no band.

- A **stat** evaluates the last valid value it displays, including zero, and
  reports `unknown` when there is none. Its band exists whenever thresholds do.
- A **gauge** (`threshold-gauge`), **status grid**, **status history** or
  **heatmap** evaluates the series the visualization draws, each on its latest
  recorded sample. A missing latest sample is `unknown` and sets no band. The
  widget reports the most severe declared band among them (critical, then
  warning, unknown, info, ok, with the lowest series position winning a tie).
  `bandSeries` reports `evaluated` (the drawn series), `omitted` (returned series
  the visualization does not draw) and, when a band matched, the `series` index
  and a bounded `name` for the series that set it. A band is reported only when
  the thresholds name a status.

The drawn series follow the UI's caps, pinned to its source by
`TestPluginSeriesCapsMatchTheUI`: a gauge in `first` mode draws one series, and in
`all` mode `config.maxSeries ?? 6`; a status history draws `maxSeries ?? 12`; a
status grid draws `maxSeries ?? 512`; a heatmap draws its first 100 rows. A
returned series beyond those caps never sets a band, so a tile that shows green
is not reported critical.

Bands are author-configured visualizations, not alerts or health verdicts. Check
`tailMissing`, `freshness` and the signal state before treating a band as current,
and do not describe an old reading as current just because it is the latest
finite point.

### Breaches and samples

A **time series** whose thresholds name a `warning` or `critical` status reports
`breaches`: the stretches of the returned window where a sample sits in such a
band. It follows the UI's time-series breach rules, which are shared with the
browser through `conformance/breaches.json`. A run ends at the first sample that
does not continue it, extends to that sample or one observed cadence past its last
breaching sample (only when that sample is observed and not separated by a gap of
more than 1.5 cadences), and otherwise ends at its last breaching sample. Cadence
is the lower median of the positive steps between observed samples, and needs
three observed samples; without it nothing extends past the last breaching sample.
Up to 12 series are evaluated; `seriesEvaluated` and `seriesOmitted` say which.

`intervals` lists the most recent intervals of each level, up to 12 per level per
widget. The caps are per level, so one critical interval is never crowded out by
later warning flaps. A dashboard-wide budget (96 listed intervals) lowers the
per-widget count when many widgets are selected, which makes the structured result
more likely to fit its 128 KiB cap before any omission; `intervalsOmitted` counts
every interval not listed.
When the encoded result still exceeds the cap, the listed intervals are the first
detail omitted (see Omitted detail below).
Each interval gives `series`, a bounded `name`, `level`, `start`, `end` and
`durationMs` (Unix milliseconds, except the duration). `latestLevel` names the band
of the newest sample, and it is absent when that sample is not breaching.
`summary` merges intervals across series: `intervals` counts merged spans with
positive duration, `samples` counts single breaching samples outside them, and
`durationMs` is the merged time. Every breach figure is a count inside the returned
window. Only `latestLevel` describes the current sample. A failed signal reports no
`breaches`, so an absent object is not an empty result. A time series with no
warning or critical status reports no `breaches`.

Omitted detail. The structured result is budgeted against its encoded size. When it
would exceed 128 KiB, optional detail is dropped in this fixed order, and each step
runs only if the result still does not fit: (1) `breachIntervals`, the listed breach
intervals and their series names, with their count moved into `intervalsOmitted`;
(2) `breaches`, each widget's whole breach object, which includes its window
`summary` and `latestLevel`; (3) `bandSeries`, each multi-series band's whole
`bandSeries` object, so the drawn and omitted counts and the series that set the
band are absent while the band's `threshold` stays; (4) `sample`: each time series'
first-contract `freshness` is removed, a stale `sample` keeps its `state` and loses
its limit, timestamp and age, a stale `sample` is removed entirely when the widget's `attention`
already reads `stale`, and every other `sample` is removed entirely. A widget without
`sample` therefore has a fresh, `no_threshold` or `unknown` state that the cap
removed. A stat's `freshness` is never removed. The top-level `omitted` array names
the steps applied, in order. It is absent when nothing was dropped, so a result that
fits keeps every fact. Attention is counted before any omission and is never changed.
The text synopsis states what was omitted and that `widget_ids` narrows the query to
recover it.

Never dropped, under any step: the top-level `schemaVersion`, `dashboard`,
`observedAt`, `range`, `variables`, `savedQueries`, `signals` (every signal, its
series summaries and their labels), `queryCount`, `state`, `attention` and `omitted`;
and for each widget its identity fields (`id`, `title`, `type`, `unit`, `decimals`,
`pluginId`, `dataKind`), its saved-query, annotation and signal references and
resolution errors, its `threshold` object (for a multi-series band as well as a stat),
its per-widget `attention`, and the first-contract `freshness` of a stat. A stale
`sample` keeps its `state` unless `attention` already reads `stale`. A selection whose
remaining facts still exceed the cap after every step is refused with 413. The
largest of these is the signals: a dashboard of 48 widgets, each with three series of
nine raw kube-state labels and status bands, keeps 131,910 bytes after all four steps
on the current ladder, which is 838 bytes over the cap, so it is refused. Narrowing
the selection, the series or the history points brings it under the cap. The HTTP
response says so. An MCP caller sees `resource_exhausted` with its fixed message.

Every metric widget reports `sample` unless the result cap removes it (see Omitted
detail): the age of its latest valid returned sample relative to the range end, and
the limit that judges it. A stat measures its
displayed primary series. A time series measures the newest sample of any of its
series, as the UI's stale tail does. The limit is the widget's `staleAfterSeconds`
where it is set, for stat and time-series widgets. A time series without that
option uses the UI's fallback: twice the longest cadence among the series that
reported the newest sample (`basis: cadence`). A time series whose result is
truncated is not judged, because the UI draws no stale tail for a truncated result.
Otherwise the state is `no_threshold`: the age is reported without a judgement.
Other metric types, such as bars, heatmaps, tables and rich-metrics plugins, have
no limit. Rich metrics read `staleAfterSeconds` only as a track-end grace, not a
stale mark. `unknown` means no usable returned sample.

`freshness`, the first contract's object, is present only where an explicit
`staleAfterSeconds` judges the widget. It carries the same judgement in the same
three states, with `thresholdSeconds`. `thresholdSeconds` is an integer, so the
cadence-derived limit appears only in `sample`. Text describes only judged samples.
Under the result cap, a time series' `freshness` is removed in step 4, and a stat's is kept.

Trace results include `returned`, `statusCounts` and a few examples with IDs,
service, operation, duration in milliseconds and start time in Unix milliseconds. Counts describe the
bounded provider sample, never total requests. Unknown status stays unknown.
Malformed numeric trace fields are omitted and marked with `invalidFields`.

Missing saved-query references and invalid bindings are widget errors. Provider
failures are signal errors with fixed, sanitized codes/messages. Empty successful
queries remain empty; no synthetic zero or health judgment is introduced. A
dashboard is `partial` when a widget fails or a signal is partial/error. Sampling
and size omissions have explicit truncation flags; they are not automatically
provider failures. A provider-limited response with no usable observations is
`partial`, not a conclusive empty result; a limited response with observations
is `ok` and separately reports `providerTruncated`. Check `truncated`, `providerTruncated`, `seriesTruncated`,
`metadataTruncated`, `historyTruncated` and `examplesTruncated` where present.
Successful metric signals report `seriesReturned` and `seriesOmitted`, including
zero for an empty response. The former counts the bounded provider response,
not total source cardinality; the latter counts fetched series omitted from the
compact summary. Both are independent of `providerTruncated`.

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

The compact text synopsis includes the resolved time range, step, observation
time and dashboard ETag, followed by bounded effective variable values (saved
defaults plus any overrides). Variable names are sorted; shortened values use
an ellipsis and omitted variables are counted. Use structured content for the
complete context. The synopsis also includes a bounded per-series summary for signals
with multiple metric series: identity, latest valid value and timestamp, and
whether the latest observation is missing, and its sample mean when available.
A series without a valid observation
is reported as such. At most three sorted labels are shown per series; additional
labels and series omitted to fit the 1,000-byte per-signal detail budget are
disclosed. Structured content remains authoritative for complete included
series metadata and for the overall source and preview truncation flags.
Trace text likewise includes sample status counts and bounded example IDs,
service, operation, status, duration and start time when present. It labels
these as sampled results, discloses omitted examples, and never invents missing
numeric fields. Use structured content for the authoritative included examples.

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
| Breaches | 12 series evaluated, 12 most recent intervals listed per widget, two levels in the summary |
| Structured result | 128 KiB. Optional detail is omitted in a fixed order and named in `omitted`; 413 only when the signals and the never-dropped facts (see Omitted detail) still exceed it |
| Text synopsis | At most 8 KiB |
| Execution | 22-second budget for the whole read; shared-catalog calls draw on it, each capped at 20 seconds, with partial timeout results when possible |
| Shared catalog | 4 concurrent catalog phases; a waiting query gets one within 5 seconds (16 waiters), else 429 with `Retry-After: 1`; a listing's own cap is 10 seconds. A `/query` has one 22-second budget covering the wait, the admission wait, the listing and the data call |

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
The breach rules are pinned by `conformance/breaches.json`. The Go breach port and
the UI's `breaches.test.ts` both run it, so the two cannot diverge.
`conformance/attention.json` (widget facts to attention counts) is run by the Go
tests only. No UI port exists yet, so a later UI slice that computes attention
must run it too. Characterisation tests pin the output of a document without status
thresholds. Its structured values are unchanged, and its text synopsis is unchanged
except for the leading attention line, which is the only added line. The additive
fields (`attention`, `sample`, `breaches`, `bandSeries`, `omitted`) are stripped before the
structured comparison.

The UI's series caps (`TestPluginSeriesCapsMatchTheUI`) and the stale set
(`TestStaleJudgementSetMatchesTheUI`) are pinned by reading the UI sources, so a UI
change that moves either fails the Go tests.

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

### Rollout recheck — 27 October 2026

On 27 October Melbourne time, the API, Insights and Observe gateway were still ready
on the deployed `d4b6f354` image above. No replacement rollout was needed.
The public Observe endpoint advertised `query_dashboard` and passed all four
live machine checks again. The Service overview still resolves eight widgets
into seven unique queries, with all eight saved documents unchanged.

For `uptime-api`, the complete MCP response measured 6,335 bytes against 149,673
bytes of full normalized provider results (96% smaller). For `brandbrain-api`,
it measured 3,363 against 16,825 bytes (80% smaller), correctly preserving empty
HTTP metric signals and a bounded trace sample. All seven real-provider browser
checks also passed, including light/dark desktop/mobile rendering, service
switching and sparklines. Existing unrelated fleet-health warnings are unchanged.

The Observe README and both bundled skills now direct clients to
`list_dashboards` → `query_dashboard` for an existing dashboard instead of
fetching and executing each saved query separately. Package contract tests pass.
Fresh results and a readable bundle presentation are available under
`artifacts/insights/dashboard-bundle-rollout-20261027/` (git-ignored). Temporary
read-only validation tokens were removed after this recheck.
