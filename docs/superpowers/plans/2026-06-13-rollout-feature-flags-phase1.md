# Phase 1: Rollout CRD + Strategy Engine + Controller

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the `rollouts.paprika.io/v1alpha1` API group, define the Rollout CRD with five strategy types, implement the strategy interface and three core strategies (Rolling, Canary, BlueGreen), and build the Rollout controller.

**Architecture:** New `rollouts.paprika.io/v1alpha1` API group follows multi-group layout. Strategy implementations live in `internal/rollout/` with one package per strategy. The controller manages ReplicaSets directly (not Deployments) and delegates per-strategy logic to the Strategy interface.

**Tech Stack:** Go, kubebuilder, controller-runtime, dynamic client, ReplicaSets, Istio/Gateway API (via traffic/ package)

**Spec:** `docs/superpowers/specs/2026-06-13-rollout-feature-flags-design.md`

---

## File Structure

### New files:
- `api/rollouts/v1alpha1/rollout_types.go` — Rollout CRD + all strategy types
- `api/rollouts/v1alpha1/groupversion_info.go` — GV registration
- `internal/rollout/rollout.go` — Strategy interface, factory, SyncResult, Action types
- `internal/rollout/rolling/rolling.go` — RollingStrategy implementation
- `internal/rollout/canary/canary.go` — CanaryStrategy implementation (uses traffic.Router)
- `internal/rollout/bluegreen/bluegreen.go` — BlueGreenStrategy implementation
- `internal/rollout/rolling/rolling_test.go` — unit tests
- `internal/rollout/canary/canary_test.go` — unit tests
- `internal/rollout/bluegreen/bluegreen_test.go` — unit tests
- `internal/rollout/rollout_test.go` — factory tests
- `internal/controller/rollouts/rollout_controller.go` — main reconciler
- `internal/controller/rollouts/suite_test.go` — envtest suite
- `internal/controller/rollouts/rollout_controller_test.go` — controller unit tests
- `internal/webhook/rollouts/v1alpha1/rollout_webhook.go` — validation + defaulting
- `internal/webhook/rollouts/v1alpha1/rollout_webhook_test.go` — webhook tests

### Modified files:
- `cmd/main.go` — wire Rollout controller manager + webhook
- `config/rbac/role.yaml` — via `make manifests`
- `config/crd/bases/` — via `make manifests`
- `config/webhook/manifests.yaml` — via `make manifests`

---

## Chunk 1: Scaffold API Group + CRD Types

**Files:**
- Create: `api/rollouts/v1alpha1/rollout_types.go`
- Create: `api/rollouts/v1alpha1/groupversion_info.go`
- Regenerate: `config/crd/bases/rollouts.paprika.io_rollouts.yaml`
- Regenerate: `api/rollouts/v1alpha1/zz_generated.deepcopy.go`

- [ ] **Step 1: Create groupversion_info.go**

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

	SchemeBuilder = &scheme.Builder{GroupVersion: SchemeGroupVersion}

	AddToScheme = SchemeBuilder.AddToScheme
)
```

- [ ] **Step 2: Create rollout_types.go with Rollout top-level type**

```go
package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

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
	Target     RolloutTarget       `json:"target"`
	Strategy   RolloutStrategy     `json:"strategy"`
	Template   corev1.PodTemplateSpec `json:"template"`
	Replicas   *int32              `json:"replicas,omitempty"`
	RevisionHistoryLimit *int32    `json:"revisionHistoryLimit,omitempty"`
	Paused     bool                `json:"paused,omitempty"`
	RollbackPolicy *RollbackPolicy `json:"rollbackPolicy,omitempty"`
	// +optional
	TrafficRouter *pipelinesv1alpha1.TrafficRouter `json:"trafficRouter,omitempty"`
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
	Type     string              `json:"type"`
	Rolling  *RollingStrategy    `json:"rolling,omitempty"`
	Canary   *CanaryStrategy     `json:"canary,omitempty"`
	BlueGreen *BlueGreenStrategy `json:"blueGreen,omitempty"`
	ABTest   *ABTestStrategy     `json:"abTest,omitempty"`
	Mirror   *MirrorStrategy     `json:"mirror,omitempty"`
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
	Phase              RolloutPhase       `json:"phase,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
	CurrentStepIndex   int32              `json:"currentStepIndex,omitempty"`
	CurrentStepWeight  int32              `json:"currentStepWeight,omitempty"`
	StableRS           string             `json:"stableRS,omitempty"`
	CanaryRS           string             `json:"canaryRS,omitempty"`
	ActiveService      string             `json:"activeService,omitempty"`
	PreviewService     string             `json:"previewService,omitempty"`
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	Message            string             `json:"message,omitempty"`
}
```

- [ ] **Step 3: Add strategy and supporting types to rollout_types.go**

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
	Type    string `json:"type"`    // Header, Cookie
	Name    string `json:"name"`
	Value   string `json:"value"`
	Service string `json:"service"` // stable, canary
}

type MirrorStrategy struct {
	MirrorPercent int32            `json:"mirrorPercent"`
	StableService string           `json:"stableService,omitempty"`
	CanaryService string           `json:"canaryService,omitempty"`
	Duration      *metav1.Duration `json:"duration,omitempty"`
	Analysis      *RolloutAnalysis `json:"analysis,omitempty"`
}

type RolloutAnalysis struct {
	Checks           []AnalysisCheck    `json:"checks,omitempty"`
	FailedThreshold  *int32             `json:"failedThreshold,omitempty"`
	SuccessThreshold *int32             `json:"successThreshold,omitempty"`
	Interval         *metav1.Duration   `json:"interval,omitempty"`
}

type AnalysisCheck struct {
	Provider   string                    `json:"provider"` // http, prometheus, job
	HTTP       *HTTPAnalysisCheck        `json:"http,omitempty"`
	Prometheus *PrometheusAnalysisCheck  `json:"prometheus,omitempty"`
	Job        *JobAnalysisCheck         `json:"job,omitempty"`
}

type HTTPAnalysisCheck struct {
	URL                string `json:"url"`
	Method             string `json:"method,omitempty"`
	ExpectedStatusCode int32  `json:"expectedStatusCode,omitempty"`
}

type PrometheusAnalysisCheck struct {
	Query     string          `json:"query"`
	Threshold string          `json:"threshold"` // e.g. ">0.99"
	Duration  metav1.Duration `json:"duration,omitempty"`
}

type JobAnalysisCheck struct {
	Image         string   `json:"image"`
	Command       []string `json:"command"`
	TimeoutSeconds int32   `json:"timeoutSeconds,omitempty"`
}

type RollbackPolicy struct {
	Auto       *bool  `json:"auto,omitempty"`
	MaxRetries *int32 `json:"maxRetries,omitempty"`
}
```

- [ ] **Step 4: Add +kubebuilder:object:root=true sentinel for list type**

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

- [ ] **Step 5: Resolve the TrafficRouter import**

Add at top of the file (or use the full type path):
```go
pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
```

- [ ] **Step 6: Regenerate deepcopy and CRDs**

```bash
make generate
make manifests
```

Verify the CRD YAML was created:
```bash
ls config/crd/bases/rollouts.paprika.io_rollouts.yaml
```

Expected: file exists with Rollout, RolloutList kinds.

- [ ] **Step 7: Verify build**

```bash
go build ./...
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add api/rollouts/ config/crd/bases/rollouts.paprika.io_rollouts.yaml
git commit -m "feat: scaffold rollouts.paprika.io/v1alpha1 API group with Rollout CRD types"
```

## Chunk 2: Strategy Interface + Factory

**Files:**
- Create: `internal/rollout/rollout.go`

- [ ] **Step 1: Write the strategy interface and shared types**

```go
package rollout

import (
	"context"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	corev1 "k8s.io/api/core/v1"
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
```

- [ ] **Step 2: Write the factory function**

```go
import (
	"fmt"
)

func NewStrategy(spec *rolloutsv1alpha1.RolloutStrategy) (Strategy, error) {
	switch spec.Type {
	case "Rolling":
		return rolling.NewStrategy(spec.Rolling), nil
	case "Canary":
		return canary.NewStrategy(spec.Canary), nil
	case "BlueGreen":
		return bluegreen.NewStrategy(spec.BlueGreen), nil
	case "ABTest":
		return nil, fmt.Errorf("ABTest strategy not implemented in Phase 1")
	case "Mirror":
		return nil, fmt.Errorf("Mirror strategy not implemented in Phase 1")
	default:
		return nil, fmt.Errorf("unknown strategy type: %s", spec.Type)
	}
}
```

- [ ] **Step 3: Verify build**

```bash
go build ./internal/rollout/...
```

Expected: compile error about missing packages (rolling, canary, bluegreen) — expected, we create them next.

- [ ] **Step 4: Commit**

```bash
git add internal/rollout/rollout.go
git commit -m "feat: add Strategy interface and factory"
```

## Chunk 3: Shared Template Hash Utility

**Files:**
- Create: `internal/rollout/templatehash.go`

- [ ] **Step 1: Extract shared hashTemplate to internal/rollout/templatehash.go**

```go
package rollout

import (
	"crypto/sha256"
	"fmt"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
)

// HashTemplate returns a deterministic 8-char hex hash of a PodTemplateSpec.
// Used by all strategies to produce consistent ReplicaSet revision names.
func HashTemplate(tmpl corev1.PodTemplateSpec) string {
	var fields []string
	for _, c := range tmpl.Spec.Containers {
		fields = append(fields, c.Name, c.Image)
		for _, e := range c.Env {
			fields = append(fields, e.Name)
			if e.Value != "" {
				fields = append(fields, e.Value)
			}
		}
	}
	for _, v := range tmpl.Spec.Volumes {
		fields = append(fields, v.Name)
	}
	sort.Strings(fields)
	h := sha256.Sum256([]byte(fmt.Sprintf("%v", fields)))
	return fmt.Sprintf("%x", h[:8])
}

// RevisionHash extracts the hash from a ReplicaSet name (last 8 chars after final "-").
// Returns empty string if the name has no dash suffix.
func RevisionHash(name string) string {
	if idx := strings.LastIndex(name, "-"); idx >= 0 && len(name) > idx+1 {
		return name[idx+1:]
	}
	return ""
}
```

- [ ] **Step 2: Verify build**

```bash
go build ./internal/rollout/...
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add internal/rollout/templatehash.go
git commit -m "feat: add shared HashTemplate utility for consistent ReplicaSet naming"
```

## Chunk 4: Rolling Strategy

**Files:**
- Create: `internal/rollout/rolling/rolling.go`

- [ ] **Step 1: Write RollingStrategy (using shared HashTemplate)**

```go
package rolling

import (
	"context"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout"
)

type RollingStrategy struct {
	config *rolloutsv1alpha1.RollingStrategy
}

func NewStrategy(cfg *rolloutsv1alpha1.RollingStrategy) *RollingStrategy {
	return &RollingStrategy{config: cfg}
}

func (s *RollingStrategy) Type() string { return "Rolling" }

func (s *RollingStrategy) Sync(ctx context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus) (*rollout.SyncResult, error) {
	replicas := int32(1)
	if ro.Spec.Replicas != nil {
		replicas = *ro.Spec.Replicas
	}

	if status.StableRS == "" {
		hash := rollout.HashTemplate(ro.Spec.Template)
		status.StableRS = ro.Name + "-" + hash
		return &rollout.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  rollout.ActionCreateStable,
			Message: "Creating initial ReplicaSet",
			ReplicaSets: []rollout.ReplicaSetAction{
				{
					Name:     status.StableRS,
					Replicas: replicas,
					Template: ro.Spec.Template,
					Labels: map[string]string{
						"rollouts.paprika.io/rollout": ro.Name,
						"rollouts.paprika.io/stable":  "true",
					},
				},
			},
		}, nil
	}

	currentHash := rollout.HashTemplate(ro.Spec.Template)
	if rollout.RevisionHash(status.StableRS) != currentHash {
		return &rollout.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  rollout.ActionCreateStable,
			Message: "Template changed, creating new ReplicaSet",
			ReplicaSets: []rollout.ReplicaSetAction{
				{
					Name:     ro.Name + "-" + currentHash,
					Replicas: replicas,
					Template: ro.Spec.Template,
					Labels: map[string]string{
						"rollouts.paprika.io/rollout": ro.Name,
						"rollouts.paprika.io/stable":  "true",
					},
				},
			},
		}, nil
	}

	return &rollout.SyncResult{
		Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
		Action:  rollout.ActionComplete,
		Message: "Rollout is healthy",
	}, nil
}

func (s *RollingStrategy) Cleanup(ctx context.Context, ro *rolloutsv1alpha1.Rollout) error {
	return nil
}
```

- [ ] **Step 2: Verify build**

```bash
go build ./internal/rollout/...
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add internal/rollout/rolling/rolling.go
git commit -m "feat: implement Rolling strategy using shared HashTemplate"
```

## Chunk 5: Canary Strategy

**Files:**
- Create: `internal/rollout/canary/canary.go`

- [ ] **Step 1: Write CanaryStrategy**

```go
package canary

import (
	"context"
	"fmt"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout"
	"github.com/benebsworth/paprika/traffic"
)

type CanaryStrategy struct {
	config  *rolloutsv1alpha1.CanaryStrategy
	traffic traffic.Router
}

func NewStrategy(cfg *rolloutsv1alpha1.CanaryStrategy) *CanaryStrategy {
	return &CanaryStrategy{config: cfg}
}

// SetTrafficRouter injects the traffic router after construction.
// Called by the controller at reconcile time, not at strategy construction.
func (s *CanaryStrategy) SetTrafficRouter(tr traffic.Router) {
	s.traffic = tr
}

func (s *CanaryStrategy) Type() string { return "Canary" }

func (s *CanaryStrategy) Sync(ctx context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus) (*rollout.SyncResult, error) {
	replicas := int32(1)
	if ro.Spec.Replicas != nil {
		replicas = *ro.Spec.Replicas
	}

	steps := s.config.Steps
	stepIndex := int(status.CurrentStepIndex)
	weight := int(status.CurrentStepWeight)

	if status.StableRS == "" {
		hash := rollout.HashTemplate(ro.Spec.Template)
		status.StableRS = ro.Name + "-" + hash
		status.CurrentStepIndex = 0
		return &rollout.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  rollout.ActionCreateStable,
			Message: "Created stable ReplicaSet, waiting for progression",
			ReplicaSets: []rollout.ReplicaSetAction{
				{
					Name:     status.StableRS,
					Replicas: replicas,
					Template: ro.Spec.Template,
					Labels: map[string]string{
						"rollouts.paprika.io/rollout": ro.Name,
						"rollouts.paprika.io/stable":  "true",
					},
				},
			},
		}, nil
	}

	if status.CanaryRS == "" {
		hash := rollout.HashTemplate(ro.Spec.Template)
		if rollout.RevisionHash(status.StableRS) == hash {
			return &rollout.SyncResult{
				Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
				Action:  rollout.ActionComplete,
				Message: "No template change, rollout is healthy",
			}, nil
		}
		status.CanaryRS = ro.Name + "-" + hash
		status.CurrentStepIndex = 0
		return &rollout.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  rollout.ActionCreateStable,
			Message: "Created canary ReplicaSet",
			ReplicaSets: []rollout.ReplicaSetAction{
				{
					Name:     status.CanaryRS,
					Replicas: 1,
					Template: ro.Spec.Template,
					Labels: map[string]string{
						"rollouts.paprika.io/rollout": ro.Name,
						"rollouts.paprika.io/canary":  "true",
					},
				},
			},
		}, nil
	}

	if stepIndex >= len(steps) {
		return s.promote(ctx, ro, status)
	}

	step := steps[stepIndex]
	weight = step.SetWeight

	if s.traffic != nil {
		if err := s.traffic.SetWeight(ctx, weight); err != nil {
			return nil, fmt.Errorf("failed to set traffic weight: %w", err)
		}
	}

	if step.Duration != nil && step.Duration.Duration > 0 {
		if status.CurrentStepWeight != int32(weight) {
			status.CurrentStepWeight = int32(weight)
			return &rollout.SyncResult{
				Action:  rollout.ActionStep,
				Message: fmt.Sprintf("Step %d: set weight to %d", stepIndex, weight),
			}, nil
		}
		return &rollout.SyncResult{
			Action:  rollout.ActionStep,
			Message: fmt.Sprintf("Step %d: waiting for duration", stepIndex),
		}, nil
	}

	status.CurrentStepWeight = int32(weight)
	return &rollout.SyncResult{
		Action:  rollout.ActionPause,
		Phase:   rolloutsv1alpha1.RolloutPhasePaused,
		Message: fmt.Sprintf("Step %d: paused at weight %d, waiting for manual promotion", stepIndex, weight),
	}, nil
}

func (s *CanaryStrategy) promote(ctx context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus) (*rollout.SyncResult, error) {
	if s.traffic != nil {
		if err := s.traffic.SetWeight(ctx, 100); err != nil {
			return nil, fmt.Errorf("failed to set traffic to stable during promote: %w", err)
		}
	}
	return &rollout.SyncResult{
		Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
		Action:  rollout.ActionPromote,
		Message: "Canary promoted to stable",
	}, nil
}

func (s *CanaryStrategy) Cleanup(ctx context.Context, ro *rolloutsv1alpha1.Rollout) error {
	if s.traffic != nil {
		return s.traffic.RemoveCanary(ctx)
	}
	return nil
}
```

- [ ] **Step 3: Verify build**

```bash
go build ./internal/rollout/...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add internal/rollout/canary/canary.go
git commit -m "feat: implement Canary strategy with traffic weight progression"
```

## Chunk 6: BlueGreen Strategy

**Files:**
- Create: `internal/rollout/bluegreen/bluegreen.go`

- [ ] **Step 1: Write BlueGreenStrategy (using shared HashTemplate)**

```go
package bluegreen

import (
	"context"
	"fmt"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout"
)

type BlueGreenStrategy struct {
	config *rolloutsv1alpha1.BlueGreenStrategy
}

func NewStrategy(cfg *rolloutsv1alpha1.BlueGreenStrategy) *BlueGreenStrategy {
	return &BlueGreenStrategy{config: cfg}
}

func (s *BlueGreenStrategy) Type() string { return "BlueGreen" }

func (s *BlueGreenStrategy) Sync(ctx context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus) (*rollout.SyncResult, error) {
	replicas := int32(1)
	if ro.Spec.Replicas != nil {
		replicas = *ro.Spec.Replicas
	}

	previewReplicas := replicas
	if s.config.PreviewReplicaCount != nil {
		previewReplicas = *s.config.PreviewReplicaCount
	}

	activeSvc := s.config.ActiveService
	if activeSvc == "" {
		activeSvc = ro.Name + "-active"
	}
	previewSvc := s.config.PreviewService
	if previewSvc == "" {
		previewSvc = ro.Name + "-preview"
	}

	status.ActiveService = activeSvc
	status.PreviewService = previewSvc

	if status.StableRS == "" {
		hash := rollout.HashTemplate(ro.Spec.Template)
		status.StableRS = ro.Name + "-" + hash
		return &rollout.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  rollout.ActionCreateStable,
			Message: "Created active ReplicaSet",
			ReplicaSets: []rollout.ReplicaSetAction{
				{
					Name:     status.StableRS,
					Replicas: replicas,
					Template: ro.Spec.Template,
					Labels: map[string]string{
						"rollouts.paprika.io/rollout": ro.Name,
						"rollouts.paprika.io/stable":  "true",
					},
				},
			},
		}, nil
	}

	if status.CanaryRS == "" {
		hash := rollout.HashTemplate(ro.Spec.Template)
		if rollout.RevisionHash(status.StableRS) == hash {
			return &rollout.SyncResult{
				Phase:   rolloutsv1alpha1.RolloutPhaseHealthy,
				Action:  rollout.ActionComplete,
				Message: "No template change, rollout is healthy",
			}, nil
		}
		status.CanaryRS = ro.Name + "-" + hash
		return &rollout.SyncResult{
			Phase:   rolloutsv1alpha1.RolloutPhaseProgressing,
			Action:  rollout.ActionCreateStable,
			Message: "Created preview ReplicaSet",
			ReplicaSets: []rollout.ReplicaSetAction{
				{
					Name:     status.CanaryRS,
					Replicas: previewReplicas,
					Template: ro.Spec.Template,
					Labels: map[string]string{
						"rollouts.paprika.io/rollout": ro.Name,
						"rollouts.paprika.io/canary":  "true",
					},
				},
			},
		}, nil
	}

	return &rollout.SyncResult{
		Action:  rollout.ActionPause,
		Phase:   rolloutsv1alpha1.RolloutPhasePaused,
		Message: fmt.Sprintf("Preview ready. Active service: %s, Preview service: %s", activeSvc, previewSvc),
	}, nil
}

func (s *BlueGreenStrategy) Cleanup(ctx context.Context, ro *rolloutsv1alpha1.Rollout) error {
	return nil
}
```

- [ ] **Step 3: Verify build**

```bash
go build ./internal/rollout/...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add internal/rollout/bluegreen/bluegreen.go
git commit -m "feat: implement BlueGreen strategy with preview/active services"
```

## Chunk 7: Shared Test Utilities + Strategy Unit Tests

**Files:**
- Create: `internal/rollout/testutil.go`
- Create: `internal/rollout/rolling/rolling_test.go`
- Create: `internal/rollout/canary/canary_test.go`
- Create: `internal/rollout/bluegreen/bluegreen_test.go`
- Create: `internal/rollout/rollout_test.go`

- [ ] **Step 1: Create shared test utility**

```go
package rollout

// Ptr returns a pointer to a copy of v. Used in tests across all strategy packages.
func Ptr[T any](v T) *T {
	return &v
}
```

- [ ] **Step 2: Write rolling strategy test**

```go
package rolling_test

import (
	"context"
	"testing"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout"
	"github.com/benebsworth/paprika/internal/rollout/rolling"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestRollingStrategy_FirstReconcile_CreateStable(t *testing.T) {
	s := rolling.NewStrategy(&rolloutsv1alpha1.RollingStrategy{})
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test-rollout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: rollout.Ptr[int32](3),
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "app", Image: "nginx:latest"}},
				},
			},
		},
	}
	status := &rolloutsv1alpha1.RolloutStatus{}

	result, err := s.Sync(context.Background(), ro, status)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Action != "CreateStable" {
		t.Errorf("expected Action CreateStable, got %s", result.Action)
	}
	if len(result.ReplicaSets) != 1 {
		t.Fatalf("expected 1 ReplicaSetAction, got %d", len(result.ReplicaSets))
	}
	if result.ReplicaSets[0].Replicas != 3 {
		t.Errorf("expected 3 replicas, got %d", result.ReplicaSets[0].Replicas)
	}
}

func TestRollingStrategy_NoTemplateChange_Healthy(t *testing.T) {
	s := rolling.NewStrategy(&rolloutsv1alpha1.RollingStrategy{})
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test-rollout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: rollout.Ptr[int32](3),
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "app", Image: "nginx:latest"}},
				},
			},
		},
	}
	status := &rolloutsv1alpha1.RolloutStatus{
		StableRS: "test-rollout-abc12345",
	}

	result, err := s.Sync(context.Background(), ro, status)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Action != "Complete" {
		t.Errorf("expected Action Complete, got %s", result.Action)
	}
	if result.Phase != rolloutsv1alpha1.RolloutPhaseHealthy {
		t.Errorf("expected Phase Healthy, got %s", result.Phase)
	}
}
```

- [ ] **Step 3: Write canary strategy test**

```go
package canary_test

import (
	"context"
	"testing"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout"
	"github.com/benebsworth/paprika/internal/rollout/canary"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestCanaryStrategy_FirstReconcile_CreateStable(t *testing.T) {
	s := canary.NewStrategy(&rolloutsv1alpha1.CanaryStrategy{
		Steps: []rolloutsv1alpha1.CanaryStep{
			{SetWeight: 10, Duration: &metav1.Duration{Duration: 30}},
		},
	})
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test-rollout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: rollout.Ptr[int32](5),
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "app", Image: "nginx:latest"}},
				},
			},
		},
	}
	status := &rolloutsv1alpha1.RolloutStatus{}

	result, err := s.Sync(context.Background(), ro, status)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Action != "CreateStable" {
		t.Errorf("expected Action CreateStable, got %s", result.Action)
	}
}

func TestCanaryStrategy_TemplateChange_CreateCanary(t *testing.T) {
	s := canary.NewStrategy(&rolloutsv1alpha1.CanaryStrategy{
		Steps: []rolloutsv1alpha1.CanaryStep{
			{SetWeight: 10},
		},
	})
	status := &rolloutsv1alpha1.RolloutStatus{
		StableRS: "test-rollout-oldhash123",
	}
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test-rollout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: rollout.Ptr[int32](5),
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "app", Image: "nginx:1.25.0"}},
				},
			},
		},
	}

	result, err := s.Sync(context.Background(), ro, status)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status.CanaryRS == "" {
		t.Error("expected CanaryRS to be set")
	}
	if len(result.ReplicaSets) != 1 {
		t.Fatalf("expected 1 ReplicaSetAction, got %d", len(result.ReplicaSets))
	}
}

func TestCanaryStrategy_PromoteAfterAllSteps(t *testing.T) {
	s := canary.NewStrategy(&rolloutsv1alpha1.CanaryStrategy{
		Steps: []rolloutsv1alpha1.CanaryStep{
			{SetWeight: 50, Duration: &metav1.Duration{Duration: 10}},
			{SetWeight: 100, Duration: &metav1.Duration{Duration: 10}},
		},
	})
	status := &rolloutsv1alpha1.RolloutStatus{
		StableRS:         "test-rollout-oldhash123",
		CanaryRS:         "test-rollout-newhash456",
		CurrentStepIndex: 2,
	}
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test-rollout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "app", Image: "nginx:latest"}},
				},
			},
		},
	}

	result, err := s.Sync(context.Background(), ro, status)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Action != "Promote" {
		t.Errorf("expected Action Promote after all steps, got %s", result.Action)
	}
}
```

- [ ] **Step 4: Write bluegreen strategy test**

```go
package bluegreen_test

import (
	"context"
	"testing"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout"
	"github.com/benebsworth/paprika/internal/rollout/bluegreen"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestBlueGreenStrategy_FirstReconcile_CreateActive(t *testing.T) {
	s := bluegreen.NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{
		ActiveService: "myapp-active",
	})
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test-rollout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: rollout.Ptr[int32](3),
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "app", Image: "nginx:latest"}},
				},
			},
		},
	}
	status := &rolloutsv1alpha1.RolloutStatus{}

	result, err := s.Sync(context.Background(), ro, status)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.Action != "CreateStable" {
		t.Errorf("expected Action CreateStable, got %s", result.Action)
	}
	if status.ActiveService != "myapp-active" {
		t.Errorf("expected ActiveService myapp-active, got %s", status.ActiveService)
	}
}

func TestBlueGreenStrategy_TemplateChange_CreatePreview(t *testing.T) {
	s := bluegreen.NewStrategy(&rolloutsv1alpha1.BlueGreenStrategy{
		ActiveService: "myapp-active",
	})
	status := &rolloutsv1alpha1.RolloutStatus{
		StableRS: "test-rollout-oldhash123",
	}
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test-rollout"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Replicas: rollout.Ptr[int32](3),
			Template: corev1.PodTemplateSpec{
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{{Name: "app", Image: "nginx:1.25.0"}},
				},
			},
		},
	}

	result, err := s.Sync(context.Background(), ro, status)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if status.CanaryRS == "" {
		t.Error("expected CanaryRS to be set for preview")
	}
	if len(result.ReplicaSets) != 1 {
		t.Fatalf("expected 1 ReplicaSetAction, got %d", len(result.ReplicaSets))
	}
}
```

- [ ] **Step 5: Write factory test**

```go
package rollout_test

import (
	"testing"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout"
)

func TestNewStrategy_Factory(t *testing.T) {
	tests := []struct {
		name    string
		spec    *rolloutsv1alpha1.RolloutStrategy
		wantErr bool
	}{
		{"rolling", &rolloutsv1alpha1.RolloutStrategy{Type: "Rolling"}, false},
		{"canary", &rolloutsv1alpha1.RolloutStrategy{Type: "Canary"}, false},
		{"bluegreen", &rolloutsv1alpha1.RolloutStrategy{Type: "BlueGreen"}, false},
		{"abtest", &rolloutsv1alpha1.RolloutStrategy{Type: "ABTest"}, true},
		{"mirror", &rolloutsv1alpha1.RolloutStrategy{Type: "Mirror"}, true},
		{"unknown", &rolloutsv1alpha1.RolloutStrategy{Type: "Unknown"}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := rollout.NewStrategy(tt.spec)
			if (err != nil) != tt.wantErr {
				t.Errorf("NewStrategy() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}
```

- [ ] **Step 6: Run tests**

```bash
go test ./internal/rollout/... -v -count=1
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add internal/rollout/testutil.go internal/rollout/rolling/rolling_test.go internal/rollout/canary/canary_test.go internal/rollout/bluegreen/bluegreen_test.go internal/rollout/rollout_test.go
git commit -m "test: add testutil.Ptr and strategy unit tests for rolling, canary, bluegreen, and factory"
```

## Chunk 8: Rollout Controller

**Files:**
- Create: `internal/controller/rollouts/rollout_controller.go`
- Create: `internal/controller/rollouts/suite_test.go`

- [ ] **Step 1: Write the Rollout reconciler**

```go
package rollouts

import (
	"context"
	"fmt"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"github.com/benebsworth/paprika/internal/rollout"
	"github.com/benebsworth/paprika/internal/rollout/canary"
	"github.com/benebsworth/paprika/traffic"
)

// RolloutReconciler reconciles Rollout resources.
type RolloutReconciler struct {
	client.Client
	Scheme        *runtime.Scheme
	Recorder      record.EventRecorder
	DynamicClient dynamic.Interface
}

// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=replicasets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=networking.istio.io,resources=virtualservices,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=gateway.networking.k8s.io,resources=httproutes,verbs=get;list;watch;update;patch

func (r *RolloutReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)
	log.Info("Starting reconciliation")

	var ro rolloutsv1alpha1.Rollout
	if err := r.Get(ctx, req.NamespacedName, &ro); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	// Handle paused state
	if ro.Spec.Paused {
		if ro.Status.Phase != rolloutsv1alpha1.RolloutPhasePaused {
			ro.Status.Phase = rolloutsv1alpha1.RolloutPhasePaused
			if err := r.Status().Update(ctx, &ro); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{}, nil
	}

	// Handle deletion
	if !ro.DeletionTimestamp.IsZero() {
		return r.finalize(ctx, &ro)
	}

	// Instantiate strategy
	strategy, err := rollout.NewStrategy(&ro.Spec.Strategy)
	if err != nil {
		log.Error(err, "Failed to instantiate strategy")
		return ctrl.Result{}, err
	}

	// Inject traffic router for canary strategy when TrafficRouter is configured
	if canaryStrategy, ok := strategy.(*canary.CanaryStrategy); ok && ro.Spec.TrafficRouter != nil {
		tr, err := traffic.NewRouter(ro.Spec.TrafficRouter, r.DynamicClient, "", "", ro.Namespace)
		if err != nil {
			log.Error(err, "Failed to create traffic router")
			return ctrl.Result{}, err
		}
		canaryStrategy.SetTrafficRouter(tr)
	}

	// Run strategy sync
	status := ro.Status.DeepCopy()
	result, err := strategy.Sync(ctx, &ro, status)
	if err != nil {
		log.Error(err, "Strategy sync failed")
		r.Recorder.Event(&ro, "Warning", "StrategySyncFailed", err.Error())
		return ctrl.Result{}, err
	}

	// Execute actions
	if err := r.executeActions(ctx, &ro, status, result); err != nil {
		log.Error(err, "Failed to execute rollout actions")
		return ctrl.Result{}, err
	}

	// Update status
	patch := client.MergeFrom(&ro)
	ro.Status = *status
	if result.Phase != "" {
		ro.Status.Phase = result.Phase
	}
	if result.Message != "" {
		ro.Status.Message = result.Message
	}
	ro.Status.ObservedGeneration = ro.Generation

	if err := r.Status().Patch(ctx, &ro, patch); err != nil {
		log.Error(err, "Failed to patch rollout status")
		return ctrl.Result{}, err
	}

	log.Info("Reconciliation complete", "phase", ro.Status.Phase, "action", result.Action)
	return ctrl.Result{}, nil
}

func (r *RolloutReconciler) executeActions(ctx context.Context, ro *rolloutsv1alpha1.Rollout, status *rolloutsv1alpha1.RolloutStatus, result *rollout.SyncResult) error {
	for _, rsAction := range result.ReplicaSets {
		if err := r.reconcileReplicaSet(ctx, ro, &rsAction); err != nil {
			return fmt.Errorf("failed to reconcile ReplicaSet %s: %w", rsAction.Name, err)
		}
	}

	// Manage services for canary/bluegreen
	if ro.Spec.Strategy.Canary != nil {
		if err := r.reconcileService(ctx, ro, ro.Spec.Strategy.Canary.StableService, "stable"); err != nil {
			return err
		}
		if err := r.reconcileService(ctx, ro, ro.Spec.Strategy.Canary.CanaryService, "canary"); err != nil {
			return err
		}
	}
	if ro.Spec.Strategy.BlueGreen != nil {
		if err := r.reconcileService(ctx, ro, ro.Spec.Strategy.BlueGreen.ActiveService, "stable"); err != nil {
			return err
		}
		if err := r.reconcileService(ctx, ro, ro.Spec.Strategy.BlueGreen.PreviewService, "canary"); err != nil {
			return err
		}
	}

	return nil
}

func (r *RolloutReconciler) finalize(ctx context.Context, ro *rolloutsv1alpha1.Rollout) (ctrl.Result, error) {
	strategy, err := rollout.NewStrategy(&ro.Spec.Strategy)
	if err != nil {
		return ctrl.Result{}, err
	}
	if err := strategy.Cleanup(ctx, ro); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

func (r *RolloutReconciler) reconcileReplicaSet(ctx context.Context, ro *rolloutsv1alpha1.Rollout, action *rollout.ReplicaSetAction) error {
	var rs appsv1.ReplicaSet
	err := r.Get(ctx, types.NamespacedName{Name: action.Name, Namespace: ro.Namespace}, &rs)
	if err != nil && !errors.IsNotFound(err) {
		return err
	}

	labels := action.Labels
	if labels == nil {
		labels = make(map[string]string)
	}
	labels["app.kubernetes.io/name"] = ro.Name
	if labels["rollouts.paprika.io/rollout"] == "" {
		labels["rollouts.paprika.io/rollout"] = ro.Name
	}

	selectorLabels := map[string]string{
		"rollouts.paprika.io/rollout": ro.Name,
	}
	if action.Labels["rollouts.paprika.io/stable"] == "true" {
		selectorLabels["rollouts.paprika.io/stable"] = "true"
	}
	if action.Labels["rollouts.paprika.io/canary"] == "true" {
		selectorLabels["rollouts.paprika.io/canary"] = "true"
	}

	desiredRS := &appsv1.ReplicaSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      action.Name,
			Namespace: ro.Namespace,
			Labels:    labels,
		},
		Spec: appsv1.ReplicaSetSpec{
			Replicas: &action.Replicas,
			Selector: &metav1.LabelSelector{MatchLabels: selectorLabels},
			Template: action.Template,
		},
	}

	if err := controllerutil.SetControllerReference(ro, desiredRS, r.Scheme); err != nil {
		return fmt.Errorf("failed to set owner reference: %w", err)
	}

	if errors.IsNotFound(err) {
		r.Recorder.Eventf(ro, "Normal", "CreateReplicaSet", "Creating ReplicaSet %s with %d replicas", action.Name, action.Replicas)
		return r.Create(ctx, desiredRS)
	}

	// Scale existing ReplicaSet
	rs.Spec.Replicas = &action.Replicas
	if err := r.Update(ctx, &rs); err != nil {
		return fmt.Errorf("failed to update ReplicaSet replicas: %w", err)
	}
	r.Recorder.Eventf(ro, "Normal", "ScaleReplicaSet", "Scaled ReplicaSet %s to %d replicas", action.Name, action.Replicas)
	return nil
}

func (r *RolloutReconciler) reconcileService(ctx context.Context, ro *rolloutsv1alpha1.Rollout, serviceName, selectorRole string) error {
	if serviceName == "" {
		serviceName = ro.Name + "-" + selectorRole
	}

	var svc corev1.Service
	err := r.Get(ctx, types.NamespacedName{Name: serviceName, Namespace: ro.Namespace}, &svc)
	if err != nil && !errors.IsNotFound(err) {
		return err
	}

	desiredSvc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      serviceName,
			Namespace: ro.Namespace,
			Labels: map[string]string{
				"rollouts.paprika.io/rollout": ro.Name,
				"rollouts.paprika.io/role":    selectorRole,
			},
		},
		Spec: corev1.ServiceSpec{
			Selector: map[string]string{
				"rollouts.paprika.io/rollout":                        ro.Name,
				"rollouts.paprika.io/" + selectorRole:                "true",
			},
			Ports: []corev1.ServicePort{
				{Name: "http", Port: 80, TargetPort: intstr.FromInt(80)},
			},
		},
	}

	if err := controllerutil.SetControllerReference(ro, desiredSvc, r.Scheme); err != nil {
		return fmt.Errorf("failed to set owner reference: %w", err)
	}

	if errors.IsNotFound(err) {
		r.Recorder.Eventf(ro, "Normal", "CreateService", "Creating Service %s for %s role", serviceName, selectorRole)
		return r.Create(ctx, desiredSvc)
	}

	// Update selector on existing service
	svc.Spec.Selector = desiredSvc.Spec.Selector
	return r.Update(ctx, &svc)
}

func (r *RolloutReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&rolloutsv1alpha1.Rollout{}).
		Owns(&appsv1.ReplicaSet{}).
		Complete(r)
}
```

- [ ] **Step 2: Write the controller test suite**

```go
package rollouts

import (
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
)

var testEnv *envtest.Environment

func TestRolloutController(t *testing.T) {
	RegisterFailHandler(Fail)
	RunSpecs(t, "Rollout Controller Suite")
}

var _ = BeforeSuite(func() {
	Expect(rolloutsv1alpha1.AddToScheme(scheme.Scheme)).To(Succeed())

	testEnv = &envtest.Environment{
		CRDDirectoryPaths: []string{
			"../../../config/crd/bases",
		},
	}

	cfg, err := testEnv.Start()
	Expect(err).NotTo(HaveOccurred())
	Expect(cfg).NotTo(BeNil())
})

var _ = AfterSuite(func() {
	Expect(testEnv.Stop()).To(Succeed())
})
```

- [ ] **Step 3: Verify build**

```bash
go build ./internal/controller/rollouts/...
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add internal/controller/rollouts/
git commit -m "feat: add Rollout controller with strategy dispatch and ReplicaSet/Service management"
```

## Chunk 9: Rollout Validation Webhook

**Files:**
- Create: `internal/webhook/rollouts/v1alpha1/rollout_webhook.go`
- Create: `internal/webhook/rollouts/v1alpha1/rollout_webhook_test.go`

- [ ] **Step 1: Implement the webhook using CustomDefaulter/CustomValidator**

```go
package v1alpha1

import (
	"context"
	"fmt"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/webhook"
	"sigs.k8s.io/controller-runtime/pkg/webhook/admission"
)

// log is for logging in this package.
var rolloutlog = logf.Log.WithName("rollout-webhook")

// RolloutCustomDefaulter implements webhook.CustomDefaulter for Rollout.
type RolloutCustomDefaulter struct{}

// +kubebuilder:webhook:path=/mutate-rollouts-paprika-io-v1alpha1-rollout,mutating=true,failurePolicy=fail,sideEffects=None,groups=rollouts.paprika.io,resources=rollouts,verbs=create;update,versions=v1alpha1,name=mrollout.kb.io,admissionReviewVersions=v1

var _ webhook.CustomDefaulter = &RolloutCustomDefaulter{}

func (d *RolloutCustomDefaulter) Default(ctx context.Context, obj runtime.Object) error {
	ro, ok := obj.(*rolloutsv1alpha1.Rollout)
	if !ok {
		return fmt.Errorf("expected Rollout object, got %T", obj)
	}
	rolloutlog.Info("defaulting", "name", ro.Name)

	if ro.Spec.Replicas == nil {
		one := int32(1)
		ro.Spec.Replicas = &one
	}
	if ro.Spec.RevisionHistoryLimit == nil {
		ten := int32(10)
		ro.Spec.RevisionHistoryLimit = &ten
	}
	return nil
}

// RolloutCustomValidator implements webhook.CustomValidator for Rollout.
type RolloutCustomValidator struct{}

// +kubebuilder:webhook:path=/validate-rollouts-paprika-io-v1alpha1-rollout,mutating=false,failurePolicy=fail,sideEffects=None,groups=rollouts.paprika.io,resources=rollouts,verbs=create;update,versions=v1alpha1,name=vrollout.kb.io,admissionReviewVersions=v1

var _ webhook.CustomValidator = &RolloutCustomValidator{}

func (v *RolloutCustomValidator) ValidateCreate(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
	ro, ok := obj.(*rolloutsv1alpha1.Rollout)
	if !ok {
		return nil, fmt.Errorf("expected Rollout object, got %T", obj)
	}
	return nil, v.validateRollout(ro)
}

func (v *RolloutCustomValidator) ValidateUpdate(ctx context.Context, oldObj, newObj runtime.Object) (admission.Warnings, error) {
	ro, ok := newObj.(*rolloutsv1alpha1.Rollout)
	if !ok {
		return nil, fmt.Errorf("expected Rollout object, got %T", newObj)
	}
	return nil, v.validateRollout(ro)
}

func (v *RolloutCustomValidator) ValidateDelete(ctx context.Context, obj runtime.Object) (admission.Warnings, error) {
	return nil, nil
}

func (v *RolloutCustomValidator) validateRollout(ro *rolloutsv1alpha1.Rollout) error {
	switch ro.Spec.Strategy.Type {
	case "Rolling", "Canary", "BlueGreen", "ABTest", "Mirror":
		// valid
	default:
		return fmt.Errorf("strategy.type must be one of: Rolling, Canary, BlueGreen, ABTest, Mirror")
	}

	if ro.Spec.Strategy.Canary != nil {
		if len(ro.Spec.Strategy.Canary.Steps) == 0 {
			return fmt.Errorf("canary strategy requires at least one step")
		}
		for i, step := range ro.Spec.Strategy.Canary.Steps {
			if step.SetWeight < 0 || step.SetWeight > 100 {
				return fmt.Errorf("canary step %d: setWeight must be 0-100", i)
			}
		}
	}

	if ro.Spec.Strategy.ABTest != nil && len(ro.Spec.Strategy.ABTest.Routes) == 0 {
		return fmt.Errorf("abTest strategy requires at least one route")
	}

	if ro.Spec.Strategy.Mirror != nil {
		if ro.Spec.Strategy.Mirror.MirrorPercent < 1 || ro.Spec.Strategy.Mirror.MirrorPercent > 100 {
			return fmt.Errorf("mirror.mirrorPercent must be 1-100")
		}
	}

	if ro.Spec.Target.Kind != "Deployment" && ro.Spec.Target.Kind != "" {
		return fmt.Errorf("target.kind must be Deployment or empty")
	}

	return nil
}
```

Add to the same file, a setup helper:
```go
func SetupRolloutWebhookWithManager(mgr ctrl.Manager) error {
	return ctrl.NewWebhookManagedBy(mgr).
		For(&rolloutsv1alpha1.Rollout{}).
		WithDefaulter(&RolloutCustomDefaulter{}).
		WithValidator(&RolloutCustomValidator{}).
		Complete()
}
```

- [ ] **Step 2: Write webhook tests**

```go
package v1alpha1

import (
	"context"
	"testing"

	rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestValidateRollout_ValidTypes(t *testing.T) {
	validator := &RolloutCustomValidator{}
	tests := []struct {
		name string
		ro   *rolloutsv1alpha1.Rollout
	}{
		{"rolling", &rolloutsv1alpha1.Rollout{
			ObjectMeta: metav1.ObjectMeta{Name: "test"},
			Spec: rolloutsv1alpha1.RolloutSpec{
				Strategy: rolloutsv1alpha1.RolloutStrategy{Type: "Rolling"},
			},
		}},
		{"canary", &rolloutsv1alpha1.Rollout{
			ObjectMeta: metav1.ObjectMeta{Name: "test"},
			Spec: rolloutsv1alpha1.RolloutSpec{
				Strategy: rolloutsv1alpha1.RolloutStrategy{
					Type: "Canary",
					Canary: &rolloutsv1alpha1.CanaryStrategy{
						Steps: []rolloutsv1alpha1.CanaryStep{{SetWeight: 50}},
					},
				},
			},
		}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := validator.ValidateCreate(context.Background(), tt.ro)
			if err != nil {
				t.Errorf("unexpected error: %v", err)
			}
		})
	}
}

func TestValidateRollout_InvalidTypes(t *testing.T) {
	validator := &RolloutCustomValidator{}
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Strategy: rolloutsv1alpha1.RolloutStrategy{Type: "Unknown"},
		},
	}
	_, err := validator.ValidateCreate(context.Background(), ro)
	if err == nil {
		t.Error("expected error for unknown strategy type")
	}
}

func TestValidateRollout_EmptyCanarySteps(t *testing.T) {
	validator := &RolloutCustomValidator{}
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Strategy: rolloutsv1alpha1.RolloutStrategy{
				Type:   "Canary",
				Canary: &rolloutsv1alpha1.CanaryStrategy{},
			},
		},
	}
	_, err := validator.ValidateCreate(context.Background(), ro)
	if err == nil {
		t.Error("expected error for empty canary steps")
	}
}

func TestValidateRollout_InvalidTargetKind(t *testing.T) {
	validator := &RolloutCustomValidator{}
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
		Spec: rolloutsv1alpha1.RolloutSpec{
			Target: rolloutsv1alpha1.RolloutTarget{Kind: "StatefulSet"},
		},
	}
	_, err := validator.ValidateCreate(context.Background(), ro)
	if err == nil {
		t.Error("expected error for invalid target kind")
	}
}

func TestDefaultRollout(t *testing.T) {
	defaulter := &RolloutCustomDefaulter{}
	ro := &rolloutsv1alpha1.Rollout{
		ObjectMeta: metav1.ObjectMeta{Name: "test"},
	}
	if err := defaulter.Default(context.Background(), ro); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ro.Spec.Replicas == nil || *ro.Spec.Replicas != 1 {
		t.Error("expected default Replicas to be 1")
	}
	if ro.Spec.RevisionHistoryLimit == nil || *ro.Spec.RevisionHistoryLimit != 10 {
		t.Error("expected default RevisionHistoryLimit to be 10")
	}
}
```

Note: webhook tests should be placed in `internal/webhook/rollouts/v1alpha1/rollout_webhook_test.go`.

- [ ] **Step 3: Verify build**

```bash
go build ./internal/webhook/rollouts/...
```

Expected: no errors.

- [ ] **Step 4: Run all Phase 1 tests**

```bash
go test ./internal/rollout/... ./internal/webhook/rollouts/... -v -count=1
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add internal/webhook/rollouts/
git commit -m "feat: add Rollout validation webhook with strategy and target validation"
```

## Chunk 10: Wire into cmd/main.go + Regenerate Manifests

**Files:**
- Modify: `cmd/main.go`
- Regenerate: `config/rbac/role.yaml`
- Regenerate: `config/webhook/manifests.yaml`

- [ ] **Step 1: Add rollout scheme registration**

Add import to `cmd/main.go`:
```go
rolloutsv1alpha1 "github.com/benebsworth/paprika/api/rollouts/v1alpha1"
rolloutcontrollers "github.com/benebsworth/paprika/internal/controller/rollouts"
rolloutwebhook "github.com/benebsworth/paprika/internal/webhook/rollouts/v1alpha1"
```

Add scheme registration in `init()` (alongside the existing scheme adds):
```go
utilruntime.Must(rolloutsv1alpha1.AddToScheme(scheme))
```

- [ ] **Step 2: Add setupRolloutController function**

Add alongside existing setup functions (after `setupApplicationController`):
```go
func setupRolloutController(mgr ctrl.Manager, shardFilter *sharding.Filter) error {
	dynClient, err := dynamic.NewForConfig(mgr.GetConfig())
	if err != nil {
		return fmt.Errorf("creating dynamic client for rollout controller: %w", err)
	}
	return (&rolloutcontrollers.RolloutReconciler{
		Client:        mgr.GetClient(),
		Scheme:        mgr.GetScheme(),
		Recorder:      mgr.GetEventRecorderFor("rollout-controller"),
		DynamicClient: dynClient,
	}).SetupWithManager(mgr)
}
```

- [ ] **Step 3: Add rollout controller to the setup list**

In `setupOperatorControllers`, add to the controllers list and after the list (following the existing mixed pattern for Cluster/AppProject/Repository):
```go
// In the controllers list:
{"rollout", func() error { return setupRolloutController(mgr, shardFilter) }},

// --- OR ---

// Directly after the list (following the Cluster/AppProject pattern):
if err := setupRolloutController(mgr, shardFilter); err != nil {
	return fmt.Errorf("setting up rollout controller: %w", err)
}
```

- [ ] **Step 4: Add rollout webhook to setupWebhooks**

Add to the webhooks list in `setupWebhooks`:
```go
{"Rollout", rolloutwebhook.SetupRolloutWebhookWithManager},
```

- [ ] **Step 5: Regenerate manifests**

```bash
make manifests
```

Verify RBAC was generated:
```bash
grep -c "rollouts.paprika.io" config/rbac/role.yaml
```

Expected: at least 1 match.

- [ ] **Step 6: Verify build**

```bash
go build ./...
```

Expected: no errors.

- [ ] **Step 7: Run full test suite**

```bash
make test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add cmd/main.go config/rbac/role.yaml config/webhook/manifests.yaml
git commit -m "feat: wire Rollout controller and webhook into cmd/main.go, regenerate manifests"
```

## Chunk 11: Regenerate dist/install.yaml

- [ ] **Step 1: Generate install bundle**

```bash
make build-installer IMG=placeholder
```

- [ ] **Step 2: Verify Rollout CRD + webhook in bundle**

```bash
grep "rollouts.paprika.io" dist/install.yaml
```

Expected: CRD definition, RBAC rules, webhook configuration for Rollout.

- [ ] **Step 3: Final verification**

```bash
make lint && make test
```

Expected: 0 lint issues, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add dist/install.yaml
git commit -m "chore: regenerate dist/install.yaml with Rollout CRD and webhooks"
```

---

## Chunk Summary

| Chunk | What | Status |
|-------|------|--------|
| 1 | API group scaffold + CRD types | Pending |
| 2 | Strategy interface + factory | Pending |
| 3 | Shared template hash utility | Pending |
| 4 | Rolling strategy implementation | Pending |
| 5 | Canary strategy implementation | Pending |
| 6 | BlueGreen strategy implementation | Pending |
| 7 | Strategy unit tests | Pending |
| 8 | Rollout controller | Pending |
| 9 | Rollout validation webhook | Pending |
| 10 | Wiring + manifests | Pending |
| 11 | dist/install.yaml | Pending |
