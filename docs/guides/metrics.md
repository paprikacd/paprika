# Metrics and Alerting

Prometheus metrics exposed by the Paprika controller-manager and how to use
them for monitoring and alerting.

## Accessing Metrics

The controller-manager metrics port defaults to `8443`. The transport follows
the Helm chart's `metrics.secure` value, not the port number:

| Chart setting | Transport and access |
| --- | --- |
| `metrics.secure: true` (default) | HTTPS with authentication and authorization. The scraper needs permission to `get` the `/metrics` non-resource URL. |
| `metrics.secure: false` | HTTP; the chart passes `--metrics-secure=false` to the controller. |

Use the setting from your installed release. For HTTPS, configure the scraper's
bearer credential and certificate trust; the chart creates a
`<release>-metrics-reader` ClusterRole that can be bound to the scraper's ServiceAccount.
A local port-forward does not bypass authorization.

If Prometheus Operator is installed, `prometheus.enable: true` renders a
ServiceMonitor whose port name and scheme follow `metrics.secure`. Review the
[chart's ServiceMonitor template](../../charts/chart/templates/prometheus/controller-manager-metrics-monitor.yaml)
for its certificate and bearer-token configuration, and the
[metrics-reader role](../../charts/chart/templates/rbac/metrics-reader.yaml)
for the permission it grants.

### Local HTTP example

The following example applies only to an installation explicitly configured
with `metrics.secure: false`. It uses the release `paprika` in namespace
`paprika-system`; substitute your own release and namespace. Keep this command
running in one terminal:

```sh
kubectl -n paprika-system port-forward \
  svc/paprika-controller-manager-metrics-service 8443:8443
```

Then query it from another terminal:

```sh
curl --fail --silent --show-error http://localhost:8443/metrics
```

An HTTP ServiceMonitor or PodMonitor must also use the `http` scheme. Do not
copy that scrape configuration to a release using secure metrics.

## Metric Reference

### Application Lifecycle

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `paprika_application_phase_total` | Counter | `application`, `namespace`, `phase` | Application phase transitions |
| `paprika_application_reconcile_duration_seconds` | Histogram | `application`, `namespace` | Application reconciliation duration |
| `paprika_release_phase_total` | Counter | `release`, `namespace`, `phase` | Release phase transitions |
| `paprika_pipeline_phase_total` | Counter | `pipeline`, `namespace`, `phase` | Pipeline phase transitions |

### Drift and Sync

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `paprika_out_of_sync` | Gauge | `app`, `namespace` | Current out-of-sync resource count |
| `paprika_prunable` | Gauge | `app`, `namespace` | Current prunable resource count |
| `paprika_prune_total` | Counter | `app`, `namespace`, `kind` | Resources pruned per apply |

These are updated on every diff evaluation (every poll interval, default
60s). The gauges reflect the CURRENT state; the counter accumulates over
time.

### Reconciliation

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `paprika_reconcile_total` | Counter | `controller`, `result` | Controller reconciliation count |
| `paprika_reconcile_duration_seconds` | Histogram | `controller` | Controller reconciliation duration |

### Sync Operations

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `paprika_sync_duration_seconds` | Histogram | `app` | Manifest apply duration |
| `paprika_sync_errors_total` | Counter | `app` | Manifest apply errors |

### Control-Plane Health

These OTel instruments answer "is Paprika itself healthy and keeping up?".
They are exported by the controller-manager and are the raw data behind the
`paprika health` CLI, the `get_system_health` MCP tool, and
`PaprikaService.GetSystemHealth`.

| Metric | Type | Labels | Description |
|--------|------|--------|-------------|
| `paprika_controller_last_reconcile_timestamp_seconds` | Gauge | `controller`, `result` | Unix timestamp of the last reconcile attempt |
| `paprika_application_last_reconcile_timestamp_seconds` | Gauge | `application`, `namespace` | Unix timestamp of the last Application reconcile attempt |
| `paprika_application_reconcile_lag` | Gauge | `application`, `namespace` | Spec generations behind the controller's observed generation |
| `paprika_applications_stale` | Gauge | — | Applications whose observed generation is behind their spec generation |
| `paprika_applications_release_retries_exhausted` | Gauge | — | Applications holding the `ReleaseRetriesExhausted` condition |
| `paprika_releases_stuck` | Gauge | — | Non-terminal, non-gated releases older than 30 minutes |
| `paprika_fleet_index_degraded` | Gauge | — | 1 when the fleet index health is degraded |

Useful queries:

```promql
# Controllers that have not completed a reconcile in five minutes.
# Controllers record result="success", "error", or "fail" (releases only); only success counts.
time() - max by (controller) (
  paprika_controller_last_reconcile_timestamp_seconds{result="success"}
) > 300

# Applications with unreconciled spec changes.
max by (application, namespace) (paprika_application_reconcile_lag) > 0

# Workqueue backlog and oldest unfinished work (controller-runtime).
max by (controller) (workqueue_depth) > 0
max by (controller) (workqueue_unfinished_work_seconds) > 60
max by (controller) (workqueue_longest_running_processor_seconds) > 60

# Releases that have not reached a terminal phase.
paprika_releases_stuck > 0
```

A ready-made Insights dashboard charts these gauges with the same `max()`
semantics as the alert rules: the `paprika-control-plane` starter in
`internal/insights/starters/`.

`workqueue_*` and `controller_runtime_reconcile_*` are supplied by
controller-runtime; the Paprika-specific gauges above add the per-application
lag and release-liveness view that those generic metrics cannot express.

### OTel Instruments

These use the OTel API (`otel.Meter("paprika")`) and appear with the
`otel_scope_name="paprika"` label:

| Metric | Type | Description |
|--------|------|-------------|
| `paprika_render_total` | Counter | Template render operations |
| `paprika_render_errors_total` | Counter | Template render errors |
| `paprika_render_duration_seconds` | Histogram | Template render duration |
| `paprika_git_operations_total` | Counter | Git source operations |
| `paprika_git_errors_total` | Counter | Git source errors |
| `paprika_git_duration_seconds` | Histogram | Git source operation duration |
| `paprika_auth_attempts_total` | Counter | Authentication attempts |
| `paprika_auth_failures_total` | Counter | Authentication failures |
| `paprika_authz_denials_total` | Counter | Authorization denials |
| `paprika_sse_connections` | UpDownCounter | Active SSE connections |
| `paprika_events_published_total` | Counter | Events published |

### Satellite Reporting

The central API records these OTel instruments for outbound satellite reports.
Prometheus translates the dotted names to underscores and adds its standard
counter and unit suffixes.

| OTel instrument | Type | Attributes | Description |
|-----------------|------|------------|-------------|
| `paprika.satellite.reports` | Counter | `transport`, `outcome` | Reports by transport (`post`, `stream`) and outcome (`accepted`, `resync`, `rejected`) |
| `paprika.satellite.report.duration` | Histogram (seconds) | `transport`, `outcome` | Time to authenticate and persist a report |
| `paprika.satellite.report.bytes` | Histogram (bytes) | none | Uncompressed size of accepted reports |
| `paprika.satellite.link.events` | Counter | `event` | Link lifecycle: `attached`, `detached`, `refused` |
| `paprika.satellite.tasks` | Counter | `action`, `outcome` | Dispatched tasks by outcome (`ok`, `failed`, `offline`, `error`) |
| `paprika.satellite.task.duration` | Histogram (seconds) | `action` | Round-trip duration of a dispatched task |
| `paprika.satellite.link.up` | Gauge | `namespace`, `cluster` | Present with value 1 while a cluster holds a link |
| `paprika.satellite.report.age` | Gauge (seconds) | `namespace`, `cluster` | Time since the last accepted report; absent before the first one |
| `paprika.satellite.applications` | Gauge | `namespace`, `cluster` | Applications in the last accepted report |

The two transports report separately because they fail separately: a link that
stops accepting reports and a POST endpoint returning 401 are different
incidents. `outcome="resync"` is not a failure — the control plane is asking the
satellite to open a new session.

Report age is the signal that a satellite went quiet. The fleet view keeps
serving the last accepted report, so nothing else in the process knows how old
it is. `link.up` covers the case where the connection is gone but the age has
not crossed the alert threshold yet; the series is absent when no link exists.

```promql
# A satellite that has not reported in five minutes.
paprika_satellite_report_age_seconds > 300
# Link churn: more than three detaches in ten minutes.
sum(increase(paprika_satellite_link_events_total{event="detached"}[10m])) > 3
# Refused handshakes mean a credential or cluster-identity problem.
increase(paprika_satellite_link_events_total{event="refused"}[15m]) > 0
```

Name suffixes follow the exporter's conventions: counters end in `_total` and
gauges with unit `1` end in `_ratio`. See the
[multi-cluster guide](multi-cluster.md) for heartbeat and timeout settings.

### Kubernetes Gauges

These are observable gauges populated from the K8s API on each scrape:

| Metric | Type | Description |
|--------|------|-------------|
| `paprika_applications_active_ratio` | Gauge | Number of active applications |
| `paprika_applications_by_phase_ratio` | Gauge | Applications by phase |
| `paprika_releases_active_ratio` | Gauge | Number of active releases |
| `paprika_releases_by_phase_ratio` | Gauge | Releases by phase |

Note: The `_ratio` suffix is the OTel Prometheus exporter's convention for
dimensionless (unit "1") observable gauges. Not a bug.

### Kubernetes Client (`rest_client_*`)

Client-go REST metrics are exposed on every component's `/metrics` endpoint,
filtered to the `rest_client_` prefix from the component-base legacy registry:

| Metric | Type | Description |
|--------|------|-------------|
| `rest_client_requests_total` | Counter | Requests by code/host/method |
| `rest_client_request_duration_seconds` | Histogram | Per-request latency |
| `rest_client_rate_limiter_duration_seconds` | Histogram | **Client-side throttle wait** — sustained `sum/count` growth means QPS/Burst is the bottleneck |
| `rest_client_transport_cache_entries` | Gauge | Shared transport pool size |

All Paprika REST configs are tuned to QPS=50 / Burst=100 (client-go defaults
are 5/10, which throttles uncached calls under load).

## Alerting Rules

The alerts Paprika ships are in
[`prometheusrules.yaml`](../../charts/chart/templates/prometheus/prometheusrules.yaml),
enabled with `prometheus.rules.enabled`. That template is the source of truth.
Its expressions are checked by promtool unit tests in
[`charts/chart/tests/prometheus`](../../charts/chart/tests/prometheus), and the
PromQL in this guide is checked against the Go instrument definitions by
`internal/metrics`. The drift, prune, sync, render, git and info examples below
are illustrations, not shipped rules.

Counters are created on their first increment, so a bare `increase()` misses
that first event. The phase alerts below pair `increase()` with a check for a
series with no sample in the hour before the last five minutes, and a rise above
the value from before the last five minutes. The other `increase()` examples in
the Info, Warning and Drift sections do not, and can miss a first error or first
prune. Current state comes from the `*_by_phase_ratio` gauges.

The phase alerts have one known blind spot. After an in-place container restart
(same pod name and label set), a first failure that leaves the counter at its
old value is not reported until the counter rises again. A continuous scrape
that sees the counter drop fires for about five minutes.

### Critical Alerts

```yaml
groups:
  - name: paprika-critical
    rules:
      # A release failed: a transition counter, transition-aware for the first event.
      - alert: PaprikaReleaseFailed
        expr: |
          increase(paprika_release_phase_total{phase="Failed"}[5m]) > 0
          or
          paprika_release_phase_total{phase="Failed"} unless last_over_time(paprika_release_phase_total{phase="Failed"}[1h] offset 5m)
          or
          paprika_release_phase_total{phase="Failed"} > last_over_time(paprika_release_phase_total{phase="Failed"}[1h] offset 5m)
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Release {{ $labels.release }} in namespace {{ $labels.namespace }} failed"

      # Release retries exhausted. The gauge counts applications holding the
      # condition; it is unlabelled, so the alert cannot name the application.
      # max() collapses the same value reported by each manager pod.
      - alert: PaprikaReleaseRetriesExhausted
        expr: max(paprika_applications_release_retries_exhausted) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "{{ $value }} application(s) hold the ReleaseRetriesExhausted condition"
```

### Warning Alerts

```yaml
groups:
  - name: paprika-warning
    rules:
      # Current state from the phase gauge, debounced for five minutes.
      - alert: PaprikaApplicationDegraded
        expr: max(paprika_applications_by_phase_ratio{phase="Degraded"}) > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "{{ $value }} application(s) are Degraded"

      # Rolled back: a transition counter, transition-aware for the first event.
      - alert: PaprikaApplicationRolledBack
        expr: |
          increase(paprika_application_phase_total{phase="RolledBack"}[5m]) > 0
          or
          paprika_application_phase_total{phase="RolledBack"} unless last_over_time(paprika_application_phase_total{phase="RolledBack"}[1h] offset 5m)
          or
          paprika_application_phase_total{phase="RolledBack"} > last_over_time(paprika_application_phase_total{phase="RolledBack"}[1h] offset 5m)
        for: 1m
        labels:
          severity: warning
        annotations:
          summary: "Application {{ $labels.application }} in namespace {{ $labels.namespace }} was rolled back"

      # Drift detected and persisting
      - alert: PaprikaDriftDetected
        expr: paprika_out_of_sync > 0
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Application {{ $labels.app }} has {{ $value }} out-of-sync resources"
          description: "Check kubectl get application {{ $labels.app }} -n {{ $labels.namespace }} -o json | jq '[.status.resources[] | select(.status!=\"Synced\")]'"

      # Prunable resources accumulating
      - alert: PaprikaPrunableAccumulation
        expr: paprika_prunable > 0
        for: 10m
        labels:
          severity: warning
        annotations:
          summary: "Application {{ $labels.app }} has {{ $value }} prunable resources"
          description: "Enable syncOptions.prune or review status.prunableResources"

      # Unexpected prune activity
      - alert: PaprikaUnexpectedPrune
        expr: increase(paprika_prune_total[5m]) > 5
        labels:
          severity: warning
        annotations:
          summary: "Application {{ $labels.app }} pruned {{ $value }} resources in 5m"

      # Sync errors
      - alert: PaprikaSyncErrors
        expr: increase(paprika_sync_errors_total[5m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "Application {{ $labels.app }} had sync errors in the last 5m"

      # Render errors
      - alert: PaprikaRenderErrors
        expr: increase(paprika_render_errors_total[5m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "Template render errors in the last 5m"

      # Git source errors
      - alert: PaprikaGitErrors
        expr: increase(paprika_git_errors_total[5m]) > 0
        labels:
          severity: warning
        annotations:
          summary: "Git source errors in the last 5m"
```

### Info Alerts

```yaml
groups:
  - name: paprika-info
    rules:
      # New application created
      - alert: PaprikaNewApplication
        expr: increase(paprika_application_phase_total{phase="Healthy"}[1h]) > 0
        labels:
          severity: info
        annotations:
          summary: "Application {{ $labels.application }} became Healthy"
```

## Grafana Dashboards

### Application Health Panel

```json
{
  "title": "Application Health",
  "targets": [
    {
      "expr": "paprika_out_of_sync",
      "legendFormat": "{{ app }} ({{ namespace }})"
    }
  ],
  "type": "stat",
  "fieldConfig": {
    "defaults": {
      "thresholds": {
        "steps": [
          {"color": "green", "value": 0},
          {"color": "yellow", "value": 1},
          {"color": "red", "value": 5}
        ]
      }
    }
  }
}
```

### Prune Activity Panel

```json
{
  "title": "Prune Activity",
  "targets": [
    {
      "expr": "increase(paprika_prune_total[5m])",
      "legendFormat": "{{ app }}/{{ kind }}"
    }
  ],
  "type": "timeseries"
}
```

### Phase Transition Timeline

```json
{
  "title": "Phase Transitions",
  "targets": [
    {
      "expr": "increase(paprika_application_phase_total[1h])",
      "legendFormat": "{{ application }} → {{ phase }}"
    }
  ],
  "type": "timeseries"
}
```

## Debugging with Metrics

### "Is my app drifting?"

```sh
curl -s http://localhost:8443/metrics | grep 'paprika_out_of_sync{app="<app>"'
```

If > 0, check which resources are out of sync:

```sh
kubectl get application <app> -n <ns> -o json | \
  jq '[.status.resources[] | select(.status!="Synced")]'
```

### "Is prune working?"

```sh
curl -s http://localhost:8443/metrics | grep 'paprika_prune_total'
```

If the counter is 0 and you expect prunes, check that `syncOptions.prune` is
enabled on the Application.

### "Why is my app stuck?"

```sh
curl -s http://localhost:8443/metrics | \
  grep 'paprika_application_phase_total{application="<app>"'
```

Look for transitions to `Degraded`, `RolledBack`, or `Pending`. Then check
the Application conditions:

```sh
kubectl get application <app> -n <ns> -o json | \
  jq '[.status.conditions[] | select(.status=="True")]'
```

### "How long do syncs take?"

```sh
curl -s http://localhost:8443/metrics | \
  grep 'paprika_sync_duration_seconds'
```

The histogram buckets show the distribution of apply durations per app.
