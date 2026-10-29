# Reference dashboard acceptance specification

These are private test compositions grounded in the four user-supplied Grafana screenshots. They are not gallery templates. The acceptance path generates/imports complete dashboard bundles with saved queries and one shared service filter, then renders them through the real application. The deterministic data is explicitly test-only.

## What must match

- Panel hierarchy, relative widths, visual density and chart mix follow the supplied reference.
- Every visible signal comes from a saved query and changes through the shared service filter.
- Additive stacks, histogram buckets, units, dual axes and missing observations retain their actual meanings.
- References 1, 3 and 4 fit a desktop frame at 1600 × 1100; the two-dashboard collage in reference 2 intentionally scrolls.
- The result is judged from the complete generated dashboard, then its filters, inspection, editing and persistence are exercised.
- Pixel equality is not claimed: the original images have different sizes, two are cropped/composited, and Paprika retains its own type and control styling.

## image-1: Ingress controller

Source: `codex-clipboard-3576a3e9-1377-493e-829a-18b2545bd80a.png` (468 × 427). One desktop frame.

| Panel | Geometry x/y/w/h | Reusable component | Reference role |
| --- | --- | --- | --- |
| Requests · period | 0/0/2/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| Available | 2/0/1/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| Connections | 3/0/1/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| p95 latency | 4/0/1/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| Success rate | 5/0/2/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| HTTP 2xx | 7/0/1/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| HTTP 3xx | 8/0/1/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| HTTP 4xx | 9/0/1/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| HTTP 5xx | 10/0/2/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| HTTP requests / ingress | 0/2/4/3 | timeseries | First of three equal-width traffic plots; irregular request rates with short bursts. |
| HTTP status codes | 4/2/4/3 | timeseries | Four low-opacity response-code lines with a compact legend. |
| Total HTTP requests | 8/2/4/3 | stacked-timeseries | Green-style vertical time bars with varying heights, not categorical bars. |
| Latency · average and percentiles | 0/5/6/3 | timeseries | Half-width multi-quantile line chart; a sharp high-percentile excursion preserves the reference silhouette. |
| Latency distribution | 6/5/6/3 | distribution-heatmap | Half-width dense time-by-latency color field; cumulative buckets are valid and overflow is explicit. |
| New connections opened | 0/8/6/3 | stacked-timeseries | Lower-left thin vertical bars with sparse large spikes. |
| Total connections open | 6/8/6/3 | timeseries | Lower-right cumulative area rises in irregular steps. |

Documented approximations:

- Nine KPI widths use the existing twelve-column grid, so three values receive wider cells.
- The reference's collapsible row headings and percentile mean/max table are represented by panel titles and latest-value legends.
- Values and timestamps are deterministic test observations, not numbers extracted from the low-resolution screenshot.

Data contracts:

- **Requests · period** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-total`.
- **Available** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-availability`.
- **Connections** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-connections`.
- **p95 latency** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-duration`.
- **Success rate** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-success`.
- **HTTP 2xx** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-http2xx`.
- **HTTP 3xx** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-http3xx`.
- **HTTP 4xx** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-http4xx`.
- **HTTP 5xx** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-http5xx`.
- **HTTP requests / ingress** — 2 metric series per scope; 121 timestamp-aligned numeric/null observations; labels ingress, service. Saved query: `reference-ingress-traffic`.
- **HTTP status codes** — 4 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-status`.
- **Total HTTP requests** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-request-bars`.
- **Latency · average and percentiles** — 4 metric series per scope; 121 timestamp-aligned numeric/null observations; labels quantile, service. Saved query: `reference-ingress-quantiles`.
- **Latency distribution** — 9 metric series per scope; 121 timestamp-aligned numeric/null observations; labels le, service. Saved query: `reference-ingress-distribution`.
- **New connections opened** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-opened`.
- **Total connections open** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-ingress-total-connections`.

## image-2: Network and host operations

Source: `codex-clipboard-39e37762-0d41-4e67-bccb-e64bb369e081.png` (518 × 590). Two stacked dashboard sections; vertical scrolling is expected.

| Panel | Geometry x/y/w/h | Reusable component | Reference role |
| --- | --- | --- | --- |
| Observation clocks | 0/0/2/3 | record-list | Top-left time readouts belong to the fixed source snapshot, not live ticking browser clocks. |
| Firewall block events | 2/0/4/3 | timeseries | Compact event-rate area plot with narrow irregular spikes. |
| Top connection destinations | 6/0/3/3 | bar | Five ranked destination counts replace the original horizontal list with the existing comparison bars. |
| UPS battery capacity | 9/0/3/3 | threshold-gauge | Two short green capacity rows echo the reference's UPS status strip. |
| Firewall event origins | 0/3/4/3 | connection-map | Location-weighted dots use actual supplied coordinates; geographic outline is visual context only. |
| WAN traffic | 4/3/4/3 | directional-traffic | Spiky bandwidth with inbound above/outbound below the shared baseline. |
| Protocol observations | 8/3/4/3 | record-table | Dense protocol table balances the network plots. |
| DHCP clients | 0/6/4/3 | record-table | The first of three compact operational tables uses documentation-range addresses. |
| Firewall rule counters | 4/6/4/3 | record-table | Numeric rule counters replace the reference's embedded colored mini-bars, which are not currently table features. |
| Recent flows | 8/6/4/3 | record-table | A third table preserves the network dashboard's lower-row density. |
| host-01 | 0/9/2/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| host-02 | 2/9/2/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| host-03 | 4/9/2/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| host-04 | 6/9/2/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| host-05 | 8/9/2/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| host-06 | 10/9/2/2 | stat | Compact top-line numeric card; authored color conveys the signal family. |
| CPU usage · now | 0/11/2/3 | threshold-gauge | Six current-value host meters align with all six series in the neighboring host telemetry plot. |
| CPU usage · hosts | 2/11/5/3 | timeseries | Six thin host series form the center column of the original hardware matrix. |
| CPU usage · GPUs | 7/11/5/3 | timeseries | Six related device series form the right column; flat memory bands contrast with bursty utilization. |
| Temperature · now | 0/14/2/3 | threshold-gauge | Six current-value host meters align with all six series in the neighboring host telemetry plot. |
| Temperature · hosts | 2/14/5/3 | timeseries | Six thin host series form the center column of the original hardware matrix. |
| Temperature · GPUs | 7/14/5/3 | timeseries | Six related device series form the right column; flat memory bands contrast with bursty utilization. |
| Power draw · now | 0/17/2/3 | threshold-gauge | Six current-value host meters align with all six series in the neighboring host telemetry plot. |
| Power draw · hosts | 2/17/5/3 | timeseries | Six thin host series form the center column of the original hardware matrix. |
| Fan speed · devices | 7/17/5/3 | timeseries | Six related device series form the right column; flat memory bands contrast with bursty utilization. |
| Memory used · now | 0/20/2/3 | threshold-gauge | Six current-value host meters align with all six series in the neighboring host telemetry plot. |
| Memory used · hosts | 2/20/5/3 | timeseries | Six thin host series form the center column of the original hardware matrix. |
| Memory used · GPUs | 7/20/5/3 | timeseries | Six related device series form the right column; flat memory bands contrast with bursty utilization. |

Documented approximations:

- The supplied image combines two separate dashboards. This composition intentionally preserves both as a vertically scrolling network block and host matrix.
- Snapshot clocks are source records and do not tick in the browser.
- The reference's horizontal destination bars and per-cell table meters use existing vertical bars and numeric record cells.
- Location markers represent supplied coordinates; no location or connection is inferred from an IP address.

Data contracts:

- **Observation clocks** — Record columns: service:string, clock:string, zone:string, date:string. Saved query: `reference-network-hosts-clock`.
- **Firewall block events** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-network-hosts-blocked`.
- **Top connection destinations** — 5 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-network-hosts-destinations`.
- **UPS battery capacity** — 2 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-network-hosts-power`.
- **Firewall event origins** — Record columns: service:string, label:string, latitude:number, longitude:number, value:number, status:string. Saved query: `reference-network-hosts-locations`.
- **WAN traffic** — 2 metric series per scope; 121 timestamp-aligned numeric/null observations; labels direction, service. Saved query: `reference-network-hosts-traffic`.
- **Protocol observations** — Record columns: service:string, name:string, packets:number, bytes:number (MB), state:string. Saved query: `reference-network-hosts-protocol`.
- **DHCP clients** — Record columns: service:string, ip:string, host:string, lease:string, state:string. Saved query: `reference-network-hosts-clients`.
- **Firewall rule counters** — Record columns: service:string, rule:string, hits:number, rate:number (/s), state:string. Saved query: `reference-network-hosts-rules`.
- **Recent flows** — Record columns: service:string, source:string, destination:string, packets:number, state:string. Saved query: `reference-network-hosts-flows`.
- **host-01** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-network-hosts-host-0`.
- **host-02** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-network-hosts-host-1`.
- **host-03** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-network-hosts-host-2`.
- **host-04** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-network-hosts-host-3`.
- **host-05** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-network-hosts-host-4`.
- **host-06** — 1 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-network-hosts-host-5`.
- **CPU usage · now** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-cpu-current`.
- **CPU usage · hosts** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-cpu-hosts`.
- **CPU usage · GPUs** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-cpu-devices`.
- **Temperature · now** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-temperature-current`.
- **Temperature · hosts** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-temperature-hosts`.
- **Temperature · GPUs** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-temperature-devices`.
- **Power draw · now** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-power-current`.
- **Power draw · hosts** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-power-hosts`.
- **Fan speed · devices** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-power-devices`.
- **Memory used · now** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-memory-current`.
- **Memory used · hosts** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-memory-hosts`.
- **Memory used · GPUs** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, signal, service. Saved query: `reference-network-hosts-memory-devices`.

## image-3: Mixed service signals

Source: `codex-clipboard-c9fa678c-26c1-4b9b-acad-f681e1f1c288.png` (738 × 414). One desktop frame.

| Panel | Geometry x/y/w/h | Reusable component | Reference role |
| --- | --- | --- | --- |
| Server requests / s | 0/0/8/3 | stacked-timeseries | Wide four-layer traffic area at the upper left; layers have independent jagged load. |
| CPU / Memory | 8/0/4/3 | records-line | Small dual-axis line-and-point panel with CPU percent left and memory GB right. |
| Client-side full page load | 0/3/8/3 | stacked-timeseries | Warm multicolor time bars preserve the reference shape while stacking additive phases rather than incorrectly summing percentiles. |
| Logins | 8/3/4/3 | timeseries | Overlapping translucent areas with a clear short outage before recovery. |
| Traffic In/Out | 0/6/12/3 | directional-traffic | A full-width final traffic panel retains the signed baseline and multiple network bands. |

Documented approximations:

- The top of this reference is cropped; the missing server panel title is inferred from its visible web_server legend.
- Page-load phases are additive durations. The screenshot's percentile-looking series labels would not be mathematically valid as a stacked total.
- Per-series mean/current tabular legends are approximated by current-value legends; dual-axis units remain explicit.

Data contracts:

- **Server requests / s** — 4 metric series per scope; 121 timestamp-aligned numeric/null observations; labels server, service. Saved query: `reference-mixed-signals-requests`.
- **CPU / Memory** — Record columns: service:string, at:timestamp, cpu:number (%), memory:number (GB). Saved query: `reference-mixed-signals-resources`.
- **Client-side full page load** — 4 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-mixed-signals-page-load`.
- **Logins** — 2 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-mixed-signals-logins`.
- **Traffic In/Out** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels direction, link, service. Saved query: `reference-mixed-signals-traffic`.

## image-4: Service overview

Source: `codex-clipboard-8e02f56f-0d25-4739-8b42-d10f263f027b.png` (1280 × 640). One desktop frame.

| Panel | Geometry x/y/w/h | Reusable component | Reference role |
| --- | --- | --- | --- |
| Logins | 0/0/4/3 | timeseries | Two translucent overlapping login bands, blue/purple in the reference. |
| Memory / CPU | 4/0/4/3 | records-line | Independent red/blue-style dual axes preserve percent versus GB semantics. |
| Free disk space | 8/0/4/3 | threshold-gauge | Six compact segmented horizontal disk rows, matching the reference's top-right capacity bank. |
| Server requests / s | 0/3/8/4 | stacked-timeseries | The broad middle-left traffic chart is the visual anchor with four jagged stacked layers. |
| Free disk space · volumes | 8/3/4/4 | threshold-gauge | Six radial gauges in a three-by-two bank; low space is red, middle yellow and ample space green. |
| Server CPU usage | 0/7/8/3 | status-history | Six continuous horizontal state lanes with abrupt green/yellow/red transitions and an explicit unknown interval. |
| Flow readings | 8/7/4/3 | record-table | Five exact timestamped flow rows complete the lower-right table. |

Documented approximations:

- Radial and segmented capacities are multi-series components rather than six independent dashboard tiles.
- The original free-space panels show different readings, so the two banks use separately named saved queries.
- Per-cell table coloring and a fixed-right tabular series legend are not yet part of record-table; values and units remain exact.

Data contracts:

- **Logins** — 2 metric series per scope; 121 timestamp-aligned numeric/null observations; labels service. Saved query: `reference-service-overview-logins`.
- **Memory / CPU** — Record columns: service:string, at:timestamp, cpu:number (%), memory:number (GB). Saved query: `reference-service-overview-resources`.
- **Free disk space** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels disk, service. Saved query: `reference-service-overview-capacity`.
- **Server requests / s** — 4 metric series per scope; 121 timestamp-aligned numeric/null observations; labels server, service. Saved query: `reference-service-overview-requests`.
- **Free disk space · volumes** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels disk, service. Saved query: `reference-service-overview-free-radial`.
- **Server CPU usage** — 6 metric series per scope; 121 timestamp-aligned numeric/null observations; labels host, service. Saved query: `reference-service-overview-cpu-history`.
- **Flow readings** — Record columns: service:string, at:timestamp, flow1:number (%), flow2:number (%), flow3:number (%). Saved query: `reference-service-overview-flow-readings`.

## Fixture execution

`ui/e2e/fixtures/reference-dashboard-data.ts` exports `referenceDashboards`, `referenceSpecs`, `referenceDashboardBundles`, `referenceQueryFixtures` and `resultForReferenceQuery(request)`. The resolver accepts remapped provider IDs and operates only on the authored fixture expressions. Metrics retain 121 timestamp-aligned points, including irregular bursts, outage intervals, step changes and unknowns. Records preserve typed columns and explicit units. Every query uses a quoted, exact `service` parameter after the application resolves its saved-query binding.

The fixture unit tests verify schema/plugin compatibility, panel/query closure, nonoverlapping geometry, both service choices, hostile unmatched parameter values, valid cumulative histogram buckets with a 120-column display budget, six-volume capacity banks, six-host meters matching every neighboring host plot under both gateway filters, data diversity and portable JSON/YAML round trips. Provider transport and persisted document behavior are covered by the real-Go browser acceptance harness.

All five reference record tables use the reusable `density: "compact"` and `showSearch: false` settings. The service overview keeps its five timestamped flow readings in the three-row panel; sorting and record inspection remain available.

## Execution evidence

On 29 October 2026, the UI imported all four dashboards and 56 saved queries into empty real Go storage. All 14 generation/theme/restart/mobile checks passed. Conditional writes retained ETags and no browser or query-fixture errors were observed. An earlier successful run also recovered from a rate-limit rejection. The suite produced 14 screenshot captures. Desktop assertions cover every state lane and gauge, all five flow rows, nonoverlapping bucket-axis labels, meaningful plot height, tile geometry and the specified one-screen compositions.

The comparison gallery and generated portable bundle are in `artifacts/insights/reference-dashboards/`. The gallery can switch between light and dark captures beside the supplied reference images. The fixtures demonstrate the component vocabulary and authoring contract; their expressions are test data and are not deployable live-provider queries. Independent visual review records the remaining deliberate approximations.
