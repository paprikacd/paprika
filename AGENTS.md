## Goal
- Track P0–P2 code audit fixes across Go codebase (gosec, data races, security, goroutine leaks).
- Build production-grade Helm chart: observability, security hardening, CRD lifecycle, Gateway API support.

## Constraints & Preferences
- TDD; frequent git commits; favor smaller focused files.
- Keep monolith deployment mode unless split is proven necessary.
- CRDs must survive `helm uninstall`; namespace lifecycle must be opt-in.
- Gateway API (Envoy Gateway) replaces ingress-nginx for production ingress.
- Chart supports both `ingress` and `gateway-api` ingress types. Mode selected by `apiServer.ingress.type`.

## Progress
### Done
- **Code audit (P0-P2)**
  - P0: use-after-close (cache), data race (Filter), wildcard CORS, AllowUnauth bypass, plaintext password
  - P1: completionRegistry/Backoff races, TOCTOU cluster_pool, Broker deadlock, CachedTemplateRenderer, dev mode, appset authz filter, bare return err, WithReadMaxBytes(10MB), SMTP cleartext refusal, sanitized HTTP errors
  - P2: OCI docker config, RedisBroker deprecation, RBAC wildcard subjects, hash.Write comments, Go skill rules

- **Helm chart**
  - Stale auth args removal
  - Production polish: commonLabels, extraEnv/extraEnvFrom, revisionHistoryLimit, helpers
  - Ingress for API server
  - Observability: Grafana dashboard sidecar, 11 PrometheusRules, ServiceMonitor tuning
  - Security: PSA namespace (opt-in), network policies, priorityClassName, runAsUser/runAsGroup/fsGroup: 1001
  - Day-2: Enhanced NOTES.txt with backup/restore/upgrade/debug commands
  - Pre-upgrade CRD check hook, pre-delete CRD cleanup hook
  - 19 CRDs shipped: all API groups including analysisruns, analysistemplates, rollouts, featureflags, featureflagbindings
  - Chart metadata: kubeVersion, maintainers, home, sources
  - CRD lifecycle: 5 CRDs added (analysisruns, analysistemplates, rollouts, featureflags, featureflagbindings)

- **E2E deployment (VKE)**
  - All 7 components deployed and running (2× api-server, 2× controller-manager, 1× repo-server, 2× webhook-receiver)
  - API health endpoint returns 200
  - Frontend SPA served at LoadBalancer IP
  - Controller-manager crash fixed: missing CRDs installed + memory boosted from 256Mi → 1Gi limit
  - E2E harness: deploy/test-values.yaml, hack/e2e-vultr.sh
- **Ingress (VKE)**: ingress-nginx controller installed in `ingress-nginx` ns, Vultr LB auto-provisioned by CCM. Chart's `apiServer.ingress` enabled with cert-manager selfsigned-issuer TLS. Verified end-to-end via `paprika.<lb-ip>.nip.io`.

- **Go skill**: 3 Dos/Don'ts, 5 linting rules (11.1–11.5), 8 takeaways (#18–25)
- **golangci.yml**: Re-enabled G204/G304/G306 with justifications
- **CI/CD**: Build+push to ghcr.io/paprikacd/paprika
- **Gateway API support**: Chart supports both `ingress` and `gateway-api` ingress types via `apiServer.ingress.type`. `deploy/test-values.yaml` switched to `gateway-api`. Envoy Gateway is the production ingress controller. Ingress-nginx removed; api-server LoadBalancer changed to ClusterIP. Only 1 LB remaining (Envoy Gateway at `45.77.238.224`, saves ~$10/mo).
- **Envoy data plane resource limits**: Capped proxy pod to 50m/128Mi requests, 200m/256Mi limits (was unlimited 100m/512Mi). Total ingress footprint: ~100m CPU + 384Mi memory.

### Remaining
- Consolidate `contains()` → shared util or `slices.Contains`
- SHA-256 → bcrypt/argon2
- `ClusterConnectionPool` caller audit for context lifecycle
- Run `make test`, `make lint`, `helm lint` across whole codebase
- Push new image with `--cache-sync-timeout` flag + slices.Contains refactor (BLOCKED: no `paprikacd` org token)
- Production TLS cert (replace selfsigned-issuer with Let's Encrypt DNS-01 via CF API scoped token - blocked by cert-manager v1.16 cloudflare lib bug)
- Automate Envoy Gateway install + Gateway + xDS service alias in `hack/e2e-vultr.sh`

## Key Decisions
- `DenyAllAuthorizer` (deny-all fallback) not `AllowAllAuthorizer` — silence = denial
- `sync.Mutex` on `Filter.matcher` (Matcher is interface; atomic.Value can't hold interfaces)
- Inline SHA-256 as transitional fix; long-term bcrypt/argon2
- OCI credentials parsed in-memory from `.dockerconfigjson` — no temp file
- SMTP refuses cleartext auth when STARTTLS unavailable
- Monolith mode kept as default; split only when profiling proves need
- Chart extraEnv/extraEnvFrom uses inline range loops to avoid YAML indentation bugs
- Hook RBAC resources are regular templates (not hooks)
- PSA labels on namespace opt-in with helm.sh/resource-policy: keep
- Controller-manager needs 512Mi memory limit minimum with 5+ CRD informers
- All 19 CRDs shipped in chart; analysisruns/analysistemplates critical for controller-manager startup
- In split mode, manager.args should be empty (--ui-bind-address handled by api-server)
- Vultr CCM auto-provisions LBs for `Service type: LoadBalancer`; service deletion is gated by `service.kubernetes.io/load-balancer-cleanup` finalizer. After LB deletion, the service stays in `Terminating` until the LB is actually torn down in Vultr (~30s).
- The chart's `apiServer.ingress` only renders in split mode. For testing without a real domain, use `nip.io` (e.g. `paprika.<lb-ip>.nip.io`) which auto-resolves to the LB IP. TLS works with a self-signed issuer.
- Chart's `apiServer.service.type` changed to `ClusterIP` in test-values since Envoy Gateway handles external access now.
- HTTPRoute targets Gateway `paprika` in `envoy-gateway-system` namespace. GatewayClass `eg` and Gateway must be pre-installed.
- Envoy Gateway's xDS config references `envoy-gateway` service but bitnami chart creates `eg-envoy-gateway`. Fixed with a Service (ClusterIP None) + EndpointSlice alias. Proxy cert SANs must include `envoy-gateway` for mTLS.
- EnvoyProxy CRD resource limits may not be reconciled by EG v1.4.0. Apply limits directly via `kubectl patch deployment` on the proxy deployment as fallback.
- Resource limits cap total ingress footprint to ~100m CPU + 384Mi memory (control plane 50m/128Mi requests + 500m/256Mi limits, data plane 50m/128Mi requests + 200m/256Mi limits).

## Relevant Files
- `cmd/main.go`, `cmd/cloud-run/main.go`, `cmd/main_operator.go`
- `internal/sharding/sharding.go`, `internal/api/sse.go`, `internal/api/auth/*`
- `internal/controller/pipelines/cluster_pool.go`, `notification_controller.go`, `release_controller.go`, `email_sender.go`
- `internal/api/events/broker.go`, `internal/ratelimit/ratelimit.go`, `internal/engine/hooks/completion.go`, `internal/engine/cached_renderer.go`
- `internal/webhook/receiver/handler.go`, `internal/source/oci.go`, `internal/api/server.go`
- `charts/chart/values.yaml`, `charts/chart/templates/_helpers.tpl`
- `charts/chart/templates/api-server/deployment.yaml`, `charts/chart/templates/api-server/ingress.yaml`, `charts/chart/templates/api-server/httproute.yaml`
- `charts/chart/templates/manager/manager.yaml`, `charts/chart/templates/manager/statefulset.yaml`
- `charts/chart/templates/webhook-receiver/deployment.yaml`, `charts/chart/templates/repo-server/deployment.yaml`
- `charts/chart/templates/agent/daemonset.yaml`, `charts/chart/templates/namespace.yaml`
- `charts/chart/templates/crd/*.yaml` (19 CRD templates)
- `charts/chart/templates/hooks/pre-upgrade-crd-check.yaml`, `charts/chart/templates/hooks/pre-delete-crd-cleanup.yaml`
- `charts/chart/templates/grafana/dashboards-configmap.yaml`, `charts/chart/templates/prometheus/*`
- `charts/chart/templates/networkpolicy/*.yaml`, `charts/chart/templates/extras/*.yaml`
- `charts/chart/templates/NOTES.txt`
- `deploy/test-values.yaml`, `deploy/envoy-proxy.yaml`, `deploy/envoy-gateway-svc-alias.yaml`, `hack/e2e-vultr.sh`
- `go-best-practices/SKILL.md`, `.golangci.yml`

## Commands
- `make test`, `make lint`, `just build/lint/test`
- `helm lint charts/chart/`
- `helm template test-release charts/chart/ --values deploy/test-values.yaml`
- `helm upgrade paprika-e2e charts/chart/ --namespace paprika-e2e --values deploy/test-values.yaml --wait --timeout 5m`
- `KUBECONFIG=.kubeconfig-e2e kubectl get pods -n paprika-e2e`
- `KUBECONFIG=.kubeconfig-e2e kubectl get pods -n envoy-gateway-system`
- `KUBECONFIG=.kubeconfig-e2e kubectl apply -f deploy/envoy-proxy.yaml`
- `KUBECONFIG=.kubeconfig-e2e kubectl apply -f deploy/envoy-gateway-svc-alias.yaml`
- `KUBECONFIG=.kubeconfig-e2e kubectl patch deployment/envoy-envoy-gateway-system-paprika-05f44800 -n envoy-gateway-system --type=strategic -p '{"spec":{"template":{"spec":{"containers":[{"name":"envoy","resources":{"requests":{"cpu":"50m","memory":"128Mi"},"limits":{"cpu":"200m","memory":"256Mi"}}}]}}}}'`
