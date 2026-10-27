# Validating dashboard data coverage

A healthy provider proves that its endpoint is reachable. A successful query
with zero series does not prove that a dashboard has the telemetry it needs.
Validate the source identity, metric names, labels, units and time window before
calling an imported dashboard live.

## Service overview

The shared service variable binds both HTTP metrics and Tempo trace searches.
Uptime uses `http_request_count_total` and millisecond duration buckets with
`otel_scope_name="uptime-api"` in the Telesis scrape dataset. Brandbrain uses the
stable OTel `http_server_request_duration_seconds` histogram with
`service_name="brandbrain-api"` in its own scrape job. Its histogram count is
the request count; its quantiles must be multiplied by 1000 for millisecond
widgets. The two schemas are selected independently rather than added together.

Brandbrain must initialize an OTel MeterProvider and Prometheus exporter before
constructing its HTTP middleware. A TraceProvider alone does not record HTTP
metrics, even when traces and the `/metrics` endpoint both work.

The tested query patches and exact-ETag migration are documented in
[`hack/service-overview/README.md`](../../hack/service-overview/README.md).
Apply them only after the owning scrape job exposes the expected metric and
service labels. Leave missing telemetry empty; an absent error-class series may
become zero only relative to observed request traffic. Zero-traffic percentages
and quantiles remain undefined.

`ui/e2e/insights-service-overview.e2e.mjs` requires real data for every configured
service by default. It checks finite chart history, stat precision, matching
trace services, shared filters, light/dark rendering and unchanged saved
documents. Use explicit empty expectations only for intentional negative cases,
not to waive a missing production source.

## Shorted imported dashboards

The source repository contains several different monitoring environments:

| Dashboard | Required source |
| --- | --- |
| Operations; Stealth Scraping & Logo Discovery | Shorted production telemetry in Grafana Cloud |
| Grafana metrics | Grafana in the local `analysis/sql` monitoring stack |
| PostgreSQL Exporter | Exporter connected to the Shorted analysis database |
| Prometheus Stats | Prometheus serving that local analysis stack |
| Stock and application dashboards | The configured Shorted PostgreSQL or application adapter |

These requirements need independent mappings. A compatible Prometheus API is
not evidence that it contains the intended workload. For example, Cuttlefish's
`pg_stat_database_*{datname="cuttlefish"}` and Cuttlefish alert rules are real
observations, but are not Shorted database or Grafana observations. Reusing an
example with another workload must be explicitly labelled as such.

Shorted production exports OTLP to Grafana Cloud. Discover its actual Prometheus
endpoint and tenant from stack metadata, then use a credential with
`metrics:read`. Ingestion credentials may have only write access. Keep credentials
in labelled Kubernetes Secrets; never in dashboards, queries or committed
configuration. A paused stack or denied read scope is a connection problem, not
a zero-traffic result.

After connecting the real source, discover native metric names and labels before
adapting imported expressions. OTel exporters can add unit/type suffixes. Error
ratios require matching vector labels on both operands. Batch jobs may require a
longer window than five minutes; use actual source timestamps and do not invent
continuous history for periodically sampled records.

Changing a saved query's provider changes its identity. Create a new saved query,
then update the owning dashboard's references using its fresh ETag. Preserve
shared parameter bindings and unrelated widgets. Verify MCP bundles and browser
results against the native provider, including a second filter selection.
