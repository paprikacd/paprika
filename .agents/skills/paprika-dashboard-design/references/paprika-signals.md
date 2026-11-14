# Paprika platform signals

The metrics Paprika itself exports, for dashboards about Paprika's own health.
Use this table to pick a name, its labels and its meaning, then confirm the
name exists in the provider with `list_metric_names` and `get_metric_metadata`
before querying. The repository, not this page, is the source of truth; a
drift test in `internal/metrics/signals_reference_test.go` fails when a metric
defined in Go is missing here or a listed source no longer exists.

## Boundaries

- **Health tool.** `get_system_health` is served by the platform MCP at `/mcp`
  (`internal/api/mcp/tools_read.go`). It is not an Observe MCP tool, so an
  agent connected only to `/observe/mcp` cannot call it. The Observe gateway
  reads these series through provider queries.
- **Not covered here.** client-go `rest_client_*`, controller-runtime
  `workqueue_*` and `controller_runtime_*`, OpenTelemetry HTTP and runtime
  instruments, and `target_info`. Names built at runtime are not enumerated.
  Labels, units and healthy ranges are reviewed by hand and are not tested.
- **Healthy range.** Filled only when `internal/metrics` or
  `docs/guides/metrics.md` states it. Thresholds from `metrics.md` are labelled by
  where they come from: a query in its "Useful queries" block, or an alert example.
  Neither is a health range. A dash means the source does not say.
- **Canonical PromQL.** Copied from `docs/guides/metrics.md` only. The "Useful queries"
  and the alert examples there are queries and examples, not a rule set for your
  deployment. Other rows have no documented query; derive one from the type and labels.

## Exported names

Source names are either Prometheus collectors (`internal/metrics/metrics.go`) or
OpenTelemetry instruments. The OpenTelemetry instruments are in `otel.go`, `fleet.go`,
`health.go`, `reconcile.go` and `satellite.go`, and the `paprika_insights_*` pair in
`internal/insights/server.go` is also OpenTelemetry, with underscore names.
The OpenTelemetry names are dotted; the exporter (`otel/exporters/prometheus`
v0.69) turns them into the Exported name column:

- dots become underscores;
- a `s` unit appends `_seconds`, `ms` appends `_milliseconds`, and `By` appends
  `_bytes`, unless the unit word already appears as a dot-separated part of the name.
  `paprika.bytes.sent` therefore exports as `paprika_bytes_sent_total`;
- counters append `_total`;
- gauges with unit `1` append `_ratio`, whether synchronous or observable. Up-down
  counters with unit `1` do not (`paprika_sse_connections`);
- annotation units such as `{generation}` add nothing;
- histograms also emit `_bucket`, `_sum` and `_count` series when scraped.

Exported names come from `otlptranslator`, the naming library the exporter calls, and
`internal/metrics` checks every row against the definitions in both directions
(`TestSignalsReferenceMatchesDefinedMetrics`). Prometheus names (`paprika_build_info`,
`paprika_out_of_sync`, ...) are exported as written.

Dashboard queries should use the Exported name. Read the Source name when
searching the code.

## Table

Labels come from the attribute keys recorded with each instrument; `—` means none.

Five definitions have no recording call in `internal/` or `cmd/`: `paprika_sync_total`,
`paprika_sync_last_timestamp_seconds`, `paprika_source_resolve_total`,
`paprika_source_resolve_errors_total` and `paprika_release_duration_seconds`. They are
marked **Never recorded** in the table. Do not build a dashboard on them until a recording
call exists.

The PromQL cells copy `metrics.md`. The controller-staleness query uses a regular
expression with alternation, which a table cell cannot hold without an escaped pipe, so it
is in the block below the table.

| Exported name | Source | Type | Labels | Meaning | Healthy range | Canonical PromQL |
|---|---|---|---|---|---|---|
| `paprika_analysis_check_total` | `paprika_analysis_check_total` | Counter | `release`, `namespace`, `check_type`, `result` | Number of analysis checks executed | — | — |
| `paprika_api_cache_sync_duration_milliseconds` | `paprika.api.cache.sync.duration` | Histogram | — | Duration of split API server Kubernetes informer cache sync | — | — |
| `paprika_api_list_duration_milliseconds` | `paprika.api.list.duration` | Histogram | `resource` | Duration of API list handlers | — | — |
| `paprika_api_list_errors_total` | `paprika.api.list.errors` | Counter | `resource` | Number of API list handler errors | — | — |
| `paprika_api_list_items` | `paprika.api.list.items` | Histogram | `resource` | Number of objects returned by API list handlers | — | — |
| `paprika_api_request_duration_seconds` | `paprika_api_request_duration_seconds` | Histogram | `method`, `path`, `status_code` | Duration of API requests in seconds | — | — |
| `paprika_api_request_total` | `paprika_api_request_total` | Counter | `method`, `path`, `status_code` | Number of API requests | — | — |
| `paprika_application_last_reconcile_timestamp_seconds` | `paprika.application.last_reconcile.timestamp` | Gauge | `application`, `namespace` | Unix timestamp of the last reconcile attempt for an application | — | — |
| `paprika_application_phase_total` | `paprika_application_phase_total` | Counter | `application`, `namespace`, `phase` | Number of application phase transitions | — | `max(paprika_applications_by_phase_ratio{phase="Degraded"}) > 0` |
| `paprika_application_reconcile_duration_seconds` | `paprika_application_reconcile_duration_seconds` | Histogram | `application`, `namespace` | Duration of application reconciliation in seconds | — | — |
| `paprika_application_reconcile_lag` | `paprika.application.reconcile.lag` | Gauge | `application`, `namespace` | Number of spec generations an application is behind its observed generation | 0; `metrics.md` query flags above 0 | `max by (application, namespace) (paprika_application_reconcile_lag) > 0` |
| `paprika_applications_active_ratio` | `paprika.applications.active` | Gauge | — | Number of active applications | — | — |
| `paprika_applications_by_phase_ratio` | `paprika.applications.by_phase` | Gauge | `phase` | Number of applications by phase | — | — |
| `paprika_applications_release_retries_exhausted` | `paprika.applications.release_retries_exhausted` | Gauge | — | Number of applications holding the ReleaseRetriesExhausted condition | — | — |
| `paprika_applications_stale` | `paprika.applications.stale` | Gauge | — | Number of applications whose observed generation is behind their spec generation | — | — |
| `paprika_auth_attempts_total` | `paprika.auth.attempts` | Counter | `subject` | Number of authentication attempts | — | — |
| `paprika_auth_failures_total` | `paprika.auth.failures` | Counter | `method` | Number of authentication failures | — | — |
| `paprika_authz_decisions_total` | `paprika.authz.decisions` | Counter | `decision` | Number of authorization decisions made | — | — |
| `paprika_authz_denials_total` | `paprika.authz.denials` | Counter | `action`, `resource` | Number of authorization denials | — | — |
| `paprika_build_info` | `paprika_build_info` | Gauge | `version`, `commit`, `go_version` | Build identity of the running paprika binary (version, commit, go toolchain) | — | — |
| `paprika_canary_step_total` | `paprika_canary_step_total` | Counter | `release`, `namespace`, `stage` | Number of canary weight step transitions | — | — |
| `paprika_canary_weight_current` | `paprika_canary_weight_current` | Gauge | `release`, `namespace`, `stage` | Current canary traffic weight percentage | — | — |
| `paprika_controller_last_reconcile_timestamp_seconds` | `paprika.controller.last_reconcile.timestamp` | Gauge | `controller`, `result` | Unix timestamp of the last reconcile attempt, by controller and result | `metrics.md` query flags more than 300 s without a successful reconcile | See the query below the table. |
| `paprika_coordinator_heartbeat_failures_total` | `paprika_coordinator_heartbeat_failures_total` | Counter | — | Number of failed coordinator heartbeat attempts | — | — |
| `paprika_coordinator_heartbeat_seconds` | `paprika_coordinator_heartbeat_seconds` | Histogram | — | Coordinator heartbeat round-trip latency in seconds | — | — |
| `paprika_coordinator_replicas` | `paprika_coordinator_replicas` | Gauge | — | Number of active replicas in the coordinator ring | — | — |
| `paprika_events_published_total` | `paprika.events.published` | Counter | `topic` | Number of events published to the broker | — | — |
| `paprika_fleet_index_build_duration_seconds` | `paprika.fleet.index.build.duration` | Histogram | `operation`, `outcome` | Duration of full fleet index builds | — | — |
| `paprika_fleet_index_degraded` | `paprika.fleet.index.degraded` | Gauge | — | Whether the installed fleet index health is degraded | 0; 1 when degraded (`metrics.md`) | — |
| `paprika_fleet_index_generation` | `paprika.fleet.index.generation` | Gauge | — | Generation of the installed fleet index snapshot | — | — |
| `paprika_fleet_index_items` | `paprika.fleet.index.items` | Gauge | — | Number of applications in the installed fleet index snapshot | — | — |
| `paprika_fleet_index_rebuild_failures_total` | `paprika.fleet.index.rebuild.failures` | Counter | `operation`, `outcome` | Number of failed fleet index rebuilds | — | — |
| `paprika_fleet_index_update_duration_seconds` | `paprika.fleet.index.update.duration` | Histogram | `operation`, `outcome` | Duration of incremental fleet index updates | — | — |
| `paprika_fleet_query_duration_seconds` | `paprika.fleet.query.duration` | Histogram | `query_kind`, `outcome`, `active_dimension_count`, `cache_outcome` | Duration of cache-only fleet queries | — | — |
| `paprika_fleet_query_results` | `paprika.fleet.query.results` | Histogram | `query_kind`, `outcome`, `active_dimension_count`, `cache_outcome` | Number of items returned by fleet queries | — | — |
| `paprika_git_cache_evictions_total` | `paprika.git.cache.evictions` | Counter | `kind` | Git cache entries evicted | — | — |
| `paprika_git_cache_lookups_total` | `paprika.git.cache.lookups` | Counter | `layer`, `result` | Git cache lookups by layer and result | — | — |
| `paprika_git_cache_size_bytes` | `paprika.git.cache.size` | Gauge | `dir` | Bytes on disk in the git cache | — | — |
| `paprika_git_duration_seconds` | `paprika.git.duration` | Histogram | `operation` | Duration of git operations | — | — |
| `paprika_git_errors_total` | `paprika.git.errors` | Counter | `operation` | Number of git operation errors | — | `increase(paprika_git_errors_total[5m]) > 0` |
| `paprika_git_fetch_duration_seconds` | `paprika.git.fetch.duration` | Histogram | `op`, `result` | Duration of git network operations (ls-remote, commit fetch, blob fetch) | — | — |
| `paprika_git_fetch_inflight` | `paprika.git.fetch.inflight` | Gauge | `op` | Git network operations in flight | — | — |
| `paprika_git_fetch_received_bytes_total` | `paprika.git.fetch.received` | Counter | `op` | Pack bytes received by git fetches | — | — |
| `paprika_git_fetch_waiting` | `paprika.git.fetch.waiting` | Gauge | — | Git network operations waiting for a concurrency slot | — | — |
| `paprika_git_operations_total` | `paprika.git.operations` | Counter | `operation` | Number of git operations (clone/fetch) | — | — |
| `paprika_healthcheck_duration_seconds` | `paprika.healthcheck.duration` | Histogram | `namespace`, `application`, `check` | Wall time of an actual health check evaluation | — | — |
| `paprika_healthcheck_fresh_ratio` | `paprika.healthcheck.fresh` | Gauge | `namespace`, `application`, `check` | Whether the latest observation is within two check intervals | 1 when the latest observation is within two check intervals (`health.go`) | — |
| `paprika_healthcheck_last_observed_seconds` | `paprika.healthcheck.last_observed` | Gauge | `namespace`, `application`, `check` | Unix timestamp of the last real health check | — | — |
| `paprika_healthcheck_observations_total` | `paprika.healthcheck.observations` | Counter | `namespace`, `application`, `check`, `result` | Actual health check evaluations; cached reads do not increment this counter | — | — |
| `paprika_healthcheck_up_ratio` | `paprika.healthcheck.up` | Gauge | `namespace`, `application`, `check` | Latest fresh check: 1 healthy, 0 degraded; absent when stale or unknown | 1 healthy, 0 degraded; absent when stale or unknown (`health.go`) | — |
| `paprika_insights_queries_total` | `paprika_insights_queries` | Counter | `kind`, `outcome`, `provider` | Provider queries by outcome | — | — |
| `paprika_insights_query_duration_seconds` | `paprika_insights_query_duration_seconds` | Histogram | `kind`, `outcome`, `provider` | Provider query duration | — | — |
| `paprika_insights_store_quarantined_total` | `paprika_insights_store_quarantined` | Counter | `kind` | Stored dashboards and saved queries moved to quarantine at startup because they failed validation | — | — |
| `paprika_mcp_tool_calls_total` | `paprika.mcp.tool.calls` | Counter | `tool`, `outcome` | Number of MCP tool calls by tool and outcome | — | — |
| `paprika_mcp_tool_duration_milliseconds` | `paprika.mcp.tool.duration` | Histogram | `tool`, `outcome` | Duration of MCP tool invocations by tool and outcome | — | — |
| `paprika_mcp_tool_response_bytes` | `paprika.mcp.tool.response_bytes` | Histogram | `tool` | Serialized size of MCP tool results by tool | — | — |
| `paprika_out_of_sync` | `paprika_out_of_sync` | Gauge | `app`, `namespace` | Number of out-of-sync resources (added, modified, or deleted) per application | 0; `metrics.md` alert example fires above 0 | `paprika_out_of_sync > 0` |
| `paprika_pipeline_duration_seconds` | `paprika_pipeline_duration_seconds` | Histogram | `pipeline`, `namespace` | Duration of pipeline execution in seconds | — | — |
| `paprika_pipeline_phase_total` | `paprika_pipeline_phase_total` | Counter | `pipeline`, `namespace`, `phase` | Number of pipeline phase transitions | — | — |
| `paprika_prunable` | `paprika_prunable` | Gauge | `app`, `namespace` | Number of prunable resources (live, paprika-labelled, not in desired set) per application | 0; `metrics.md` alert example fires above 0 | `paprika_prunable > 0` |
| `paprika_prune_total` | `paprika_prune_total` | Counter | `app`, `namespace`, `kind` | Number of resources pruned after apply | — | `increase(paprika_prune_total[5m]) > 5` |
| `paprika_reconcile_duration_seconds` | `paprika_reconcile_duration_seconds` | Histogram | `controller` | Duration of controller reconciliations in seconds | — | — |
| `paprika_reconcile_total` | `paprika_reconcile_total` | Counter | `controller`, `result` | Number of controller reconciliations | — | — |
| `paprika_release_duration_seconds` | `paprika_release_duration_seconds` | Histogram | `release`, `namespace`, `target_stage` | Duration of release reconciliation in seconds **Never recorded:** no recording call in `internal/` or `cmd/`. | — | — |
| `paprika_release_phase_total` | `paprika_release_phase_total` | Counter | `release`, `namespace`, `phase` | Number of release phase transitions | — | — |
| `paprika_release_transitions_total` | `paprika.release.transitions` | Counter | `from`, `to` | Number of release phase transitions | — | — |
| `paprika_releases_active_ratio` | `paprika.releases.active` | Gauge | — | Number of active (non-terminal) releases | — | — |
| `paprika_releases_by_phase_ratio` | `paprika.releases.by_phase` | Gauge | `phase` | Number of releases by phase | — | — |
| `paprika_releases_stuck` | `paprika.releases.stuck` | Gauge | — | Number of active releases older than the stuck-release threshold | 0; `metrics.md` query flags above 0 | `paprika_releases_stuck > 0` |
| `paprika_render_duration_seconds` | `paprika.render.duration` | Histogram | `type` | Duration of template rendering | — | — |
| `paprika_render_errors_total` | `paprika.render.errors` | Counter | `type` | Number of template rendering errors | — | `increase(paprika_render_errors_total[5m]) > 0` |
| `paprika_render_total` | `paprika.render.total` | Counter | `type` | Number of templates rendered | — | — |
| `paprika_resource_patch_total` | `paprika.resource.patch.total` | Counter | `kind`, `result` | Number of resource patch operations | — | — |
| `paprika_rollout_canary_step_total` | `paprika_rollout_canary_step_total` | Counter | `rollout`, `namespace` | Number of canary step transitions for Rollout resources | — | — |
| `paprika_rollout_canary_weight_current` | `paprika_rollout_canary_weight_current` | Gauge | `rollout`, `namespace` | Current canary traffic weight percentage for a Rollout | — | — |
| `paprika_rollout_phase_total` | `paprika_rollout_phase_total` | Counter | `rollout`, `namespace`, `phase` | Number of Rollout phase transitions | — | — |
| `paprika_satellite_applications_ratio` | `paprika.satellite.applications` | Gauge | `namespace`, `cluster` | Applications the satellite last reported | — | — |
| `paprika_satellite_link_events_total` | `paprika.satellite.link.events` | Counter | `event` | Satellite link lifecycle events by type | — | `increase(paprika_satellite_link_events_total{event="refused"}[15m]) > 0` |
| `paprika_satellite_link_up_ratio` | `paprika.satellite.link.up` | Gauge | `namespace`, `cluster` | Whether a satellite link is attached for this cluster | 1 while a link is attached; series absent without one (`metrics.md`) | — |
| `paprika_satellite_report_age_seconds` | `paprika.satellite.report.age` | Gauge | `namespace`, `cluster` | Seconds since the last accepted satellite report | `metrics.md` query flags above 300 s; absent before the first report | `paprika_satellite_report_age_seconds > 300` |
| `paprika_satellite_report_bytes` | `paprika.satellite.report.bytes` | Histogram | — | Uncompressed accepted satellite report size | — | — |
| `paprika_satellite_report_duration_seconds` | `paprika.satellite.report.duration` | Histogram | `transport`, `outcome` | Time to accept a satellite inventory report | — | — |
| `paprika_satellite_reports_total` | `paprika.satellite.reports` | Counter | `transport`, `outcome` | Satellite inventory reports by outcome | — | — |
| `paprika_satellite_task_duration_seconds` | `paprika.satellite.task.duration` | Histogram | `action`, `outcome` | Round-trip duration of a dispatched satellite task | — | — |
| `paprika_satellite_tasks_total` | `paprika.satellite.tasks` | Counter | `action`, `outcome` | Satellite tasks dispatched by action and outcome | — | — |
| `paprika_slo_availability_ratio` | `paprika.slo.availability.ratio` | Gauge | `namespace`, `application`, `check` | Healthy fraction of observed probes; use coverage and state alongside it | — | — |
| `paprika_slo_burn_rate_ratio` | `paprika.slo.burn_rate` | Gauge | `namespace`, `application`, `check` | Observed failure fraction divided by the allowed failure fraction | Below 1 spends the budget more slowly than the target allows (definition in `health.go`) | — |
| `paprika_slo_coverage_ratio` | `paprika.slo.coverage.ratio` | Gauge | `namespace`, `application`, `check` | Observed fraction of slots since monitoring began, bounded by the rolling window | — | — |
| `paprika_slo_error_budget_remaining_ratio` | `paprika.slo.error_budget.remaining.ratio` | Gauge | `namespace`, `application`, `check` | Rolling-window error budget remaining; negative means exceeded | Negative means the budget is exceeded (`health.go`) | — |
| `paprika_slo_state_ratio` | `paprika.slo.state` | Gauge | `namespace`, `application`, `check`, `state` | Current SLO analysis state, represented by its bounded state label | — | — |
| `paprika_slo_target_ratio` | `paprika.slo.target.ratio` | Gauge | `namespace`, `application`, `check` | Configured availability target | — | — |
| `paprika_slo_window_coverage_ratio` | `paprika.slo.window.coverage.ratio` | Gauge | `namespace`, `application`, `check` | Observed fraction of the entire configured rolling window | — | — |
| `paprika_source_resolve_errors_total` | `paprika.source.resolve.errors` | Counter | — | Number of source resolution errors **Never recorded:** no recording call in `internal/` or `cmd/`. | — | — |
| `paprika_source_resolve_total` | `paprika.source.resolve.total` | Counter | — | Number of source resolution operations **Never recorded:** no recording call in `internal/` or `cmd/`. | — | — |
| `paprika_sse_connections` | `paprika.sse.connections` | Gauge | — | Number of active SSE connections | — | — |
| `paprika_sync_duration_seconds` | `paprika.sync.duration` | Histogram | `app` | Duration of sync operations | — | — |
| `paprika_sync_errors_total` | `paprika.sync.errors` | Counter | `app` | Number of sync errors | — | `increase(paprika_sync_errors_total[5m]) > 0` |
| `paprika_sync_last_timestamp_seconds` | `paprika.sync.last_timestamp` | Gauge | — | Unix timestamp of the last successful sync **Never recorded:** no recording call in `internal/` or `cmd/`. | — | — |
| `paprika_sync_selective_total` | `paprika.sync.selective.total` | Counter | `app`, `result` | Number of selective (resource-filtered) sync applies | — | — |
| `paprika_sync_total` | `paprika.sync.total` | Counter | — | Number of application sync operations **Never recorded:** no recording call in `internal/` or `cmd/`. | — | — |
| `paprika_sync_validate_total` | `paprika.sync.validate.total` | Counter | `app`, `result` | Number of server-side validation pre-flights | — | — |
| `paprika_sync_wave_wait_duration_seconds` | `paprika.sync.wave.wait.duration` | Histogram | `app` | Duration of sync-wave health gates | — | — |

## Documented queries that a table cell cannot hold

From the "Useful queries" block in `docs/guides/metrics.md`. These are queries, not alert rules.

```promql
# Controllers that have not completed a reconcile in five minutes.
# Controllers record result="success", "error", or "fail" (releases only); only success counts.
time() - max by (controller) (
  paprika_controller_last_reconcile_timestamp_seconds{result="success"}
) > 300
```
