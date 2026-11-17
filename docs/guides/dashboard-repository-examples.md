# Shorted and Uptime dashboard examples

Open **Insights → Examples** to browse the repository library. It contains the
seven Shorted Grafana dashboards, Shorted's application dashboards, Uptime's
Overview, SLO and Reliability dashboards, a Shorted widget collection and a
Paprika signal-interaction example: 16 entries and 153 sample widgets in total.

The gallery records source paths, revisions, query mappings and adaptation
limits. The [coverage inventory](../design/insights/repository-examples/implementation-notes.md)
accounts for every source Grafana target and the application dashboard regions.
These are native Paprika adaptations; source-specific controls and presentation
differences are documented alongside each entry.

## Explore locally

Open `/dashboard/insights/?example=1`. A fresh browser example workspace includes
the whole library under **Repository examples**. Existing edited workspaces are
preserved; use **Examples** to import another entry. Samples are explicitly
labelled and use local fixture data without contacting providers.

The housing examples include the source's authored historical data and formulas,
with their original dates. Those are static source-backed examples, not live
telemetry. Other sample data is illustrative.

## Connect live data

1. Configure the required provider on **Observability**, using the provider
   catalog's field and credential guidance. Existing Prometheus and Tempo
   providers remain usable.
2. In the live Insights workspace, open **Examples**, choose a dashboard and
   review **Adaptations and data requirements**.
3. Map every placeholder to a connected provider of the matching type. Review
   the dashboard and saved-query conflicts, then import. Imports preserve the
   normal Keep/Copy/Replace choices and ETag checks.
4. Select dashboard variables and inspect the returned data. Empty, unavailable
   and partial results remain visible; no live query falls back to sample data.

Application and database sources use these adapters:

| Source | Adapter and access |
| --- | --- |
| Shorted RPC, market and news data | [Shorted](shorted-provider.md), with fixed read operations and optional public-source credentials |
| Shorted admin dashboard | Shorted with a separate authorized `adminToken`; fixed GET reads only |
| Uptime application dashboards | [Uptime](uptime-provider.md), with organization membership and a bearer or Firebase refresh credential |
| Shorted SQL dashboards | [PostgreSQL](postgresql-provider.md), with a dedicated SELECT-only reader and verified TLS |

Selecting a provider does not provision source credentials or database grants.
The PostgreSQL adapter rejects privileged writer/admin roles. A private database
certificate authority must be trusted by the gateway runtime. Source metric
names, tables and permissions must exist at the selected destination.

## Saved queries, widgets and MCP

Application queries use a JSON operation editor. PostgreSQL uses a SQL editor
with separate typed bindings; dashboard variables belong in the binding array,
while SQL contains `$1`, `$2`, and so on. Record previews offer tables, cards,
treemaps, matrices, line charts and bar charts with explicit column mappings.

Bundles include all referenced saved queries and can be downloaded as portable
JSON. Imported documents use the same storage as Paprika Observe MCP. Discover
providers with `list_insights_providers`, inspect authoring shapes with
`get_insights_schema`, and create or patch saved queries and dashboards with
the existing authoring tools. Updates require the current ETag and synchronize
with clean UI views without overwriting unsaved drafts.

Use `query_records` to read a provider's typed rows. Use `query_dashboard` to
collect a saved dashboard's bound queries once and receive compact signals.
Record summaries include a bounded preview, the returned-row count, and
separate provider/summary truncation indicators. A returned page count is not
the source's total inventory count.

## Verification

Run the repository gallery browser suite against a local UI:

```sh
cd ui
node e2e/run-insights.mjs e2e/insights-repository-examples.e2e.mjs
```

It renders every sample widget in light/dark modes, checks overflow and runtime
errors, validates portable query closure, and verifies that sample mode makes
no live provider requests. The application-records suite additionally runs the
Observe → Insights → UI flow with a real isolated PostgreSQL database. Its
required local database setting is documented in
`ui/e2e/insights-application-records.e2e.mjs`.
