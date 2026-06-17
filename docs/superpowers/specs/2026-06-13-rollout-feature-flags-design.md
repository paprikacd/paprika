# Rollout + Feature Flag Unified Design

## Problem

Paprika's Release controller manages canary deployments with fixed Helm-parameter injection (`features.canary.enabled`, `canaryWeight=N`) and a TrafficRouter abstraction for Istio/Gateway API weight splitting. But three gaps block production adoption:

1. **No unified strategy abstraction.** Each deployment strategy (Rolling, Canary, BlueGreen, A/B, Mirror) lives ad-hoc in the Release controller. Adding a new strategy requires editing the release state machine.
2. **No feature-flag subsystem.** Teams use ad-hoc Helm values to toggle features per environment. No audit trail, no gradual rollout, no per-user targeting.
3. **No first-class Rollout resource.** Releases own strategy state implicitly through phase transitions. Operators cannot inspect "what strategy is active" or pause/resume a rollout independently.

## Design

### 1. New API Groups

Two new API groups:

- `rollouts.paprika.io/v1alpha1` — `Rollout` CRD (unified strategy resource)
- `featureflags.paprika.io/v1alpha1` — `FeatureFlag` CRD (in-cluster flag definitions) + `FeatureFlagBinding` CRD (targeting rules)

Both follow the existing multi-group layout: `api/rollouts/v1alpha1/`, `api/featureflags/v1alpha1/`.

### 2. Rollout CRD

The Rollout is a top-level resource that encapsulates a deployment strategy. It owns ReplicaSets directly (like Argo Rollouts) and manages their lifecycle through strategy state transitions. It does NOT manage Deployments, StatefulSets, or DaemonSets — those are owned by their respective controllers.

**Deployment adoption (when `RolloutTarget.Kind=Deployment`):**
1. The controller lists ReplicaSets with label `app.kubernetes.io/name=<target.Name>` in the Rollout's namespace
2. If found, the controller adopts them by adding an ownerReference to the Rollout, and removes any existing ownerReference pointing to the Deployment
3. The controller scales the existing Deployment to 0 replicas (patches `spec.replicas=0`)
4. The Deployment's ReplicaSets are now managed by the Rollout as stable/canary ReplicaSets, labeled with `rollouts.paprika.io/revision=<hash>`
5. Once the Rollout is deleted/finalized, the controller does NOT restore the Deployment — this is a deliberate cutover. Users should delete the Deployment after migration.

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

    Spec   RolloutSpec   `json:"spec,omitempty"`
    Status RolloutStatus `json:"status,omitempty"`
}

type RolloutSpec struct {
    // Target is the workload resource managed by this rollout.
    Target RolloutTarget `json:"target"`

    // Strategy defines the deployment strategy.
    Strategy RolloutStrategy `json:"strategy"`

    // Template is the desired pod template. The rollout manages updates to this template.
    Template corev1.PodTemplateSpec `json:"template"`

    // Replicas is the desired number of replicas (default: 1).
    // +optional
    Replicas *int32 `json:"replicas,omitempty"`

    // RevisionHistoryLimit limits old ReplicaSets kept (default: 10).
    // +optional
    RevisionHistoryLimit *int32 `json:"revisionHistoryLimit,omitempty"`

    // Paused suspends the rollout. The controller stops progressing until Paused=false.
    // +optional
    Paused bool `json:"paused,omitempty"`

    // RollbackPolicy controls automatic rollback on failure.
    // +optional
    RollbackPolicy *RollbackPolicy `json:"rollbackPolicy,omitempty"`

    // TrafficRouter configures traffic splitting (imported from api/pipelines/v1alpha1).
    // Cross-group import is within the same Go module — no circular dependency.
    // At runtime, the rollout controller converts this serializable config into a
    // traffic.Router interface implementation via traffic.NewRouter(). The mapping is:
    //   config.Provider="istio"       → traffic/istio.Router
    //   config.Provider="gateway-api" → traffic/gatewayapi.Router
    // Each traffic.Router method maps to a strategy action:
    //   SetWeight        → canary step progression / bluegreen cutover
    //   SetHeaderRoute   → ABTest route activation
    //   SetMirror        → mirror strategy activation
    //   RemoveCanary     → promotion completion
    //   RemoveHeaderRoute→ ABTest teardown
    //   RemoveMirror     → mirror teardown
    // +optional
    TrafficRouter *pipelinesv1alpha1.TrafficRouter `json:"trafficRouter,omitempty"`
}

type RolloutTarget struct {
    // Kind of existing workload to adopt. One of: Deployment, "".
    // "" (empty) means pure ReplicaSet management — the controller creates ReplicaSets directly.
    // "Deployment" means adopt ReplicaSets from an existing Deployment (the Deployment is
    // scaled to 0 after adoption). StatefulSet and DaemonSet are not supported — their
    // pod management semantics are incompatible with ReplicaSet-based rollout strategies.
    // +optional
    Kind string `json:"kind,omitempty"`
    // Name of the existing workload resource. If empty, the controller derives names
    // from the Rollout name: <rollout>-<hash> for ReplicaSets.
    // +optional
    Name string `json:"name,omitempty"`
}

type RolloutStrategy struct {
    // Type selects the strategy implementation.
    // One of: Rolling, Canary, BlueGreen, ABTest, Mirror.
    Type string `json:"type"`

    // Rolling config (used when Type=Rolling).
    // +optional
    Rolling *RollingStrategy `json:"rolling,omitempty"`

    // Canary config (used when Type=Canary).
    // +optional
    Canary *CanaryStrategy `json:"canary,omitempty"`

    // BlueGreen config (used when Type=BlueGreen).
    // +optional
    BlueGreen *BlueGreenStrategy `json:"blueGreen,omitempty"`

    // ABTest config (used when Type=ABTest).
    // +optional
    ABTest *ABTestStrategy `json:"abTest,omitempty"`

    // Mirror config (used when Type=Mirror).
    // +optional
    Mirror *MirrorStrategy `json:"mirror,omitempty"`
}

// RollingStrategy: Standard rolling update (k8s native, but managed by rollout controller).
type RollingStrategy struct {
    // MaxUnavailable (default: 25%).
    // +optional
    MaxUnavailable *intstr.IntOrString `json:"maxUnavailable,omitempty"`
    // MaxSurge (default: 25%).
    // +optional
    MaxSurge *intstr.IntOrString `json:"maxSurge,omitempty"`
}

// CanaryStrategy: Weighted traffic split with step progression.
type CanaryStrategy struct {
    // Steps defines the weight progression. Each step is a target weight to hold.
    Steps []CanaryStep `json:"steps"`

    // Analysis runs verification checks during/after canary.
    // +optional
    Analysis *RolloutAnalysis `json:"analysis,omitempty"`

    // StableService is the name of the stable Kubernetes Service (default: <rollout>-stable).
    // +optional
    StableService string `json:"stableService,omitempty"`

    // CanaryService is the name of the canary Kubernetes Service (default: <rollout>-canary).
    // +optional
    CanaryService string `json:"canaryService,omitempty"`
}

type CanaryStep struct {
    // SetWeight sets the canary traffic weight (0-100). Reached immediately, held for SetDuration or until manual promotion.
    SetWeight int32 `json:"setWeight"`

    // Pause duration before auto-promoting. 0 = indefinite (requires manual promotion).
    // +optional
    Duration *metav1.Duration `json:"duration,omitempty"`

    // Analysis runs verification at this step. If failing, the step retries or rolls back.
    // +optional
    Analysis *RolloutAnalysis `json:"analysis,omitempty"`
}

// BlueGreenStrategy: Full replica swap between preview and active.
type BlueGreenStrategy struct {
    // PreviewService routes traffic to the new version before promotion.
    // +optional
    PreviewService string `json:"previewService,omitempty"`

    // ActiveService routes production traffic to the promoted version.
    ActiveService string `json:"activeService"`

    // AutoPromotionSeconds waits N seconds then auto-promotes. 0 = manual.
    // +optional
    AutoPromotionSeconds *int32 `json:"autoPromotionSeconds,omitempty"`

    // ScaleDownDelaySeconds waits N seconds after promotion before scaling down old ReplicaSet.
    // +optional
    ScaleDownDelaySeconds *int32 `json:"scaleDownDelaySeconds,omitempty"`

    // Analysis runs before cutover.
    // +optional
    Analysis *RolloutAnalysis `json:"analysis,omitempty"`

    // PreviewReplicaCount is how many replicas to run in preview (default: 100% via Replicas).
    // +optional
    PreviewReplicaCount *int32 `json:"previewReplicaCount,omitempty"`
}

// ABTestStrategy: Route splits based on HTTP headers or cookies.
type ABTestStrategy struct {
    // Routes define how traffic is split between versions.
    Routes []ABTestRoute `json:"routes"`

    // StableService is the baseline service (default: <rollout>-stable).
    // +optional
    StableService string `json:"stableService,omitempty"`

    // CanaryService is the variant service (default: <rollout>-canary).
    // +optional
    CanaryService string `json:"canaryService,omitempty"`

    // Analysis runs during the A/B test to compare metrics.
    Analysis *RolloutAnalysis `json:"analysis,omitempty"`
}

type ABTestRoute struct {
    // Type of routing: Header, Cookie.
    Type string `json:"type"`

    // Name of the header or cookie to match.
    Name string `json:"name"`

    // Value to match.
    Value string `json:"value"`

    // Service selects stable or canary.
    Service string `json:"service"` // "stable" or "canary"
}

// MirrorStrategy: Duplicate traffic to canary for observation (no impact on users).
type MirrorStrategy struct {
    // MirrorPercent of traffic to mirror (1-100).
    MirrorPercent int32 `json:"mirrorPercent"`

    // StableService is the production service (default: <rollout>-stable).
    // +optional
    StableService string `json:"stableService,omitempty"`

    // CanaryService receives mirrored traffic (default: <rollout>-canary).
    // +optional
    CanaryService string `json:"canaryService,omitempty"`

    // Duration of mirroring before auto-promotion. 0 = manual.
    // +optional
    Duration *metav1.Duration `json:"duration,omitempty"`

    // Analysis runs during mirroring.
    Analysis *RolloutAnalysis `json:"analysis,omitempty"`
}

// RolloutAnalysis specifies verification checks.
// Reuses concepts from the existing analysis/ package (analysis.Analyzer interface,
// http/probes checks) but defines its own types to avoid circular dependencies.
// The rollout controller bridges RolloutAnalysis -> analysis.Analyzer at runtime:
//   RolloutAnalysis.HTTP -> analysis.NewHTTPAnalyzer
//   RolloutAnalysis.Prometheus -> analysis.NewPrometheusAnalyzer
//   RolloutAnalysis.Job -> analysis.NewJobAnalyzer (new addition)
//
// Precedence for threshold/interval overrides:
//   RolloutAnalysis provides defaults. When a CanaryStep also has its own Analysis,
//   the step-level Analysis fields override the strategy-level defaults.
//   Example: step.Analysis.FailedThreshold=1 overrides analysis.FailedThreshold=3.
type RolloutAnalysis struct {
    // Checks run after the rollout step to determine success/failure.
    Checks []AnalysisCheck `json:"checks,omitempty"`

    // FailedThreshold is how many consecutive failures trigger rollback (default: 3).
    // +optional
    FailedThreshold *int32 `json:"failedThreshold,omitempty"`

    // SuccessThreshold is how many consecutive successes consider the step healthy (default: 1).
    // +optional
    SuccessThreshold *int32 `json:"successThreshold,omitempty"`

    // Interval between check executions (default: 10s).
    // +optional
    Interval *metav1.Duration `json:"interval,omitempty"`
}

type AnalysisCheck struct {
    // Provider: http, prometheus, job.
    Provider string `json:"provider"`

    // HTTP check config.
    // +optional
    HTTP *HTTPAnalysisCheck `json:"http,omitempty"`

    // Prometheus check config.
    // +optional
    Prometheus *PrometheusAnalysisCheck `json:"prometheus,omitempty"`

    // Job check runs an arbitrary command in-cluster as a Kubernetes Job.
    // +optional
    Job *JobAnalysisCheck `json:"job,omitempty"`
}

type HTTPAnalysisCheck struct {
    URL     string `json:"url"`
    Method  string `json:"method,omitempty"`
    // ExpectedStatusCode (default: 200).
    ExpectedStatusCode int32 `json:"expectedStatusCode,omitempty"`
}

type PrometheusAnalysisCheck struct {
    Query     string `json:"query"`
    // Threshold is a comparison expression in the form: <operator> <value>.
    // Operator: >, >=, <, <=, ==, !=
    // Value: a float64 number.
    // Example: ">0.99" means the query result must be greater than 0.99.
    // Parsed at controller runtime via strings.Fields after trimming.
    Threshold string `json:"threshold"`
    Duration  metav1.Duration `json:"duration,omitempty"`
}

type JobAnalysisCheck struct {
    Image   string   `json:"image"`
    Command []string `json:"command"`
    // TimeoutSeconds (default: 30).
    TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`
}

// RollbackPolicy controls automatic rollback.
type RollbackPolicy struct {
    // Auto triggers automatic rollback on failure (default: true).
    // +optional
    Auto *bool `json:"auto,omitempty"`

    // MaxRetries is how many times to retry before rolling back (default: 3).
    // +optional
    MaxRetries *int32 `json:"maxRetries,omitempty"`
}
```

Rollout phases:

```go
type RolloutPhase string

const (
    RolloutPhasePending    RolloutPhase = "Pending"
    RolloutPhaseProgressing RolloutPhase = "Progressing"
    RolloutPhasePaused     RolloutPhase = "Paused"
    RolloutPhaseHealthy    RolloutPhase = "Healthy"
    RolloutPhaseDegraded   RolloutPhase = "Degraded"
    RolloutPhaseFailed     RolloutPhase = "Failed"
    RolloutPhaseRolledBack RolloutPhase = "RolledBack"
)
```

RolloutStatus:

```go
type RolloutStatus struct {
    Phase              RolloutPhase           `json:"phase"`
    Conditions         []metav1.Condition     `json:"conditions,omitempty"`
    CurrentStepIndex   int32                  `json:"currentStepIndex,omitempty"`
    CurrentStepWeight  int32                  `json:"currentStepWeight,omitempty"`
    StableRS           string                 `json:"stableRS,omitempty"`       // name of stable ReplicaSet
    CanaryRS           string                 `json:"canaryRS,omitempty"`       // name of canary ReplicaSet (canary/ab/mirror)
    ActiveService      string                 `json:"activeService,omitempty"`  // BlueGreen only
    PreviewService     string                 `json:"previewService,omitempty"` // BlueGreen only
    ObservedGeneration int64                  `json:"observedGeneration,omitempty"`
    Message            string                 `json:"message,omitempty"`
}
```

### 3. FeatureFlag CRD

A simple in-cluster feature flag CRD compatible with OpenFeature evaluation:

```go
// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=ff
type FeatureFlag struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   FeatureFlagSpec   `json:"spec,omitempty"`
    Status FeatureFlagStatus `json:"status,omitempty"`
}

type FeatureFlagSpec struct {
    // Type of flag: boolean, string, int, float.
    Type string `json:"type"`

    // DefaultValue is returned when no targeting rule matches.
    DefaultValue FeatureFlagValue `json:"defaultValue"`

    // Rules define targeting conditions (optional).
    // +optional
    Rules []TargetingRule `json:"rules,omitempty"`

    // Description explains the flag's purpose.
    // +optional
    Description string `json:"description,omitempty"`

    // Tags for grouping and discovery.
    // +optional
    Tags []string `json:"tags,omitempty"`

    // Disabled disables the flag, returning default value to all callers.
    // +optional
    Disabled bool `json:"disabled,omitempty"`
}

type FeatureFlagValue struct {
    // +optional
    BoolValue *bool `json:"boolValue,omitempty"`
    // +optional
    StringValue *string `json:"stringValue,omitempty"`
    // +optional
    IntValue *int64 `json:"intValue,omitempty"`
    // +optional
    FloatValue *float64 `json:"floatValue,omitempty"`
}

type TargetingRule struct {
    // Name identifies this rule.
    Name string `json:"name,omitempty"`

    // Condition is a CEL expression evaluated against the evaluation context.
    // Available variables: user (map), group (map), device (map).
    // Example: "user.region == 'us-east' && user.tier == 'beta'"
    Condition string `json:"condition"`

    // Value returned when the condition matches.
    Value FeatureFlagValue `json:"value"`
}
```

### FeatureFlagBinding

Binds flag values to specific contexts (deployments, rollouts, namespaces):

```go
// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Namespaced,shortName=ffb
type FeatureFlagBinding struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec FeatureFlagBindingSpec `json:"spec,omitempty"`
}

type FeatureFlagBindingSpec struct {
    // FlagRef references a FeatureFlag by name.
    FlagRef string `json:"flagRef"`

    // Target selects which workloads this binding applies to.
    Target BindingTarget `json:"target"`

    // OverrideValue overrides the flag's default for matching targets.
    OverrideValue FeatureFlagValue `json:"overrideValue"`
}

type BindingTarget struct {
    // Kind of target resource: Rollout, Deployment, Namespace.
    Kind string `json:"kind"`

    // Name of the target resource. Empty matches all.
    // +optional
    Name string `json:"name,omitempty"`

    // Selector for label-based matching (mutually exclusive with Name).
    // +optional
    Selector *metav1.LabelSelector `json:"selector,omitempty"`
}
```

### 4. Strategy Engine

A pluggable strategy interface in a new `internal/rollout/` package:

```go
// Strategy defines the lifecycle of a rollout strategy.
type Strategy interface {
    // Type returns the strategy type identifier.
    Type() string

    // Sync executes one reconciliation loop. It returns the desired action.
    // The rollout controller calls Sync on every reconcile.
    // The strategy may mutate *RolloutStatus directly (e.g., setting CurrentStepIndex,
    // CurrentStepWeight) AND communicates the next phase transition via SyncResult.Phase.
    // SyncResult.Phase takes precedence over status.Phase when both are set.
    Sync(ctx context.Context, ro *Rollout, status *RolloutStatus) (*SyncResult, error)

    // Cleanup is called when the rollout is complete/failed/rolled back.
    Cleanup(ctx context.Context, ro *Rollout) error
}

type SyncResult struct {
    // Phase to set on the rollout.
    Phase RolloutPhase

    // DesiredAction tells the controller what to do next.
    Action Action

    // Message is a human-readable status message.
    Message string

    // ReplicaSets to create/scale/delete.
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
    Name   string
    Replicas int32
    Template corev1.PodTemplateSpec
    // Labels to set on the ReplicaSet (includes rollout name, revision, version).
    Labels map[string]string
}
```

The `internal/rollout/` package layout:

```
internal/rollout/
  rollout.go            # Strategy interface, factory, shared types
  rolling/
    rolling.go          # RollingStrategy implementation
  canary/
    canary.go           # CanaryStrategy implementation (uses traffic.Router)
  bluegreen/
    bluegreen.go        # BlueGreenStrategy implementation
  abtest/
    abtest.go           # ABTestStrategy implementation
  mirror/
    mirror.go           # MirrorStrategy implementation
```

The factory:

```go
func NewStrategy(spec *RolloutStrategy) (Strategy, error) {
    switch spec.Type {
    case "Rolling":
        return rolling.NewStrategy(spec.Rolling)
    case "Canary":
        return canary.NewStrategy(spec.Canary)
    case "BlueGreen":
        return bluegreen.NewStrategy(spec.BlueGreen)
    case "ABTest":
        return abtest.NewStrategy(spec.ABTest)
    case "Mirror":
        return mirror.NewStrategy(spec.Mirror)
    default:
        return nil, fmt.Errorf("unknown strategy type: %s", spec.Type)
    }
}
```

Each strategy implementation is stateless (no mutable fields) — the Rollout CRD's status holds all progression state. Strategies are lightweight constructors called per reconcile.

### 5. Traffic Router Extension

The existing `traffic.Router` interface handles `SetWeight` and `RemoveCanary`. For A/B and Mirror strategies, new methods are needed:

```go
type Router interface {
    // Existing:
    SetWeight(ctx context.Context, weight int32) error
    RemoveCanary(ctx context.Context) error
    Type() string

    // New for A/B:
    SetHeaderRoute(ctx context.Context, header, value, service string) error
    RemoveHeaderRoute(ctx context.Context, header string) error

    // New for Mirror:
    SetMirror(ctx context.Context, percent int32) error
    RemoveMirror(ctx context.Context) error
}
```

These are additive — existing providers (Istio, Gateway API) that don't support header/mirror routing return `ErrNotSupported`. The rollout controller checks `errors.Is(err, ErrNotSupported)` and surfaces a condition rather than failing.

The Istio provider implements all four operations natively (VirtualService supports header matching, mirroring, and weight splits). Gateway API provider implements `SetWeight`/`RemoveCanary` only; header/mirror require Gateway API v1.2+ experimental features.

### 6. Feature Flag Provider Interface

```go
// Provider evaluates feature flags from any backend.
type Provider interface {
    // BoolEvaluation returns a boolean flag value.
    BoolEvaluation(ctx context.Context, flag string, defaultValue bool, evalCtx EvaluationContext) (*ProviderResult[bool], error)

    // StringEvaluation returns a string flag value.
    StringEvaluation(ctx context.Context, flag string, defaultValue string, evalCtx EvaluationContext) (*ProviderResult[string], error)

    // IntEvaluation returns an int flag value.
    IntEvaluation(ctx context.Context, flag string, defaultValue int64, evalCtx EvaluationContext) (*ProviderResult[int64], error)

    // FloatEvaluation returns a float flag value.
    FloatEvaluation(ctx context.Context, flag string, defaultValue float64, evalCtx EvaluationContext) (*ProviderResult[float64], error)

    // Metadata returns provider metadata (name, capabilities).
    Metadata() ProviderMetadata
}

type EvaluationContext struct {
    TargetingKey string            `json:"targetingKey,omitempty"`
    User         map[string]string `json:"user,omitempty"`
    Group        map[string]string `json:"group,omitempty"`
    Device       map[string]string `json:"device,omitempty"`
    Custom       map[string]interface{} `json:"custom,omitempty"`
}

type ProviderResult[T any] struct {
    Value   T
    Reason  string // "STATIC", "TARGETING", "SPLIT", "DISABLED", "ERROR"
    Flag    string
}

type ProviderMetadata struct {
    Name         string
    Capabilities []string // "bool", "string", "int", "float", "targeting"
}
```

Package layout:

```
internal/featureflag/
  provider.go            # Provider interface, EvaluationContext, ProviderResult, ProviderMetadata
  kubernetes/
    kubernetes.go        # In-cluster provider: reads FeatureFlag + FeatureFlagBinding CRDs
  openfeature/
    openfeature.go       # OpenFeature provider adapter (bridges to flagd/LaunchDarkly/Unleash)
  client.go              # FlagClient: caches providers, evaluates with fallback chain
```

### 7. Rollout Controller

The controller watches `Rollout` resources and owns `ReplicaSet` resources. It does NOT manage Deployments directly — it manages ReplicaSets, which is simpler and avoids conflicts with the k8s Deployment controller.

**Reconciliation loop:**

```
Reconcile(rollout):
  1. If rollout.Spec.Paused → set phase=Paused, return
  2. If rollout.DeletionTimestamp != 0 → run finalizer (strategy.Cleanup)
  3. Instantiate strategy: NewStrategy(&rollout.Spec.Strategy)
  4. Call strategy.Sync(ctx, rollout, &status)
  5. Execute result.Action:
     - ActionCreateStable: create/scale ReplicaSet to 100% desired replicas
     - ActionPromote: switch traffic to stable, run strategy.Cleanup
     - ActionStep: progress to next canary step/applied weight
     - ActionPause: set phase=Paused, set condition with reason
     - ActionRollback: revert to previous revision ReplicaSet
     - ActionComplete: set phase=Healthy, record ObservedGeneration
  6. Execute ReplicaSetActions (create/scale/delete RS)
  7. Manage Services derived from strategy config:
     - Canary: ensure Services named <rollout>-stable and <rollout>-canary exist
       (or the overridden names from CanaryStrategy.StableService/CanaryService),
       selectors pointing to the stable/canary ReplicaSet labels
     - BlueGreen: ensure Services named <rollout>-active and <rollout>-preview
       (or the overridden names from BlueGreenStrategy.ActiveService/PreviewService)
     - ABTest/Mirror: same pattern, service names from strategy config
     - Services are created with OwnerReference to the Rollout for GC
     - Services are NOT deleted mid-rollout — they persist until Rollout deletion
  8. If TrafficRouter is set, configure traffic routing:
     - Canary: traffic.NewRouter → SetWeight(step weight)
     - ABTest: traffic.NewRouter → SetHeaderRoute(header, value, "canary")
     - Mirror: traffic.NewRouter → SetMirror(mirror percent)
     - BlueGreen: traffic.NewRouter → SetWeight(100) on cutover, RemoveCanary after
  9. Update RolloutStatus
```

**RBAC markers:**

```go
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=rollouts.paprika.io,resources=rollouts/finalizers,verbs=update
// +kubebuilder:rbac:groups=apps,resources=replicasets,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=services,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
// +kubebuilder:rbac:groups=core,resources=secrets,verbs=get;list;watch
```

**Wiring in cmd/main.go:**

```go
if err = (&rolloutcontroller.RolloutReconciler{
    Client:          mgr.GetClient(),
    Scheme:          mgr.GetScheme(),
    Recorder:        mgr.GetEventRecorderFor("rollout-controller"),
    DynamicClient:   dynamic.NewForConfigOrDie(mgr.GetConfig()),
    TrafficClient:   traffic.NewFactoryClient(mgr.GetClient()),
}).SetupWithManager(mgr); err != nil {
    setupLog.Error(err, "unable to create controller", "controller", "Rollout")
    os.Exit(1)
}
```

### 8. Release Controller Integration

The Release controller's canary phase adopts the Rollout strategy engine:

- When `Stage.Spec.Strategy` is set (instead of or in addition to `CanaryConfig`), the Release controller creates a Rollout child resource
- The Release controller reads RolloutStatus.Phase to map back to ReleasePhase
- Migration path: existing `CanaryConfig` converts to CanaryStrategy automatically (set by webhook defaulting)

```go
// In release_controller.go reconcileReleasePhase:

case r.phaseIs(Canarying):
    if rollout := r.getChildRollout(ctx, release); rollout != nil {
        // Rollout-managed canary
        return r.reconcileRolloutCanary(ctx, release, rollout)
    }
    // Legacy canary (existing code path)
    return r.reconcileLegacyCanary(ctx, release)
```

StageSpec changes:

```go
type StageSpec struct {
    // existing fields...

    // Strategy defines the deployment strategy for the Release created from this Stage.
    // When set, the Release controller creates a Rollout resource instead of using the
    // built-in canary steps. Mutually exclusive with CanaryConfig.
    // +optional
    Strategy *RolloutStrategy `json:"strategy,omitempty"`
}
```

The Rollout strategy replaces the need for separate `CanaryConfig` on StageSpec. For backward compatibility, a webhook defaulting/conversion function converts `CanaryConfig` → `CanaryStrategy` when writing to the Rollout CRD.

### 9. FeatureFlag Controller

A separate controller that manages `FeatureFlag` and `FeatureFlagBinding` CRDs:

```go
// FeatureFlagReconciler watches FeatureFlag CRDs and manages the in-cluster flag state.
// No active reconciliation needed per-flag — the CRD stores the definitive state.
// The controller exists for status updates and event recording.
```

The Kubernetes provider in `internal/featureflag/kubernetes/` reads flags at evaluation time (no caching layer in Phase 3; a Redis-backed cache layer is added in Phase 4 alongside cache invalidation from webhook receivers). The client package handles provider fallback:

```go
type FlagClient struct {
    providers []Provider
}

func (c *FlagClient) Bool(ctx context.Context, flag string, defaultValue bool, evalCtx EvaluationContext) (bool, string) {
    for _, p := range c.providers {
        result, err := p.BoolEvaluation(ctx, flag, defaultValue, evalCtx)
        if err == nil && result.Reason != "ERROR" {
            return result.Value, result.Reason
        }
    }
    return defaultValue, "ERROR"
}
```

Providers are tried in order: in-cluster Kubernetes → OpenFeature (flagd) → OpenFeature (LaunchDarkly). The first provider to return a non-error result wins. This allows in-cluster defaults to be overridden by external systems.

OpenFeature provider adapter wraps the OpenFeature Go SDK:

```go
type OpenFeatureProvider struct {
    client *ofg.Client
    name   string
}
```

The adapter maps OpenFeature `Client.Evaluation` calls to the internal `Provider` interface. This allows Paprika to use any OpenFeature-compatible backend (flagd, LaunchDarkly, Unleash, Split) without custom provider code.

### 10. Package Dependencies

```
RolloutController
  → internal/rollout/        (strategy factory + implementations)
  → traffic/                  (Router interface + Istio/GatewayAPI)
  → internal/featureflag/     (FlagClient for feature flag evaluation)
  → analysis/                 (existing analysis checks)
  → engine/                   (template rendering for ReplicaSet)

ReleaseController
  → internal/rollout/         (creates Rollout child, reads status)
  → traffic/                  (existing traffic routing)
  → analysis/                 (existing analysis)
  → internal/featureflag/     (evaluate flags during release)

FlagClient
  → internal/featureflag/kubernetes/   (in-cluster provider)
  → internal/featureflag/openfeature/  (OpenFeature adapter)
  → featureflags.paprika.io CRDs

Webhook receivers
  → internal/featureflag/     (cache invalidation on flag change)
```

### 11. Validation & Defaulting Webhooks

Rollout validation webhook:

- Strategy type must be one of the supported types
- CanaryStrategy requires at least one step
- CanaryStep.SetWeight must be 0-100
- ABTest requires at least one route
- MirrorPercent must be 1-100
- Mutually exclusive strategy configs: only the selected type's config is non-nil
- Target.Kind must be `Deployment` or `""` (empty = ReplicaSet management)
- TrafficRouter config validation (reuses existing webhook logic)

FeatureFlag validation webhook:

- Type must be boolean, string, int, or float
- DefaultValue must match the declared type
- TargetingRule.Condition must be valid CEL syntax
- TargetingRule.Value must match flag type

### 12. Proto/API Updates

New messages in `proto/paprika/v1/api.proto`:

```protobuf
// Rollout
message Rollout {
    string name = 1;
    string namespace = 2;
    string strategy_type = 3;
    string phase = 4;
    int32 current_step = 5;
    int32 current_weight = 6;
    string stable_rs = 7;
    string canary_rs = 8;
    int64 observed_generation = 9;
    repeated v1.Condition conditions = 10;
    string message = 11;
    string target_kind = 12;
    string target_name = 13;
}

message FeatureFlag {
    string name = 1;
    string namespace = 2;
    string type = 3;
    bool disabled = 4;
    string default_value = 5; // serialized JSON
    repeated string tags = 6;
}
```

New RPCs on `PaprikaService`:

```protobuf
rpc ListRollouts(ListRolloutsRequest) returns (ListRolloutsResponse);
rpc GetRollout(GetRolloutRequest) returns (GetRolloutResponse);
rpc PauseRollout(PauseRolloutRequest) returns (PauseRolloutResponse);
rpc PromoteRollout(PromoteRolloutRequest) returns (PromoteRolloutResponse);
rpc RollbackRollout(RollbackRolloutRequest) returns (RollbackRolloutResponse);

rpc ListFeatureFlags(ListFeatureFlagsRequest) returns (ListFeatureFlagsResponse);
rpc GetFeatureFlag(GetFeatureFlagRequest) returns (GetFeatureFlagResponse);
rpc EvaluateFeatureFlag(EvaluateFeatureFlagRequest) returns (EvaluateFeatureFlagResponse);
rpc ToggleFeatureFlag(ToggleFeatureFlagRequest) returns (ToggleFeatureFlagResponse);
```

### 13. Testing Strategy

**Unit tests (strategy implementations):**
- `internal/rollout/rolling/rolling_test.go` — mock ReplicaSet state, verify scaling
- `internal/rollout/canary/canary_test.go` — mock traffic.Router, verify step progression
- `internal/rollout/bluegreen/bluegreen_test.go` — verify preview→active promotion
- `internal/rollout/abtest/abtest_test.go` — verify header route config
- `internal/rollout/mirror/mirror_test.go` — verify mirror percent
- `internal/rollout/rollout_test.go` — factory tests, interface compliance

**Unit tests (feature flags):**
- `internal/featureflag/kubernetes/kubernetes_test.go` — fake CRD client, verify evaluation
- `internal/featureflag/openfeature/openfeature_test.go` — mock OpenFeature provider
- `internal/featureflag/client_test.go` — provider fallback chain

**Unit tests (controllers):**
- `internal/controller/rollouts/rollout_controller_test.go` — fake strategy, verify state machine
- `internal/controller/pipelines/release_controller_rollout_test.go` — verify Release→Rollout child creation

**Integration tests:**
- Canary with Istio traffic routing (existing, extended)
- BlueGreen with Gateway API
- A/B test with header routing
- FeatureFlag in-cluster evaluation during release
- Rollout pause/resume lifecycle

### 14. Implementation Order

#### Phase 1: CRDs + Strategy Engine + Rollout Controller

1. `kubebuilder create api --group rollouts --version v1alpha1 --kind Rollout --resource --controller`
2. Define Rollout CRD types (`api/rollouts/v1alpha1/rollout_types.go`)
3. `make manifests generate`
4. Rename generated controller to `internal/controller/rollouts/rollout_controller.go`
5. Build `internal/rollout/rollout.go` — Strategy interface, factory, shared types
6. Implement `internal/rollout/rolling/rolling.go` — Rolling strategy
7. Implement `internal/rollout/canary/canary.go` — Canary strategy (uses traffic.Router)
8. Implement `internal/rollout/bluegreen/bluegreen.go` — BlueGreen strategy
9. Implement the Rollout controller reconciliation loop
10. Rollout validation webhook (kubebuilder create webhook + implement)
11. Unit tests for all strategies and controller
12. Wire into `cmd/main.go`

#### Phase 2: A/B + Mirror Strategies + Traffic Router Extension

1. Implement `internal/rollout/abtest/abtest.go` — ABTest strategy
2. Implement `internal/rollout/mirror/mirror.go` — Mirror strategy
3. Extend `traffic.Router` interface with `SetHeaderRoute`, `RemoveHeaderRoute`, `SetMirror`, `RemoveMirror`
4. Implement Istio provider methods for header/mirror
5. Implement Gateway API provider methods (where supported)
6. Unit tests for new strategies and traffic router methods

#### Phase 3: FeatureFlag CRDs + Providers

1. `kubebuilder create api --group featureflags --version v1alpha1 --kind FeatureFlag --resource --controller`
2. `kubebuilder create api --group featureflags --version v1alpha1 --kind FeatureFlagBinding --resource`
3. Define CRD types (`api/featureflags/v1alpha1/`)
4. `make manifests generate`
5. Build `internal/featureflag/provider.go` — Provider interface, types
6. Implement `internal/featureflag/kubernetes/kubernetes.go` — in-cluster provider
7. Implement `internal/featureflag/openfeature/openfeature.go` — OpenFeature adapter
8. Build `internal/featureflag/client.go` — FlagClient with fallback
9. FeatureFlag + FeatureFlagBinding validation webhooks
10. Unit tests
11. Wire into `cmd/main.go`

#### Phase 4: Release Controller Integration + Proto Updates

1. Add `Strategy` field to `StageSpec`
2. Update `ReleaseReconciler` to create Rollout child when strategy is set
3. Add Rollout phase → ReleasePhase mapping
4. Update proto definitions with Rollout/FeatureFlag messages and RPCs
5. `buf generate` to regenerate Go code + TypeScript client
6. Update webhook receiver for Rollout/FeatureFlag cache invalidation
7. Audit log events for Rollout/FeatureFlag operations
8. Update Helm chart RBAC templates

#### Phase 5: Prometheus Metrics + E2E Tests + UI

1. Prometheus metrics: `rollout_phase`, `rollout_strategy`, `rollout_duration_seconds`, `rollout_step_duration_seconds`, `featureflag_evaluations_total`, `featureflag_provider_errors_total`
2. Grafana dashboard panels for rollout progress
3. E2E tests: Rolling, Canary (with Istio/Gateway API), BlueGreen, A/B, Mirror, FeatureFlag evaluation
4. UI screens: Rollout list/detail, FeatureFlag editor, pause/promote/rollback controls

## Open Questions

1. **ReplicaSet vs Deployment ownership?** Using ReplicaSet directly avoids conflicts with k8s Deployment controller, but means the rollout controller must manage all ReplicaSet lifecycle. This matches Argo Rollouts' approach. Alternative: manage Deployments but with ownership markers to avoid controller conflicts. **Recommendation**: ReplicaSet ownership — simpler and battle-tested.

2. **FeatureFlag CRD vs ConfigMap-backed?** A ConfigMap-backed approach is simpler but lacks validation, typing, and CEL targeting. **Recommendation**: CRD-based for production (validation, typing, CEL), with optional ConfigMap fallback provider for bootstrapping.

3. **OpenFeature SDK version?** OpenFeature Go SDK v1.x is stable and widely used. Pin to v1.x in go.mod.

4. **CEL evaluation library?** Use `k8s.io/apiextensions-apiserver/pkg/apiserver/schema/cel` (same library k8s uses) for targeting rule evaluation. Already vendored in most k8s projects.

5. **Traffic router header/mirror — error semantics?** Return sentinel error `ErrNotSupported` so the rollout controller can gracefully degrade rather than fail the rollout. Providers that don't support a feature simply skip that step.

## References
- Argo Rollouts: https://argo-rollouts.readthedocs.io/
- Argo Rollouts traffic routing: https://github.com/argoproj/argo-rollouts/tree/master/rollout/trafficrouting
- OpenFeature spec: https://openfeature.dev/docs/reference/concepts/
- OpenFeature Go SDK: https://github.com/open-feature/go-sdk
- K8s ReplicaSet: https://kubernetes.io/docs/concepts/workloads/controllers/replicaset/
- K8s CEL: https://kubernetes.io/docs/reference/using-api/cel/
