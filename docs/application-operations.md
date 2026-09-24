# Application operations and availability objectives

Applications can publish operational links, context and optional ownership in
`spec.operations`. Overview shows these beside the deployment. Links retain the
destination's authentication; Paprika never fetches them or grants Grafana access.
Do not put credentials in URLs or metadata.

```yaml
spec:
  operations:
    metadata:
      Environment: production
      Cluster: production-1
    links:
      - kind: dashboard
        label: Grafana
        url: https://grafana.example.com/d/application
      - kind: runbook
        label: Recovery guide
        url: https://docs.example.com/runbooks/application
  healthChecks:
    - name: internal-deepcheck
      interval: 30s
      httpProbe:
        url: http://frontend.tenant.svc.cluster.local:3000/deepcheck
        method: GET
        timeout: 8
        expectedStatus: 200
      expression: 'http.statusCode == 200 && http.bodyJson.ready == true'
      slo:
        targetPercentage: 99.9
        window: 30d
```

The optional `owner`, `ownerLabel`, `onCall` and `tier` (1–4) fields describe
ownership. Link kinds are `dashboard`, `logs`, `traces`, `runbook`, `cost`,
`repository` and `custom`. Limits are 20 links and 16 metadata entries per app.
Existing application/project authorization applies to every operational read.

## Health failure evidence

The Health tab shows the latest response and **Recent check issues**. Expand an
issue to inspect its timestamp, classified reason, HTTP status, elapsed time and
response excerpt. Responses with a `checks` array containing `name` and boolean
`ok` fields also show dependency results, optional `latency` and `error` details.
JSON is formatted; other responses are displayed as text, never rendered HTML.

The controller retains the newest five unsuccessful observations per check for
up to 30 days in Application status. They survive successful probes and controller
restarts. A probe/CEL/interval/window change clears the diagnostic sample; changing
only the SLO target retains it. This sample is independent of the SLO ring and
must not be interpreted as the total failure count. Results collected before
this feature have counts only; overwritten responses cannot be reconstructed.

Latest bodies are capped at 4 KiB; historical bodies at 2 KiB, with an explicit
truncation indicator. Common credential fields, configured credentials and URL
query values are redacted before storage. Headers are never retained. Health
endpoints should still return diagnostic information only, not secrets or user
data. The same application authorization applies to these responses. Transport
errors are classified without persisting raw errors that can contain credentials.
Incomplete or oversized HTTP responses cannot pass a check, even with a constant
true expression.

Operational links use bundled Grafana/GitHub marks based on the hostname or link
label, including self-hosted services. Other links use their configured kind's
icon. No external favicon requests are made.

## What the SLO measures

This is availability observed by scheduled HTTP probes, not request success rate.
An observation succeeds only when HTTP returns the expected status (200 by default)
and CEL evaluates healthy. Timeouts and unexpected HTTP responses fail; invalid
CEL and missed observations remain unknown. Cached reads do not add observations.
The monitor runs during delivery reconciliation, including failed releases.

Overview displays the target, observed availability and full-window coverage.
Health adds error budget, observed burn rate and grouped observation history.
`Collecting` means the full window has not elapsed; `Stale` means the last probe is
older than two intervals. After a full window, known failures can establish
`Breached`; `Met` requires enough healthy observations even treating unknown slots
as unavailable. Otherwise the result is `InsufficientData`. Missing observations
never become successful uptime. Always interpret availability and burn rate
alongside coverage and state. Budget remaining uses the whole configured window;
negative values mean the budget has been exceeded.

Historical SLO analysis does not trigger rollback or change immediate application
health. The configured health check continues to drive the existing health policy.
A 99.9% target over 30 days allows 43.2 minutes of failed probe intervals.

History is a bounded two-bit ring stored in Application status. It survives
controller restarts; changing the probe, CEL, interval or window starts a new
history. Changing only the target reuses the evidence. Windows are `1h`, `24h`,
`7d` or `30d`; intervals must be whole seconds from 10 seconds to one hour and
divide the window. At most four SLOs and 32 checks are allowed per application.
Each history uses at most 64,800 raw bytes. No external time-series database is
required. Controller downtime appears as missing coverage, not service downtime.

## Prometheus and OpenTelemetry

Health instruments use Paprika's shared OTel meter. The controller's `/metrics`
Prometheus exporter is enabled by default; the same instruments reach OTLP when
the existing Helm `otel.enabled`, `otel.endpoint` and `otel.protocol` settings are
configured. The collector must support the OTLP metrics signal. Choose one
ingestion path for a given metrics backend to avoid double counting.

| OTel instrument | Meaning |
| --- | --- |
| `paprika.healthcheck.observations` | Counter of actual evaluations, by result |
| `paprika.healthcheck.duration` | Evaluation duration histogram in seconds |
| `paprika.healthcheck.up` | Fresh healthy=1, degraded=0; absent if stale/unknown |
| `paprika.healthcheck.last_observed` | Last observation Unix timestamp |
| `paprika.healthcheck.fresh` | Observation within two check intervals: 1/0 |
| `paprika.slo.target.ratio` | Configured target, e.g. 0.999 |
| `paprika.slo.availability.ratio` | Healthy fraction of observed probes |
| `paprika.slo.coverage.ratio` | Coverage since monitoring started, within window |
| `paprika.slo.window.coverage.ratio` | Coverage of the full configured window |
| `paprika.slo.error_budget.remaining.ratio` | Remaining budget; may be negative |
| `paprika.slo.burn_rate` | Observed failure ratio / allowed failure ratio |
| `paprika.slo.state` | Current analysis state as a bounded label |

Labels are `namespace`, `application` and `check`; the counter adds `result`, and
the state gauge adds `state`. URLs, headers and response bodies are never metric
labels. Prometheus replaces dots with underscores and applies standard unit/type
suffixes, e.g. `paprika_healthcheck_observations_total` and
`paprika_healthcheck_duration_seconds_bucket`. Scrape the controller component;
API/repo processes do not execute these checks. Removed checks lose their current
gauges; counters retain process-lifetime totals. Alert on freshness/absence as
well as `up == 0` so a stopped monitor cannot look healthy.

```yaml
otel:
  enabled: true
  endpoint: otel-collector.observability.svc.cluster.local:4317
  protocol: grpc
  insecure: true # plaintext only within the trusted cluster network
```
