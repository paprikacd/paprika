# Conftest / OPA Gates Design

## Goal

Add **policy-as-code gates** to the promotion pipeline: before a Release promotes a
manifest bundle, evaluate the rendered manifests against user-authored Rego policies and
block (or warn on) violations.

This complements the two existing gate families:

- **Verification gates** (`release.Spec.Verify`) — runtime checks (smoke-test, duration)
  executed *after* promotion.
- **Governance gate** (`runGovernanceGate`) — built-in, code-level CEL policies evaluated
  *before* promotion.

Conftest gates are **user-authored Rego**, evaluated *before* promotion. They reuse the
governance gate's violation semantics so the operator experience is consistent.

## Context

The release controller already runs two pre-promotion manifest validations:

- `runGovernanceGate` (`internal/controller/pipelines/release_controller.go`) calls
  `governance.PolicyEvaluator.Evaluate`, which runs built-in CEL rules and returns
  `governance.Violations`. Blocking violations set a release condition
  (`setReleaseGovernanceCondition`) and abort promotion; warnings set a passing-with-warning
  condition.
- `governance.Violations` (`internal/governance/violation.go`) is a `[]Violation` with
  `.Blocking()` and `.Warnings()` collectors. `Violation.Blocking()` decides whether a
  violation aborts promotion.

Existing types that this design mirrors:

- `ApprovalGate` / `GateStatus` (`api/pipelines/v1alpha1/application_types.go`) —
  application-level gate declarations and their per-gate status.
- `ApplicationSpec.ApprovalGates []ApprovalGate` — the binding pattern for app-level gates.
- `GateConfig` / `release.Spec.Verify []GateConfig` — verification gate config.
- `pipelines.GateExecutor` interface (`internal/controller/pipelines/gate_executor.go`) —
  the consumer-side interface pattern for injecting gate executors into the reconciler.

This design reuses `governance.Violations` for results and mirrors the
`GateExecutor` injection pattern.

## Non-Goals (v1)

- Git / OCI / ConfigMap policy sources. v1 ships **inline Rego** only. The multi-source
  renderer can be wired in later without changing the evaluator contract.
- Stage-level policy scoping. Policies are bound at the Application level and apply to
  every promotion of that Application.
- OPA bundle download / signature verification.
- A new API / connect RPC or UI surface. The gate surfaces via release conditions and
  events, consistent with the governance gate.
- Parameterizing policies with arbitrary structured input. v1 supports a flat
  `map[string]string` parameter map only.

## API Changes

### New CRD: `ConftestPolicy` (`api/pipelines/v1alpha1/conftest_types.go`)

Group/version: `pipelines.paprika.io/v1alpha1`. Namespaced.

```go
// ConftestEnforcementMode controls how violations from this policy affect promotion.
// +kubebuilder:validation:Enum=enforce;warn
type ConftestEnforcementMode string

const (
    // ConftestEnforce blocks promotion on any deny/violation result.
    ConftestEnforce ConftestEnforcementMode = "enforce"
    // ConftestWarn records violations as warnings but does not block promotion.
    ConftestWarn ConftestEnforcementMode = "warn"
)

// ConftestPolicySpec defines a user-authored Rego policy evaluated against rendered
// manifests before promotion.
type ConftestPolicySpec struct {
    // Rego is the policy source. Must define rule sets named `deny`, `warn`, and/or
    // `violation` following the conftest convention. `violation` rules are treated as
    // deny rules.
    // +kubebuilder:validation:Required
    // +kubebuilder:validation:MinLength=1
    Rego string `json:"rego"`

    // Enforcement controls whether violations block promotion (enforce) or only warn.
    // +kubebuilder:default=enforce
    // +optional
    Enforcement ConftestEnforcementMode `json:"enforcement,omitempty"`

    // Parameters are exposed to the policy as `input.parameters.<key>`.
    // +optional
    Parameters map[string]string `json:"parameters,omitempty"`
}

// ConftestPolicyStatus reports the last compilation/evaluation outcome for operator UX.
type ConftestPolicyStatus struct {
    // ObservedGeneration is the most recent generation observed.
    // +optional
    ObservedGeneration int64 `json:"observedGeneration,omitempty"`

    // Conditions reflect compile readiness.
    // +optional
    // +patchMergeKey=type
    // +patchStrategy=merge
    // +listType=map
    // +listMapKey=type
    Conditions []metav1.Condition `json:"conditions,omitempty" patchStrategy:"merge" patchMergeKey:"type"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced
// +kubebuilder:printcolumn:name="Enforce",type=string,JSONPath=".spec.enforcement"
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"
type ConftestPolicy struct {
    metav1.TypeMeta   `json:",inline"`
    metav1.ObjectMeta `json:"metadata,omitempty"`

    Spec   ConftestPolicySpec   `json:"spec,omitempty"`
    Status ConftestPolicyStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type ConftestPolicyList struct {
    metav1.TypeMeta `json:",inline"`
    metav1.ListMeta `json:"metadata,omitempty"`
    Items           []ConftestPolicy `json:"items"`
}
```

A small controller (or webhook) compiles each `ConftestPolicy` and writes a `Ready`
condition (`True`/compiled-ok, `False`/compile-error with the Rego error in the message).
A policy that does not compile can never be enforced; the gate treats a missing/`False`
`Ready` referenced policy as a **blocking** violation ("policy not ready").

### Binding: `ApplicationSpec.ConftestPolicies`

Add to `ApplicationSpec`:

```go
    // ConftestPolicies are Rego policies evaluated against rendered manifests before each
    // promotion. References are namespace-scoped. A missing or not-Ready policy blocks
    // promotion.
    // +optional
    ConftestPolicies []ConftestPolicyRef `json:"conftestPolicies,omitempty"`
```

```go
// ConftestPolicyRef references a ConftestPolicy by name in the Application's namespace.
type ConftestPolicyRef struct {
    // Name of the ConftestPolicy.
    // +kubebuilder:validation:Required
    // +kubebuilder:validation:MinLength=1
    Name string `json:"name"`
}
```

References are namespace-scoped (the Application's namespace), consistent with the
governance project boundary.

## Evaluator

New package `internal/conftest`:

```go
package conftest

// Policy is a compiled policy ready for evaluation.
type Policy struct {
    UID       types.UID
    Generation int64
    Enforcement governance.ConftestEnforcementMode // re-export or alias from v1alpha1
    Parameters  map[string]string
    // compiled *rego.Rego or cached prepared query (internal)
}

// Evaluator compiles and evaluates ConftestPolicies against rendered manifests.
type Evaluator struct {
    client client.Client
    cache  map[types.UID]*compiledEntry
    mu     sync.RWMutex
}

func NewEvaluator(c client.Client) *Evaluator

// LoadPolicies resolves and compiles the referenced policies. Policies that fail to
// compile or are not Ready are returned as blocking Violations ("policy <name> not ready"
// / "<name>: <compile error>").
func (e *Evaluator) LoadPolicies(ctx context.Context, namespace string, refs []paprikav1.ConftestPolicyRef) ([]Policy, governance.Violations, error)

// Evaluate runs the policies against the manifest objects and returns Violations.
// deny/violation rules on an `enforce` policy -> Blocking.
// deny/violation rules on a `warn` policy     -> Warnings.
// warn rules on any policy                    -> Warnings.
func (e *Evaluator) Evaluate(ctx context.Context, policies []Policy, manifests []*unstructured.Unstructured) (governance.Violations, error)
```

### Evaluation engine

Uses the Open Policy Agent **in-process** (`github.com/open-policy-agent/opa/rego`), with
**conftest rule conventions**:

- Rule sets named `deny`, `warn`, and `violation`.
- `violation` rules are treated as `deny` (conftest compatibility).
- Each manifest object is provided as `input` (one evaluation per object), matching how
  conftest iterates documents. `input.parameters` carries the policy's parameter map.

The conftest Go module (`github.com/open-policy-agent/conftest`) is added to `go.mod` and
its `parser`/`output` packages are used where they aid multi-doc handling and result
shaping; the evaluation itself uses OPA's `rego` package, exactly as conftest does
internally. No subprocess is spawned (consistent with the in-process Helm migration).

### Caching

Compiled policies are cached keyed by `(UID, Generation)`. On each `LoadPolicies`, entries
whose generation is unchanged are reused; changed/missing entries are recompiled. The cache
keeps compile cost off the reconcile hot path.

### Error mapping

- Compile error on a referenced policy → blocking `Violation` (message includes the Rego
  compile error and policy name). Promotion is blocked until the policy is fixed.
- Referenced policy not found → blocking `Violation` ("conftest policy <name> not found").
- Evaluation internal error (should not happen after successful compile) → returned as the
  Go `error` from `Evaluate`; the release controller surfaces it as a reconcile error and
  requeues.

## Controller Integration

### Consumer-side interface

Mirror the `GateExecutor` pattern. In the `pipelines` package:

```go
// ConftestEvaluator evaluates ConftestPolicies against rendered manifests.
type ConftestEvaluator interface {
    LoadPolicies(ctx context.Context, namespace string, refs []paprikav1.ConftestPolicyRef) ([]conftest.Policy, governance.Violations, error)
    Evaluate(ctx context.Context, policies []conftest.Policy, manifests []*unstructured.Unstructured) (governance.Violations, error)
}
```

Add to `ReleaseReconciler`:

```go
    ConftestEvaluator ConftestEvaluator
```

### New gate: `runConftestGate`

In `release_controller.go`, invoked in the pre-promotion path **immediately after**
`runGovernanceGate` (both are manifest validations; governance first because it is the
project-boundary check):

```go
func (r *ReleaseReconciler) runConftestGate(ctx context.Context, release *paprikav1.Release, app *paprikav1.Application, manifestObjects []*unstructured.Unstructured) error
```

Behavior:

1. If `r.ConftestEvaluator == nil` or `len(app.Spec.ConftestPolicies) == 0`, return nil
   (gate disabled).
2. `LoadPolicies(ctx, release.Namespace, app.Spec.ConftestPolicies)`. Load-time blocking
   violations abort promotion with a `ConftestPassed=False` condition and a Warning event.
3. `Evaluate(...)`. On blocking violations, set
   `ConftestPassed=False, Reason=PolicyViolation`, emit a Warning event with the first
   violation message, patch release status, and return a blocking error (promotion aborts).
   On warnings only, set `ConftestPassed=True, Reason=PassedWithWarnings`.
   On a clean pass, set `ConftestPassed=True, Reason=Passed`.

`runConftestGate` is called in both promotion entry points that currently call
`runGovernanceGate` (the canary/blue-green path and the direct-apply path) so policy is
enforced regardless of rollout strategy.

### Reuse of existing helpers

- `setReleaseGovernanceCondition`-style helper is generalized (or a thin
  `setReleaseConftestCondition` sibling is added) to set the `ConftestPassed` condition.
- Violation messages flow through the existing `patchReleaseStatus` + `EventRecorder` path
  used by the governance gate.

## Status Conditions

New release condition type `ConftestPassed`:

| Type            | Status | Reason             | Meaning                                            |
|-----------------|--------|--------------------|----------------------------------------------------|
| ConftestPassed  | True   | Passed             | All conftest policies passed                       |
| ConftestPassed  | True   | PassedWithWarnings | Policies passed; one or more warnings recorded     |
| ConftestPassed  | False  | PolicyViolation    | One or more enforce policies denied promotion      |
| ConftestPassed  | False  | PolicyNotReady     | A referenced policy failed to compile / is missing |

When the gate is disabled (no policies / evaluator nil), no condition is written.

`ConftestPolicy.Status.Conditions` carries `Ready` (`True`=compiled, `False`=compile error).

## RBAC

```go
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=conftestpolicies,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=conftestpolicies/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=events.k8s.io,resources=events,verbs=create;patch
```

These are added to the release controller and the small conftest-policy controller.

## Safety

- The gate only ever *blocks* promotion; it never mutates manifests or cluster state.
- A referenced policy that does not compile blocks promotion (fail-closed) rather than
  silently passing.
- Enforcement mode is per-policy: a `warn` policy can never block promotion.
- Evaluation is bounded by the reconcile context; long-running policies are cancelled on
  context timeout and surface as a reconcile error (requeue), not a silent pass.
- Policies are namespace-scoped and subject to the existing governance project boundary; a
  Release cannot reference a `ConftestPolicy` outside its Application's namespace.
- Idempotent: re-evaluating the same manifests + policies yields the same result and the
  same status condition.

## Testing Plan

### Unit tests

- `internal/conftest/evaluator_test.go`:
  - `enforce` policy with a `deny` rule matching a manifest → Blocking violation.
  - `enforce` policy with a `violation` rule → treated as deny (Blocking).
  - `warn` policy with a `deny` rule → Warning, not blocking.
  - `warn` rule on an `enforce` policy → Warning, not blocking.
  - Clean pass → no violations.
  - Compile error → blocking "not ready" violation; cache does not cache failed compiles.
  - Cache: bumping `generation` recompiles; unchanged generation reuses the entry.
  - `input.parameters` is accessible from Rego.
- `internal/controller/pipelines/conftest_gate_test.go`:
  - `runConftestGate` blocks on a violating enforce policy (`ConftestPassed=False`,
    promotion aborted).
  - Warn-only policy → `ConftestPassed=True, PassedWithWarnings`, promotion proceeds.
  - No policies / nil evaluator → no-op, no condition.
  - Missing referenced policy → blocking `PolicyNotReady`.

### Envtest / e2e tests

- A `ConftestPolicy` that denies Deployments missing `metadata.labels.app`:
  - Application referencing it: release is created, rendered manifests evaluated, release
    stays blocked (`Failed`/non-terminal) and the `ConftestPassed=False` condition is set.
- After fixing the manifest (or switching the policy to `warn`), promotion succeeds and the
  condition reflects the outcome.

### Verification commands

```bash
make manifests generate   # CRD + DeepCopy for ConftestPolicy
make lint
make test                 # unit + envtest
make test-e2e             # on an isolated Kind cluster (on-demand workflow)
```

## Generated Artifacts

After API + controller changes:

```bash
make manifests generate
```

updates:

- `api/pipelines/v1alpha1/zz_generated.deepcopy.go`
- `config/crd/bases/pipelines.paprika.io_conftestpolicies.yaml`
- `charts/chart/templates/crd/conftestpolicies.pipelines.paprika.io.yaml`
- `config/rbac/role.yaml` (new conftestpolicies verbs)
- `config/samples/` (a sample `ConftestPolicy` + referencing Application)

No protobuf changes in v1 (no new API RPC; the gate surfaces via release conditions and
events). `PROJECT` gains the new API via `kubebuilder create api`.

## Dependencies

Add to `go.mod`:

- `github.com/open-policy-agent/opa` (rego engine)
- `github.com/open-policy-agent/conftest` (parser/output + rule conventions)

Both are well-maintained Apache-2.0 Go libraries with no CGO requirement.

## Open Questions

1. Should a `warn` policy that produces *no* rules matched still report `PassedWithWarnings`
   only when warnings exist? Yes — `PassedWithWarnings` requires ≥1 warning; otherwise
   `Passed`.
2. Should conftest policies support combining into a single Rego bundle across multiple
   `ConftestPolicy` objects? Out of scope for v1; each policy is compiled and evaluated
   independently.
3. CLI/UI surface for browsing violations? Out of scope; violations appear in release
   conditions and events. A dedicated view can follow.
