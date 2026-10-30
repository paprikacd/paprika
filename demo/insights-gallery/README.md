# Local gallery data

This creates an isolated synthetic-data stack for dashboard exploration. It
does not connect to a cluster or modify another database. PostgreSQL,
Prometheus and Tempo publish ports only on `127.0.0.1`; the exporter runs on
a dedicated Docker network. PostgreSQL access uses a dedicated SELECT-only
role. The database and traces are illustrative, not production data.

New stacks append synthetic PostgreSQL probe, company, node, edge-trend,
blocked-request and gateway-event observations while their disposable database
container is running. Edge Watch adds one fictional blocked-request row per
cluster every two minutes and a synthetic gateway event every fifteen minutes;
these records are generated independently of the traffic metrics. A worker
inside that container runs once a minute; it updates only these demo history
tables, never rewrites old observations, and catches up at most one day per
run after a pause. It stops with the container. Incidents, company rankings,
node inventory and other snapshots are seeded examples, not continuously
updated data. Existing stacks created before this feature are not changed;
start a new stack to use it. Histories are not automatically pruned, so stop
and recreate a long-running demo when its storage is no longer needed.

The append-only behavior can be tested independently. This test creates and
removes its own network-isolated PostgreSQL container:

```sh
python3 demo/insights-gallery/check-postgres-refresh.py
```

With a new stack and its local gallery harness running, the read-only live
check waits for a later worker tick and verifies both clusters' saved queries:

```sh
node demo/insights-gallery/check-edge-continuation-live.mjs http://127.0.0.1:<harness-port>/
```

```sh
python3 demo/insights-gallery/start.py
```

To seed the seven local gallery dashboards, the availability and query stress labs, and their saved queries into a
separate Insights store, first build and serve the UI on loopback (use a free
port and leave that server running):

```sh
cd ui
npm run build -- --webpack
python3 -m http.server 3062 --bind 127.0.0.1 --directory out
```

From the repository root, start the isolated Insights/Observe harness, using
the private provider file printed by `start.py`:

```sh
node demo/insights-gallery/serve.mjs \
  --providers=artifacts/insights/gallery-live-<id>/providers.json \
  --ui-url=http://127.0.0.1:3062/ \
  --ready-file=artifacts/insights/gallery-ready.json
```

Use the loopback URL printed by the harness to open **Local gallery demos**.
Keep both servers and the Docker stack running. The proxy attaches a short-lived
local test credential server-side; restart the harness for a fresh session.
The harness creates a fresh private document store each time and never writes
to the production dashboard store. To exercise the saved queries with both
default and alternate filters against the local providers:

```sh
node demo/insights-gallery/check-providers.mjs http://127.0.0.1:<harness-port>/
node demo/insights-gallery/check-mcp-duplicate-observations.mjs
node demo/insights-gallery/check-reliability.mjs http://127.0.0.1:<harness-port>/
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-incident-severity-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-event-range-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-market-range-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-record-tooltip-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-record-scale-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-heatmap-scale-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-metric-pie-tooltip-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-pie-extreme-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-heatmap-scale-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-mobile-inspector-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-signal-pie-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-gauge-extremes-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-drilldown-destination-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-signal-traces-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-series-comparison-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-edge-network-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-directional-axis-authoring-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-record-table-inspector-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-record-treemap-tooltip-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-tooltip-placement-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-observation-placement-live.e2e.mjs
PAPRIKA_TRACE_CONNECTION=artifacts/insights/gallery-insights-<id>/private-connection.json node ui/e2e/insights-trace-waterfall-live.e2e.mjs
node demo/insights-gallery/check-network-history.mjs http://127.0.0.1:<harness-port>/
node demo/insights-gallery/check-trace-shapes.mjs http://127.0.0.1:<harness-port>/
node ui/e2e/insights-legend-mean-live.e2e.mjs artifacts/insights/gallery-ready.json
node ui/e2e/insights-stacked-extremes-live.e2e.mjs artifacts/insights/gallery-ready.json
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-compact-canvas-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-inactive-selection-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-inactive-tooltip-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-event-conversion-live.e2e.mjs
node demo/insights-gallery/check-geography.mjs http://127.0.0.1:<harness-port>/
node demo/insights-gallery/check-sample-age.mjs http://127.0.0.1:<harness-port>/
python3 demo/insights-gallery/check-bootstrap.py artifacts/insights/gallery-live-<id>/
node demo/insights-gallery/check-postgres-refresh-live.mjs http://127.0.0.1:<harness-port>/
node demo/insights-gallery/check-fleet-conditions.mjs http://127.0.0.1:<harness-port>/
node demo/insights-gallery/check-collection-throughput.mjs http://127.0.0.1:<harness-port>/
node demo/insights-gallery/check-mcp-bundles.mjs artifacts/insights/gallery-ready.json
node demo/insights-gallery/check-mcp-mean.mjs artifacts/insights/gallery-ready.json
node demo/insights-gallery/check-mcp-mean-cancellation.mjs artifacts/insights/gallery-ready.json
node demo/insights-gallery/check-authoring-schema.mjs artifacts/insights/gallery-ready.json
node demo/insights-gallery/check-mcp-feedback.mjs artifacts/insights/gallery-ready.json
node demo/insights-gallery/run-partial-empty-mcp.mjs --providers=artifacts/insights/gallery-live-<id>/providers.json --ui-url=http://127.0.0.1:<ui-port>/
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-save-guidance-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-gallery-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-tooltip-drilldown-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-fleet-conditions-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-small-multiples-labels-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-ai-context-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-connection-map-accessibility-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-map-overlap-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-treemap-responsive-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-record-fields-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-link-labels-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-topology-layout-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-sample-freshness-live.e2e.mjs
INSIGHTS_E2E_URL=http://127.0.0.1:<ui-port>/ PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-query-retry-live.e2e.mjs
PAPRIKA_GALLERY_READY=artifacts/insights/gallery-ready.json node ui/e2e/insights-annotation-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-gallery-stress-live.e2e.mjs
PAPRIKA_GALLERY_BASE_URL=http://127.0.0.1:<harness-port>/ node ui/e2e/insights-collection-live.e2e.mjs
node demo/insights-gallery/rapid-scroll.mjs http://127.0.0.1:<harness-port>/ 3
```

The trace-waterfall test and MCP bundle check read the harness's private
connection file; do not share its token. The former creates and removes an
isolated dashboard with an ETag, while the latter exercises Observe MCP
dashboard bundles, including variable bindings and ETags.
The read-only authoring schema check discovers a range-bound SQL example over
MCP and adapts its illustrative view to execute against synthetic PostgreSQL
data in current and historical windows.
The feedback check creates and removes a uniquely named local dashboard using
its exact ETag, and verifies that missing saved queries and provider errors
appear in both structured results and compact text.
The partial-empty check starts a separate loopback-only mock Prometheus and
Observe/Insights harness. It checks incomplete empty results versus complete
empty and observed zero through MCP and in the UI at desktop and mobile widths
in both themes, then removes each unique dashboard using its ETag.
Node.js 24 or newer is required for the TypeScript fixture imports.

The **Query Stress Lab** intentionally exceeds the 100-series metric and
1,000-record provider bounds, using 240 monitor series and 1,320 stored
PostgreSQL rows per cluster with nulls, zeroes, outliers and mixed status.
It also displays a high-volume Tempo trace sample with realistic parent/child
spans. Provider-limit notices are expected: the UI
warns about bounded results, and the MCP signals report `truncated` and
`providerTruncated` even when the queries themselves succeed. Record counts
describe the fetched page, not a source-wide total. The standard demo is not a capacity benchmark.

The rapid-scroll diagnostic reports durations, capacity rejections, aborted
requests and visible failures. It is deliberately non-gating for timing and
only measures this local stack; compare builds under the same conditions.

The gallery data, company names, and incident annotations are synthetic.
Service Pulse and Signal Kit load event markers from the saved PostgreSQL
incident query; Edge Watch loads gateway events from a separate saved query.
Service Pulse compares the selected service with catalog and worker, and its
one-hour burn rate is the observed request-error rate divided by the 0.1%
budget for a 99.9% objective. It is a burn-rate multiple, not cumulative
budget consumed. Pin a request-rate observation to see a saved-query history
for that series and open its traces on Reliability Room. The link carries the
current dashboard time range; it does not narrow the range to the hovered time.
Signal Kit's service and cluster selectors are bound to its request rate,
latency, component state, latency distribution, incident markers and the
saved-query-backed service trace panel; its memory gauge uses the same cluster
selector. The trace query matches spans carrying both selected resource labels,
so downstream spans can also match their own service. These traces and the
dashboard metrics are independently generated examples, not correlated
requests or evidence of real service health.
Open a trace's waterfall to inspect its spans on a common elapsed-time axis.
Parent guides reflect recorded span relationships; omitted, unresolved and
partial data remain identified rather than inferred. The timeline can be
scrolled horizontally when its labels and bars do not fit a narrow viewport.
On a directional or stacked chart, the inspector compares the displayed
series at the exact selected timestamp; a missing sample is shown as missing,
not filled from a neighboring time. Hover keeps a compact preview, while a
pinned observation exposes the full recorded details and history.
Its old-sample card uses a synthetic PromQL filter that excludes samples within
ten minutes of the last provider sample at the selected range end. The provider and exporter continue
running: the optional warning describes the latest valid returned sample
relative to the query range end, not scrape or ingestion health. Historical
ranges require underlying samples within the provider's retention.
Provider histories have the retention described below, and the examples are
not operational dashboards.
Edge Watch uses synthetic PostgreSQL locations for geographic hex bins and a
record honeycomb. Activate a map point or an item in its searchable location
list to update the selected location detail. A honeycomb cell updates the same
detail; its saved-query tooltip uses that record's label and current cluster. Fleet
Atlas illustrates fixed-scale continuous and segmented gauges and threshold
colors. On ordinary, stacked and directional time-series panels, **Compare
window** can zoom locally, query and overlay the preceding period, or apply the
selected bounds to the dashboard without saving them. The prior-data inspector
retains original timestamps. A stacked comparison is withheld when the prior
data cannot be matched completely; directional comparisons disclose omitted
invalid values.
Edge Watch combines a threshold-colored observation map, ranked destination
traffic, source risk histories and blocked requests. The map combines 288
named-city samples with 144 separately labeled global land samples per cluster;
the honeycomb keeps the 288 named-city records. Map points are synthetic
coordinates, not an interpolated population or customer-traffic surface. City
samples are near their named city; regional samples are near that city in the
surrounding region. Global samples are distributed across land without naming
or implying a real client. They are not real locations or precise geocoding.
Its directional traffic chart enables **Center zero on the value axis**, an
authorable option that uses equal positive and negative bounds while retaining
the original observed ingress and egress values in the inspector. Existing
directional charts keep their previous axis behavior unless the option is set.
Record-table cells can be inspected by pointer or keyboard and pinned for
details; the treemap inspector presents the recorded area and, when configured,
the independent color value. A column unit takes precedence for area values;
otherwise the treemap uses its widget unit. The color field keeps its own unit.
When marker hitboxes overlap, activating the shared point opens a list of the
recorded locations there. Choosing one preserves its original coordinates and
selection context; the searchable location explorer remains available.
The destination and risk tables number their loaded rows in the current display
order; sorting or filtering changes those positions, which are not source-wide
rankings. Blocked statuses use an explicit color mapping for the recorded value.
The fixed points were checked against the public-domain [Natural Earth 1:50m
land polygons](https://www.naturalearthdata.com/downloads/50m-physical-vectors/)
([terms of use](https://www.naturalearthdata.com/about/terms-of-use/)); the
map uses a coarser outline, so small islands may not appear. To repeat the
land check against the pinned source:

```sh
curl -fsSL -o /tmp/paprika-ne50-land.geojson https://raw.githubusercontent.com/nvkelso/natural-earth-vector/693f11422f4e08d2da4566b854dda53eb7c39fb3/geojson/ne_50m_land.geojson
python3 demo/insights-gallery/verify-geography-land.py /tmp/paprika-ne50-land.geojson
```
Reliability Room uses 30-day probe samples for availability and remaining
budget against a 99.9% target. Its request-error counter varies independently
and includes two 9-hour synthetic incidents per service; their recorded
PostgreSQL intervals align with the Prometheus error-rate spikes. Its service
comparison table is a separately seeded PostgreSQL probe set; burn rates use request-error counters, so the two
signals are not interchangeable. Timeline cells show the worst observed probe
in each three-hour lookback. Incident rows can focus the dashboard time range
and trace panel using the recorded incident start and duration.
The incident calendar colors each recorded UTC day by the maximum explicit
severity rank (warning or critical); a day without records is unobserved, not
an assertion of no incidents. A separately seeded unclassified-severity
record demonstrates unknown; its hatched day is distinct from an unobserved
day. It is created only when a past day in the current month has no existing
incident for that service, so it cannot mask a known severity.
Synthetic Tempo data includes parent/child spans across checkout, catalog,
payments and storage services for inspecting distributed traces.
Collection Control displays source-freshness thresholds against the latest
Prometheus samples. Its job execution history uses separately generated
sampled states (failed, running, complete), including an interval with no
samples; the PostgreSQL recent-job records are an independent synthetic set.
The recent-job table filters that set to failed or retrying runs and shows their
recorded start time, pipeline, duration and status. Ingestion throughput uses
separate counter-derived metrics, traces and logs series; the top statistic
reports the metrics series rather than their combined total.
Fleet Atlas uses an independent synthetic node-condition metric: 0 means
unavailable, 1 means ready with pressure, and 2 means ready without pressure.
The ready count includes observed pressure and ready states; missing samples
remain unknown and are excluded. The node resource table is a separately seeded
synthetic inventory and is not a claim about a real Kubernetes cluster.

The studies are runnable demonstrations rather than pixel-identical copies of
the artboards. Some artboard-specific detail panels and status states remain
to be built. The incident calendar displays incident duration; it does not
infer uptime for dates with no records. Company, node, source and location
selection is wired to the corresponding details.
Market Lens groups the four largest recorded companies per sector by market
capitalization; its sector trend averages all recorded companies in each
sector. The sector selector filters summary metrics, rankings and daily records,
while the composition and sector comparison remain across all sectors.
Selecting a company updates its detail and recorded hourly history, including
when the selected company's sector differs from the summary filter.

The command creates a unique directory under `artifacts/insights/` and prints
its path. `providers.json` contains private credentials and is mode 0600;
never commit it or paste it into chat. It can be passed as a private fixture to
the local `hack/insights-observe-e2e` harness via
`--application-providers-stdin`, or used to configure loopback-only development
providers. `state.json` lists container identities and public loopback ports.

Prometheus receives six hours of minute-resolution history, plus 31 days of
five-minute request-counter and probe history. The local Tempo search limit is
31 days so traces can be inspected within the Reliability Room window. A synthetic exporter keeps current metrics fresh;
its deterministic activity curve continues counters monotonically and keeps
histogram buckets cumulative, while selected gauges vary within safe ranges.
The independently generated ingress and egress gauges have bounded,
deterministic minute-scale peaks in both clusters; their backfill and live
continuation share the same signal. These values are illustrative network
traffic, not measured gateways.
Tempo receives a burst of 660 synthetic multi-span OTLP traces for omega at
startup. The live exporter then generates six new four-span traces per root
service per cluster (omega and delta) each minute. One trace per root service
and cluster in each batch has a failed root and downstream call; the rest are
successful. Six deterministic timing shapes range from 120 to 760 ms, with each
child span contained by its recorded parent. The 200 ms shape remains stable
for repeatable waterfall checks. This keeps filtered trace and error views populated after the
startup burst ages out, and a 30-minute search exercises the result bound.
The synthetic trace failure fraction is illustrative and does not represent
or derive from the separate request-error metrics.
The Prometheus TSDB is in an isolated Docker volume rather than a slow macOS
bind mount. PostgreSQL uses a disposable container and local volume layer.
If history import takes several minutes, the synthetic exporter fills the
missing past minutes with samples from the same deterministic continuation
used for live data. Prometheus briefly scrapes at one-second intervals to
collect them, then returns to the normal one-minute scrape interval before the
stack is declared ready. `check-bootstrap.py` checks the join, series identity,
and five-minute rate against that local Prometheus. Cancellation stops only the
new run's containers and network and retains its synthetic data volume.

The primary metric families are:

| Family | Labels / units |
| --- | --- |
| `paprika_demo_requests_total` | cluster, service, code; counter |
| `paprika_demo_request_duration_seconds_bucket` | cluster, service, le; cumulative histogram |
| `paprika_demo_service_up`, `paprika_demo_probe_up` | cluster, service; 0/1 |
| `paprika_demo_monitor_up` | cluster, monitor; 0/1 |
| `paprika_demo_component_up` | cluster, service, component; 0/1 |
| `paprika_demo_node_cpu_ratio`, `paprika_demo_node_memory_ratio` | cluster, node; ratios |
| `paprika_demo_node_disk_free_bytes`, `paprika_demo_node_disk_total_bytes` | cluster, node; bytes |
| `paprika_demo_network_mbps` | cluster, direction; Mb/s |
| `paprika_demo_edge_requests_total` | cluster, outcome; counter |
| `paprika_demo_edge_connections` | cluster; count |
| `paprika_demo_destination_requests` | cluster, destination; count |
| `paprika_demo_pipeline_items_total` | cluster, pipeline, signal; counter |
| `paprika_demo_pipeline_rejected_total` | cluster, pipeline; counter |
| `paprika_demo_source_freshness_seconds` | cluster, source; seconds |
| `paprika_demo_slo_burn_ratio` | cluster, service, window; ratio |
| `paprika_demo_market_companies`, `paprika_demo_market_short_percent`, `paprika_demo_market_change`, `paprika_demo_market_coverage_percent` | sector; count, percent or percentage-point change |

`seed.sql` documents the `gallery` tables for companies and histories,
nodes and histories, sources, destinations, pipeline edges, jobs, services,
observations and incidents. Company history can be rendered as a table
sparkline by selecting an ordered JSON array:

```sql
SELECT c.symbol, c.name, c.short_percent,
  (SELECT json_agg(json_build_object(
      'timestamp', to_char(h.observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
      'value', h.value) ORDER BY h.observed_at)::text
   FROM gallery.company_history h WHERE h.symbol = c.symbol) AS trend
FROM gallery.companies c
WHERE c.sector = $1
ORDER BY c.short_percent DESC
LIMIT 20;
```

When finished, stop a specific run by passing its printed state directory:

```sh
python3 demo/insights-gallery/stop.py artifacts/insights/gallery-live-<id>
```

This stops only the named local demo containers and retains its synthetic
Prometheus volume. Pass `--delete-data` to remove that volume explicitly.
The local state directory and private credentials remain for the operator to
remove deliberately.

Generator checks can be run without Docker:

```sh
python3 -m unittest discover -s demo/insights-gallery -p test_seed.py
```
