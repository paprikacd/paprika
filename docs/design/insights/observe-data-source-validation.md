# Paprika Observe MCP as a dashboard data source

Date: 2026-10-26.

**Status: deployed to Omega and validated against real Prometheus and Tempo.**

## Data path

The Insights service now uses Paprika Observe's MCP tools for shared provider
discovery, metrics, traces and metadata. Local configured Prometheus/Tempo
connections retain their existing native adapters. The integration targets the
configured Paprika Observe gateway; it does not accept arbitrary MCP endpoints
or arbitrary tool output mappings.

| UI operation | Observe MCP tool |
| --- | --- |
| Connection/provider discovery | `list_observability_providers` |
| PromQL query, widget, sparkline, tooltip | `query_metrics` |
| TraceQL query or widget | `query_traces` |
| Metric autocomplete | `list_metric_names` |
| Label discovery | `list_label_names`, `list_label_values` |
| Metric details | `get_metric_metadata` |
| Bounded label sets/cardinality | `list_metric_series` |
| Trace service discovery | `list_trace_services` |

Each operation establishes a request-local SDK MCP session, discovers the
supported read-only tools and uses structured results. The text preview may be
truncated and is never used as query data. The existing API proxy delegates the
human's subject and exact groups; the service credential is never substituted
for provider access. Redirects, automatic retries and standalone SSE are
disabled. Responses, discovery pages and operation duration are bounded.

Provider IDs, saved-query documents, widget models and renderers are unchanged.
Typed parameters and dashboard/hover bindings resolve once into native query
syntax. Queries preserve their absolute time range and metrics step. Metadata
tools accept explicit ranges, including series enumeration for bounded
cardinality inspection. Provider and protocol failures remain visible as
sanitized errors; there is no REST data fallback.

Data sources displays the actual connection status, supported tools and
providers, using the current user's access. Provider cards open Explore; the
native editor explains the MCP tool and automatic bindings. This works without
provider-configuration administrator permissions. Connection metadata stays in
the editor and Data sources rather than on ordinary widget canvases.

## Concurrency

Four shared slots bound active MCP work and legacy query/explore requests. A
separate four-slot catalog reserve permits nested authoring-to-Insights provider
discovery while all work slots are occupied. Only exact case-sensitive MCP
control/catalog methods with envelopes of at most 4 KiB use this reserve.
Eight intake slots bound body classification. Queries and writes cannot claim
catalog capacity by changing JSON field casing or injecting tool arguments.

## Validation

| Check | Result |
| --- | --- |
| UI unit suite | 1,350 tests in 140 files passed |
| MCP and Insights packages | 805 tests passed; 111 focused race tests passed |
| Observe gateway and connectors | Full race suite passed |
| Gateway command tests | Race tests passed, including nested catalog capacity, case-sensitive classification, byte/error preservation and intake cancellation |
| Required Go checks | Full build, internal/cmd vet and engine/pipeline controller tests passed |
| Changed Go packages | Repository golangci-lint: zero issues |
| UI validation | TypeScript, changed-source ESLint and production build passed |
| Observe browser suite | 11/11 passed, zero page errors |
| MCP authoring browser suite | 15/15 passed, zero page errors |
| Live acceptance script against local fixture | 10/10 passed, zero page errors |

The browser suites use the real API proxy, Insights storage, MCP SDK/server,
provider authorization and native connectors against deterministic telemetry
fixtures. Recorded protocol receipts prove actual `tools/call` requests and
zero requests to legacy provider/query/explore REST routes. The Observe run
recorded 37 provider listings, 11 metric queries, one trace query and two metric
series calls, alongside metric/label discovery. Exact provider, expression,
time-range and step assertions passed.

The acceptance-script fixture recorded increases for MCP metrics, traces and
discovery usage counters while legacy `dashboard_*` counters stayed unchanged.
Saved-query parameters, service filters, single values, sparklines, hovered
service tooltips, two decimal places, light/dark themes and desktop/mobile
layouts passed. MCP authoring and UI save/readback continued to work with
strict document versions. Screenshots and JSON receipts are under
`artifacts/insights/observability/`, `observe-authoring/` and
`omega-authoring/fixture/`. These are local fixture results, not live receipts.

## Live Omega acceptance

At **2026-10-26T06:03:26Z**, all **10/10** live browser scenarios passed with
zero page errors. [Open the retained demonstration dashboard](https://paprika.benebsworth.com/dashboard/insights/?dashboard=omega-mcp-dashboard-20261026054753).
In **Data sources**, expand **Paprika Observe MCP** to see the connected
gateway's nine supported read tools and three discovered providers, then choose
**Explore provider** to build a query.

- Source commit: `60e12b27518d98e6efecd90452c8e9e36290ed79`.
- [Successful amd64 image build](https://github.com/paprikacd/paprika/actions/runs/40276639982).
- Image: `ghcr.io/paprikacd/paprika@sha256:9b09a7f21922152446ec9706174e6009c7ca720bb7fb089c89af532dc2b7b46d`.
- Helm release `paprika-e2e`, revision **44** on Omega; all six components ready.
- Only API, Observe gateway and Insights images changed across 66 rendered
  resources. The existing live OAuth client registration was retained.

The gateway recorded **nine `query_metrics` calls** and **six `query_traces`
calls** from UI data requests; the script made neither query tool call directly.
All data tools reported zero errors. Discovery counters included 34 provider
listings, two metric-name calls, two label-name calls, one label-value call and
one metric-series call. Legacy `dashboard_list_providers`, `dashboard_query`
and `dashboard_explore` counters stayed at zero.

The real Cuttlefish Prometheus query returned **301 samples** for
**05:00–06:00 UTC** at a 12-second step. An MCP edit deliberately doubled the
query to prove that a saved-query change updates the open widget; the retained
demo explicitly explains that scaling. Selecting `brandbrain` and `telesis`
showed **4.01%** and **6.27%**, respectively, with the matching history and
unchanged saved service default. Metric inspection returned ten stored series
and two service-label values. These are bounded observations, not a claim of
global cardinality.

The real Tempo provider returned its bounded **100 trace rows** for `uptime-api`,
with the result-limit notice visible. The service filter belongs to the metrics
saved query; Tempo retains its separate query and service vocabulary. Both
themes passed at 1512px and 390px widths. Strict stale-write rejection, read-only
scope denial and UI save → MCP readback passed, including sixteen transformed
responses retaining their strong application document versions.

The pre-existing two dashboards and four saved queries retain their exact
documents and versions. The successful demo adds one dashboard and two saved
queries. Short-lived validation credentials were used for these protocol and
browser checks; no client OAuth grant was replaced. Receipts, screenshots,
image/deployment metadata and document-preservation checks are under
`artifacts/insights/omega-mcp-data-source/`.
