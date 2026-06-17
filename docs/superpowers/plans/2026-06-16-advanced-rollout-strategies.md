# Advanced Rollout Strategies Implementation Plan

> **For agentic workers:** REQUIRED: Use `superpowers:subagent-driven-development` (if subagents available) or `superpowers:executing-plans` to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add A/B testing, Blue/Green with preview service, traffic mirroring, and header-based routing to Paprika via a new `rollouts.paprika.io/v1alpha1.Rollout` CRD and strategy engine.

**Architecture:**
- New `api/rollouts/v1alpha1` API group with `Rollout`, `RolloutStrategy`, and strategy-specific config types.
- New `internal/rollout/` strategy engine with one package per strategy (`rolling`, `canary`, `bluegreen`, `abtest`, `mirror`).
- New `internal/controller/rollouts/rollout_controller.go` that manages ReplicaSets, Services, and traffic routing.
- Extend `traffic.Router` with header-route and mirror methods; implement them for Istio and return `ErrNotSupported` for Gateway API.
- Release controller delegates to the Rollout child when `Stage.Spec.RolloutStrategy` is set; legacy `CanaryConfig` path stays unchanged.
- API/UI additions for listing, inspecting, and controlling rollouts.

**Tech Stack:** Go, kubebuilder, controller-runtime, dynamic client, Istio/Gateway API, Protocol Buffers (buf), Ginkgo/Gomega, envtest.

**Spec:** `docs/superpowers/specs/2026-06-16-advanced-rollout-strategies-design.md`

---

## Chunk 1: API Schema

### Task 1: Scaffold the Rollouts API group

**Files:**
- Create: `api/rollouts/v1alpha1/groupversion_info.go`
- Create: `api/rollouts/v1alpha1/rollout_types.go`

- [ ] **Step 1: Create `api/rollouts/v1alpha1/groupversion_info.go`**

```go
// Package v1alpha1 contains API Schema definitions for the rollouts v1alpha1 API group.
// +kubebuilder:object:generate=true
// +groupName=rollouts.paprika.io
package v1alpha1

import (
    "k8s.io/apimachinery/pkg/runtime/schema"
    "sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
    SchemeGroupVersion = schema.GroupVersion{Group: "rollouts.paprika.io", Version: "v1alpha1"}
    SchemeBuilder      = &scheme.Builder{GroupVersion: SchemeGroupVersion}
    AddToScheme        = SchemeBuilder.AddToScheme
)
```

- [ ] **Step 2: Create `api/rollouts/v1alpha1/rollout_types.go`**

Use the full type definitions from the design spec (`Rollout`, `RolloutSpec`, `RolloutStrategy`, `RollingStrategy`, `CanaryStrategy`, `BlueGreenStrategy`, `ABTestStrategy`, `MirrorStrategy`, `RolloutAnalysis`, `RollbackPolicy`, `RolloutStatus`).

Key imports:

```go
import (
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/util/intstr"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)
```

Add `RolloutList`:

```go
// +kubebuilder:object:root=true
type RolloutList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []Rollout `json:"items"`
}

func init() {
    SchemeBuilder.Register(&Rollout{}, &RolloutList{})
}
```

- [ ] **Step 3: Register the new group in `cmd/main.go`**

Add under existing scheme registrations:

```go
import (
    rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

func init() {
    // ...existing registrations...
    utilruntime.Must(rolloutsv1alpha1.AddToScheme(scheme))
}
```

- [ ] **Step 4: Regenerate deepcopy and CRDs**

```bash
make generate
make manifests
```

Expected:
- `api/rollouts/v1alpha1/zz_generated.deepcopy.go` is created.
- `config/crd/bases/rollouts.paprika.io_rollouts.yaml` is regenerated (overwriting the stale version).

### Task 2: Add `RolloutStrategy` to Stage and Application promotion config

**Files:**
- Modify: `api/pipelines/v1alpha1/stage_types.go`
- Modify: `api/pipelines/v1alpha1/application_types.go`
- Modify: `api/pipelines/v1alpha1/release_types.go`

- [ ] **Step 1: Import the rollouts group in `stage_types.go` and `application_types.go`**

```go
import (
    rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)
```

- [ ] **Step 2: Add `RolloutStrategy` to `StageSpec`**

```go
// RolloutStrategy is an advanced deployment strategy managed by the Rollout controller.
// Mutually exclusive with Canary.
// +optional
RolloutStrategy *rolloutsv1alpha1.RolloutStrategy `json:"rolloutStrategy,omitempty"`
```

- [ ] **Step 3: Add `RolloutStrategy` to `ApplicationPromotionStage`**

```go
// RolloutStrategy is an advanced deployment strategy for this stage.
// Mutually exclusive with Canary.
// +optional
RolloutStrategy *rolloutsv1alpha1.RolloutStrategy `json:"rolloutStrategy,omitempty"`
```

- [ ] **Step 4: Add `RolloutRef` to `ReleaseStatus`**

```go
// RolloutRef references the Rollout child when the stage uses an advanced strategy.
// +optional
RolloutRef string `json:"rolloutRef,omitempty"`
```

- [ ] **Step 5: Regenerate deepcopy and CRDs**

```bash
make generate
make manifests
```

Expected:
- `config/crd/bases/pipelines.paprika.io_stages.yaml` gains `spec.rolloutStrategy`.
- `config/crd/bases/pipelines.paprika.io_applications.yaml` gains `spec.stages[].rolloutStrategy`.
- `config/crd/bases/pipelines.paprika.io_releases.yaml` gains `status.rolloutRef`.

---

## Chunk 2: Traffic Router Extension

### Task 3: Extend the `traffic.Router` interface

**Files:**
- Modify: `traffic/traffic.go`
- Modify: `traffic/mocks/mock_traffic.go` (regenerate)

- [ ] **Step 1: Add new methods and sentinel error**

```go
package traffic

import (
    "context"
    "errors"
)

var ErrNotSupported = errors.New("traffic provider does not support this operation")

type Router interface {
    SetWeight(ctx context.Context, weight int32) error
    RemoveCanary(ctx context.Context) error
    SetHeaderRoute(ctx context.Context, header, value, service string) error
    RemoveHeaderRoute(ctx context.Context, header string) error
    SetMirror(ctx context.Context, percent int32) error
    RemoveMirror(ctx context.Context) error
    Type() string
}
```

- [ ] **Step 2: Regenerate the mock**

```bash
cd traffic && go generate ./...
```

Verify `traffic/mocks/mock_traffic.go` contains the new methods.

### Task 4: Implement header/mirror for Istio

**Files:**
- Modify: `traffic/istio/istio.go`

- [ ] **Step 1: Add helper to read/write `match` blocks**

Implement:

```go
func (r *Router) SetHeaderRoute(ctx context.Context, header, value, service string) error
func (r *Router) RemoveHeaderRoute(ctx context.Context, header string) error
func (r *Router) SetMirror(ctx context.Context, percent int32) error
func (r *Router) RemoveMirror(ctx context.Context) error
```

Implementation notes:
- `SetHeaderRoute` inserts a `match` with `headers: {header: {exact: value}}` on the route and directs matched traffic to the destination whose host matches `<service>`. If no canary/stable destination exists for the service, add one.
- `SetMirror` adds `mirror: {host: <canarySvc>, port: {number: 80}}` and `mirrorPercentage: {value: percent}` to each matched route.
- Updates are applied via the dynamic client.

- [ ] **Step 2: Add unit tests in `traffic/istio/istio_test.go`**

Cover:
- Setting and removing a header route.
- Setting and removing a mirror.
- Multiple header routes on the same VirtualService.

### Task 5: Gateway API returns `ErrNotSupported`

**Files:**
- Modify: `traffic/gatewayapi/gatewayapi.go`

- [ ] **Step 1: Stub the new methods**

```go
func (r *Router) SetHeaderRoute(ctx context.Context, header, value, service string) error {
    return fmt.Errorf("gateway-api header routing: %w", traffic.ErrNotSupported)
}

func (r *Router) RemoveHeaderRoute(ctx context.Context, header string) error {
    return fmt.Errorf("gateway-api header routing: %w", traffic.ErrNotSupported)
}

func (r *Router) SetMirror(ctx context.Context, percent int32) error {
    return fmt.Errorf("gateway-api traffic mirroring: %w", traffic.ErrNotSupported)
}

func (r *Router) RemoveMirror(ctx context.Context) error {
    return fmt.Errorf("gateway-api traffic mirroring: %w", traffic.ErrNotSupported)
}
```

- [ ] **Step 2: Add unit tests verifying `ErrNotSupported`**

---

## Chunk 3: Strategy Engine + Core Strategies

### Task 6: Create the strategy interface and factory

**Files:**
- Create: `internal/rollout/rollout.go`

- [ ] **Step 1: Write interface, shared types, and factory**

```go
package rollout

import (
    "context"
    "fmt"

    corev1 "k8s.io/api/core/v1"
    rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

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

type ReplicaSetAction struct {
    Name     string
    Replicas int32
    Template corev1.PodTemplateSpec
    Labels   map[string]string
}

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

- [ ] **Step 2: Create `internal/rollout/templatehash.go`**

```go
package rollout

import (
    "crypto/sha256"
    "fmt"
    "sort"

    corev1 "k8s.io/api/core/v1"
)

func HashTemplate(tmpl corev1.PodTemplateSpec) string { ... }
func RevisionHash(name string) string { ... }
```

### Task 7: Implement Rolling, Canary, and BlueGreen strategies

**Files:**
- Create: `internal/rollout/rolling/rolling.go`
- Create: `internal/rollout/canary/canary.go`
- Create: `internal/rollout/bluegreen/bluegreen.go`
- Create unit tests for each.

- [ ] **Step 1: Implement Rolling strategy**

Create the initial stable ReplicaSet on first reconcile; on template change, replace it. Return `ActionComplete` when the stable ReplicaSet matches the desired template.

- [ ] **Step 2: Implement Canary strategy**

- Create stable ReplicaSet on first reconcile.
- On template change, create canary ReplicaSet.
- Progress through `spec.strategy.canary.steps`, returning `ActionStep`/`ActionPause`.
- When all steps complete, return `ActionPromote`.

- [ ] **Step 3: Implement BlueGreen strategy**

- Create active (stable) ReplicaSet on first reconcile.
- On template change, create preview (canary) ReplicaSet.
- Return `ActionPause` while waiting for promotion.
- On promotion, swap active Service selector, scale down old ReplicaSet after delay.

- [ ] **Step 4: Add unit tests**

Cover first reconcile, template changes, promotion, and pause conditions.

---

## Chunk 4: Advanced Strategies

### Task 8: Implement A/B strategy

**Files:**
- Create: `internal/rollout/abtest/abtest.go`
- Create: `internal/rollout/abtest/abtest_test.go`

- [ ] **Step 1: Implement ABTestStrategy.Sync**

- Create stable and canary ReplicaSets when the template differs from stable.
- Return `ActionPause` with a message listing active routes.
- On promotion, return `ActionPromote`.

- [ ] **Step 2: Add validation helpers**

Ensure `len(routes) > 0` and each route service is `stable` or `canary`.

- [ ] **Step 3: Add unit tests**

### Task 9: Implement Mirror strategy

**Files:**
- Create: `internal/rollout/mirror/mirror.go`
- Create: `internal/rollout/mirror/mirror_test.go`

- [ ] **Step 1: Implement MirrorStrategy.Sync**

- Create stable ReplicaSet at full desired replicas.
- Create canary ReplicaSet at the configured preview replica count.
- Return `ActionPause` while mirroring.
- On promotion or completion, return `ActionPromote` or `ActionComplete`.

- [ ] **Step 2: Validate `mirrorPercent` is between 1 and 100**

- [ ] **Step 3: Add unit tests**

---

## Chunk 5: Rollout Controller

### Task 10: Implement the Rollout reconciler

**Files:**
- Create: `internal/controller/rollouts/rollout_controller.go`
- Create: `internal/controller/rollouts/suite_test.go`
- Create: `internal/controller/rollouts/rollout_controller_test.go`
- Modify: `cmd/main.go`

- [ ] **Step 1: Add RBAC markers**

```go
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=replicasets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=networking.istio.io,resources=virtualservices,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;update;patch
```

- [ ] **Step 2: Implement reconciler structure**

```go
type RolloutReconciler struct {
    client.Client
    Scheme        *runtime.Scheme
    DynamicClient dynamic.Interface
    Analyzer      analysis.Analyzer
    EventRecorder record.EventRecorder
}
```

- [ ] **Step 3: Implement reconciliation loop**

Use the flow from the design spec:
1. Paused guard.
2. Finalizer.
3. Resolve/adopt target Deployment.
4. `NewStrategy(...).Sync(...)`.
5. Execute ReplicaSet actions.
6. Ensure Services.
7. Configure traffic router.
8. Run analysis checks.
9. Patch status.

- [ ] **Step 4: Wire into `cmd/main.go`**

In `setupOperatorControllers`, add:

```go
{"rollout", func() error { return setupRolloutController(mgr, k8sClient, operatorNamespace, c, shardFilter, rateLimiter, broker) }},
```

Add a `setupRolloutController` helper similar to `setupReleaseController`.

- [ ] **Step 5: Regenerate manifests for RBAC and webhooks**

```bash
make manifests
```

Expected: `config/rbac/role.yaml` gains apps/replicasets, services, deployments, and Istio/Gateway API permissions.

### Task 11: Add Rollout webhook validation/defaulting

**Files:**
- Create: `internal/webhook/rollouts/v1alpha1/rollout_webhook.go`
- Create: `internal/webhook/rollouts/v1alpha1/rollout_webhook_test.go`
- Modify: `cmd/main.go` setupWebhooks list

- [ ] **Step 1: Create validation webhook**

Validate:
- `spec.strategy.type` is one of `Rolling`, `Canary`, `BlueGreen`, `ABTest`, `Mirror`.
- The matching strategy config is non-nil and others are nil.
- `CanaryStrategy` has at least one step and all weights are 0–100.
- `BlueGreenStrategy` has `activeService`.
- `ABTestStrategy` has at least one route.
- `MirrorStrategy` has `mirrorPercent` between 1 and 100.
- `target.kind` is `Deployment` or empty.

- [ ] **Step 2: Add defaulting webhook**

Default `spec.replicas` to 1 if nil, `spec.revisionHistoryLimit` to 10 if nil, service names to `<rollout>-stable`/`<rollout>-canary`/`<rollout>-active`/`<rollout>-preview` when empty.

- [ ] **Step 3: Register webhook in `cmd/main.go`**

Add `"Rollout", webhookrollouts.SetupRolloutWebhookWithManager` to the webhooks slice.

- [ ] **Step 4: Regenerate webhook manifests**

```bash
make manifests
```

---

## Chunk 6: Release Controller Integration

### Task 12: Stage webhook mutual exclusion

**Files:**
- Modify: `internal/webhook/pipelines/v1alpha1/stage_webhook.go`

- [ ] **Step 1: Reject specs with both `Canary` and `RolloutStrategy`**

```go
if s.Spec.Canary != nil && s.Spec.RolloutStrategy != nil {
    allErrs = append(allErrs, field.Forbidden(specPath, "Canary and RolloutStrategy are mutually exclusive"))
}
```

### Task 13: Release controller delegates to Rollout

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: Add Rollout import and helper constants**

```go
import (
    rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)
```

- [ ] **Step 2: Hook Rollout delegation in `handlePromotingPhase`**

After `r.promote(ctx, release)` succeeds and the Stage is fetched, branch:

```go
if stage.Spec.RolloutStrategy != nil {
    return r.reconcileRolloutManagedRelease(ctx, release, &stage, result)
}
```

- [ ] **Step 3: Implement `reconcileRolloutManagedRelease`**

Create/update the child Rollout:

```go
rolloutName := release.Name + "-rollout"
expected := &rolloutsv1alpha1.Rollout{
    ObjectMeta: metav1.ObjectMeta{
        Name:      rolloutName,
        Namespace: release.Namespace,
        Labels:    release.Labels,
    },
    Spec: rolloutsv1alpha1.RolloutSpec{
        Target: rolloutsv1alpha1.RolloutTarget{
            Kind: "Deployment",
            Name: release.Name + "-deployment", // or from stage config
        },
        Strategy:      *stage.Spec.RolloutStrategy,
        TrafficRouter: stage.Spec.TrafficRouter,
    },
}
// set owner reference to Release
```

Map Rollout phase to Release phase and patch status.

- [ ] **Step 4: Add Rollout mapping to `handleActiveRelease` if needed**

`handleActiveRelease` already maps `ReleaseCanarying`, `ReleaseVerifying`, etc. to Application phases. No change required.

### Task 14: Rollout-aware release cleanup

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: In `cleanup`, also delete the child Rollout**

When a Release is deleted, list and delete any Rollout owned by it.

---

## Chunk 7: Proto / API / UI

### Task 15: Add Rollout messages and RPCs

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1: Add messages after the existing Release block**

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

- [ ] **Step 2: Add RPCs to `PaprikaService`**

```protobuf
rpc ListRollouts(ListRolloutsRequest) returns (ListRolloutsResponse);
rpc GetRollout(GetRolloutRequest) returns (GetRolloutResponse);
rpc PromoteRollout(PromoteRolloutRequest) returns (PromoteRolloutResponse);
rpc AbortRollout(AbortRolloutRequest) returns (AbortRolloutResponse);
```

- [ ] **Step 3: Regenerate protobuf clients**

```bash
make generate-proto
```

Expected updates:
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

### Task 16: Implement API handlers

**Files:**
- Modify: `internal/api/server.go`

- [ ] **Step 1: Add `ListRollouts`, `GetRollout`, `PromoteRollout`, `AbortRollout` handlers**

`PromoteRollout` adds/sets an annotation `paprika.io/promote` on the Rollout.
`AbortRollout` adds/sets an annotation `paprika.io/abort` on the Rollout.

- [ ] **Step 2: Add `convertRollout` helper**

```go
func convertRollout(r *rolloutsv1alpha1.Rollout) *paprikav1.Rollout { ... }
```

### Task 17: Build UI pages

**Files:**
- Create: `ui/src/app/dashboard/rollouts/page.tsx`
- Create: `ui/src/app/dashboard/rollouts/detail/page.tsx`
- Create: `ui/src/components/dashboard/rollout-card.tsx`
- Modify: `ui/src/app/dashboard/page.tsx` to load and display rollout counts

- [ ] **Step 1: Add Rollout list page**

Use the same pattern as the existing Applications section: fetch `client.listRollouts({})`, render cards.

- [ ] **Step 2: Add Rollout detail page**

Display:
- Strategy type badge.
- Phase via `StatusBadge`.
- Current step / weight.
- Stable and canary ReplicaSet names.
- Active/preview Services.
- Promote and Abort buttons calling the new RPCs.

- [ ] **Step 3: Update dashboard page**

Add a Rollouts stat card and section.

---

## Chunk 8: Testing

### Task 18: Unit tests

**Files:**
- Create/extend: `internal/rollout/*/*_test.go`
- Create/extend: `traffic/istio/istio_test.go`, `traffic/gatewayapi/gatewayapi_test.go`

- [ ] **Step 1: Run strategy unit tests**

```bash
go test ./internal/rollout/...
```

Expected: all pass.

- [ ] **Step 2: Run traffic router unit tests**

```bash
go test ./traffic/...
```

Expected: all pass.

### Task 19: Controller envtest

**Files:**
- Create: `internal/controller/rollouts/rollout_controller_test.go`
- Create/extend: `internal/controller/pipelines/release_controller_rollout_test.go`

- [ ] **Step 1: Write envtest specs**

- Rollout creates ReplicaSets and Services.
- Release creates a Rollout child when `Stage.Spec.RolloutStrategy` is set.
- Rollout failure maps to Release Failed.

- [ ] **Step 2: Run envtest suite**

```bash
go test ./internal/controller/rollouts -v
go test ./internal/controller/pipelines -run TestControllers -v
```

### Task 20: E2E tests

**Files:**
- Modify: `test/e2e/e2e_test.go`

- [ ] **Step 1: Add Blue/Green Rollout scenario**

Create an Application with a stage that sets `rolloutStrategy.type=BlueGreen` and `activeService`/`previewService`. Assert the Rollout reaches `Healthy` and the active Service selector switches.

- [ ] **Step 2: Add Canary Rollout scenario with Gateway API**

Use a Gateway API `HTTPRoute` and assert weights are patched.

- [ ] **Step 3: Add A/Mirror tests gated by Istio availability**

Skip unless the e2e cluster has Istio CRDs installed.

---

## Chunk 9: Final Verification and Documentation

### Task 21: Lint and full test suite

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

- [ ] **Step 3: Verify generated artifacts are committed**

```bash
git diff --stat
```

Ensure the following are updated:
- `api/rollouts/v1alpha1/`
- `internal/rollout/`
- `internal/controller/rollouts/`
- `traffic/`
- `internal/controller/pipelines/release_controller.go`
- `internal/api/server.go`
- `proto/paprika/v1/api.proto`
- `ui/src/`
- `config/crd/bases/rollouts.paprika.io_rollouts.yaml`
- `config/crd/bases/pipelines.paprika.io_*.yaml`
- `config/rbac/role.yaml`
- `config/webhook/manifests.yaml`

### Task 22: Documentation

- [ ] **Step 1: Add user-facing docs**

Create or update:
- `docs/guides/rollouts.md` — overview of each strategy.
- `docs/guides/canary.md` — update to mention Rollout-managed canary vs legacy `CanaryConfig`.
- `docs/api.md` — document new Rollout RPCs.

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat(rollouts): add advanced rollout strategies (A/B, Blue/Green, Mirror)

- Add rollouts.paprika.io/v1alpha1 Rollout CRD and strategy engine
- Implement Rolling, Canary, BlueGreen, ABTest, and Mirror strategies
- Extend traffic.Router with header and mirror operations
- Integrate Rollout controller with Release controller
- Add List/Get/Promote/Abort Rollout RPCs and UI pages
- Add unit, envtest, and e2e coverage"
```

---

## Notes for Implementers

- The design spec is at `/Users/benebsworth/projects/paprika/docs/superpowers/specs/2026-06-16-advanced-rollout-strategies-design.md`.
- Do not modify `config/crd/bases/*.yaml`, `config/rbac/role.yaml`, `config/webhook/manifests.yaml`, or `**/zz_generated.*.go` by hand; always regenerate via `make`.
- The existing `config/crd/bases/rollouts.paprika.io_rollouts.yaml` is stale and will be overwritten; verify the regenerated diff.
- Keep the legacy `CanaryConfig` path intact. Existing canary tests must continue to pass.
- Gateway API does not support header/mirror in v1; implement graceful degradation with `ErrNotSupported`.
