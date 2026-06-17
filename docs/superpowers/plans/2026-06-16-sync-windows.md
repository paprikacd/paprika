# Sync Windows Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this plan.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cron-based sync windows to Paprika Applications so automatic sync
(source polling, release creation, and self-heal drift sync) only runs during
allowed maintenance windows. Manual sync via the API/UI bypasses windows.

**Architecture:** Extend the `Application` CRD with a `syncWindows` list. A new
`internal/syncwindow` evaluator parses cron schedules, durations, and timezones,
and returns `allowed`, a reason, and the next transition time. The Application
controller calls the evaluator in `handleHealthyPhase`, `reconcileRelease`, and
`reconcileSelfHeal`. A `paprika.io/manual-sync` annotation marks API/UI sync
requests and bypasses window checks. State is surfaced through a `SyncWindow`
`metav1.Condition`, which the UI can read from the existing `conditions` field.

**Tech Stack:** Go, Kubernetes controller-runtime, kubebuilder, Protocol Buffers
(buf), Ginkgo/Gomega, envtest, `github.com/robfig/cron/v3`.

---

## Chunk 1: API Schema

### Task 1: Add `SyncWindowKind` and `SyncWindow` types

**Files:**
- Modify: `api/pipelines/v1alpha1/application_types.go`

- [ ] **Step 1: Insert window types after `SelfHealConfig`**

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

- [ ] **Step 2: Add `SyncWindows` to `ApplicationSpec`**

Insert after `SelfHeal`:

```go
    // SyncWindows restrict when automatic sync may run.
    // +optional
    SyncWindows []SyncWindow `json:"syncWindows,omitempty"`
```

- [ ] **Step 3: Run `go fmt`**

```bash
go fmt ./api/pipelines/v1alpha1/...
```

### Task 2: Regenerate deepcopy and CRDs

- [ ] **Step 1: Run code generation**

```bash
make generate
```

Expected: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` gains
`DeepCopyInto` for `SyncWindow`.

- [ ] **Step 2: Run manifest generation**

```bash
make manifests
```

Expected changes:
- `config/crd/bases/pipelines.paprika.io_applications.yaml` gains
  `spec.syncWindows`.
- `config/rbac/role.yaml` should be unchanged.

### Task 3: Sync Helm chart CRD

- [ ] **Step 1: Regenerate Helm chart**

```bash
make helm-generate
```

- [ ] **Step 2: Verify the Helm CRD**

```bash
git diff -- charts/chart/templates/crd/applications.pipelines.paprika.io.yaml
```

Expected: new `syncWindows` fields appear.

---

## Chunk 2: Sync Window Evaluator

### Task 4: Add `github.com/robfig/cron/v3` dependency

- [ ] **Step 1: Add the dependency**

```bash
go get github.com/robfig/cron/v3
go mod tidy
```

### Task 5: Create the evaluator package

**Files:**
- Create: `internal/syncwindow/evaluator.go`
- Create: `internal/syncwindow/evaluator_test.go`

- [ ] **Step 1: Implement `internal/syncwindow/evaluator.go`**

```go
package syncwindow

import (
    "fmt"
    "time"

    "github.com/robfig/cron/v3"

    paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Evaluator decides whether a sync is currently allowed by the configured windows.
type Evaluator interface {
    IsSyncAllowed(windows []paprikav1.SyncWindow, stage string, now time.Time, manual bool) Result
}

// Result is the outcome of a sync-window evaluation.
type Result struct {
    Allowed        bool
    Reason         string
    NextTransition *time.Time
}

// NewEvaluator creates a default cron-based evaluator.
func NewEvaluator() Evaluator {
    return &evaluator{
        parser: cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow),
    }
}

type evaluator struct {
    parser cron.Parser
}

func (e *evaluator) IsSyncAllowed(windows []paprikav1.SyncWindow, stage string, now time.Time, manual bool) Result {
    if manual {
        return Result{Allowed: true, Reason: "Manual sync override"}
    }
    if len(windows) == 0 {
        return Result{Allowed: true, Reason: "No sync windows configured"}
    }

    var parsed []parsedWindow
    for i := range windows {
        w := &windows[i]
        if len(w.Stages) > 0 && !contains(w.Stages, stage) {
            continue
        }
        pw, err := e.parse(w)
        if err != nil {
            return Result{Allowed: false, Reason: fmt.Sprintf("invalid sync window %q: %v", w.Schedule, err)}
        }
        parsed = append(parsed, pw)
    }

    if len(parsed) == 0 {
        return Result{Allowed: true, Reason: "No sync windows apply to stage"}
    }

    hasAllow := false
    for _, w := range parsed {
        if w.kind == SyncWindowAllow {
            hasAllow = true
            break
        }
    }

    var nextAllow *time.Time
    for _, w := range parsed {
        active, start, end := w.activeAt(now)

        if w.kind == SyncWindowBlock && active {
            return Result{Allowed: false, Reason: fmt.Sprintf("blocked by window %s until %s", w.schedule, end.UTC().Format(time.RFC3339)), NextTransition: &end}
        }

        if w.kind == SyncWindowAllow {
            if active {
                return Result{Allowed: true, Reason: fmt.Sprintf("within allow window %s", w.schedule)}
            }
            if nextAllow == nil || start.Before(*nextAllow) {
                nextAllow = &start
            }
        }
    }

    if hasAllow {
        reason := "outside allow window"
        if nextAllow != nil {
            reason = fmt.Sprintf("outside allow window; next allow at %s", nextAllow.UTC().Format(time.RFC3339))
        }
        return Result{Allowed: false, Reason: reason, NextTransition: nextAllow}
    }

    return Result{Allowed: true, Reason: "No blocking window active"}
}

type parsedWindow struct {
    kind     paprikav1.SyncWindowKind
    schedule cron.Schedule
    duration time.Duration
    schedule string
}

func (e *evaluator) parse(w *paprikav1.SyncWindow) (parsedWindow, error) {
    loc := time.UTC
    if w.Timezone != "" {
        var err error
        loc, err = time.LoadLocation(w.Timezone)
        if err != nil {
            return parsedWindow{}, fmt.Errorf("timezone %q: %w", w.Timezone, err)
        }
    }
    schedule, err := e.parser.Parse(w.Schedule)
    if err != nil {
        return parsedWindow{}, fmt.Errorf("schedule %q: %w", w.Schedule, err)
    }
    d, err := time.ParseDuration(w.Duration)
    if err != nil {
        return parsedWindow{}, fmt.Errorf("duration %q: %w", w.Duration, err)
    }
    if d <= 0 {
        return parsedWindow{}, fmt.Errorf("duration must be positive")
    }
    return parsedWindow{
        kind:     w.Kind,
        schedule: cronScheduleInLoc(schedule, loc),
        duration: d,
        schedule: w.Schedule,
    }, nil
}

func (w parsedWindow) activeAt(now time.Time) (active bool, start, end time.Time) {
    loc := time.UTC
    if s, ok := w.schedule.(interface{ Location() *time.Location }); ok {
        loc = s.Location()
    }
    t := now.In(loc)

    lookback := 24*time.Hour + w.duration
    candidate := w.schedule.Next(t.Add(-lookback))
    for !candidate.After(t) {
        windowEnd := candidate.Add(w.duration)
        if !t.Before(candidate) && t.Before(windowEnd) {
            return true, candidate, windowEnd
        }
        next := w.schedule.Next(candidate)
        if !next.After(candidate) {
            break
        }
        candidate = next
    }

    nextStart := w.schedule.Next(t)
    return false, nextStart, nextStart.Add(w.duration)
}

func contains(items []string, v string) bool {
    for _, item := range items {
        if item == v {
            return true
        }
    }
    return false
}

func cronScheduleInLoc(s cron.Schedule, loc *time.Location) cron.Schedule {
    // robfig/cron Schedule already embeds location; the wrapper preserves it.
    return s
}
```

Note: if `cronScheduleInLoc` is not needed because the parser can be created
with `cron.WithLocation`, replace `parse` with a `cron.New` per-window to bind
location.

- [ ] **Step 2: Implement `internal/syncwindow/evaluator_test.go`**

Write table-driven tests covering:

- Empty windows allow.
- Manual override allows.
- Allow window active/inactive.
- Block window active/inactive.
- Allow + block overlap semantics.
- Stage filtering.
- Timezone handling.
- Invalid schedule/duration/timezone returns blocked.

Example starter:

```go
func TestEvaluator_IsSyncAllowed(t *testing.T) {
    fixed := time.Date(2026, 6, 16, 10, 0, 0, 0, time.UTC)
    e := NewEvaluator()

    tests := []struct {
        name    string
        windows []paprikav1.SyncWindow
        stage   string
        manual  bool
        allowed bool
    }{
        {
            name:    "empty allows",
            allowed: true,
        },
        {
            name: "active allow window",
            windows: []paprikav1.SyncWindow{{
                Kind:     paprikav1.SyncWindowAllow,
                Schedule: "0 9 * * MON-FRI",
                Duration: "8h",
            }},
            allowed: true,
        },
        {
            name: "inactive allow window",
            windows: []paprikav1.SyncWindow{{
                Kind:     paprikav1.SyncWindowAllow,
                Schedule: "0 18 * * MON-FRI",
                Duration: "8h",
            }},
            allowed: false,
        },
        {
            name: "active block window",
            windows: []paprikav1.SyncWindow{{
                Kind:     paprikav1.SyncWindowBlock,
                Schedule: "0 9 * * MON-FRI",
                Duration: "8h",
            }},
            allowed: false,
        },
    }

    for _, tc := range tests {
        t.Run(tc.name, func(t *testing.T) {
            res := e.IsSyncAllowed(tc.windows, tc.stage, fixed, tc.manual)
            if res.Allowed != tc.allowed {
                t.Fatalf("allowed: got %v, want %v (reason: %s)", res.Allowed, tc.allowed, res.Reason)
            }
        })
    }
}
```

- [ ] **Step 3: Run evaluator tests**

```bash
go test ./internal/syncwindow -v
```

Expected: all pass.

---

## Chunk 3: Controller Integration

### Task 6: Wire evaluator into `ApplicationReconciler`

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go`
- Modify: `internal/controller/pipelines/self_heal.go`
- Create: `internal/controller/pipelines/sync_window.go`
- Modify: `cmd/main.go`

- [ ] **Step 1: Import the syncwindow package in `application_controller.go`**

```go
import (
    ...
    "github.com/benebsworth/paprika/internal/syncwindow"
)
```

- [ ] **Step 2: Add the `SyncWindowEvaluator` field and `manualSyncAnnotation` constant**

In the reconciler struct:

```go
    // SyncWindowEvaluator decides whether automatic sync is allowed.
    SyncWindowEvaluator syncwindow.Evaluator
```

In the constants block:

```go
    manualSyncAnnotation = "paprika.io/manual-sync"
```

- [ ] **Step 3: Initialize the evaluator in `SetupWithManager`**

At the top of `SetupWithManager`:

```go
    if r.SyncWindowEvaluator == nil {
        r.SyncWindowEvaluator = syncwindow.NewEvaluator()
    }
```

- [ ] **Step 4: Create `internal/controller/pipelines/sync_window.go`**

```go
package controller

import (
    "context"
    "fmt"
    "time"

    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/api/meta"

    paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "github.com/benebsworth/paprika/internal/syncwindow"
)

func (r *ApplicationReconciler) syncWindowAllows(
    ctx context.Context,
    app *paprikav1.Application,
    stage string,
    manual bool,
) (bool, syncwindow.Result) {
    if r.SyncWindowEvaluator == nil {
        return true, syncwindow.Result{Allowed: true, Reason: "evaluator not configured"}
    }
    if stage == "" {
        stage = r.getTargetStage(app)
    }
    return r.SyncWindowEvaluator.IsSyncAllowed(app.Spec.SyncWindows, stage, r.currentTime(), manual)
}

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

- [ ] **Step 5: Modify `handleSyncTrigger` to preserve the manual-sync marker**

In `application_controller.go`, replace the annotation-removal block with:

```go
    patch := client.MergeFrom(app.DeepCopy())
    for _, key := range []string{syncAnnotation, resyncAnnotation, legacyWebhookTriggerAnnotation} {
        delete(app.Annotations, key)
    }
    if app.Annotations == nil {
        app.Annotations = map[string]string{}
    }
    app.Annotations[manualSyncAnnotation] = strconv.FormatInt(time.Now().Unix(), 10)
    if err := r.Patch(ctx, app, patch); err != nil {
        log.Error(err, "Failed to set manual sync annotation")
        return ctrl.Result{}, fmt.Errorf("setting manual sync annotation: %w", err)
    }
```

- [ ] **Step 6: Modify `handleHealthyPhase`**

After `sourceChanged` is detected:

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

        r.setSyncWindowCondition(app, metav1.ConditionTrue, "Allowed", "Source change within sync window")
        r.updatePhase(ctx, app, paprikav1.ApplicationPending, "SourceChanged", "source hash changed, re-syncing")
        return ctrl.Result{RequeueAfter: defaultRequeue}, nil
    }
```

- [ ] **Step 7: Modify `reconcileRelease` to check windows**

At the top of `reconcileRelease`:

```go
    manualOverride := app.Annotations[manualSyncAnnotation] != ""
```

Before the `app.Spec.SyncPolicy == paprikav1.SyncManual` check, add:

```go
    if !manualOverride && app.Spec.SyncPolicy == paprikav1.SyncAuto && len(app.Spec.SyncWindows) > 0 {
        targetStage := r.getTargetStage(app)
        if allowed, res := r.syncWindowAllows(ctx, app, targetStage, false); !allowed {
            r.updatePhase(ctx, app, paprikav1.ApplicationPending, "SyncWindowBlocked", res.Reason)
            r.setSyncWindowCondition(app, metav1.ConditionFalse, "Blocked", res.Reason)
            return ctrl.Result{RequeueAfter: r.syncWindowRequeueAfter(res.NextTransition)}, nil
        }
    }
```

At every exit point after this check, ensure the `manualSyncAnnotation` is
cleared when it was present. A named-result `err error` and a `defer` is the
simplest approach:

```go
    defer func() {
        if manualOverride {
            if perr := r.clearManualSyncAnnotation(ctx, app); perr != nil && err == nil {
                err = perr
            }
        }
    }()
```

Add `clearManualSyncAnnotation` to `sync_window.go`:

```go
func (r *ApplicationReconciler) clearManualSyncAnnotation(ctx context.Context, app *paprikav1.Application) error {
    if app.Annotations == nil {
        return nil
    }
    if _, ok := app.Annotations[manualSyncAnnotation]; !ok {
        return nil
    }
    patch := client.MergeFrom(app.DeepCopy())
    delete(app.Annotations, manualSyncAnnotation)
    if err := r.Patch(ctx, app, patch); err != nil {
        return fmt.Errorf("clearing manual sync annotation: %w", err)
    }
    return nil
}
```

- [ ] **Step 8: Modify `reconcileSelfHeal`**

In `internal/controller/pipelines/self_heal.go`, after the cooldown check and
before drift/health checks, add:

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

- [ ] **Step 9: Wire the evaluator in `cmd/main.go`**

In `setupApplicationController`, add:

```go
        SyncWindowEvaluator: syncwindow.NewEvaluator(),
```

Add the import:

```go
    "github.com/benebsworth/paprika/internal/syncwindow"
```

- [ ] **Step 10: Run `go fmt` and `go vet`**

```bash
go fmt ./...
go vet ./...
```

---

## Chunk 4: API Manual Sync Marker

### Task 7: Set the manual-sync annotation in `SyncApplication`

**Files:**
- Modify: `internal/api/server.go`

- [ ] **Step 1: Update `SyncApplication` to also set `paprika.io/manual-sync`**

In `internal/api/server.go`, after setting `app.Annotations["paprika.io/sync"]`, add:

```go
    app.Annotations["paprika.io/manual-sync"] = strconv.FormatInt(time.Now().UnixNano(), 10)
```

- [ ] **Step 2: Run `go fmt` and `go vet`**

---

## Chunk 5: UI

### Task 8: Show sync-window state on the dashboard

**Files:**
- Modify: `ui/src/components/dashboard/application-card.tsx`

- [ ] **Step 1: Add a sync-window badge helper**

```tsx
function SyncWindowBadge({ conditions }: { conditions?: Application["conditions"] }) {
  if (!conditions) return null
  const cond = conditions.find((c) => c.type === "SyncWindow")
  if (!cond || cond.status !== "False") return null
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-500 border border-amber-500/20">
      <Clock className="size-3" />
      Window blocked
    </span>
  )
}
```

- [ ] **Step 2: Render the badge in `ApplicationCard`**

Add `<SyncWindowBadge conditions={application.conditions} />` near the
`<StatusBadge />` row.

### Task 9: Show sync-window state on the application detail page

**Files:**
- Modify: `ui/src/app/dashboard/application/page.tsx`

- [ ] **Step 1: Add a conditions section**

Render the `SyncWindow` condition (if present) in a new card or row under the
source card, showing the reason and message.

- [ ] **Step 2: Verify TypeScript generation**

Because the proto is unchanged, run:

```bash
cd ui && npm run typecheck
```

If types are stale, regenerate the TypeScript clients:

```bash
make generate-proto
```

---

## Chunk 6: Controller Tests

### Task 10: Add envtest coverage

**Files:**
- Create: `internal/controller/pipelines/sync_window_envtest_test.go`

- [ ] **Step 1: Write Ginkgo envtest specs**

Cover:

1. Source change is blocked outside an allow window.
2. Auto Release creation is blocked outside an allow window.
3. Manual `SyncApplication` bypasses windows and creates a Release.
4. Self-heal drift sync is blocked by a block window.
5. Invalid window config sets `SyncWindow=Invalid`.
6. Requeue respects the next allow-window start.

Example skeleton:

```go
var _ = ginkgo.Describe("Application Controller Sync Windows", func() {
    ctx := context.Background()
    const appName = "sync-window-app"
    appKey := types.NamespacedName{Name: appName, Namespace: "default"}

    ginkgo.It("should block source change outside allow window", func() {
        app := &pipelinesv1alpha1.Application{
            ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
            Spec: pipelinesv1alpha1.ApplicationSpec{
                Source: pipelinesv1alpha1.ApplicationSource{
                    Type: "helm",
                    Chart: pipelinesv1alpha1.ChartRef{Path: "/charts/demo-app"},
                },
                Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
                SyncPolicy:  pipelinesv1alpha1.SyncAuto,
                SyncWindows: []paprikav1.SyncWindow{{
                    Kind:     paprikav1.SyncWindowAllow,
                    Schedule: "0 9 * * *",
                    Duration: "8h",
                }},
            },
        }
        gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())

        r := &ApplicationReconciler{
            Client: k8sClient,
            Scheme: k8sClient.Scheme(),
            now:    func() time.Time { return time.Date(2026, 6, 16, 20, 0, 0, 0, time.UTC) },
        }
        _, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: appKey})
        gomega.Expect(err).NotTo(gomega.HaveOccurred())

        var updated pipelinesv1alpha1.Application
        gomega.Expect(k8sClient.Get(ctx, appKey, &updated)).To(gomega.Succeed())
        cond := meta.FindStatusCondition(updated.Status.Conditions, "SyncWindow")
        gomega.Expect(cond).NotTo(gomega.BeNil())
        gomega.Expect(cond.Status).To(gomega.Equal(metav1.ConditionFalse))
        gomega.Expect(cond.Reason).To(gomega.Equal("Blocked"))
    })
})
```

- [ ] **Step 2: Run the envtest specs**

```bash
go test ./internal/controller/pipelines -run TestControllers -v
```

Expected: all sync-window specs pass.

### Task 11: Add focused unit tests for controller helpers

**Files:**
- Create: `internal/controller/pipelines/sync_window_test.go`

- [ ] **Step 1: Test `syncWindowRequeueAfter` edge cases**

- nil next ⇒ `defaultRequeue`.
- next in the past ⇒ 1s.
- next more than one hour away ⇒ 1h.
- next within one hour ⇒ exact duration.

---

## Chunk 7: Final Verification

### Task 12: Lint and full test suite

- [ ] **Step 1: Run linter**

```bash
make lint
```

Expected: no errors.

- [ ] **Step 2: Run unit/envtest suite**

```bash
make test
```

Expected: all tests pass.

### Task 13: Commit the implementation

- [ ] **Step 1: Commit**

```bash
git add -A
git commit -m "feat(pipelines): add Application sync windows

- Add SyncWindow CRD fields to Application spec
- Add internal/syncwindow cron evaluator with allow/block/timezone support
- Gate source-change, release-creation, and self-heal drift sync by windows
- Manual API/UI sync bypasses windows via paprika.io/manual-sync annotation
- Surface SyncWindow state through status conditions and UI badge"
```

---

## Notes for Implementers

- The design spec is at
  `/Users/benebsworth/projects/paprika/docs/superpowers/specs/2026-06-16-sync-windows-design.md`.
- Do not edit `config/crd/bases/*.yaml`, `config/rbac/role.yaml`,
  `**/zz_generated.*.go`, or `PROJECT` by hand; always regenerate via `make`.
- If a window has an invalid schedule or duration, the evaluator returns
  `Allowed=false`. The controller surfaces this as `SyncWindow=Invalid`.
- The `manualSyncAnnotation` is intentionally not included in
  `syncTriggerPresent` so it does not keep re-triggering `handleSyncTrigger`.
