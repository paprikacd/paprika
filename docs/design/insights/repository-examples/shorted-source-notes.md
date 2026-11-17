# Shorted dashboard source inventory

This is a source inventory, not an example conversion or a live-data validation.
The companion `shorted-sources.json` records Shorted revision
`af0e5d03ab5ebb9a0bcd12ac2a95af19206f8d0b`. The source checkout was clean.
Source paths are relative to the Shorted repository; SHA-256 hashes pin each
inspected document. No source-repository files were modified.

## Finite example scope

There are **11 main example candidates**: seven Grafana definitions, one
customizable application preset, and three component adaptations. General
stock, suburb, state, institution and politician detail routes are not separate
dashboard imports. The eleven configurable product widget kinds are coverage
cases under the application preset, not eleven more main dashboards.

| Inventory ID | Source | Interpretation |
| --- | --- | --- |
| `shorted-operations` | `terraform/modules/grafana-dashboards/main.tf` | Literal Grafana definition; 28 panels, 25 targets |
| `shorted-stealth-scraping` | `analysis/sql/grafana/dashboards/shorted/stealth-scraping.json` | Literal Grafana definition; 16 panels, 16 targets |
| `shorted-grafana-metrics` | `analysis/sql/grafana/dashboards/system/grafana.json` | Literal Grafana definition; 11 panels, 14 targets |
| `shorted-postgres-exporter` | `analysis/sql/grafana/dashboards/system/postgres.json` | Literal Grafana definition; 6 panels, 15 targets |
| `shorted-prometheus-stats` | `analysis/sql/grafana/dashboards/system/prometheus.json` | Literal Grafana definition; 13 panels, 21 targets |
| `shorted-per-stock` | `analysis/sql/grafana/dashboards/shorted/per-stock-summary.json` | Literal financial SQL definition; 5 panels, 3 targets |
| `shorted-shorts-overview` | `analysis/sql/grafana/dashboards/shorted/shorts-overview.json` | Literal financial SQL definition; 2 panels, 2 targets |
| `shorted-my-dashboard` | `web/src/app/dashboards/page.tsx` | Literal application preset; 2 default widgets, 11 widget coverage cases |
| `shorted-housing-feature` | `web/src/@/components/features/housing/dashboards.tsx` | Five-panel collection composed in `/features/the-widow-maker` |
| `shorted-industry-intelligence` | `web/src/@/components/industry/industry-channel-dashboards.tsx` | Five named evidence channels sharing one template, plus crowding overview |
| `shorted-admin-dashboard` | `web/src/app/admin/page.tsx` | Four read-only overview regions; mutation controls explicitly excluded |

The seven Grafana definitions contain **81 panels including seven rows**, **74
non-row panels**, and **96 query targets**. Rows and child arrays remain in
source order. Operations has no explicit Grafana panel IDs; its JSON pointers
and ordinals identify the source positions without inventing original IDs.

## How to consume the JSON

For Grafana entries, `sourceIdentity` retains dashboard IDs/UIDs and versions;
`sourceProperties` retains time, refresh, links and annotation configuration.
Each panel has its source pointer, ordinal, original ID, type, layout,
datasource reference, targets, presentation and nested panels. A target records
its exact `expr` or `rawSql`, language, reference ID and remaining query settings.
Presentation retains field configuration, thresholds, mappings, units, axes,
legacy styles, tooltip/legend settings and plugin-specific options. Variables
retain query expressions, multi/All behavior, regexes and dependency references.

The HCL document was parsed as literal objects/arrays, `concat` and variable
references. Its datasource variable is represented symbolically as
`${var.prometheus_datasource_uid}`; no Terraform provider was initialized or
contacted. Other datasource names and UIDs are references, not connection
configuration. A converter must map these references deliberately.

Product entries describe component regions, fields, controls and logical API
requirements. They are not fabricated Grafana documents. `productWidgetCoverage`
includes the exact default layout and settings schema from the source registry,
plus observed runtime behavior where the registry and component disagree.

Sanitization excludes provider configurations, credentials, deployment/backend
addresses, observed instance selections, the external news-feed/proxy endpoint
and a long placeholder text narrative. Omitted values carry explicit reasons;
where useful, their source hash/pointer remains. Public documentation links and
the relative Grafana `/metrics` link are retained. No query was executed.

## Source deployment and fidelity notes

- Six JSON dashboards are file-provisioned by the local analysis Docker stack.
  The Operations Terraform module remains defined but is not called by current
  production Terraform. Its README's remaining decommission-shim reference is
  stale. This does not establish whether a previously created live dashboard
  still exists.
- The local Prometheus configuration lists Grafana and PostgreSQL scrape jobs;
  it does not establish application metric or Prometheus self-scrape coverage.
  Application OTel instruments exist, but exported names and live data remain
  unvalidated. PostgreSQL datasource provisioning is duplicated; dashboard UIDs
  are unique.
- Operations' service All regex omits `shorted-web`, despite that option existing.
  Several frontend/security/job panels use fixed filters. Its Tempo variable is
  unused: there are no trace panels in these sources.
- Postgres uses chained instance/database query variables and an unused job
  variable. The two financial dashboards also contain unused stock-selection
  variables and inconsistent datasource references. Preserve these facts before
  any deliberate adaptation; do not silently rewrite source semantics.
- The per-stock sentiment gauge is random test data. The text panel contains
  placeholders and unsupported sentiment-analysis claims. The news panel needs
  an explicitly chosen feed. These must not become apparently live financial
  facts in an example. The SQL data source is separate from Prometheus.
- The configurable dashboard has one checked-in preset, `My Dashboard`. User
  dashboards are dynamic documents and were not read. Its nominal datasource
  endpoint metadata is not the actual query path: widgets call their own typed
  hooks and market-data helpers.
- Runtime/catalog mismatches are recorded: the screener widget ignores its
  configured limit and uses fixed 5/10 rows; time-series runtime settings differ
  from the advertised `analysisType`; sector performance ignores its period and
  averages representative stocks' current quotes; portfolio summary calculates
  valuation/day change, not the marketing description's short exposure.
- Housing combines attributed historical arrays, optional annualized live tails,
  and an illustrative rate model. Keep units, rebasing, citations and scenario
  caveats. Its controls include dollar/percentage mode, time window, secondary
  series, country visibility, peak/calendar alignment, rate and elasticity mode.
- Industry Intelligence requires shared industry selection, metric-specific
  units, financial-year bars, ranked entity bars, headline figures, attribution
  and caveats. Its overview adds distribution bands, mean/median, four-week SMA,
  momentum and trailing z-score. CSV export is premium-gated in the source.
- Admin's read-only regions are fleet health, conditional attention issues,
  scheduled jobs and market-data sync record detail. Jobs and sync records use
  privileged HTTP reads. The cache section only performs flush/revalidation;
  there is no read-only cache statistics panel to clone. Exclude it and job-run
  buttons. Source URL-filter default inconsistencies are noted in the JSON.

## Feature coverage boundaries

Faithful conversion must retain multi-target overlays, instant/range settings,
reducers, formatting, thresholds, field overrides, stacking, null gaps, query
variables, links and legacy table/graph behavior. Additional renderers or plugins
are needed for pie/donut, gauges, bar gauges, treemaps, numeric correlation
heatmaps, rich news/text, mixed-axis overlays and scenario controls. Do not drop
these panels or substitute generic charts while calling the result equivalent.

No Grafana panel repeats, transformation pipelines, authored alert rules or
trace panels were found. Built-in `Annotations & Alerts` entries, visual
`alertThreshold` settings and queries of the `ALERTS` metric do not establish
those capabilities. Housing policy/APRA markers are actual source event
annotations and are recorded separately.

The inventory also points to geographic housing/economy views, financial
scans/strategies/themes and register/ownership views as coverage context only.
`/pulse` is a placeholder, `/seasonality` is editorial, and embeds reuse charts.
These do not increase the eleven main-example count.

## Validation

Validation compares recorded source hashes and exact Grafana query expressions
with the pinned checkout, checks recursive panel/target totals and IDs, checks
all eleven widget registry entries, parses the resulting JSON, and scans retained
strings for deployment addresses and non-documentation absolute URLs. This is
documentation/data validation; it is not rendering, provider or E2E validation.
Example conversion and sample-versus-live integration remain separate work.
