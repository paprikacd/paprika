# Phase 1: Hardening — Webhooks, Finalizers, Error Handling

**Date**: 2026-06-10
**Status**: Draft
**Applies to**: All operators in `internal/controller/` and `cmd/main.go`

## Overview

Paprika's six CRDs (Application, Pipeline, Stage, Release, Template, Artifact) currently have no admission control, no finalizer cleanup, and poor error handling. This spec addresses all three CRITICAL hardening gaps in one phase.

---

## 1. Admission Webhooks

### 1.1 Validating Webhooks

One validating webhook per CRD. Each validates cross-field constraints that cannot be expressed with CRD schema markers alone.

#### Application

| Rule | Logic |
|------|-------|
| Source required | `app.Spec.Source.Type != ""` and at least one of `Git`, `Helm`, `S3` sub-fields populated |
| At least one stage | `len(app.Spec.Stages) > 0` |
| Strategy-required fields | If `strategy == "canary"`, then for each canary stage: `trafficRouter` must be set, canary steps must exist, provider must be `istio` or `gateway-api` |
| Gate stage references | If a gate has `Stage` set, that stage name must exist in `app.Spec.Stages` |
| Poll interval parseable | If set, `app.Spec.Source.PollInterval` must be a valid Go duration |
| Health check source type | If `check.Source == "http"`, `check.HTTP.URL` must be non-empty |

#### Stage

| Rule | Logic |
|------|-------|
| Traffic router provider | If set, must be `"istio"` or `"gateway-api"` |
| Router config mutual exclusion | If provider is `"istio"`, `TrafficRouter.Istio` must be set; `TrafficRouter.GatewayAPI` must be nil. Vice versa for `"gateway-api"`. |
| Template references non-empty | `len(stage.Spec.Templates) > 0` |
| Canary step weights | All step weights in range [0, 100], monotonically non-decreasing |

#### Release

| Rule | Logic |
|------|-------|
| Target exists | `release.Spec.Target` is non-empty |
| Canary step index in range | If set, `release.Status.CanaryStepIndex` must be ≤ `len(canaryCfg.Steps)` |

#### Pipeline

| Rule | Logic |
|------|-------|
| No duplicate step names | All step names must be unique |
| DAG has no cycles | Reachability check from each step: no step depends on itself transitively |
| Valid step types | Each `step.Type` must be `"task"` or `"approval"` |
| Dependency existence | Each `step.DependsOn` entry must reference another step in the same pipeline |
| Artifact source references | If `ArtifactRef.Source` is set, it must match a step name |

#### Template

| Rule | Logic |
|------|-------|
| Type required | `template.Spec.Type` must be `"helm"`, `"git"`, or `"s3"` |
| Type-specific fields | If helm: `Chart.Repo` and `Chart.Name` required. If git: `Git.URL` required. If s3: `S3.Bucket` and `S3.Key` required |

#### Artifact

No validating webhook needed — leaf CRD with no inter-field dependencies.

### 1.2 Defaulting Webhooks

One defaulting webhook per CRD. Sets sensible defaults for unset fields.

| CRD | Defaults |
|-----|----------|
| **Application** | `strategy: "rolling"`, `syncPolicy: "auto"`, `pollInterval: "30s"` |
| **Stage** | If strategy is canary and steps are empty: `steps: [10, 25, 50, 75, 100]`. If trafficRouter is set but no provider: default to `"istio"`. Stable service defaults to `"<release-name>-stable"`, canary service defaults to `"<release-name>-canary"` |
| **Release** | `canaryWeight: 0`, `canaryStepIndex: 0` |
| **Pipeline** | `timeout: "30m"` for each step if unset |
| **Template** | No defaults needed |

### 1.3 Implementation

Scaffold using:
```bash
kubebuilder create webhook --group pipelines --version v1alpha1 --kind Application --defaulting --programmatic-validation
kubebuilder create webhook --group pipelines --version v1alpha1 --kind Stage --defaulting --programmatic-validation
kubebuilder create webhook --group pipelines --version v1alpha1 --kind Pipeline --defaulting --programmatic-validation
kubebuilder create webhook --group pipelines --version v1alpha1 --kind Release --defaulting --programmatic-validation
kubebuilder create webhook --group pipelines --version v1alpha1 --kind Template --defaulting --programmatic-validation
```

This generates files under `internal/webhook/pipelines/v1alpha1/`. Webhooks are registered automatically in `cmd/main.go` at the `// +kubebuilder:scaffold:webhook` marker.

The generated `SetupWebhookWithManager` methods are called from the `Setup()` function. Conversion webhooks are not needed (single API version).

Cert-manager is already installed in the cluster, so webhook certs are handled by cert-manager annotations.

---

## 2. Finalizers

### 2.1 Which Controllers

| Controller | Finalizer Name | Cleanup Action | Priority |
|------------|---------------|----------------|----------|
| ReleaseReconciler | `paprika.io/release-cleanup` | Delete manifest ConfigMap + using `track=canary` label selector | Highest (leaks applied resources) |
| ApplicationReconciler | `paprika.io/application-cleanup` | Delete child Template, Pipeline, Stage, Release CRs | High (leaks child CRs) |
| PipelineReconciler | `paprika.io/pipeline-cleanup` | Delete Jobs and Pods created by pipeline steps | Medium (leaks Job resources) |
| StageReconciler | None needed | Stage owns no external resources | Skip |
| TemplateReconciler | None needed | Template owns no external resources | Skip |
| ArtifactReconciler | None needed | Artifact owns no external resources | Skip |

### 2.2 Pattern

Every finalizer-enabled controller follows the same pattern in `Reconcile`:

```go
const myFinalizer = "paprika.io/my-cleanup"

// 1. Check if the object is being deleted
if !obj.ObjectMeta.DeletionTimestamp.IsZero() {
    if controllerutil.ContainsFinalizer(obj, myFinalizer) {
        if err := r.cleanup(ctx, obj); err != nil {
            return ctrl.Result{}, err  // transient, retry
        }
        controllerutil.RemoveFinalizer(obj, myFinalizer)
        if err := r.Update(ctx, obj); err != nil {
            return ctrl.Result{}, err
        }
    }
    return ctrl.Result{}, nil
}

// 2. Ensure finalizer is present
if !controllerutil.ContainsFinalizer(obj, myFinalizer) {
    controllerutil.AddFinalizer(obj, myFinalizer)
    if err := r.Update(ctx, obj); err != nil {
        return ctrl.Result{}, err
    }
}

// 3. Normal reconciliation
```

Using `sigs.k8s.io/controller-runtime/pkg/controller/controllerutil` for `AddFinalizer`/`ContainsFinalizer`/`RemoveFinalizer`.

### 2.3 Release Cleanup

```go
func (r *ReleaseReconciler) cleanup(ctx context.Context, release *paprikav1.Release) error {
    // Delete manifest snapshot ConfigMap
    cmName := release.Name + "-manifest-snapshot"
    if err := r.Delete(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{
        Name:      cmName,
        Namespace: release.Namespace,
    }}); err != nil && !apierrors.IsNotFound(err) {
        return fmt.Errorf("deleting manifest snapshot: %w", err)
    }

    // Delete canary resources (Deployments, Services, Ingresses with track=canary label)
    selector := labels.SelectorFromSet(labels.Set{"track": "canary", "paprika.io/release": release.Name})
    r.cleanupResourcesBySelector(ctx, release.Namespace, selector)

    return nil
}
```

### 2.4 Application Cleanup

```go
func (r *ApplicationReconciler) cleanup(ctx context.Context, app *paprikav1.Application) error {
    // Delete child Releases
    r.deleteAllInNamespace(ctx, &paprikav1.ReleaseList{}, app.Namespace, ...)
    // Delete child Stages
    r.deleteAllInNamespace(ctx, &paprikav1.StageList{}, app.Namespace, ...)
    // Delete child Pipelines
    r.deleteAllInNamespace(ctx, &paprikav1.PipelineList{}, app.Namespace, ...)
    // Delete child Templates
    r.deleteAllInNamespace(ctx, &paprikav1.TemplateList{}, app.Namespace, ...)
    return nil
}
```

Child resources are garbage collected via owner references set during creation, but explicit deletion is more robust for CRD-managed resources.

### 2.5 Pipeline Cleanup

```go
func (r *PipelineReconciler) cleanup(ctx context.Context, pipeline *paprikav1.Pipeline) error {
    // Delete Jobs with pipline=<name> label
    selector := labels.SelectorFromSet(labels.Set{"pipeline": pipeline.Name})
    return r.deleteJobsBySelector(ctx, pipeline.Namespace, selector)
}
```

---

## 3. Error Handling & Retry

### 3.1 Classification

Every error in controller reconciliation is classified as either:

| Type | Handling | Examples |
|------|----------|---------|
| **Transient** | `return ctrl.Result{}, err` (auto-requeue by controller-runtime with exponential backoff) | API server timeout, conflict, network error |
| **Terminal** | Update status condition, `return ctrl.Result{}` (no requeue) | Invalid spec, missing required CRD, non-retryable validation failure |

### 3.2 Transient Error Paths Currently Returning No Requeue

| Controller | Location | Current | Fix |
|-----------|----------|---------|-----|
| ReleaseReconciler | `handlePromotingPhase` (line ~213) | `return ctrl.Result{}, nil` after log.Error | `return ctrl.Result{}, err` |
| ReleaseReconciler | `handleFailedRollback` (line ~268) | `result = resultError; return ctrl.Result{}, nil` | `return ctrl.Result{}, err` |
| PipelineReconciler | Pipeline failure (line ~87) | `return ctrl.Result{}, nil` | `return ctrl.Result{}, err` |
| ReleaseReconciler | `checkConcurrentRelease` errors (line ~98) | `return ctrl.Result{}, nil` | `return ctrl.Result{}, err` |
| All controllers | Status update failures | `log.Error(err, ...); return ctrl.Result{}, nil` | `return ctrl.Result{}, err` |
| ReleaseReconciler | `storeManifestSnapshot` conflict | `log.Error(err, ...); return nil` then caller returns `ctrl.Result{}, nil` | Propagate error |

### 3.3 MaxConcurrentReconciles

Set `MaxConcurrentReconciles` on each controller to allow parallel processing:

| Controller | Value | Rationale |
|-----------|-------|-----------|
| ReleaseReconciler | 5 | Most active controller — many simultaneous canary rollouts |
| ApplicationReconciler | 3 | Orchestrates child CRs, moderate throughput |
| PipelineReconciler | 3 | Parallel pipeline executions |
| Others | 1 | Lower throughput needs |

### 3.4 Client-Side Rate Limiting

Add rate limiting to the default `rest.Config`:

```go
config := mgr.GetConfig()
config.QPS = 50
config.Burst = 100
```

This applies to all controllers sharing the same client. The existing defaults (QPS=5, Burst=10) are too low for an operator managing multiple concurrent reconciliations.

---

## 4. Verification

After implementation:
- `make generate && make manifests` — regenerates deepcopy, CRDs, RBAC, webhook manifests
- `make lint` — 0 issues
- `make test` — all unit tests pass
- `make test-e2e` — all e2e tests pass with webhooks enabled
- Manual: create Application with invalid spec → validating webhook rejects it
- Manual: create Application with minimal spec → defaulting webhook fills defaults
- Manual: delete Release → finalizer triggers cleanup, ConfigMap deleted
