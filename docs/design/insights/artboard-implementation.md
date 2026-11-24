# Rich chart implementation

The dashboard artboards guide the visual treatment of reusable charts and components. They are not published dashboard templates. Existing dashboards gain these capabilities through the widget library and editor.

| Component | Input contract | Main controls |
| --- | --- | --- |
| Distribution heatmap | Cumulative histogram series with a bucket boundary label, compatible timestamp grids and nondecreasing values | Boundary label, bucket unit, density unit, histogram grouping, visible bucket/time limits |
| Stacked time series | Timestamp-aligned numeric series | Area or time bars, visible series/time limits |
| Directional traffic | Nonnegative observations with an explicit inbound/outbound label | Direction field, outbound value, visible series/time limits |
| Connection map | Records with numeric latitude/longitude and optional numeric value/status | Coordinate, label, value and status fields; point limit |
| Pipeline topology | Records containing source/target stage names and optional numeric value/status | Stage/value/status fields, node/edge limits |
| Incident calendar | Dated records with optional numeric values | Date/value/status fields, daily aggregation, UTC month window |
| Threshold gauge | Numeric metric observations | Continuous, segmented or radial appearance, first-series or multi-series banks, columns, visible-series limit, segment count, threshold labels |

All use the same saved-query, shared-variable and document configuration contracts as other widgets. Guided controls edit the same configuration that JSON/YAML and MCP expose. Colors and typography follow the shared light/dark chart tokens. Numeric formatting follows the widget decimal-place setting.

Histogram inputs must already be rates when a per-second density unit is configured. The chart converts cumulative buckets to individual bucket observations; it does not derive rates. Directional charts place outbound values below zero while preserving their original positive value in inspection. Missing observations remain unknown. Calendar dates and boundaries use UTC. Geographic positions come only from supplied coordinates, with an explicitly labelled coordinate grid and a public-domain Natural Earth land outline.

## Validation fixtures

`ui/e2e/fixtures/rich-chart-data.ts` contains six test-only compositions covering services, fleet capacity, edge traffic, application records, reliability and ingestion. These deterministic fixtures are not registered in the public gallery, imported by application code or represented as production telemetry.

The dedicated chart E2E intercepts only the local test host's Insights API. It supplies normalized metric/trace/record responses, stores authored dashboard documents with ETags, and drives the real renderer, saved-query resolution, shared filters and editor. It exercises light/dark at desktop and mobile widths, hover/keyboard/pinning, guided configuration, persistence and JSON/YAML conversion. This is UI integration coverage; the separate Go-backed suites validate real provider adapters and service persistence.

Fixture unit tests verify query-reference closure, compatible result shapes, deterministic scope filtering, hostile unmatched parameters, histogram monotonicity, unknown intervals, nonoverlapping composition and JSON/YAML/OpenUI round trips.

The 29 October 2026 verification and reference-derived acceptance runs are in
[receipts/artboard-verification-2026-10-29.md](receipts/artboard-verification-2026-10-29.md).
