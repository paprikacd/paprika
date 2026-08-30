# Metrics and Alerting

Prometheus metrics exposed by the Paprika controller-manager and how to use
them for monitoring and alerting.

## Accessing Metrics

The controller-manager exposes metrics on port 8443 over HTTP (not HTTPS —
the controller uses `--metrics-secure=false`):

```sh
kubectl -n paprika-e2e port-forward \
  svc/paprika-e2e-controller-manager-metrics-service 8443:8443 &

curl -s http://localhost:8443/metrics
```

For Prometheus scraping, add a ServiceMonitor or PodMonitor targeting the
`paprika-e2e-controller-manager-metrics-service` on port 8443 with scheme
`http`.

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

## Alerting Rules

### Critical Alerts

```yaml
groups:
  - name: paprika-critical
    rules:
      # Application stuck in a failure state
      - alert: PaprikaApplicationDegraded
        expr: paprika_application_phase_total{phase="Degraded"} > 0
        for: 1m
        labels:
          severity: critical
        annotations:
          summary: "Application {{ $labels.application }} is Degraded"

      # Release retries exhausted
      - alert: PaprikaReleaseRetriesExhausted
        expr: paprika_application_phase_total{phase="RolledBack"} > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Application {{ $labels.application }} release retries exhausted"
```

### Warning Alerts

```yaml
groups:
  - name: paprika-warning
    rules:
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
