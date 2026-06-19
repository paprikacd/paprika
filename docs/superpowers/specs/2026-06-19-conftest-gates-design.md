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
- Policy parameterization. Each manifest object is provided to Rego as `input` (the standard
  conftest convention, so off-the-shelf conftest policies work unchanged). Injecting extra
  parameters via `input.parameters` or a `data` document is deferred (see Decisions).

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

A small controller (`ConftestPolicyReconciler`, see below) compiles each `ConftestPolicy`
and writes a `Ready` condition (`True`/compiled-ok, `False`/compile-error with the Rego
error in the message). This condition is **informational UX only** — the gate always
recompiles authoritatively via its own evaluator and is never gated by this status (see
*Source of Truth*).

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

New package `internal/conftest`. The public surface is a single method so consumers never
handle concrete compiled-policy types (mirroring how `GateExecutor` only references data
types, not the executor implementation):

```go
package conftest

// Evaluator resolves, compiles, and evaluates ConftestPolicies against rendered manifests.
// Compile errors and missing referenced policies are returned as blocking governance.Violations.
type Evaluator struct {
    client client.Client
    cache  map[types.UID]*compiledEntry // keyed by (UID, Generation)
    mu     sync.RWMutex
}

func NewEvaluator(c client.Client) *Evaluator

// Evaluate resolves and compiles the referenced policies and runs them against the manifest
// objects. It returns all violations across all policies/objects.
//
// deny/violation rules on an `enforce` policy -> Blocking violation.
// deny/violation rules on a `warn` policy     -> Warning violation.
// warn rules on any policy                    -> Warning violation.
//
// Compile errors and missing policies are returned as blocking Violations (fail-closed);
// post-compile evaluation engine errors are returned as the Go error.
func (e *Evaluator) Evaluate(ctx context.Context, namespace string, refs []paprikav1.ConftestPolicyRef, manifests []*unstructured.Unstructured) (governance.Violations, error)
```

`compiledEntry` (the compiled `*rego.Rego` / prepared query, the policy name, and its
`paprikav1.ConftestEnforcementMode`) is unexported and never escapes the package.

### Evaluation engine

Uses the Open Policy Agent **in-process** (`github.com/open-policy-agent/opa/rego`), with
**conftest rule conventions**:

- Rule sets named `deny`, `warn`, and `violation`.
- `violation` rules are treated as `deny` (conftest compatibility).
- **Input shape:** each manifest object is provided to Rego as `input`, one evaluation per
  object, matching how conftest iterates documents. This means off-the-shelf conftest
  policies (e.g. `deny { input.kind == "Deployment" }`) work unchanged. There is no
  `input.parameters` — OPA's `rego.Input()` takes a single value, which is the manifest
  object itself.

The conftest Go module (`github.com/open-policy-agent/conftest`) is added to `go.mod` and
its `parser`/`output` packages are used where they aid multi-doc handling and result
shaping; the evaluation itself uses OPA's `rego` package, exactly as conftest does
internally. No subprocess is spawned (consistent with the in-process Helm migration).

### Violation mapping

Each Rego result string maps to one `governance.Violation`. Note that
`Violation.Blocking()` keys off the **`Action`** field (`== PolicyActionEnforce`), not
`Severity`, so the evaluator MUST set `Action` correctly:

- `Violation.Rule` = the source `ConftestPolicy` name.
- `Violation.Message` = the Rego result string.
- `Violation.Severity` = the rule set that fired: `"deny"`, `"violation"`, or `"warn"`
  (informational; does not drive blocking). **Compile errors and missing policies use the
  sentinel `Severity = "not-ready"`** so the gate can distinguish an incomplete evaluation
  from a real policy denial (see `runConftestGate` reason selection).
- `Violation.Action` = `governance.PolicyActionEnforce` for a `deny`/`violation` rule on an
  **`enforce`** policy (so `.Blocking()` is true), and for compile errors / missing policies
  (fail-closed); `governance.PolicyActionWarn` for `warn` rules and for `deny`/`violation`
  rules on a **`warn`** policy (so they land in `.Warnings()`).

This keeps conftest results flowing through the existing `Blocking()` / `Warnings()`
collectors used by the governance gate.

### Caching

Compiled policies are cached keyed by `(UID, Generation)`. On each `Evaluate`, entries whose
generation is unchanged are reused; changed/missing entries are recompiled. The cache keeps
compile cost off the reconcile hot path. Failed compiles are **not** cached (so a fixed
policy takes effect on the next reconcile). The cache is keyed by `UID`, so its size is
bounded by the number of `ConftestPolicy` objects in the cluster; entries for deleted
policies are pruned lazily on cache miss during `Evaluate`.

### Error mapping

- Compile error on a referenced policy → blocking `Violation` (message includes the Rego
  compile error and policy name). Promotion is blocked until the policy is fixed.
- Referenced policy not found → blocking `Violation` ("conftest policy <name> not found").
- Evaluation engine error after a successful compile (should not happen) → returned as the
  Go `error` from `Evaluate`; the release controller surfaces it as a reconcile error and
  requeues.

## Controller Integration

### Consumer-side interface

Mirror the `GateExecutor` pattern. In the `pipelines` package, a single-method interface so
the consumer never depends on concrete `conftest` types:

```go
// ConftestEvaluator resolves, compiles, and evaluates ConftestPolicies against rendered
// manifests. Compile errors and missing policies are returned as blocking governance.Violations.
type ConftestEvaluator interface {
    Evaluate(ctx context.Context, namespace string, refs []paprikav1.ConftestPolicyRef, manifests []*unstructured.Unstructured) (governance.Violations, error)
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
2. `violations, err := r.ConftestEvaluator.Evaluate(ctx, release.Namespace, app.Spec.ConftestPolicies, manifestObjects)`.
3. Partition `violations` via `.Blocking()` / `.Warnings()`:
   - Blocking non-empty → this is a **gate-decided abort** (distinct from an unexpected
     failure in step 2). Choose the condition reason from the blocking violations:
     `PolicyNotReady` if **any** blocking violation is a not-ready type
     (`Severity == "not-ready"` — compile error or missing policy, where evaluation was
     incomplete); otherwise `PolicyViolation`. Set `ConftestPassed=False` with that reason,
     emit a Warning event with the first blocking violation's message, patch release status,
     and return a blocking error so promotion aborts. The release stays in its current
     (non-terminal) phase and retries on the next reconcile; fixing the policy or manifest
     auto-resumes promotion.
   - Warnings only → set `ConftestPassed=True, Reason=PassedWithWarnings`, promotion proceeds.
   - Clean → set `ConftestPassed=True, Reason=Passed`, promotion proceeds.
4. A non-nil `err` from step 2 is an **unexpected engine failure**, not a gate decision:
     set no condition, surface it as a reconcile error, and requeue (do not mark the release
     terminal). This keeps "policy said no" (condition set, abort) separate from "evaluator
     broke" (no condition, requeue).

### Hook sites

`runGovernanceGate` is currently called at three sites in `release_controller.go`, and all
three precede a manifest apply to the cluster:

- `:692` — the direct-promote path.
- `:1852` — `applyCanaryWeight`, which **re-renders** templates with `canaryWeight`
  injected, parses fresh manifest objects, and **calls `applyManifestsForCluster`** — so
  the weight-step manifests are genuinely applied, not merely traffic tuning.
- `:1898` — `promoteCanary` (new revision about to be applied).

Because every one of these paths applies manifests that a Rego policy may need to gate
(e.g. a policy that branches on `canaryWeight`), `runConftestGate` is called at **all three
sites, immediately after the corresponding `runGovernanceGate` call** — mirroring governance
exactly, with no divergence to keep track of. There is no skipped path.

### Reuse of existing helpers

- A thin `setReleaseConftestCondition(release, passed bool, reason, msg string)` sibling of
  `setReleaseGovernanceCondition` sets the `ConftestPassed` condition.
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
This is **informational UX only**; it never gates promotion (see Source of Truth below).

### Source of truth: a single compiler

There are two places that compile Rego — the `ConftestPolicy` status controller (which writes
`Ready`) and the `Evaluator` cache (used by the gate). To avoid ambiguity:

- The **gate's `Evaluator.Evaluate` is authoritative.** It always compiles fresh (or from
  its `(UID, Generation)` cache) and its result decides promotion, fail-closed.
- The status controller's `Ready` condition is best-effort operator feedback and is **never
  read** by `runConftestGate`. A stale `Ready=False` therefore cannot block promotion if the
  policy actually compiles, and a stale `Ready=True` cannot unblock a policy that fails to
  compile. This removes all precedence ambiguity between the two compilers.

## RBAC

On the **release controller** (`release_controller.go`) — needed because its
`ConftestEvaluator` reads policies via the manager client:

```go
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=conftestpolicies,verbs=get;list;watch
```

On the **`ConftestPolicyReconciler`** (status controller) — additionally writes status:

```go
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=conftestpolicies,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=conftestpolicies/status,verbs=get;update;patch
```

Both controllers share the events permission:

```go
// +kubebuilder:rbac:groups=events.k8s.io,resources=events,verbs=create;patch
```

## ConftestPolicy status controller

A small **controller** (`ConftestPolicyReconciler` in
`internal/controller/pipelines/conftest_policy_controller.go`) — not a webhook — watches
`ConftestPolicy` create/update, compiles the Rego, and writes the `Ready` condition (and
`observedGeneration`). A controller is chosen over a webhook because it re-validates on OPA
upgrades, requires no webhook server/certs, and matches the rest of the codebase. It writes
status only; it never gates promotion.

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
  - Compile error → blocking violation; cache does not cache failed compiles.
  - Cache: bumping `generation` recompiles; unchanged generation reuses the entry.
  - `input` is the manifest object itself (a `deny` rule keyed on `input.kind` matches).
- `internal/controller/pipelines/conftest_gate_test.go`:
  - `runConftestGate` blocks on a violating enforce policy (`ConftestPassed=False`,
    promotion aborted, release left in its non-terminal phase).
  - Warn-only policy → `ConftestPassed=True, PassedWithWarnings`, promotion proceeds.
  - No policies / nil evaluator → no-op, no condition.
  - Missing referenced policy → blocking `PolicyNotReady`.

### Envtest / e2e tests

- A `ConftestPolicy` that denies Deployments missing `metadata.labels.app`:
  - Application referencing it: release is created, rendered manifests evaluated, promotion
    is blocked — the release is **not** advanced to a terminal phase; it remains retryable
    and the `ConftestPassed=False` condition is set.
- After fixing the manifest (or switching the policy to `warn`), the next reconcile
  re-evaluates, promotion succeeds, and the condition reflects the outcome.

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

Both are well-maintained Apache-2.0 Go libraries with no CGO requirement. Note: OPA pulls a
large transitive tree (Rego VM, AST, parser) that will noticeably grow the manager binary;
this is an accepted cost of in-process policy evaluation and is preferable to a subprocess.

## Decisions

1. A policy (enforce or warn) that produces *no* rule matches reports `Passed` (not
   `PassedWithWarnings`). `PassedWithWarnings` requires ≥1 warning; otherwise `Passed`.
2. Each `ConftestPolicy` is compiled and evaluated independently. Combining multiple policies
   into a single Rego bundle is out of scope for v1.
3. Violations surface via release conditions and events only. A dedicated CLI/UI view for
   browsing violations can follow; no new API RPC in v1.
4. Policy parameterization (exposing extra values to Rego beyond the manifest `input`) is
   deferred. v1 gives each policy the manifest object as `input`, matching standard conftest
   policies.
