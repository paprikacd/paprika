# Paprika Observe MCP as a dashboard data source

Date: 2026-10-26.

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
