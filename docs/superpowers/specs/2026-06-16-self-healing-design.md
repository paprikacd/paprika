# Self-Healing Design

## Goal
Add automatic remediation to Paprika Applications:

- **Auto-sync on drift**: when the live cluster state diverges from the desired manifests, re-apply the desired state.
- **Auto-revert on health failure**: when an Application becomes `Degraded`, roll back to the previous release.

## Context
The following building blocks already exist:

- `engine.DiffEngine` computes per-resource diff and produces `Application.Status.Resources` and `Application.Status.OutOfSync`.
- `health.Evaluator` and `health.ResourceHealthChecker` produce `Application.Status.Health` and `Application.Status.HealthChecks`.
- The Application controller already reacts to `paprika.io/resync` by resetting phase to `Pending`.
- The Release controller already reacts to `paprika.io/rollback-requested` by rolling back a release.

This design reuses those mechanisms instead of introducing new controllers.

## API Changes

### `api/pipelines/v1alpha1/application_types.go`

Add a new config block:

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

Add to `ApplicationSpec`:

```go
    // SelfHeal controls automatic remediation when drift or health failures are detected.
    // +optional
    SelfHeal *SelfHealConfig `json:"selfHeal,omitempty"`
```

Add to `ApplicationStatus`:

```go
    // LastSelfHealTime records the last time a self-heal action was taken.
    // +optional
    LastSelfHealTime *metav1.Time `json:"lastSelfHealTime,omitempty"`
```

## Controller Behavior

### Reconciler additions

Add to `ApplicationReconciler`:

```go
    // now returns the current time. Overridden in tests.
    now func() time.Time
```

Default to `time.Now` in `SetupWithManager`.

Add to `ReleaseReconciler`:

```go
    // resyncAnnotation triggers a terminal release to re-apply its manifests.
    resyncAnnotation = "paprika.io/resync"
```

### Where to hook

`reconcileApp` has two paths that evaluate diff and health:

1. The active-release path (`reconcileReleaseFlow`) for non-Healthy phases.
2. The steady-state path (`handleHealthyPhase`) when `phase == Healthy`.

Call `reconcileSelfHeal` after diff/health evaluation in **both** paths, before the final status patch.

```go
func (r *ApplicationReconciler) reconcileSelfHeal(ctx context.Context, app *paprikav1.Application) error
```

The helper runs only when `app.Spec.SelfHeal` is non-nil.

### Allowed phases

Self-heal may only act when the Application is in one of these phases:

- `Healthy`
- `Degraded`
- `Failed`

It must **not** act during `Pending`, `Building`, `Promoting`, `Canarying`, `Verifying`, or `RolledBack`.

### Auto-sync on drift

Conditions for acting:

1. `app.Spec.SelfHeal.AutoSyncOnDrift` is true.
2. `app.Spec.SyncPolicy` is `Auto`.
3. `app.Status.Phase` is in the allowed set.
4. `app.Status.OutOfSync > 0`.
5. The cooldown period has elapsed since `status.lastSelfHealTime`.

Action:

- Fetch the current Release via `app.Status.ReleaseRef`.
- Skip if the Release phase is not `Complete` or already has the `paprika.io/resync` annotation.
- Add annotation `paprika.io/resync` to the Release using `client.MergeFrom` + `r.Patch`.
- Update `app.Status.LastSelfHealTime`.
- Emit a warning event: `SelfHealDriftSync`.
- Set condition:
  ```go
  Type: "SelfHealed", Status: True, Reason: "DriftDetected", Message: "Out-of-sync resources detected; triggered re-sync"
  ```

The Release controller will detect the annotation on its next reconciliation, clear it, set the Release phase to `Pending`, and re-render/apply the manifests.

### Auto-revert on health failure

Conditions for acting:

1. `app.Spec.SelfHeal.AutoRevertOnHealthFailure` is true.
2. `app.Status.Health == Degraded`.
3. `app.Status.Phase` is in the allowed set.
4. `app.Status.ReleaseRef` is non-empty.
5. The current Release's phase is `Complete`.
6. `release.Spec.OnFailure != nil && release.Spec.OnFailure.Action == "rollback"`.
7. The cooldown period has elapsed.

Action:

- Fetch the current Release via `app.Status.ReleaseRef`.
- Skip if the Release phase is not `Complete`, or already has the `paprika.io/rollback-requested` annotation.
- Add annotation `paprika.io/rollback-requested` to the Release using `client.MergeFrom` + `r.Patch`.
- Update `app.Status.LastSelfHealTime`.
- Emit a warning event: `SelfHealRevert`.
- Set condition:
  ```go
  Type: "SelfHealed", Status: True, Reason: "HealthDegraded", Message: "Application health degraded; requested rollback"
  ```

The Release controller will perform the rollback on its next reconciliation.

### Release-controller resync handling

In `ReleaseReconciler.reconcileReleasePhase`, before the rollback/terminal-phase checks, delegate to a helper:

```go
if res, handled, err := r.handleResyncAnnotation(ctx, release, result); handled {
    return res, err
}
```

The helper resets the phase first and then clears the annotation so the resync request is not lost if the status patch fails. It also clears the annotation defensively when it is present on a non-terminal release.

```go
func (r *ReleaseReconciler) handleResyncAnnotation(ctx context.Context, release *paprikav1.Release, result *string) (res ctrl.Result, handled bool, err error) {
    if _, ok := release.Annotations[resyncAnnotation]; !ok {
        return ctrl.Result{}, false, nil
    }

    if r.isReleaseTerminal(release) {
        oldPhase := release.Status.Phase
        release.Status.Phase = paprikav1.ReleasePending
        if err := r.patchReleaseStatus(ctx, release, oldPhase); err != nil {
            *result = resultError
            return ctrl.Result{}, true, fmt.Errorf("resetting release phase to pending: %w", err)
        }
    }

    patch := client.MergeFrom(release.DeepCopy())
    delete(release.Annotations, resyncAnnotation)
    if err := r.Patch(ctx, release, patch); err != nil {
        *result = resultError
        return ctrl.Result{}, true, fmt.Errorf("clearing resync annotation: %w", err)
    }
    return ctrl.Result{RequeueAfter: 1 * time.Second}, true, nil
}
```

This reuses the existing Release lifecycle to re-apply manifests instead of trying to recreate the Release.

### Cooldown

Default cooldown: `5m` when `spec.selfHeal.cooldown` is empty or invalid.

A self-heal action is skipped if:

```go
status.LastSelfHealTime != nil && r.now().Sub(status.LastSelfHealTime.Time) < cooldown
```

The cooldown is shared between drift-sync and health-revert to prevent thrashing.

## Safety

- Self-heal never overrides `SyncPolicy: Manual` for auto-sync.
- Self-heal actions are rate-limited per Application via cooldown.
- Auto-revert only fires when the user has explicitly configured `spec.onFailure.action: rollback`.
- Auto-revert is idempotent: repeated reconciliations see the existing rollback annotation and do nothing.
- Auto-sync is idempotent: setting the `paprika.io/resync` annotation is safe to repeat after cooldown.

## Status Conditions

Introduce a new condition type:

| Type        | Status | Reason            | Meaning                                  |
|-------------|--------|-------------------|------------------------------------------|
| SelfHealed  | True   | DriftDetected     | Auto-sync triggered due to drift         |
| SelfHealed  | True   | HealthDegraded    | Auto-revert triggered due to health      |
| SelfHealed  | False  | CooldownActive    | Self-heal skipped because of cooldown    |
| SelfHealed  | False  | NoActionNeeded    | No drift or health failure detected      |
| SelfHealed  | False  | PhaseBlocked      | Phase does not allow self-heal           |

## UI / API Impact

- No new RPCs or UI pages required for the first iteration.
- The `Application` proto message currently does not expose `status.conditions`, so dashboards will not see the `SelfHealed` condition until the proto is extended.
- Add a `Condition` message to the proto package:

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

- Add `repeated Condition conditions` to the proto `Application` message status, regenerate the TypeScript clients, and map `a.Status.Conditions` in `convertApplication` so the UI can display self-heal state.

## Testing Plan

### Unit tests
- `self_heal_test.go` in `internal/controller/pipelines/` tests:
  - cooldown math with a fake clock,
  - allowed/blocked phase guards,
  - `SyncPolicy: Manual` blocking auto-sync,
  - missing `OnFailure: rollback` blocking auto-revert.

### Envtest tests
- **Drift self-heal**: create an Application with `autoSyncOnDrift: true`, force a resource out of sync, assert `SelfHealed=DriftDetected` and the `paprika.io/resync` annotation is set.
- **Health self-heal**: create an Application with `spec.onFailure.action: rollback`, a health check that always fails, and `autoRevertOnHealthFailure: true`; assert the current Release gets the `paprika.io/rollback-requested` annotation.
- **Cooldown**: trigger self-heal, immediately force another condition, assert no second action occurs within cooldown.
- **Blocked phases**: verify self-heal does not act when phase is `Promoting` or `Canarying`.

## Generated Artifacts

Run after API and proto changes:

```bash
make generate manifests
make generate-proto   # or the project's proto generation target
```

This updates:

- `api/pipelines/v1alpha1/zz_generated.deepcopy.go`
- `config/crd/bases/pipelines.paprika.io_applications.yaml`
- `charts/chart/templates/crd/applications.pipelines.paprika.io.yaml`
- `config/rbac/role.yaml` (no new RBAC required; controller already owns Application resources)
- `proto/paprika/v1/api.proto`
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

## Open Questions

1. Should auto-revert also fire when `Health == Progressing` for too long? Out of scope for this iteration.
2. Should self-heal be configurable per stage? Out of scope; it is an Application-level setting for now.
