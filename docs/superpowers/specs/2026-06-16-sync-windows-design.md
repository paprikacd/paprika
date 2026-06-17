# Sync Windows Design

## Goal

Add cron-based sync windows to Paprika Applications so that **automatic**
synchronization only happens during declared maintenance windows.

- **Allow windows**: permit auto-sync only while at least one allow window is
  active (when any allow window is configured).
- **Block windows**: always deny auto-sync while a block window is active.
- **Manual sync** triggered through the API/UI bypasses windows.
- **Self-healing auto-sync** on drift respects windows and does not fire outside
  an allowed window.
- Windows are scoped per-Application, with optional per-stage filters and IANA
  timezone support.

## Context

The following pieces already exist and are reused:

- `Application` CRD (`api/pipelines/v1alpha1/application_types.go`) already
  contains `SyncPolicy`, `SelfHeal`, `Stages`, and `Conditions`.
- The Application controller creates a new `Release` in
  `reconcileRelease` only when `SyncPolicy == Auto`.
- `handleHealthyPhase` polls the source and transitions the Application to
  `Pending` when the source hash changes.
- `reconcileSelfHeal` can annotate the current Release with
  `paprika.io/resync` when drift is detected.
- `SyncApplication` API sets the `paprika.io/sync` annotation, and
  `handleSyncTrigger` clears it and resets the phase to `Pending`.
- `metav1.Condition` values are already exposed to the UI through the proto
  `Condition` message and `convertConditions`.

This design adds a small `internal/syncwindow` evaluator package and wires it
into the existing Application reconciliation flow. No new CRD or RPC is needed
for the first iteration.

## API Changes

### `api/pipelines/v1alpha1/application_types.go`

Add the window types:

```go
// SyncWindowKind selects whether a window permits or denies sync.
// +kubebuilder:validation:Enum=Allow;Block
type SyncWindowKind string

const (
    SyncWindowAllow SyncWindowKind = "Allow"
    SyncWindowBlock SyncWindowKind = "Block"
)

// SyncWindow defines a cron-based time window that controls automatic sync.
type SyncWindow struct {
    // Kind is whether this window allows or blocks sync.
    // +kubebuilder:validation:Required
    Kind SyncWindowKind `json:"kind"`

    // Schedule is a standard 5-field cron expression:
    //   MIN HOUR DOM MONTH DOW
    // Example: "0 9 * * MON-FRI" for 09:00 on weekdays.
    // +kubebuilder:validation:Required
    Schedule string `json:"schedule"`

    // Duration is how long the window stays active after each scheduled start.
    // Parsed with time.ParseDuration, e.g. "8h".
    // +kubebuilder:validation:Required
    Duration string `json:"duration"`

    // Timezone is an IANA timezone name (e.g. "America/New_York"). Defaults to
    // UTC when empty.
    // +optional
    Timezone string `json:"timezone,omitempty"`

    // Stages limits the window to the named stages. Empty means all stages.
    // +optional
    Stages []string `json:"stages,omitempty"`
}
```

Add to `ApplicationSpec`:

```go
    // SyncWindows restrict when automatic sync may run.
    // +optional
    SyncWindows []SyncWindow `json:"syncWindows,omitempty"`
```

No new status fields are required; state is surfaced through a `SyncWindow`
condition.

## Controller Behavior

### Reconciler additions

Add to `ApplicationReconciler`:

```go
    // SyncWindowEvaluator decides whether the current time is inside an allowed
    // sync window. If nil, sync is always allowed.
    SyncWindowEvaluator syncwindow.Evaluator
```

Initialize a default evaluator in `SetupWithManager` if nil:

```go
    if r.SyncWindowEvaluator == nil {
        r.SyncWindowEvaluator = syncwindow.NewEvaluator()
    }
```

Add annotation constants in `application_controller.go`:

```go
    manualSyncAnnotation = "paprika.io/manual-sync"
```

### Where to hook

Introduce a helper in `internal/controller/pipelines/sync_window.go`:

```go
func (r *ApplicationReconciler) syncWindowAllows(
    ctx context.Context,
    app *paprikav1.Application,
    stage string,
    manual bool,
) (bool, syncwindow.Result)
```

It uses `r.SyncWindowEvaluator.IsSyncAllowed(app.Spec.SyncWindows, stage,
r.currentTime(), manual)`. The `stage` argument is the current target stage
name.

### Source-change path

In `handleHealthyPhase`, after detecting a source change, evaluate windows
before transitioning to `Pending`:

```go
if sourceChanged {
    targetStage := r.getTargetStage(app)
    if allowed, res := r.syncWindowAllows(ctx, app, targetStage, false); !allowed {
        msg := fmt.Sprintf("Source change detected but %s", res.Reason)
        log.Info(msg, "app", app.Name)
        r.setSyncWindowCondition(app, metav1.ConditionFalse, "Blocked", msg)
        if err := r.patchAppStatus(ctx, app); err != nil {
            log.Error(err, "Failed to patch sync-window status")
        }
        return ctrl.Result{RequeueAfter: r.syncWindowRequeueAfter(res.NextTransition)}, nil
    }

    r.setSyncWindowCondition(app, metav1.ConditionTrue, "Allowed",
        "Source change within sync window")
    r.updatePhase(ctx, app, paprikav1.ApplicationPending, "SourceChanged",
        "source hash changed, re-syncing")
    return ctrl.Result{RequeueAfter: defaultRequeue}, nil
}
```

### Release-creation path

In `reconcileRelease`, before building a new Release for auto sync, check
windows. A manual sync marker bypasses the check:

```go
manualOverride := app.Annotations[manualSyncAnnotation] != ""

if !manualOverride && app.Spec.SyncPolicy == paprikav1.SyncAuto && len(app.Spec.SyncWindows) > 0 {
    targetStage := r.getTargetStage(app)
    if allowed, res := r.syncWindowAllows(ctx, app, targetStage, false); !allowed {
        r.updatePhase(ctx, app, paprikav1.ApplicationPending, "SyncWindowBlocked", res.Reason)
        r.setSyncWindowCondition(app, metav1.ConditionFalse, "Blocked", res.Reason)
        return ctrl.Result{RequeueAfter: r.syncWindowRequeueAfter(res.NextTransition)}, nil
    }
}
```

After creating the Release, clear the `paprika.io/manual-sync` annotation if it
was present.

### Manual sync bypass

The API `SyncApplication` handler sets **both** `paprika.io/sync` and
`paprika.io/manual-sync` annotations. `handleSyncTrigger` removes the trigger
annotations but preserves `paprika.io/manual-sync`, then sets the phase to
`Pending`. On the next reconciliation, `reconcileRelease` sees the marker,
creates the Release regardless of windows, and clears the marker.

### Self-heal interaction

In `reconcileSelfHeal`, before evaluating drift or health, check windows:

```go
if r.SyncWindowEvaluator != nil {
    res := r.SyncWindowEvaluator.IsSyncAllowed(
        app.Spec.SyncWindows, r.getTargetStage(app), r.currentTime(), false)
    if !res.Allowed {
        r.setSelfHealCondition(app, metav1.ConditionFalse, "SyncWindowBlocked", res.Reason)
        r.setSyncWindowCondition(app, metav1.ConditionFalse, "Blocked", res.Reason)
        return nil
    }
}
```

This prevents drift-driven auto-sync outside a maintenance window while still
recording why no action was taken.

### Requeue timing

When blocked, the controller computes the next transition time from the
evaluator and requeues for that duration, capped at one hour:

```go
func (r *ApplicationReconciler) syncWindowRequeueAfter(next *time.Time) time.Duration {
    if next == nil {
        return defaultRequeue
    }
    d := next.Sub(r.currentTime())
    if d <= 0 {
        return 1 * time.Second
    }
    if d > time.Hour {
        return time.Hour
    }
    return d
}
```

## Sync Window Evaluator

Create package `internal/syncwindow`.

### Interface

```go
type Evaluator interface {
    IsSyncAllowed(
        windows []paprikav1.SyncWindow,
        stage string,
        now time.Time,
        manual bool,
    ) Result
}

type Result struct {
    Allowed        bool
    Reason         string
    NextTransition *time.Time
}
```

### Semantics

- `manual == true` ⇒ allowed (Reason: `Manual sync override`).
- Empty `windows` list ⇒ allowed.
- Windows whose `Stages` list is non-empty and does not contain the target
  stage are ignored.
- Invalid `Schedule` or `Duration` ⇒ blocked with Reason describing the parse
  error.
- If any active `Block` window matches ⇒ blocked, `NextTransition` is the end
  of that window.
- If any `Allow` windows exist and none are active ⇒ blocked, `NextTransition`
  is the next scheduled start of an allow window.
- Otherwise ⇒ allowed.

### Implementation notes

- Use `github.com/robfig/cron/v3` with a 5-field parser
  (`cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow`).
- Timezone default is UTC; load with `time.LoadLocation`.
- To determine whether a window is active at time `t`, look back at least
  `max(24h, duration)` from `t` and walk cron scheduled starts forward until
  passing `t`. This handles schedules where the window duration is longer than
  the cron interval.

## Safety

- Windows never abort an in-progress Release. They only gate the decision to
  start a new Release or to transition from `Healthy` to `Pending` on source
  change.
- Manual sync bypasses windows, keeping emergency operations possible.
- Invalid window configuration blocks auto-sync and surfaces a condition
  instead of silently failing.
- Requeue is capped so spec changes are not delayed indefinitely.

## Status Conditions

Introduce a new condition type:

| Type       | Status | Reason            | Meaning                                              |
|------------|--------|-------------------|------------------------------------------------------|
| SyncWindow | True   | Allowed           | Current time is inside an allowed sync window        |
| SyncWindow | False  | Blocked           | Outside allowed window or inside a block window      |
| SyncWindow | False  | Invalid           | Window config (cron/duration/timezone) is invalid    |

The condition helper:

```go
func (r *ApplicationReconciler) setSyncWindowCondition(
    app *paprikav1.Application,
    status metav1.ConditionStatus,
    reason, message string,
) {
    meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
        Type:               "SyncWindow",
        Status:             status,
        Reason:             reason,
        Message:            message,
        LastTransitionTime: metav1.Time{Time: r.currentTime()},
    })
}
```

## UI / API Impact

- No new proto messages or RPCs are required because `Application` already
  exposes `conditions`.
- `convertApplication` already maps all conditions, so the UI can inspect
  `conditions` for `Type == "SyncWindow"`.
- Add a small badge on `ApplicationCard` and the application detail page that
  shows when auto-sync is currently blocked by a window.
- The manual **Re-sync** button continues to call `SyncApplication`, which sets
  the manual-sync marker and therefore bypasses windows.

## Testing Plan

### Unit tests

`internal/syncwindow/evaluator_test.go` covers:

- Active/inactive `Allow` windows.
- Active/inactive `Block` windows.
- Mixed allow + block windows.
- Stage filtering.
- IANA timezone handling.
- Invalid cron schedule, invalid duration, invalid timezone.
- Manual override and empty windows list.

### Envtest tests

`internal/controller/pipelines/sync_window_envtest_test.go` covers:

- Source change outside an allow window keeps the Application in `Healthy` and
  sets `SyncWindow=Blocked`.
- Release creation outside an allow window is blocked and requeues.
- Manual `SyncApplication` bypasses windows and creates a Release.
- Self-heal drift sync is blocked by an active block window.
- Invalid window config sets `SyncWindow=Invalid` and blocks auto-sync.
- Requeue duration respects the next window transition.

## Generated Artifacts

After API changes:

```bash
make generate manifests
make helm-generate
```

This updates:

- `api/pipelines/v1alpha1/zz_generated.deepcopy.go`
- `config/crd/bases/pipelines.paprika.io_applications.yaml`
- `charts/chart/templates/crd/applications.pipelines.paprika.io.yaml`
- `go.mod` / `go.sum` after adding `github.com/robfig/cron/v3`

`config/rbac/role.yaml` does not require new rules because sync windows are
computed from the Application spec.

## Dependencies on Other P2 Items

- **Self-Healing**: the self-heal drift path must call the window evaluator so
  that drift-driven re-sync does not violate windows.
- **Event-Driven Sync** (not yet implemented): when webhooks trigger a sync,
  they should use the same `paprika.io/sync` annotation. Webhook-initiated
  syncs will therefore respect windows unless the receiver also sets the
  `paprika.io/manual-sync` marker.

## Open Questions

1. Should sync windows also be configurable at the `AppProject` level for
   multi-application policy? Out of scope for this iteration.
2. Should block windows also prevent self-heal rollback? This design blocks all
   self-heal actions while outside allowed windows, which is the conservative
   choice.
3. Should there be a metric for time-spent-blocked by windows? Deferred until
   observability needs are clearer.
