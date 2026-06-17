# Advanced Rollout Strategies Design

## Goal

Make Paprika’s progressive delivery comparable to Argo Rollouts by supporting:

- **A/B testing** — route traffic to stable or canary based on HTTP headers or cookies.
- **Blue/Green with preview service** — run the new version behind a preview service, then cut over to an active service.
- **Traffic mirroring** — send a percentage of live traffic to canary as a shadow stream.
- **Header-based routing** — general-purpose request matching for canary, A/B, and custom experiments.

These strategies build on the existing canary weight engine and traffic-router abstraction, but move the strategy lifecycle into a first-class `Rollout` resource so each strategy is explicit, observable, and independently controllable.

## Context

### What already exists

| Component | Relevant code | Status |
|---|---|---|
| Stage CRD with canary config | `api/pipelines/v1alpha1/stage_types.go` (`CanaryConfig`, `AnalysisConfig`, `TrafficRouter`) | ✅ |
| Weight-based traffic routing | `traffic/traffic.go`, `traffic/istio/istio.go`, `traffic/gatewayapi/gatewayapi.go` | ✅ |
| Release canary state machine | `internal/controller/pipelines/release_controller.go` (`reconcileCanary`, `applyTrafficWeight`, `promoteCanary`) | ✅ |
| Analysis checks | `analysis/analysis.go` (`AnalyzerImpl.RunChecks`) | ✅ |
| Multi-cluster apply | `internal/controller/pipelines/cluster.go`, `ClusterRef` in Stage/Application | ✅ |
| Rollout CRD YAML (stale) | `config/crd/bases/rollouts.paprika.io_rollouts.yaml` | ⚠️ generated, no Go types/controller |
| Rollout webhook/RBAC stubs | `config/webhook/manifests.yaml`, `config/rbac/role.yaml` | ⚠️ generated, no handlers |

### What is missing

- No `api/rollouts/v1alpha1` Go types or controller.
- `traffic.Router` only supports `SetWeight`/`RemoveCanary`; no header or mirror operations.
- The Release controller cannot express Blue/Green, A/B, or Mirror strategies.
- No API/UI surface for inspecting or controlling an active rollout.

This design introduces a `rollouts.paprika.io/v1alpha1.Rollout` CRD with a pluggable strategy engine. The Release controller delegates to the Rollout controller when a Stage declares a `rolloutStrategy`; the legacy `CanaryConfig` path remains untouched for backward compatibility.

## API Changes

### New API group: `rollouts.paprika.io/v1alpha1`

Create `api/rollouts/v1alpha1/groupversion_info.go` and `api/rollouts/v1alpha1/rollout_types.go`.

```go
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=ro
// +kubebuilder:printcolumn:name="Strategy",type=string,JSONPath=".spec.strategy.type"
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=".status.phase"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"
type Rollout struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`
    Spec              RolloutSpec   `json:"spec,omitempty"`
    Status            RolloutStatus `json:"status,omitempty"`
}

type RolloutSpec struct {
    Target          RolloutTarget                        `json:"target"`
    Strategy        RolloutStrategy                      `json:"strategy"`
    Template        corev1.PodTemplateSpec               `json:"template,omitempty"`
    Replicas        *int32                               `json:"replicas,omitempty"`
    RevisionHistoryLimit *int32                          `json:"revisionHistoryLimit,omitempty"`
    Paused          bool                                 `json:"paused,omitempty"`
    RollbackPolicy  *RollbackPolicy                      `json:"rollbackPolicy,omitempty"`
    TrafficRouter   *pipelinesv1alpha1.TrafficRouter     `json:"trafficRouter,omitempty"`
}

type RolloutTarget struct {
    // +kubebuilder:validation:Enum=Deployment;""
    // +optional
    Kind string `json:"kind,omitempty"`
    // +optional
    Name string `json:"name,omitempty"`
}

type RolloutStrategy struct {
    // +kubebuilder:validation:Enum=Rolling;Canary;BlueGreen;ABTest;Mirror
    Type      string              `json:"type"`
    Rolling   *RollingStrategy    `json:"rolling,omitempty"`
    Canary    *CanaryStrategy     `json:"canary,omitempty"`
    BlueGreen *BlueGreenStrategy  `json:"blueGreen,omitempty"`
    ABTest    *ABTestStrategy     `json:"abTest,omitempty"`
    Mirror    *MirrorStrategy     `json:"mirror,omitempty"`
}

type RolloutPhase string

const (
    RolloutPhasePending     RolloutPhase = "Pending"
    RolloutPhaseProgressing RolloutPhase = "Progressing"
    RolloutPhasePaused      RolloutPhase = "Paused"
    RolloutPhaseHealthy     RolloutPhase = "Healthy"
    RolloutPhaseDegraded    RolloutPhase = "Degraded"
    RolloutPhaseFailed      RolloutPhase = "Failed"
    RolloutPhaseRolledBack  RolloutPhase = "RolledBack"
)

type RolloutStatus struct {
    ObservedGeneration int64              `json:"observedGeneration,omitempty"`
    Phase              RolloutPhase       `json:"phase,omitempty"`
    Conditions         []metav1.Condition `json:"conditions,omitempty"`
    CurrentStepIndex   int32              `json:"currentStepIndex,omitempty"`
    CurrentStepWeight  int32              `json:"currentStepWeight,omitempty"`
    StableRS           string             `json:"stableRS,omitempty"`
    CanaryRS           string             `json:"canaryRS,omitempty"`
    ActiveService      string             `json:"activeService,omitempty"`
    PreviewService     string             `json:"previewService,omitempty"`
    Message            string             `json:"message,omitempty"`
}
```

Strategy types:

```go
type RollingStrategy struct {
    MaxUnavailable *intstr.IntOrString `json:"maxUnavailable,omitempty"`
    MaxSurge       *intstr.IntOrString `json:"maxSurge,omitempty"`
}

type CanaryStrategy struct {
    Steps         []CanaryStep     `json:"steps"`
    Analysis      *RolloutAnalysis `json:"analysis,omitempty"`
    StableService string           `json:"stableService,omitempty"`
    CanaryService string           `json:"canaryService,omitempty"`
}

type CanaryStep struct {
    SetWeight int32            `json:"setWeight"`
    Duration  *metav1.Duration `json:"duration,omitempty"`
    Analysis  *RolloutAnalysis `json:"analysis,omitempty"`
}

type BlueGreenStrategy struct {
    PreviewService        string           `json:"previewService,omitempty"`
    ActiveService         string           `json:"activeService"`
    AutoPromotionSeconds  *int32           `json:"autoPromotionSeconds,omitempty"`
    ScaleDownDelaySeconds *int32           `json:"scaleDownDelaySeconds,omitempty"`
    Analysis              *RolloutAnalysis `json:"analysis,omitempty"`
    PreviewReplicaCount   *int32           `json:"previewReplicaCount,omitempty"`
}

type ABTestStrategy struct {
    Routes        []ABTestRoute    `json:"routes"`
    StableService string           `json:"stableService,omitempty"`
    CanaryService string           `json:"canaryService,omitempty"`
    Analysis      *RolloutAnalysis `json:"analysis,omitempty"`
}

type ABTestRoute struct {
    Type    string `json:"type"`    // Header or Cookie
    Name    string `json:"name"`
    Value   string `json:"value"`
    Service string `json:"service"` // stable or canary
}

type MirrorStrategy struct {
    MirrorPercent int32            `json:"mirrorPercent"`
    StableService string           `json:"stableService,omitempty"`
    CanaryService string           `json:"canaryService,omitempty"`
    Duration      *metav1.Duration `json:"duration,omitempty"`
    Analysis      *RolloutAnalysis `json:"analysis,omitempty"`
}

type RolloutAnalysis struct {
    Checks          []pipelinesv1alpha1.AnalysisCheck `json:"checks,omitempty"`
    FailedThreshold *int32                            `json:"failedThreshold,omitempty"`
    SuccessThreshold *int32                           `json:"successThreshold,omitempty"`
    Interval        *metav1.Duration                  `json:"interval,omitempty"`
}

type RollbackPolicy struct {
    Auto       *bool  `json:"auto,omitempty"`
    MaxRetries *int32 `json:"maxRetries,omitempty"`
}
```

`AnalysisCheck` is reused from `api/pipelines/v1alpha1` to avoid duplicating the existing http/podMetrics schema.

### Stage / Application schema additions

Add a `RolloutStrategy` field to the Stage and Application promotion config:

```go
// In api/pipelines/v1alpha1/stage_types.go on StageSpec:
// RolloutStrategy is an advanced deployment strategy managed by the Rollout controller.
// Mutually exclusive with Canary.
// +optional
RolloutStrategy *rolloutsv1alpha1.RolloutStrategy `json:"rolloutStrategy,omitempty"`
```

```go
// In api/pipelines/v1alpha1/application_types.go on ApplicationPromotionStage:
// RolloutStrategy is an advanced deployment strategy for this stage.
// Mutually exclusive with Canary.
// +optional
RolloutStrategy *rolloutsv1alpha1.RolloutStrategy `json:"rolloutStrategy,omitempty"`
```

Add a `RolloutRef` to `ReleaseStatus` so the Release controller can track the child Rollout:

```go
// In api/pipelines/v1alpha1/release_types.go on ReleaseStatus:
// RolloutRef references the Rollout child when the stage uses an advanced strategy.
// +optional
RolloutRef string `json:"rolloutRef,omitempty"`
```

### Traffic router extension

Extend `traffic.Router` in `traffic/traffic.go`:

```go
var ErrNotSupported = errors.New("traffic provider does not support this operation")

type Router interface {
    SetWeight(ctx context.Context, weight int32) error
    RemoveCanary(ctx context.Context) error

    // Header/cookie routing for A/B tests.
    SetHeaderRoute(ctx context.Context, header, value, service string) error
    RemoveHeaderRoute(ctx context.Context, header string) error

    // Traffic mirroring.
    SetMirror(ctx context.Context, percent int32) error
    RemoveMirror(ctx context.Context) error

    Type() string
}
```

- **Istio** implements all methods via `VirtualService` patches.
- **Gateway API** implements `SetWeight`/`RemoveCanary`; `SetHeaderRoute`/`SetMirror` return `ErrNotSupported`. The Rollout controller surfaces a `HeaderRoutingNotSupported` condition instead of failing.

## Controller Behavior

### New package: `internal/rollout`

The strategy engine is stateless. All progression state lives in `RolloutStatus`.

```go
type Strategy interface {
    Type() string
    Sync(ctx context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus) (*SyncResult, error)
    Cleanup(ctx context.Context, ro *rolloutsv1alpha1.Rollout) error
}

type SyncResult struct {
    Phase       rolloutsv1alpha1.RolloutPhase
    Action      Action
    Message     string
    ReplicaSets []ReplicaSetAction
}

type Action string

const (
    ActionNone         Action = ""
    ActionCreateStable Action = "CreateStable"
    ActionPromote      Action = "Promote"
    ActionStep         Action = "Step"
    ActionPause        Action = "Pause"
    ActionRollback     Action = "Rollback"
    ActionComplete     Action = "Complete"
)
```

The factory in `internal/rollout/rollout.go` dispatches by `spec.strategy.type`:

```go
func NewStrategy(spec *rolloutsv1alpha1.RolloutStrategy) (Strategy, error) {
    switch spec.Type {
    case "Rolling":
        return rolling.NewStrategy(spec.Rolling), nil
    case "Canary":
        return canary.NewStrategy(spec.Canary), nil
    case "BlueGreen":
        return bluegreen.NewStrategy(spec.BlueGreen), nil
    case "ABTest":
        return abtest.NewStrategy(spec.ABTest), nil
    case "Mirror":
        return mirror.NewStrategy(spec.Mirror), nil
    default:
        return nil, fmt.Errorf("unknown strategy type: %s", spec.Type)
    }
}
```

### Rollout controller (`internal/controller/rollouts/rollout_controller.go`)

Reconciliation loop:

1. **Paused guard** — if `spec.paused`, set `status.phase = Paused` and return.
2. **Finalizer** — ensure finalizer; on deletion call `strategy.Cleanup` and remove traffic routes.
3. **Resolve target** —
   - `Kind == "Deployment"`: fetch the Deployment, copy its `spec.template` into the Rollout if `spec.template` is empty, scale the Deployment to 0, and adopt its ReplicaSet as the initial stable ReplicaSet by setting labels and owner references.
   - `Kind == ""`: use `spec.template` directly and create ReplicaSets named `<rollout>-<hash>`.
4. **Run strategy** — call `NewStrategy(...).Sync(...)`. The strategy returns desired `ReplicaSetAction`s (create/scale/delete) and an `Action`.
5. **Execute ReplicaSet actions** — apply create/scale/delete against the target cluster.
6. **Manage Services** — ensure stable/canary (or active/preview) Services exist with selectors pointing at the current stable/canary ReplicaSet labels. Services are owned by the Rollout.
7. **Configure traffic** — if `spec.trafficRouter` is set, call the appropriate `traffic.Router` methods for the strategy:
   - **Canary**: `SetWeight(stepWeight)` during progression, `RemoveCanary()` on completion.
   - **Blue/Green**: `SetWeight(100)` on active service cutover, `RemoveCanary()` after scale-down delay.
   - **A/B**: `SetHeaderRoute(...)` for each route, `RemoveHeaderRoute(...)` on cleanup.
   - **Mirror**: `SetMirror(percent)`, `RemoveMirror()` on cleanup.
8. **Run analysis** — when the strategy reports a step/pause with analysis, run checks via `analysis.Analyzer`. Failed checks increment a failure counter; when `failedThreshold` is reached, request rollback.
9. **Update status** — patch `RolloutStatus` with phase, step index, weight, ReplicaSet names, services, and conditions.

### Release controller integration

Modify `internal/controller/pipelines/release_controller.go`:

In `handlePromotingPhase`, after the initial manifests are applied and the Stage is fetched:

```go
if stage.Spec.RolloutStrategy != nil {
    return r.reconcileRolloutManagedRelease(ctx, release, stage, result)
}
// legacy canary/verify path remains unchanged
```

`reconcileRolloutManagedRelease`:

1. Create or update a child `Rollout` named `<release>-rollout` with owner reference to the Release and `spec.strategy` copied from the Stage.
2. Record `release.Status.RolloutRef`.
3. Map `RolloutStatus.Phase` to `ReleasePhase`:
   - `Pending`, `Progressing`, `Paused` → `ReleaseCanarying`
   - `Healthy` → `ReleaseVerifying`
   - `Degraded`/`Failed` → `ReleaseFailed`
   - `RolledBack` → `ReleaseRolledBack`
4. When Rollout reaches `Healthy`, run the Release’s verification gates (`release.Spec.Verify`) and then complete the Release.
5. When Rollout fails, honor `release.Spec.OnFailure` (rollback/halt/ignore) just like the existing path.

The Application controller needs no changes; it already maps `ReleasePhase` to `ApplicationPhase` in `handleActiveRelease`.

### Blue/Green flow

1. Strategy returns `ActionCreateStable` to create the active/stable ReplicaSet.
2. On template change it creates a preview/canary ReplicaSet.
3. It returns `ActionPause` with `Phase=Paused` while the preview service receives traffic.
4. On manual promotion (or after `autoPromotionSeconds`), it returns `ActionPromote`:
   - Switch the active Service selector to the preview ReplicaSet.
   - Optionally wait `scaleDownDelaySeconds`, then scale down the old stable ReplicaSet.
   - Call `traffic.Router.RemoveCanary()` if traffic routing was used.
5. Mark `Phase=Healthy`.

### A/B flow

1. Create stable and canary ReplicaSets.
2. For each `ABTestRoute`, call `SetHeaderRoute(header, value, service)`.
3. Non-matching traffic continues to the stable service.
4. Run analysis checks continuously or once per interval.
5. On promotion, call `RemoveHeaderRoute` for each route and scale canary to 100% (or swap selectors).

### Mirror flow

1. Create stable ReplicaSet at 100% desired replicas.
2. Create canary ReplicaSet at the configured preview/mirror replica count.
3. Call `SetMirror(percent)` so the stable service mirrors `percent` of requests to the canary service.
4. Hold for `duration` or until analysis passes.
5. On completion, remove the mirror and either promote the canary or leave it scaled down.

### Analysis integration

The Rollout controller reuses the existing `analysis.Analyzer` interface. Strategy-level `RolloutAnalysis` provides defaults; step-level `RolloutAnalysis` overrides them. The controller maintains a consecutive failure count in memory per reconcile (or in status) and triggers rollback when `failedThreshold` is reached. `rollbackPolicy.auto` controls whether rollback is automatic.

## Safety

- `RolloutStrategy` and `CanaryConfig` are mutually exclusive on a Stage; the webhook rejects specs that set both.
- `spec.paused` stops all progression but leaves traffic routing and ReplicaSets intact.
- Gateway API providers gracefully degrade A/B and Mirror by setting a `HeaderRoutingNotSupported` condition instead of failing the Rollout.
- Rollback uses the previous stable ReplicaSet snapshot; if none exists, the Rollout fails with `NoStableRevision`.
- Deployment adoption scales the Deployment to 0 and re-parents its ReplicaSets. This is a one-way cutover; users must delete the original Deployment manually after migration.

## Status Conditions

Introduce a `RolloutProgressing` condition type:

| Type | Status | Reason | Meaning |
|---|---|---|---|
| RolloutProgressing | True | StepProgressed | Moved to next canary/A/B/mirror step |
| RolloutProgressing | False | Paused | `spec.paused` is true |
| RolloutProgressing | False | Completed | Strategy reached Healthy |
| RolloutProgressing | False | RollbackInProgress | Rolling back to stable |
| RolloutProgressing | False | HeaderRoutingNotSupported | Provider cannot route by header |

## UI / API Impact

### Proto additions

Add to `proto/paprika/v1/api.proto`:

```protobuf
message Rollout {
  string name = 1;
  string namespace = 2;
  string strategy_type = 3;
  string phase = 4;
  int32 current_step = 5;
  int32 current_weight = 6;
  string stable_rs = 7;
  string canary_rs = 8;
  string active_service = 9;
  string preview_service = 10;
  int64 observed_generation = 11;
  repeated Condition conditions = 12;
  string message = 13;
  string target_kind = 14;
  string target_name = 15;
}

message ListRolloutsRequest { optional string namespace = 1; string project = 2; }
message ListRolloutsResponse { repeated Rollout rollouts = 1; }
message GetRolloutRequest { string namespace = 1; string name = 2; }
message GetRolloutResponse { Rollout rollout = 1; }
message PromoteRolloutRequest { string namespace = 1; string name = 2; }
message PromoteRolloutResponse { Rollout rollout = 1; }
message AbortRolloutRequest { string namespace = 1; string name = 2; }
message AbortRolloutResponse { Rollout rollout = 1; }
```

Add RPCs to `PaprikaService`:

```protobuf
rpc ListRollouts(ListRolloutsRequest) returns (ListRolloutsResponse);
rpc GetRollout(GetRolloutRequest) returns (GetRolloutResponse);
rpc PromoteRollout(PromoteRolloutRequest) returns (PromoteRolloutResponse);
rpc AbortRollout(AbortRolloutRequest) returns (AbortRolloutResponse);
```

### UI additions

- New dashboard section **Rollouts** (`ui/src/app/dashboard/rollouts/page.tsx`).
- Rollout detail page (`ui/src/app/dashboard/rollouts/detail/page.tsx`) showing strategy type, phase, current step/weight, ReplicaSets, services, traffic routes, and **Promote/Abort** buttons.
- Extend `ApplicationCard` to show an active rollout indicator when `application.releaseRef` points to a Release with a `RolloutRef`.

## Testing Plan

### Unit tests

- `internal/rollout/rolling/rolling_test.go` — stable ReplicaSet creation, template-change detection.
- `internal/rollout/canary/canary_test.go` — step progression, pause on duration, promotion.
- `internal/rollout/bluegreen/bluegreen_test.go` — preview→active promotion.
- `internal/rollout/abtest/abtest_test.go` — header/cookie route computation.
- `internal/rollout/mirror/mirror_test.go` — mirror percent validation.
- `traffic/istio/istio_test.go` — header route and mirror patches.
- `traffic/gatewayapi/gatewayapi_test.go` — `ErrNotSupported` for header/mirror.

### Envtest tests

- `internal/controller/rollouts/rollout_controller_test.go` — create Rollout, verify ReplicaSet/Service ownership, phase transitions.
- `internal/controller/pipelines/release_controller_rollout_test.go` — Release creates Rollout child and maps phases.
- Webhook tests for mutually exclusive `Canary`/`RolloutStrategy`.

### E2E tests

Add scenarios to `test/e2e/e2e_test.go`:

- Canary Rollout with Gateway API weight routing (no Istio required).
- Blue/Green Rollout with preview/active Services.
- A/B Rollout with Istio header routing (when Istio CRDs are present).
- Mirror Rollout with Istio traffic mirroring.

## Generated Artifacts

After API/proto changes:

```bash
make generate manifests
make generate-proto
```

This updates:

- `api/rollouts/v1alpha1/zz_generated.deepcopy.go`
- `config/crd/bases/rollouts.paprika.io_rollouts.yaml`
- `config/crd/bases/pipelines.paprika.io_stages.yaml`
- `config/crd/bases/pipelines.paprika.io_applications.yaml`
- `config/crd/bases/pipelines.paprika.io_releases.yaml`
- `config/rbac/role.yaml`
- `config/webhook/manifests.yaml`
- `proto/paprika/v1/api.proto`
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

The existing stale `config/crd/bases/rollouts.paprika.io_rollouts.yaml` will be regenerated from the new Go types; do not edit it by hand.

## Dependencies on Other Roadmap Items

- **Analysis Templates (P2 #9)** — the Rollout controller uses the same `AnalysisCheck` type today. When Analysis Templates land, Rollout analysis should reference `AnalysisTemplate` resources instead of inline checks.
- **Multi-Cluster Deployment (P1 #4)** — `RolloutSpec` should include a `ClusterRef` so advanced strategies can target remote clusters. Until then, Rollouts run in the Release namespace on the local cluster.
- **Self-Healing (P2 #12)** — auto-revert on a failed Rollout should reuse the self-heal cooldown and condition logic already added to the Application controller.
- **Notifications (P2 #10)** — Rollout phase-change events should be published to the event broker so notification triggers can fire on promotion, abort, and rollback.
- **Event-Driven Sync (P2 #7)** — git push webhooks should be able to trigger a new Release/Rollout for applications using rollout strategies.

## Risks

1. **Deployment adoption is invasive.** Scaling a user Deployment to 0 and re-parenting its ReplicaSets changes ownership semantics. Documentation and e2e migration tests are critical.
2. **Provider support matrix.** Gateway API cannot implement header/mirror until v1.2+ experimental features; users must choose Istio for A/B and Mirror.
3. **State explosion.** Five strategies × two providers × multi-cluster increases test surface. The strategy engine must stay stateless and well-unit-tested.
4. **CRD collision.** A stale `rollouts.paprika.io` CRD and webhook configuration already exist in `config/`. Regeneration may produce a different schema; verify diffs carefully.
5. **Release controller coupling.** Delegating to Rollout changes the Release lifecycle. The legacy `CanaryConfig` path must remain intact and covered by existing tests.

## Open Questions

1. Should `RolloutSpec` carry its own `ClusterRef`, or should it always inherit the Stage cluster?
2. Should A/B routes support regex/prefix matching, or only exact header/cookie values in v1?
3. Should Mirror strategy auto-promote to canary after observation, or only observe and tear down?
