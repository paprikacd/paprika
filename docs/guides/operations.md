# Operations Guide

How to build, deploy, debug, and verify Paprika on a Kubernetes cluster.

## Cluster Access

### Prerequisites

- `kubectl` configured with the target cluster's kubeconfig
- Docker (for building images)
- `helm` v3 (for production deploys)
- `go` 1.26+ (for building from source)

### Confirm the Context

Always confirm the current kubectl context before any mutation:

```sh
kubectl config current-context
```

The VKE cluster context is `admin@vke-<cluster-id>`. Do not use local Kind
contexts (e.g. `kind-deephost`) for paprika work.

### Namespaces

| Namespace | Contents |
|-----------|----------|
| `paprika-e2e` | Paprika control plane (controller-manager, api-server, repo-server, webhook-receiver) |
| `deephost` | DeepHost platform (managed via `Application/deephost`) |
| `envoy-gateway-system` | Shared Envoy Gateway and TLS listener |
| `knative-serving` | Knative Serving (for Knative-mode applications) |

## Building Images

### Fast Iteration (Go-only, ~1 second)

Use `Dockerfile.fast` for controller-manager iteration. It skips the UI build
and uses build cache mounts:

```sh
make docker-build-fast IMG=ghcr.io/paprikacd/paprika:<tag>
```

Or directly:

```sh
docker buildx build --platform linux/amd64 \
  -f Dockerfile.fast \
  -t ghcr.io/paprikacd/paprika:<tag> \
  --push .
```

This is the recommended approach for controller changes. The
controller-manager does not serve the UI; the api-server deployment uses the
full image.

### Full Build (UI + Go, ~20 minutes)

Use the full `Dockerfile` when the UI or api-server changes:

```sh
make docker-build IMG=ghcr.io/paprikacd/paprika:<tag>
make docker-push IMG=ghcr.io/paprikacd/paprika:<tag>
```

### ttl.sh Fallback

When ghcr.io is unavailable, use ttl.sh (anonymous, ephemeral):

```sh
docker build --platform linux/amd64 -t ttl.sh/paprika-amd64:<tag> .
docker push ttl.sh/paprika-amd64:<tag>
```

Tags are TTL durations (e.g. `4h`, `24h`). The image auto-deletes after expiry.

### Platform

Always build for `linux/amd64`. The build host is Apple Silicon (arm64) but
VKE nodes are amd64. `docker buildx --platform linux/amd64` handles
cross-compilation via QEMU.

## Deploying

### GitHub Actions promotion gate

Merges to `master` continue to run CI and publish the tested image. The reusable
VKE deployment job runs only when the repository variable
`VKE_AUTODEPLOY_ENABLED` is set to `true`, in addition to its existing event and
`master` checks. An unset variable leaves cluster promotion disabled. This gate
also covers the `deploy-vke` repository-dispatch workflow.

Keep the variable unset or `false` while the installed Helm release contains
recovery settings that the checked-in chart and `deploy/test-values.yaml` do not
yet preserve. The deployment workflow upgrades the complete chart, updates all
four component images, and reapplies its configured OIDC Secret. Enabling the
gate is approval for that full promotion, not just the Git cache fix. Before
enabling it, review the rendered resources and hooks against the installed
release, preserving resource budgets, permissions, and existing configuration.
Use a separately reviewed rollout based on the installed chart and values when
only selected component images should change.

### Iteration (kubectl set image)

For quick controller-manager iteration, update only the controller-manager
Deployment:

```sh
# Get the pushed digest
docker buildx imagetools inspect ghcr.io/paprikacd/paprika:<tag>

# Update the deployment
kubectl -n paprika-e2e set image deployment/paprika-e2e-controller-manager \
  manager=ghcr.io/paprikacd/paprika@sha256:<digest>

# Wait for rollout
kubectl -n paprika-e2e rollout status \
  deployment/paprika-e2e-controller-manager --timeout=240s
```

This approach is fast but bypasses Helm. The deployment's image field will
diverge from the Helm release values.

### Production (Helm)

For production deploys, use Helm so `helm rollback` works:

```sh
source .env && helm upgrade paprika-e2e charts/chart/ \
  --namespace paprika-e2e \
  --values deploy/test-values.yaml \
  --set "auth.oidc.clientID=$PAPRIKA_OIDC_CLIENT_ID" \
  --set "auth.oidc.clientSecret=$PAPRIKA_OIDC_CLIENT_SECRET" \
  --set "manager.image.repository=ghcr.io/paprikacd/paprika" \
  --set "manager.image.tag=<tag>" \
  --wait --timeout 5m
```

For digest-pinned deploys (immutable, no tag mutation risk):

```sh
helm upgrade paprika-e2e charts/chart/ \
  --namespace paprika-e2e \
  --values deploy/test-values.yaml \
  --set "manager.image.repository=ghcr.io/paprikacd/paprika@sha256:<digest>" \
  --wait --timeout 5m
```

### CRD Updates

After API type changes, regenerate and apply CRDs:

```sh
# Regenerate
go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1 \
  crd:allowDangerousTypes=true paths=./api/... \
  output:crd:artifacts:config=config/crd/bases

# Copy to chart
for f in config/crd/bases/pipelines.paprika.io_{applications,applicationsets,releases}.yaml; do
  base=$(basename $f)
  chart_name=$(echo $base | sed 's/pipelines.paprika.io_//;s/\.yaml$/.pipelines.paprika.io.yaml/')
  cp "$f" "charts/chart/templates/crd/$chart_name"
done

# Apply to cluster (or let Helm manage them)
kubectl apply -f config/crd/bases/pipelines.paprika.io_applications.yaml
kubectl apply -f config/crd/bases/pipelines.paprika.io_releases.yaml
```

### HTTP/2 (h2c) Rollout Ordering

All listeners (API/UI :3000, repo-server :8082, agent :8083) serve **both**
HTTP/1.1 and cleartext HTTP/2 (`Server.Protocols` with h2c, 256 max streams).
Internal Connect clients use prior-knowledge h2c on `http://` URLs.

When enabling h2c on a listener:

1. Deploy the **callee** first (repo-server, agent) — it accepts h1 + h2c.
2. Deploy callers (controller-manager, api-server).
3. Apply `appProtocol: kubernetes.io/h2c` on the Service **last** — a mesh or
   Gateway that sees the hint against an h1-only pod will break upstream.

Probe h2c on a live pod (binary SETTINGS frame = h2c, `HTTP/1.1` text = h1):

```sh
kubectl -n paprika-e2e exec deploy/paprika-e2e-repo-server -- sh -c \
  'printf "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n" | nc -w 5 localhost 8082 | od -t x1 | head -3'
```

## Manager Configuration

The manager binary is a cobra command tree: `manager <mode>` with
subcommands `operator`, `api`, `webhook`, `repo-server`, `agent`. The
`--mode=<mode>` flag is equivalent and kept for compatibility — existing
manifests use it.

Configuration is resolved by viper in this precedence order (highest
first):

1. **Explicit flag** — e.g. `--ui-bind-address=:4000`.
2. **Environment variable** — every flag maps to `PAPRIKA_<FLAG_NAME>`
   (`--ui-bind-address` → `PAPRIKA_UI_BIND_ADDRESS`). A few keys are
   env-only or keep legacy env names: `ENABLE_WEBHOOKS`,
   `PAPRIKA_OIDC_CLIENT_SECRET`, `PAPRIKA_OIDC_REDIRECT_URL`,
   `PAPRIKA_WEBHOOK_SECRET`, `PAPRIKA_AUTH_RBAC_RULES`,
   `PAPRIKA_REDIS_{ADDR,PASSWORD,DB}`, `PAPRIKA_SHARD_{ID,TOTAL}`,
   `POD_NAME`, `PAPRIKA_MCP_PUBLIC_URL`, `PAPRIKA_AUDIT_ENABLED`,
   `PAPRIKA_CACHE_BACKEND`, and the `PAPRIKA_GITHUB_ACTIONS_TOKEN_EXCHANGE_*`
   family.
3. **`--config` file** — a YAML file keyed by flag name, e.g.
   `metrics-bind-address: ":9090"`.
4. **Flag/viper defaults.**

List-valued keys (`--mcp-oauth-redirect-uris`,
`github-actions-token-exchange-allowed-*`) accept comma-separated strings
in env vars and YAML lists in the config file.

## Tuning Reconcile Rates

The manager exposes reconcile scheduling as flags (or `manager.reconcile.*`
Helm values — the same names rendered as args). Defaults are tuned for a
~100-app fleet; unset Helm values inherit the binary defaults.

| Helm value (`manager.reconcile.*`) | Flag | Default | Effect |
|---|---|---|---|
| `transientRequeue` | `--application-transient-requeue` | `5s` | In-flight Application states (pending/building/releasing) and the steady-state poll fallback. |
| `sourceResolveTTL` | `--application-source-resolve-ttl` | `1m` | How long a source resolve (git fetch) is reused by the steady-state poll. `0s` resolves every poll; sync triggers bypass the cache. |
| `cacheResyncPeriod` | `--cache-resync-period` | `1h` | Full informer resync. Rarely worth lowering; explicit `RequeueAfter` values drive the real cadence. |
| `maxConcurrentReconciles.application` | `--application-max-concurrent-reconciles` | `8` | Application worker pool. Raise when queue delay grows under a burst. |
| `maxConcurrentReconciles.release` | `--release-max-concurrent-reconciles` | `5` | Release worker pool. |
| `maxConcurrentReconciles.stage` | `--stage-max-concurrent-reconciles` | `3` | Stage worker pool. |
| `maxConcurrentReconciles.pipeline` | `--pipeline-max-concurrent-reconciles` | `3` | Pipeline worker pool. |
| `rateLimit.globalRate` / `globalBurst` | `--reconcile-global-rate` / `--reconcile-global-burst` | `100`/`200` | Fleet-wide reconcile token bucket. `globalRate <= 0` disables reconcile rate limiting entirely. |
| `rateLimit.appRate` / `appBurst` | `--reconcile-app-rate` / `--reconcile-app-burst` | `10`/`20` | Per-application token bucket. |

Precedence and behavior:

- `spec.source.pollInterval` on an Application overrides
  `transientRequeue` for that app's steady-state poll.
- Healthy applications requeue with deterministic jitter in
  `[interval/2, 3*interval/2)` so a fleet created together does not
  requeue in lockstep.
- Rate-limited reconciles requeue at `transientRequeue` (global bucket)
  or `2 * transientRequeue` (per-app bucket).

Watch `controller_runtime_workqueue_queue_duration_seconds` and
`controller_runtime_reconcile_time_seconds` when tuning: sustained queue
delay with idle CPU means raise concurrency; high reconcile latency means
the loop itself is slow, not the pool.

## Verifying

### Application Health

```sh
# All apps
kubectl get applications -n paprika-e2e

# Specific app
kubectl get application <app> -n <ns> -o json | jq '{
  phase: .status.phase,
  health: .status.health,
  oos: .status.outOfSync,
  notSynced: [.status.resources[] | select(.status!="Synced")]
}'
```

Expected: `phase: Healthy`, `health: Healthy`, `outOfSync: null` (or 0),
`notSynced: []`.

### Prunable Resources Preview

```sh
kubectl get application <app> -n <ns> -o json | jq '.status.prunableResources'
```

Shows what would be pruned on the next apply with `syncOptions.prune` enabled.

### Stale Conditions

```sh
kubectl get application <app> -n <ns> -o json | jq \
  '[.status.conditions[] | select(.status=="True" and (.type=="Degraded" or .type=="RolledBack" or .type=="Pending" or .type=="ReleaseRetriesExhausted"))]'
```

Should be empty after recovery.

### Public Endpoints

```sh
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.deephost.benebsworth.com/healthz
curl -fsS -o /dev/null -w '%{http_code}\n' https://www.deephost.benebsworth.com/
```

## Debugging

### Controller Logs

```sh
# Recent logs
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager --since=10m

# Follow logs
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager -f

# Filter for specific app
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager --since=10m | grep -i <app-name>

# Filter for errors
kubectl -n paprika-e2e logs deployment/paprika-e2e-controller-manager --since=10m | grep -iE 'error|panic|failed'
```

### Metrics

The metrics endpoint is HTTP on port 8443 (not HTTPS — the controller uses
`--metrics-secure=false`):

```sh
kubectl -n paprika-e2e port-forward \
  svc/paprika-e2e-controller-manager-metrics-service 8443:8443 &

curl -s http://localhost:8443/metrics | grep paprika_
```

Key metrics for debugging:

- `paprika_out_of_sync{app, namespace}` — current drift count
- `paprika_prunable{app, namespace}` — current prunable count
- `paprika_prune_total{app, namespace, kind}` — prune activity
- `paprika_application_phase_total{application, namespace, phase}` — phase
  transitions

### Manual Sync

Force a release retry (e.g. after fixing a terminal release):

```sh
kubectl -n <ns> annotate application <app> \
  paprika.io/sync="$(date +%s)" paprika.io/manual-sync="$(date +%s)" --overwrite
```

### Release Investigation

```sh
# List releases for an app
kubectl get releases.pipelines.paprika.io -n <ns> --sort-by=.metadata.creationTimestamp | grep <app>

# Release conditions
kubectl get releases.pipelines.paprika.io <release-name> -n <ns> -o json | \
  jq '.status.conditions[] | {type, status, reason, message}'

# Release manifest snapshot
kubectl get configmap <snapshot-name> -n <ns> -o json | jq -r '.data["manifests.yaml"]'
```

### RBAC Issues

If apply fails with "attempting to grant RBAC permissions not currently held":

```sh
# Check what the manager can do
kubectl auth can-i <verb> <resource> --as=system:serviceaccount:paprika-e2e:paprika-e2e-controller-manager -n <ns>

# Check the manager's ClusterRole
kubectl get clusterrole paprika-e2e-manager-role -o yaml
```

Extend the chart-managed manager role (`charts/chart/templates/rbac/manager-role.yaml`)
with the exact target permissions. Never add an unrelated cluster-admin binding.

### Drift Investigation

```sh
# What's out of sync
kubectl get application <app> -n <ns> -o json | \
  jq '[.status.resources[] | select(.status!="Synced")]'

# Compare desired vs live for a specific resource
kubectl get <kind> <name> -n <ns> -o json | jq '.spec'

# Check the release's manifest snapshot
kubectl get releases.pipelines.paprika.io <release> -n <ns> -o json | \
  jq '.status.renderedManifestSnapshot'
```

## Rolling Back

### Controller Rollback (Helm)

```sh
helm rollback paprika-e2e -n paprika-e2e
```

### Application Rollback

If a release fails, the application rolls back automatically (if
`onFailure.action: rollback`). To request a rollback of a live release:

```sh
kubectl -n <ns> annotate releases.pipelines.paprika.io <release> \
  paprika.io/rollback-requested="$(date +%s)" --overwrite
```

The controller restores the newest `Complete` (or newest non-`Failed`,
including `Superseded`) release's manifest snapshot, then marks the
release `RolledBack` with `status.rolledBackTo` and spends its automatic
retry budget so it cannot be resurrected by the adopt+resync flow. The
application parks in `ReleaseRetriesExhausted` — still polling the
source and watching release identity, so a new commit or parameter
change un-parks it. See `docs/guides/canary.md` → Rollback for the full
lifecycle.

```sh
# Check previous releases
kubectl get releases.pipelines.paprika.io -n <ns> --sort-by=.metadata.creationTimestamp | grep <app>

# Retry the same identity deliberately (bypasses and resets the retry cap):
kubectl -n <ns> annotate application <app> \
  paprika.io/sync="$(date +%s)" paprika.io/manual-sync="$(date +%s)" --overwrite
```

## Common Issues

### "connection refused" on webhook

The Knative serving webhook is down. Check:

```sh
kubectl get pods -n knative-serving
kubectl get endpoints webhook -n knative-serving
```

### "attempting to grant RBAC permissions not currently held"

The paprika manager's ClusterRole doesn't have the permissions the chart's
ClusterRole grants. Extend `charts/chart/templates/rbac/manager-role.yaml`.

### "unknown field" on kubectl apply

The cluster CRD predates the new field. Apply the updated CRD first:

```sh
kubectl apply -f config/crd/bases/pipelines.paprika.io_applications.yaml
```

### Pruned resources not being deleted

Prune is opt-in. Check that the Application has `syncOptions.prune: true`:

```sh
kubectl get application <app> -n <ns> -o json | jq '.spec.syncOptions'
```

### Metrics endpoint not responding

The metrics endpoint is HTTP on port 8443, not HTTPS. Use
`http://localhost:8443/metrics` after port-forwarding.
