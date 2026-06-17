# Self-Healing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement automatic remediation for Paprika Applications: auto-sync on drift and auto-revert on health failure.

**Architecture:** Extend the `Application` CRD with a `selfHeal` config block. A new `reconcileSelfHeal` helper in the Application controller evaluates drift, health, and cooldown, then annotates the current Release to trigger resync or rollback. The Release controller clears the resync annotation and resets its phase to `Pending` to re-apply manifests. The `Application` proto message gains a `Condition` message and a `conditions` field so the UI can observe self-heal state.

**Tech Stack:** Go, Kubernetes controller-runtime, kubebuilder, Protocol Buffers (buf), Ginkgo/Gomega, envtest.

---

## Chunk 1: API Schema

### Task 1: Add `SelfHealConfig` and status field

**Files:**
- Modify: `api/pipelines/v1alpha1/application_types.go`

- [ ] **Step 1: Insert `SelfHealConfig` after `SyncOptions`**

```go
// SelfHealConfig controls automatic remediation behavior.
type SelfHealConfig struct {
    // AutoSyncOnDrift triggers a re-sync when managed resources are out of sync.
    // +optional
    AutoSyncOnDrift bool `json:"autoSyncOnDrift,omitempty"`

    // AutoRevertOnHealthFailure rolls back the current release when the application becomes Degraded.
    // +optional
    AutoRevertOnHealthFailure bool `json:"autoRevertOnHealthFailure,omitempty"`

    // Cooldown between self-heal actions. Defaults to 5m.
    // +kubebuilder:default="5m"
    // +optional
    Cooldown string `json:"cooldown,omitempty"`
}
```

- [ ] **Step 2: Add `SelfHeal` to `ApplicationSpec`**

Insert after `ApprovalGates` (around line 319):

```go
    // SelfHeal controls automatic remediation when drift or health failures are detected.
    // +optional
    SelfHeal *SelfHealConfig `json:"selfHeal,omitempty"`
```

- [ ] **Step 3: Add `LastSelfHealTime` to `ApplicationStatus`**

Insert after `Gates` (around line 411):

```go
    // LastSelfHealTime records the last time a self-heal action was taken.
    // +optional
    LastSelfHealTime *metav1.Time `json:"lastSelfHealTime,omitempty"`
```

- [ ] **Step 4: Run `go fmt` on the file**

### Task 2: Regenerate deepcopy and CRDs

- [ ] **Step 1: Run code generation**

```bash
make generate
```

Expected: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` is updated with `DeepCopyInto` for `SelfHealConfig`.

- [ ] **Step 2: Run manifest generation**

```bash
make manifests
```

Expected changes:
- `config/crd/bases/pipelines.paprika.io_applications.yaml` gains `spec.selfHeal` and `status.lastSelfHealTime`.
- `config/rbac/role.yaml` should be unchanged.

### Task 3: Sync Helm chart CRD

- [ ] **Step 1: Regenerate Helm chart**

```bash
make helm-generate
```

This backs up and restores `charts/chart/values.yaml` automatically.

- [ ] **Step 2: Verify the Helm CRD**

```bash
git diff -- charts/chart/templates/crd/applications.pipelines.paprika.io.yaml
```

Expected: new `selfHeal` and `lastSelfHealTime` fields appear.

---

## Chunk 2: Release Controller Resync

### Task 4: Handle `paprika.io/resync` on Releases

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: Add the annotation constant**

In the constants block (around line 52), add:

```go
    resyncAnnotation   = "paprika.io/resync"
```

- [ ] **Step 2: Insert resync handling at the top of `reconcileReleasePhase`**

Before `shouldRollback`, add:

```go
    if _, ok := release.Annotations[resyncAnnotation]; ok && r.isReleaseTerminal(release) {
        oldPhase := release.Status.Phase
        patch := client.MergeFrom(release.DeepCopy())
        delete(release.Annotations, resyncAnnotation)
        if err := r.Patch(ctx, release, patch); err != nil {
            *result = resultError
            return ctrl.Result{}, fmt.Errorf("clearing resync annotation: %w", err)
        }
        release.Status.Phase = paprikav1.ReleasePending
        if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
            *result = resultError
            return ctrl.Result{}, fmt.Errorf("resetting release phase to pending: %w", err)
        }
        return ctrl.Result{Requeue: true}, nil
    }
```

- [ ] **Step 3: Run `go fmt` and `go vet`**

```bash
go fmt ./...
go vet ./...
```

- [ ] **Step 4: Add a focused unit test for resync handling**

Create a new test in `internal/controller/pipelines/release_controller_unit_test.go`:

```go
func TestReleaseReconciler_reconcileReleasePhase_resyncAnnotationResetsPending(t *testing.T) {
    ctx := context.Background()
    scheme := runtime.NewScheme()
    _ = pipelinesv1alpha1.AddToScheme(scheme)

    release := &pipelinesv1alpha1.Release{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "app-release",
            Namespace: "default",
            Annotations: map[string]string{
                "paprika.io/resync": "12345",
            },
        },
        Status: pipelinesv1alpha1.ReleaseStatus{
            Phase: pipelinesv1alpha1.ReleaseComplete,
        },
    }
    client := fake.NewClientBuilder().WithScheme(scheme).WithObjects(release).WithStatusSubresource(release).Build()

    r := &ReleaseReconciler{Client: client, Scheme: scheme}
    res, err := r.reconcileReleasePhase(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: release.Name, Namespace: release.Namespace}}, release, time.Now(), ptr(""))
    if err != nil {
        t.Fatalf("reconcileReleasePhase failed: %v", err)
    }
    if !res.Requeue {
        t.Fatalf("expected requeue after resync")
    }

    var updated pipelinesv1alpha1.Release
    if err := client.Get(ctx, types.NamespacedName{Name: release.Name, Namespace: release.Namespace}, &updated); err != nil {
        t.Fatalf("get release: %v", err)
    }
    if updated.Status.Phase != pipelinesv1alpha1.ReleasePending {
        t.Fatalf("expected phase Pending, got %s", updated.Status.Phase)
    }
    if _, ok := updated.Annotations["paprika.io/resync"]; ok {
        t.Fatalf("expected resync annotation to be removed")
    }
}
```

Add a `ptr` helper or use a local string variable.

---

## Chunk 3: Application Controller Self-Heal

### Task 5: Create the self-heal helper

**Files:**
- Create: `internal/controller/pipelines/self_heal.go`
- Modify: `internal/controller/pipelines/application_controller.go`

- [ ] **Step 1: Add `now` field to `ApplicationReconciler`**

In `internal/controller/pipelines/application_controller.go` around line 61, add inside the struct:

```go
    // now returns the current time. Overridden in tests.
    now func() time.Time
```

- [ ] **Step 2: Initialize `now` in `SetupWithManager`**

At the top of `SetupWithManager` (around line 1348), add:

```go
    if r.now == nil {
        r.now = time.Now
    }
```

- [ ] **Step 3: Wire `reconcileSelfHeal` into the two evaluation paths**

In `reconcileReleaseFlow` (around line 320), after `r.evaluateResourceHealth(ctx, app)` and before `r.patchAppStatus(ctx, app)`, add:

```go
    if err := r.reconcileSelfHeal(ctx, app); err != nil {
        log.Error(err, "Failed to reconcile self-heal")
    }
```

In `handleHealthyPhase` (around line 1223), after `r.evaluateResourceHealth(ctx, app)` and before `r.patchAppStatus(ctx, app)`, add:

```go
    if err := r.reconcileSelfHeal(ctx, app); err != nil {
        log.Error(err, "Failed to reconcile self-heal")
    }
```

- [ ] **Step 4: Create `internal/controller/pipelines/self_heal.go`**

```go
package controller

import (
    "context"
    "fmt"
    "strconv"
    "time"

    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

const (
    selfHealConditionType = "SelfHealed"
    defaultSelfHealCooldown = 5 * time.Minute
)

func (r *ApplicationReconciler) currentTime() time.Time {
    if r.now != nil {
        return r.now()
    }
    return time.Now()
}

func (r *ApplicationReconciler) reconcileSelfHeal(ctx context.Context, app *pipelinesv1alpha1.Application) error {
    if app.Spec.SelfHeal == nil {
        return nil
    }

    if !r.selfHealAllowedPhase(app.Status.Phase) {
        r.setSelfHealCondition(app, metav1.ConditionFalse, "PhaseBlocked",
            fmt.Sprintf("Phase %s does not allow self-heal", app.Status.Phase))
        return nil
    }

    cooldown := defaultSelfHealCooldown
    if app.Spec.SelfHeal.Cooldown != "" {
        if d, err := time.ParseDuration(app.Spec.SelfHeal.Cooldown); err == nil && d > 0 {
            cooldown = d
        }
    }

    if app.Status.LastSelfHealTime != nil && r.currentTime().Sub(app.Status.LastSelfHealTime.Time) < cooldown {
        remaining := cooldown - r.currentTime().Sub(app.Status.LastSelfHealTime.Time)
        r.setSelfHealCondition(app, metav1.ConditionFalse, "CooldownActive",
            fmt.Sprintf("Cooldown of %v remaining", remaining))
        return nil
    }

    if app.Spec.SelfHeal.AutoSyncOnDrift && app.Spec.SyncPolicy == pipelinesv1alpha1.SyncAuto && app.Status.OutOfSync > 0 {
        return r.selfHealDriftSync(ctx, app)
    }

    if app.Spec.SelfHeal.AutoRevertOnHealthFailure && app.Status.Health == pipelinesv1alpha1.HealthDegraded {
        return r.selfHealHealthRevert(ctx, app)
    }

    r.setSelfHealCondition(app, metav1.ConditionFalse, "NoActionNeeded", "No drift or health failure detected")
    return nil
}

func (r *ApplicationReconciler) selfHealAllowedPhase(phase pipelinesv1alpha1.ApplicationPhase) bool {
    switch phase {
    case pipelinesv1alpha1.ApplicationHealthy, pipelinesv1alpha1.ApplicationDegraded, pipelinesv1alpha1.ApplicationFailed:
        return true
    }
    return false
}

func (r *ApplicationReconciler) selfHealDriftSync(ctx context.Context, app *pipelinesv1alpha1.Application) error {
    if app.Status.ReleaseRef == "" {
        return nil
    }

    var release pipelinesv1alpha1.Release
    if err := r.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
        return fmt.Errorf("fetching release for drift sync: %w", client.IgnoreNotFound(err))
    }

    if release.Status.Phase != pipelinesv1alpha1.ReleaseComplete {
        return nil
    }
    if _, ok := release.Annotations[resyncAnnotation]; ok {
        return nil
    }

    patch := client.MergeFrom(release.DeepCopy())
    if release.Annotations == nil {
        release.Annotations = map[string]string{}
    }
    release.Annotations[resyncAnnotation] = strconv.FormatInt(r.currentTime().Unix(), 10)
    if err := r.Patch(ctx, &release, patch); err != nil {
        return fmt.Errorf("annotating release for resync: %w", err)
    }

    now := metav1.Time{Time: r.currentTime()}
    app.Status.LastSelfHealTime = &now
    r.recordEvent(app, "Warning", "SelfHealDriftSync", "Out-of-sync resources detected; triggered re-sync")
    r.setSelfHealCondition(app, metav1.ConditionTrue, "DriftDetected", "Out-of-sync resources detected; triggered re-sync")
    return nil
}

func (r *ApplicationReconciler) selfHealHealthRevert(ctx context.Context, app *pipelinesv1alpha1.Application) error {
    if app.Status.ReleaseRef == "" {
        return nil
    }
    if app.Spec.OnFailure == nil || app.Spec.OnFailure.Action != "rollback" {
        return nil
    }

    var release pipelinesv1alpha1.Release
    if err := r.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &release); err != nil {
        return fmt.Errorf("fetching release for health revert: %w", client.IgnoreNotFound(err))
    }

    if release.Status.Phase == pipelinesv1alpha1.ReleaseRolledBack || release.Status.Phase == pipelinesv1alpha1.ReleaseFailed {
        return nil
    }
    if _, ok := release.Annotations[rollbackAnnotation]; ok {
        return nil
    }

    patch := client.MergeFrom(release.DeepCopy())
    if release.Annotations == nil {
        release.Annotations = map[string]string{}
    }
    release.Annotations[rollbackAnnotation] = strconv.FormatInt(r.currentTime().Unix(), 10)
    if err := r.Patch(ctx, &release, patch); err != nil {
        return fmt.Errorf("annotating release for rollback: %w", err)
    }

    now := metav1.Time{Time: r.currentTime()}
    app.Status.LastSelfHealTime = &now
    r.recordEvent(app, "Warning", "SelfHealRevert", "Application health degraded; requested rollback")
    r.setSelfHealCondition(app, metav1.ConditionTrue, "HealthDegraded", "Application health degraded; requested rollback")
    return nil
}

func (r *ApplicationReconciler) setSelfHealCondition(app *pipelinesv1alpha1.Application, status metav1.ConditionStatus, reason, message string) {
    meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
        Type:               selfHealConditionType,
        Status:             status,
        Reason:             reason,
        Message:            message,
        LastTransitionTime: metav1.Now(),
    })
}
```

- [ ] **Step 5: Run `go fmt` and `go vet`**

```bash
go fmt ./...
go vet ./...
```

### Task 6: Unit test the self-heal helper

**Files:**
- Create: `internal/controller/pipelines/self_heal_test.go`

- [ ] **Step 1: Write table-driven unit tests**

```go
package controller

import (
    "context"
    "testing"
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/client-go/tools/record"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "github.com/benebsworth/paprika/engine"
)

func newSelfHealClient(objs ...client.Object) client.Client {
    scheme := runtime.NewScheme()
    _ = pipelinesv1alpha1.AddToScheme(scheme)
    return fake.NewClientBuilder().WithScheme(scheme).WithObjects(objs...).WithStatusSubresource(&pipelinesv1alpha1.Release{}).Build()
}

func TestApplicationReconciler_reconcileSelfHeal(t *testing.T) {
    ctx := context.Background()
    fixed := time.Date(2026, 6, 16, 12, 0, 0, 0, time.UTC)

    baseApp := func() *pipelinesv1alpha1.Application {
        return &pipelinesv1alpha1.Application{
            ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
            Spec: pipelinesv1alpha1.ApplicationSpec{
                SyncPolicy: pipelinesv1alpha1.SyncAuto,
                SelfHeal: &pipelinesv1alpha1.SelfHealConfig{
                    AutoSyncOnDrift:           true,
                    AutoRevertOnHealthFailure: true,
                },
                Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
            },
            Status: pipelinesv1alpha1.ApplicationStatus{
                Phase:      pipelinesv1alpha1.ApplicationHealthy,
                ReleaseRef: "app-release",
                OutOfSync:  1,
                Health:     pipelinesv1alpha1.HealthDegraded,
            },
        }
    }

    tests := []struct {
        name            string
        releasePhase    pipelinesv1alpha1.ReleasePhase
        releaseAnnot    map[string]string
        lastHeal        *time.Time
        syncPolicy      pipelinesv1alpha1.SyncPolicy
        onFailure       *pipelinesv1alpha1.FailureAction
        wantResync      bool
        wantRollback    bool
        wantCondition   string
    }{
        {
            name:          "drift sync annotates complete release",
            releasePhase:  pipelinesv1alpha1.ReleaseComplete,
            wantResync:    true,
            wantCondition: "DriftDetected",
        },
        {
            name:          "drift sync blocked by manual sync policy",
            releasePhase:  pipelinesv1alpha1.ReleaseComplete,
            syncPolicy:    pipelinesv1alpha1.SyncManual,
            wantResync:    false,
            wantCondition: "NoActionNeeded",
        },
        {
            name:          "cooldown prevents second action",
            releasePhase:  pipelinesv1alpha1.ReleaseComplete,
            lastHeal:      &fixed,
            wantResync:    false,
            wantCondition: "CooldownActive",
        },
        {
            name:            "health revert annotates release for rollback",
            releasePhase:    pipelinesv1alpha1.ReleaseComplete,
            onFailure:       &pipelinesv1alpha1.FailureAction{Action: "rollback"},
            wantResync:      true, // drift also qualifies; drift runs first
            wantCondition:   "DriftDetected",
        },
        {
            name:          "health revert blocked without rollback onFailure",
            releasePhase:  pipelinesv1alpha1.ReleaseComplete,
            wantResync:    true,
            wantCondition: "DriftDetected",
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            app := baseApp()
            if tc.syncPolicy != "" {
                app.Spec.SyncPolicy = tc.syncPolicy
            }
            app.Spec.OnFailure = tc.onFailure
            if tc.lastHeal != nil {
                app.Status.LastSelfHealTime = &metav1.Time{Time: *tc.lastHeal}
            }

            release := &pipelinesv1alpha1.Release{
                ObjectMeta: metav1.ObjectMeta{
                    Name:        "app-release",
                    Namespace:   "default",
                    Annotations: tc.releaseAnnot,
                    Labels: map[string]string{
                        engine.ApplicationNameLabelKey: app.Name,
                    },
                },
                Status: pipelinesv1alpha1.ReleaseStatus{Phase: tc.releasePhase},
            }

            recorder := record.NewFakeRecorder(10)
            r := &ApplicationReconciler{
                Client:        newSelfHealClient(release),
                EventRecorder: recorder,
                now:           func() time.Time { return fixed },
            }

            if err := r.reconcileSelfHeal(ctx, app); err != nil {
                t.Fatalf("reconcileSelfHeal failed: %v", err)
            }

            var updated pipelinesv1alpha1.Release
            if err := r.Get(ctx, client.ObjectKeyFromObject(release), &updated); err != nil {
                t.Fatalf("get release: %v", err)
            }

            if got := updated.Annotations[resyncAnnotation] != ""; got != tc.wantResync {
                t.Fatalf("resync annotation: got %v, want %v", got, tc.wantResync)
            }
            if got := updated.Annotations[rollbackAnnotation] != ""; got != tc.wantRollback {
                t.Fatalf("rollback annotation: got %v, want %v", got, tc.wantRollback)
            }

            cond := findCondition(app.Status.Conditions, selfHealConditionType)
            if cond == nil {
                t.Fatalf("expected SelfHealed condition")
            }
            if cond.Reason != tc.wantCondition {
                t.Fatalf("condition reason: got %s, want %s", cond.Reason, tc.wantCondition)
            }
        })
    }
}

func findCondition(conds []metav1.Condition, t string) *metav1.Condition {
    for i := range conds {
        if conds[i].Type == t {
            return &conds[i]
        }
    }
    return nil
}
```

- [ ] **Step 2: Run the new unit tests**

```bash
go test ./internal/controller/pipelines -run TestApplicationReconciler_reconcileSelfHeal -v
```

Expected: all cases pass.

---

## Chunk 4: Proto and API Surface

### Task 7: Add `Condition` message to proto

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1: Add `Condition` message before `Application`**

Insert before `message Application` (around line 112):

```protobuf
message Condition {
  string type = 1;
  string status = 2;     // "True", "False", "Unknown"
  int64 observed_generation = 3;
  string last_transition_time = 4; // RFC3339
  string reason = 5;
  string message = 6;
}
```

- [ ] **Step 2: Add `conditions` field to `Application`**

Add to `message Application` after `project = 24;`:

```protobuf
  repeated Condition conditions = 25;
```

### Task 8: Regenerate protobuf clients

- [ ] **Step 1: Run proto generation**

```bash
make generate-proto
```

Expected updates:
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

### Task 9: Map conditions in `convertApplication`

**Files:**
- Modify: `internal/api/server.go`

- [ ] **Step 1: Add `metav1` import**

In the import block, add:

```go
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
```

- [ ] **Step 2: Add `convertConditions` helper**

Insert near `convertApplication`:

```go
func convertConditions(conds []metav1.Condition) []*paprikav1.Condition {
    out := make([]*paprikav1.Condition, 0, len(conds))
    for _, c := range conds {
        out = append(out, &paprikav1.Condition{
            Type:               c.Type,
            Status:             string(c.Status),
            ObservedGeneration: c.ObservedGeneration,
            LastTransitionTime: c.LastTransitionTime.Format(time.RFC3339),
            Reason:             c.Reason,
            Message:            c.Message,
        })
    }
    return out
}
```

- [ ] **Step 3: Set `Conditions` in `convertApplication`**

In the returned `&paprikav1.Application{...}`, add:

```go
    Conditions: convertConditions(a.Status.Conditions),
```

- [ ] **Step 4: Run `go fmt` and `go vet`**

---

## Chunk 5: Integration Tests and Final Verification

### Task 10: Add envtest coverage

**Files:**
- Create: `internal/controller/pipelines/self_heal_envtest_test.go`

- [ ] **Step 1: Write Ginkgo envtest specs**

```go
package controller

import (
    "context"
    "time"

    "github.com/onsi/ginkgo/v2"
    "github.com/onsi/gomega"
    "k8s.io/apimachinery/pkg/api/meta"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/client-go/tools/record"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

var _ = ginkgo.Describe("Application Controller Self-Heal", func() {
    ctx := context.Background()
    const appName = "self-heal-app"
    appKey := types.NamespacedName{Name: appName, Namespace: "default"}

    ginkgo.BeforeEach(func() {
        app := &pipelinesv1alpha1.Application{
            ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
            Spec: pipelinesv1alpha1.ApplicationSpec{
                Source: pipelinesv1alpha1.ApplicationSource{Type: "inline"},
                Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
                SyncPolicy: pipelinesv1alpha1.SyncAuto,
                SelfHeal: &pipelinesv1alpha1.SelfHealConfig{
                    AutoSyncOnDrift:           true,
                    AutoRevertOnHealthFailure: true,
                    Cooldown:                  "1m",
                },
            },
        }
        gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())
    })

    ginkgo.AfterEach(func() {
        app := &pipelinesv1alpha1.Application{}
        if err := k8sClient.Get(ctx, appKey, app); err == nil {
            gomega.Expect(k8sClient.Delete(ctx, app)).To(gomega.Succeed())
        }
        release := &pipelinesv1alpha1.Release{}
        releaseKey := types.NamespacedName{Name: appName + "-release", Namespace: "default"}
        if err := k8sClient.Get(ctx, releaseKey, release); err == nil {
            gomega.Expect(k8sClient.Delete(ctx, release)).To(gomega.Succeed())
        }
    })

    ginkgo.It("should annotate the release for resync when drift is detected", func() {
        release := &pipelinesv1alpha1.Release{
            ObjectMeta: metav1.ObjectMeta{Name: appName + "-release", Namespace: "default"},
            Status:     pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseComplete},
        }
        gomega.Expect(k8sClient.Create(ctx, release)).To(gomega.Succeed())
        gomega.Expect(k8sClient.Status().Update(ctx, release)).To(gomega.Succeed())

        app := &pipelinesv1alpha1.Application{}
        gomega.Expect(k8sClient.Get(ctx, appKey, app)).To(gomega.Succeed())
        app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
        app.Status.ReleaseRef = release.Name
        app.Status.OutOfSync = 1
        gomega.Expect(k8sClient.Status().Update(ctx, app)).To(gomega.Succeed())

        rec := record.NewFakeRecorder(10)
        r := &ApplicationReconciler{
            Client:        k8sClient,
            Scheme:        k8sClient.Scheme(),
            EventRecorder: rec,
            now:           func() time.Time { return time.Now() },
        }
        _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
        gomega.Expect(err).NotTo(gomega.HaveOccurred())

        var updated pipelinesv1alpha1.Release
        gomega.Eventually(func() bool {
            if err := k8sClient.Get(ctx, types.NamespacedName{Name: release.Name, Namespace: "default"}, &updated); err != nil {
                return false
            }
            return updated.Annotations[resyncAnnotation] != ""
        }, 10*time.Second, 1*time.Second).Should(gomega.BeTrue())

        cond := meta.FindStatusCondition(app.Status.Conditions, selfHealConditionType)
        gomega.Expect(cond).NotTo(gomega.BeNil())
        gomega.Expect(cond.Reason).To(gomega.Equal("DriftDetected"))
    })

    ginkgo.It("should annotate the release for rollback when health is degraded", func() {
        release := &pipelinesv1alpha1.Release{
            ObjectMeta: metav1.ObjectMeta{Name: appName + "-release", Namespace: "default"},
            Status:     pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseComplete},
        }
        gomega.Expect(k8sClient.Create(ctx, release)).To(gomega.Succeed())
        gomega.Expect(k8sClient.Status().Update(ctx, release)).To(gomega.Succeed())

        app := &pipelinesv1alpha1.Application{}
        gomega.Expect(k8sClient.Get(ctx, appKey, app)).To(gomega.Succeed())
        app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
        app.Status.ReleaseRef = release.Name
        app.Status.Health = pipelinesv1alpha1.HealthDegraded
        app.Spec.OnFailure = &pipelinesv1alpha1.FailureAction{Action: "rollback"}
        gomega.Expect(k8sClient.Update(ctx, app)).To(gomega.Succeed())
        gomega.Expect(k8sClient.Status().Update(ctx, app)).To(gomega.Succeed())

        r := &ApplicationReconciler{
            Client: k8sClient,
            Scheme: k8sClient.Scheme(),
            now:    func() time.Time { return time.Now() },
        }
        _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
        gomega.Expect(err).NotTo(gomega.HaveOccurred())

        var updated pipelinesv1alpha1.Release
        gomega.Eventually(func() bool {
            if err := k8sClient.Get(ctx, types.NamespacedName{Name: release.Name, Namespace: "default"}, &updated); err != nil {
                return false
            }
            return updated.Annotations[rollbackAnnotation] != ""
        }, 10*time.Second, 1*time.Second).Should(gomega.BeTrue())

        cond := meta.FindStatusCondition(app.Status.Conditions, selfHealConditionType)
        gomega.Expect(cond).NotTo(gomega.BeNil())
        gomega.Expect(cond.Reason).To(gomega.Equal("HealthDegraded"))
    })

    ginkgo.It("should not act within cooldown", func() {
        release := &pipelinesv1alpha1.Release{
            ObjectMeta: metav1.ObjectMeta{Name: appName + "-release", Namespace: "default"},
            Status:     pipelinesv1alpha1.ReleaseStatus{Phase: pipelinesv1alpha1.ReleaseComplete},
        }
        gomega.Expect(k8sClient.Create(ctx, release)).To(gomega.Succeed())
        gomega.Expect(k8sClient.Status().Update(ctx, release)).To(gomega.Succeed())

        now := time.Now()
        app := &pipelinesv1alpha1.Application{}
        gomega.Expect(k8sClient.Get(ctx, appKey, app)).To(gomega.Succeed())
        app.Status.Phase = pipelinesv1alpha1.ApplicationHealthy
        app.Status.ReleaseRef = release.Name
        app.Status.OutOfSync = 1
        app.Status.LastSelfHealTime = &metav1.Time{Time: now}
        gomega.Expect(k8sClient.Status().Update(ctx, app)).To(gomega.Succeed())

        r := &ApplicationReconciler{
            Client: k8sClient,
            Scheme: k8sClient.Scheme(),
            now:    func() time.Time { return now.Add(1 * time.Second) },
        }
        _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
        gomega.Expect(err).NotTo(gomega.HaveOccurred())

        var updated pipelinesv1alpha1.Release
        gomega.Expect(k8sClient.Get(ctx, types.NamespacedName{Name: release.Name, Namespace: "default"}, &updated)).To(gomega.Succeed())
        gomega.Expect(updated.Annotations[resyncAnnotation]).To(gomega.BeEmpty())

        cond := meta.FindStatusCondition(app.Status.Conditions, selfHealConditionType)
        gomega.Expect(cond).NotTo(gomega.BeNil())
        gomega.Expect(cond.Reason).To(gomega.Equal("CooldownActive"))
    })
})
```

- [ ] **Step 2: Run the envtest specs**

```bash
go test ./internal/controller/pipelines -run TestControllers -v
```

Expected: all self-heal specs pass.

### Task 11: Final verification

- [ ] **Step 1: Run linter**

```bash
make lint
```

Expected: no errors.

- [ ] **Step 2: Run full unit/envtest suite**

```bash
make test
```

Expected: all tests pass.

- [ ] **Step 3: Commit the implementation**

```bash
git add -A
git commit -m "feat(pipelines): add Application self-healing (drift sync + health revert)

- Add SelfHealConfig to Application spec and LastSelfHealTime to status
- Trigger resync on the current Release when drift is detected
- Request rollback on the current Release when health is degraded
- Enforce cooldown and phase guards
- Expose status conditions via proto/API"
```

---

## Notes for Implementers

- The design spec is at `/Users/benebsworth/projects/paprika/docs/superpowers/specs/2026-06-16-self-healing-design.md`.
- Work in the worktree at `/Users/benebsworth/projects/paprika/.worktrees/feat-self-healing`.
- Do not modify `config/crd/bases/*.yaml`, `config/rbac/role.yaml`, `**/zz_generated.*.go`, or `PROJECT` by hand; always regenerate via `make`.
- If a test needs the Application to be in `Healthy` phase, pre-populate `status.phase` and call `Status().Update` before reconciling.
- The Release controller already owns the `rollbackAnnotation`; reuse it from `release_controller.go`.
