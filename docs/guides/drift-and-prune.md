# Drift Detection and Pruning

How Paprika detects configuration drift and garbage-collects stale resources.

## How Drift Detection Works

Paprika periodically compares the desired state (rendered manifests from the
Application's source) against the live state (resources actually running in
the cluster). The comparison uses the `ScalableDiffEngine`, which:

1. **Parses desired manifests** from the Application's rendered Helm chart or
   Git source into unstructured Kubernetes objects.
2. **Resolves GVRs** for each desired object using a three-tier strategy:
   - Static `knownGVRs` fast path for well-known types (no network call)
   - Discovery API with per-group-version caching (handles CRDs with
     non-standard plurals)
   - Pluralization fallback when discovery is unavailable
3. **Fetches live resources** by listing each GVR in the desired set, filtered
   by Paprika management labels (`app.paprika.io/managed-by=paprika`,
   `app.paprika.io/name=<app>`).
4. **Classifies each resource** as Synced, OutOfSync (Modified), Missing
   (Added), or Pruned (Deleted) using an apiVersion-qualified resource key
   (`apiVersion/Kind/namespace/name`).
5. **Compares spec fields** desired-centrically: every key in the desired
   spec must be present and equal in the live spec. Extra live keys
   (Kubernetes defaults, controller-injected fields) are ignored.

### False Positive Prevention

The diff engine handles several Kubernetes-specific edge cases to avoid false
drift reports:

- **Null values**: A declared `null` in a manifest (e.g. `env value: null`)
  means "field absent". Server-side apply drops the key from the stored
  object, so a live object whose key is missing matches a declared null.
- **Empty-string env values**: An env entry with `value: ""` that live omits
  is treated as equal.
- **Probe defaults**: `initialDelaySeconds: 0` omitted by the API server
  under liveness/readiness/startup probes is treated as equal.
- **Resource quantities**: `500m` and `0.5` are compared as quantities, not
  strings.
- **API group collisions**: Knative Service and core Service with the same
  name are distinguished by apiVersion-qualified keys, not bare Kind.
- **Generated children**: Live resources owned by kinds absent from the
  desired set (e.g. a Knative Route's ExternalName Service) are excluded
  from prune classification.
- **Server-managed annotations**: `deployment.kubernetes.io/*`,
  `kubectl.kubernetes.io/*`, `meta.helm.sh/*`, and similar prefixes are
  stripped before comparison.

## Resource Classification

Each resource in the diff gets one of four classifications:

| Status | Meaning | Counted in outOfSync? |
|--------|---------|----------------------|
| **Synced** | Desired and live match | No |
| **OutOfSync** | Desired and live differ (Modified) | Yes |
| **Missing** | Desired but not live (Added) | Yes |
| **Pruned** | Live but not desired (Deleted) | Yes |

The `outOfSync` count is the total of OutOfSync + Missing + Pruned resources.

## Pruning

Pruning deletes live resources that are no longer in the desired manifest
set. It is **opt-in** and runs after every successful release apply.

### Enabling Prune

Set `syncOptions.prune: true` on the Application:

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
spec:
  syncOptions:
    prune: true
```

The Release inherits this from the Application's `spec.syncOptions`.

### What Gets Pruned

A resource is pruned only if ALL of these are true:

1. It carries the Paprika management labels (`app.paprika.io/managed-by=paprika`,
   `app.paprika.io/name=<app>`)
2. It is **ownerless** (no `ownerReferences`)
3. It is **not in the desired manifest set** (no matching
   apiVersion-qualified key)
4. It is **not annotated** with `paprika.io/prune: "false"`
5. It is **namespaced** (cluster-scoped resources are only pruned if
   explicitly allowed)

### What Never Gets Pruned

- Resources with `ownerReferences` (controller-generated children)
- Resources annotated `paprika.io/prune: "false"`
- Namespaces, CRDs, and other critical cluster-scoped resources
- Resources that are in the desired manifest set

### Cluster-Scoped Prune

By default, only ClusterRole and ClusterRoleBinding are eligible for
cluster-scoped pruning. Override with `syncOptions.pruneClusterScopedKinds`:

```yaml
spec:
  syncOptions:
    prune: true
    pruneClusterScopedKinds:
      - ClusterRole
      - ClusterRoleBinding
```

Namespaces and CRDs are never pruned regardless of this setting.

### Prune Preview

Before enabling prune, review what would be deleted:

```sh
kubectl get application <app> -n <ns> -o json | jq '.status.prunableResources'
```

This lists live resources that would be pruned on the next apply. Nothing is
deleted unless prune is enabled.

### Prune Protection

Annotate individual resources to protect them from pruning:

```sh
kubectl annotate <kind> <name> -n <ns> paprika.io/prune="false"
```

This is useful for:
- Shared resources that multiple apps reference
- Manually-created resources that happen to carry paprika labels
- Resources that should persist even if removed from the chart

## Monitoring Drift

### Metrics

```sh
kubectl -n paprika-e2e port-forward \
  svc/paprika-e2e-controller-manager-metrics-service 8443:8443 &

# Current drift count per app
curl -s http://localhost:8443/metrics | grep paprika_out_of_sync

# Current prunable count per app
curl -s http://localhost:8443/metrics | grep paprika_prunable

# Prune activity
curl -s http://localhost:8443/metrics | grep paprika_prune_total
```

### Recommended Alerts

```yaml
# Alert when drift persists for more than 5 minutes
- alert: PaprikaDriftDetected
  expr: paprika_out_of_sync > 0
  for: 5m
  labels:
    severity: warning
  annotations:
    summary: "Application {{ $labels.app }} has {{ $value }} out-of-sync resources"

# Alert when prunable resources accumulate
- alert: PaprikaPrunableAccumulation
  expr: paprika_prunable > 0
  for: 10m
  labels:
    severity: info
  annotations:
    summary: "Application {{ $labels.app }} has {{ $value }} prunable resources"

# Alert on unexpected prune activity
- alert: PaprikaUnexpectedPrune
  expr: increase(paprika_prune_total[5m]) > 5
  labels:
    severity: warning
  annotations:
    summary: "Application {{ $labels.app }} pruned {{ $value }} resources in 5m"
```

## Troubleshooting Drift

### "OutOfSync but the resource looks identical"

Check for Kubernetes-defaulted fields that differ from the desired manifest:

```sh
# Compare desired (from release snapshot) vs live
kubectl get <kind> <name> -n <ns> -o json | jq '.spec'
```

Common causes:
- `env value: null` in the chart (fixed in current version)
- `initialDelaySeconds: 0` on probes (fixed)
- Resource quantity formatting (`500m` vs `0.5`) (fixed)
- API group collisions (Knative Service vs core Service) (fixed)

### "Pruned but the resource should exist"

Check if the resource was removed from the chart:

```sh
# Check the release's manifest snapshot
kubectl get configmap <snapshot-name> -n <ns> -o json | jq -r '.data["manifests.yaml"]' | grep <name>
```

If the resource should persist, annotate it with `paprika.io/prune: "false"`.

### "Missing but the resource exists"

Check for API group collisions — the desired object might resolve to the
wrong GVR. The `CachedGVRResolver` should handle this; if it persists, check
the controller logs for GVR resolution errors.

## Architecture Details

### Diff Engine

- `ScalableDiffEngine` (`internal/engine/scalable_diff.go`): label-selector
  diff computation, apiVersion-qualified resource keys, generated-child
  exclusion, cluster-scoped GVR handling.
- `DiffEngine` (`internal/engine/diff.go`): basic diff engine (namespace-wide
  scan), resourceEqual, specContains, mapContains — null-as-absent handling,
  Kubernetes default omission.
- `CachedGVRResolver` (`internal/engine/gvr_resolver.go`): discovery API with
  caching, knownGVRs fast path, pluralization fallback.

### Prune

- `pruneStaleResources` (`internal/controller/pipelines/release_controller.go`):
  runs after successful applyAllDocuments, lists live resources by GVR with
  paprika labels, deletes ownerless resources not in the desired set.

### Key Formats

- **Resource key**: `apiVersion/Kind/namespace/name` (e.g.
  `serving.knative.dev/v1/Service/deephost/deephost-hydra`)
- **Desired key**: built from parsed manifests with the same format, using
  the release namespace as fallback for namespaced resources
- **Live key**: built from listed live objects with the same format
