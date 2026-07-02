## Goal
- Track P0–P2 code audit fixes across Go codebase (gosec, data races, security, goroutine leaks).
- Build production-grade Helm chart: observability, security hardening, CRD lifecycle support.

## Constraints & Preferences
- TDD; frequent git commits; favor smaller focused files.
- Fix critical first, then high, then medium/low.
- Keep monolith deployment mode unless split is proven necessary.
- CRDs must survive `helm uninstall`; namespace lifecycle must be opt-in.

## Progress
### Done
- **Code audit (P0-P2)**
  - P0: use-after-close (cache), data race (Filter), wildcard CORS, AllowUnauth bypass, plaintext password
  - P1: completionRegistry/Backoff races, TOCTOU cluster_pool, Broker deadlock, CachedTemplateRenderer, dev mode, appset authz filter, bare return err, WithReadMaxBytes(10MB), SMTP cleartext refusal, sanitized HTTP errors
  - P2: OCI docker config, RedisBroker deprecation, RBAC wildcard subjects, hash.Write comments, Go skill rules

- **Helm chart**
  - Stale auth args removal (`auth.allowUnauthenticated`, `auth.basic.password`)
  - Production polish: `commonLabels`, `extraEnv`/`extraEnvFrom`, `revisionHistoryLimit`, helpers
  - Ingress for API server
  - Observability: Grafana dashboard sidecar, 11 PrometheusRules, ServiceMonitor tuning
  - Security: PSA namespace (opt-in), network policies (api-server tightened, webhook-receiver), `priorityClassName` (component→global fallback), `runAsUser/runAsGroup/fsGroup: 1001`
  - Day-2: Enhanced NOTES.txt with backup/restore/upgrade/debug commands
  - Pre-upgrade CRD check hook: validates storage versions + listable instances before operator upgrade
  - Consistently applied commonLabels + priorityClassName + revisionHistoryLimit to Velero/Redis extras

- **Go skill**: 3 Dos/Don'ts, 5 linting rules (11.1–11.5), 8 takeaways (#18–25)
- **golangci.yml**: Re-enabled G204/G304/G306 with justifications

### Remaining
- Consolidate `contains()` → shared util or `slices.Contains`
- SHA-256 → bcrypt/argon2
- `ClusterConnectionPool` caller audit for context lifecycle
- Run `make test`, `make lint`, `helm lint` across whole codebase

## Key Decisions
- `DenyAllAuthorizer` (deny-all fallback) not `AllowAllAuthorizer` — silence = denial
- `sync.Mutex` on `Filter.matcher` (Matcher is interface; atomic.Value can't hold interfaces)
- Inline SHA-256 as transitional fix; long-term bcrypt/argon2
- OCI credentials parsed in-memory from `.dockerconfigjson` — no temp file
- SMTP refuses cleartext auth when STARTTLS unavailable
- Monolith mode kept as default; split only when profiling proves need
- Chart `extraEnv`/`extraEnvFrom` uses inline `range` loops to avoid YAML indentation bugs
- Hook RBAC resources are regular templates (not hooks) so Helm manages their lifecycle properly
- PSA labels on namespace opt-in with `helm.sh/resource-policy: keep`

## Relevant Files
- `cmd/main.go`, `cmd/cloud-run/main.go`, `cmd/main_operator.go`
- `internal/sharding/sharding.go`, `internal/api/sse.go`, `internal/api/auth/*`
- `internal/controller/pipelines/cluster_pool.go`, `notification_controller.go`, `release_controller.go`, `email_sender.go`
- `internal/api/events/broker.go`, `internal/ratelimit/ratelimit.go`, `internal/engine/hooks/completion.go`, `internal/engine/cached_renderer.go`
- `internal/webhook/receiver/handler.go`, `internal/source/oci.go`, `internal/api/server.go`
- `charts/chart/values.yaml`, `charts/chart/templates/_helpers.tpl`
- `charts/chart/templates/api-server/deployment.yaml`, `charts/chart/templates/api-server/ingress.yaml`
- `charts/chart/templates/manager/manager.yaml`, `charts/chart/templates/manager/statefulset.yaml`
- `charts/chart/templates/webhook-receiver/deployment.yaml`, `charts/chart/templates/repo-server/deployment.yaml`
- `charts/chart/templates/agent/daemonset.yaml`, `charts/chart/templates/namespace.yaml`
- `charts/chart/templates/networkpolicy/*.yaml` (5 components)
- `charts/chart/templates/grafana/dashboards-configmap.yaml`, `charts/chart/templates/prometheus/prometheusrules.yaml`
- `charts/chart/templates/prometheus/*-metrics-monitor.yaml`
- `charts/chart/templates/hooks/pre-upgrade-crd-check.yaml` (hook Job)
- `charts/chart/templates/hooks/pre-upgrade-crd-check-rbac.yaml` (RBAC for hook)
- `charts/chart/templates/extras/velero.yaml`, `charts/chart/templates/extras/redis*.yaml`
- `charts/chart/templates/NOTES.txt`
- `go-best-practices/SKILL.md`
- `.golangci.yml`

## Commands
- `make test`, `make lint`, `just build/lint/test`
- `helm lint charts/chart/`, `helm template test-release charts/chart/ --values test-values.yaml`
- `helm install paprika charts/chart/ --namespace paprika-system --create-namespace`
- `helm upgrade paprika charts/chart/ --namespace paprika-system --values my-values.yaml`
