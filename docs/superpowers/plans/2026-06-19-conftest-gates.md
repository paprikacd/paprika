# Conftest / OPA Gates Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-authored Rego policy gates that evaluate rendered manifests before every Release promotion, blocking (or warning on) violations.

**Architecture:** A new `ConftestPolicy` CRD holds inline Rego; an Application binds policies by name via `spec.conftestPolicies`. A new `internal/conftest.Evaluator` compiles (cached by UID+generation) and evaluates policies in-process via OPA `rego` using conftest rule conventions (`deny`/`warn`/`violation`), returning the existing `governance.Violations`. The release controller calls `runConftestGate` immediately after `runGovernanceGate` at all three governance sites. A small `ConftestPolicyReconciler` writes an informational `Ready` condition.

**Tech Stack:** Go 1.26, kubebuilder v4 (multigroup), controller-runtime, `github.com/open-policy-agent/opa/rego` (+ `ast`), Ginkgo e2e, plain-Go table tests + fake client for unit tests.

**Spec:** `docs/superpowers/specs/2026-06-19-conftest-gates-design.md`

---

## File Structure

**Create:**
- `api/pipelines/v1alpha1/conftest_types.go` — `ConftestPolicy` / `ConftestPolicyList` / `ConftestEnforcementMode` / spec+status types.
- `internal/conftest/evaluator.go` — `Evaluator` (compile + cache + evaluate), exported `CompilePolicy` helper, violation mapping.
- `internal/conftest/evaluator_test.go` — table-driven unit tests pinning evaluator behavior.
- `internal/controller/pipelines/conftest_gate.go` — `ConftestEvaluator` interface, `runConftestGate`, `setReleaseConftestCondition`, reason consts.
- `internal/controller/pipelines/conftest_gate_test.go` — `runConftestGate` unit tests with a hand-rolled fake evaluator.
- `internal/controller/pipelines/conftest_policy_controller.go` — `ConftestPolicyReconciler` (status `Ready`).
- `config/samples/pipelines_v1alpha1_conftestpolicy.yaml` — sample CR.

**Modify:**
- `api/pipelines/v1alpha1/application_types.go` — add `ConftestPolicyRef` + `ApplicationSpec.ConftestPolicies`.
- `internal/controller/pipelines/release_controller.go` — add `ConftestEvaluator` field; insert `runConftestGate` calls after the 3 `runGovernanceGate` sites; add reason consts.
- `cmd/main_controllers.go` — wire `ConftestEvaluator` into the release reconciler; register `ConftestPolicyReconciler`.
- `go.mod` / `go.sum` — add `github.com/open-policy-agent/opa`.
- `PROJECT`, `config/crd/bases/*`, `config/rbac/role.yaml`, `charts/chart/templates/crd/*`, `api/pipelines/v1alpha1/zz_generated.deepcopy.go` — regenerated (DO NOT EDIT by hand).

**Design rules:** the gate is fail-closed (compile error / missing policy blocks promotion), never mutates manifests, and is idempotent. The `internal/conftest` package owns compilation; the controller owns orchestration and status.

---

## Chunk 1: CRD types + Application binding

### Task 1: Scaffold the ConftestPolicy API

**Files:**
- Create: `api/pipelines/v1alpha1/conftest_types.go`
- Create: `internal/controller/pipelines/conftestpolicy_controller.go` (scaffold only — replaced in Chunk 4)

- [ ] **Step 1: Scaffold via kubebuilder**

```bash
kubebuilder create api --group pipelines --version v1alpha1 --kind ConftestPolicy
```

Answer `Create Resource [y/n]` → `y`; `Create Controller [y/n]` → `y`.

Expected: new files under `api/pipelines/v1alpha1/conftest_types.go` and `internal/controller/pipelines/conftestpolicy_controller.go`, plus a `PROJECT` entry.

- [ ] **Step 2: Verify scaffold compiles**

Run: `go build ./...`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add api/ internal/controller/pipelines/conftestpolicy_controller.go PROJECT
git commit -m "feat(conftest): scaffold ConftestPolicy CRD and controller"
```

### Task 2: Define the ConftestPolicy types

**Files:**
- Modify: `api/pipelines/v1alpha1/conftest_types.go`

- [ ] **Step 1: Replace the scaffolded types with the spec definition**

Overwrite `conftest_types.go` with:

```go
package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

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
// manifests before promotion. The Rego source must declare a package and define rule
// sets named `deny`, `warn`, and/or `violation` (conftest convention); `violation` is
// treated as `deny`.
type ConftestPolicySpec struct {
	// Rego is the policy source. Must declare a package and define `deny`, `warn`,
	// and/or `violation` rule sets that return string messages.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Rego string `json:"rego"`

	// Enforcement controls whether violations block promotion (enforce) or only warn.
	// +kubebuilder:default=enforce
	// +optional
	Enforcement ConftestEnforcementMode `json:"enforcement,omitempty"`
}

// ConftestPolicyStatus reports the last compilation outcome for operator UX.
type ConftestPolicyStatus struct {
	// ObservedGeneration is the most recent generation observed.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// Conditions reflect compile readiness. Type "Ready": True = compiled, False = error.
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

Keep the scaffolded `schemeBuilder`/`addKnownTypes` registration block at the bottom of the file (kubebuilder generated it). Do not hand-write DeepCopy methods — Task 4 regenerates them.

- [ ] **Step 2: Verify it builds (DeepCopy will be missing — that's expected until Task 4)**

Run: `go vet ./api/...` — expect a DeepCopy-related complaint; that's fine for now.

- [ ] **Step 3: Commit**

```bash
git add api/pipelines/v1alpha1/conftest_types.go
git commit -m "feat(conftest): define ConftestPolicy spec/status types"
```

### Task 3: Add Application binding

**Files:**
- Modify: `api/pipelines/v1alpha1/application_types.go`

- [ ] **Step 1: Add the ref type and the ApplicationSpec field**

In `application_types.go`, add near the other ref/`ApprovalGate` types:

```go
// ConftestPolicyRef references a ConftestPolicy by name in the Application's namespace.
type ConftestPolicyRef struct {
	// Name of the ConftestPolicy.
	// +kubebuilder:validation:Required
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`
}
```

Add to `ApplicationSpec` (next to `ApprovalGates`):

```go
	// ConftestPolicies are Rego policies evaluated against rendered manifests before each
	// promotion. References are namespace-scoped. A missing or uncompilable policy blocks
	// promotion (fail-closed).
	// +optional
	ConftestPolicies []ConftestPolicyRef `json:"conftestPolicies,omitempty"`
```

- [ ] **Step 2: Commit**

```bash
git add api/pipelines/v1alpha1/application_types.go
git commit -m "feat(conftest): add ApplicationSpec.conftestPolicies binding"
```

### Task 4: Regenerate artifacts and verify the CRD

**Files (regenerated, DO NOT EDIT):** `api/pipelines/v1alpha1/zz_generated.deepcopy.go`, `config/crd/bases/pipelines.paprika.io_conftestpolicies.yaml`, `config/rbac/role.yaml`

- [ ] **Step 1: Regenerate**

Run: `make manifests generate`
Expected: completes without error; `zz_generated.deepcopy.go` gains `ConftestPolicy` methods; a new CRD YAML appears under `config/crd/bases/`; the Application CRD gains the `conftestPolicies` field.

- [ ] **Step 2: Sanity-check the generated CRD**

Run: `grep -n "conftestPolicies" config/crd/bases/pipelines.paprika.io_applications.yaml`
Expected: at least one match.

- [ ] **Step 3: Verify the full build**

Run: `go build ./... && go vet ./...`
Expected: clean.

- [ ] **Step 4: Commit generated artifacts**

```bash
git add api/ config/ PROJECT
git commit -m "feat(conftest): regenerate CRD, DeepCopy, RBAC for ConftestPolicy"
```

---

## Chunk 2: Conftest evaluator (`internal/conftest`)

### Task 5: Add the OPA dependency

**Files:** `go.mod`, `go.sum`

- [ ] **Step 1: Add OPA**

Run: `go get github.com/open-policy-agent/opa@latest`

- [ ] **Step 2: Verify it resolves**

Run: `go mod tidy && go build ./...`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add go.mod go.sum
git commit -m "feat(conftest): add open-policy-agent/opa dependency"
```

### Task 6: Write the failing evaluator tests

**Files:**
- Create: `internal/conftest/evaluator_test.go`

The evaluator contract (from the spec):
- `enforce` policy `deny`/`violation` match → Blocking violation.
- `warn` policy `deny` → Warning (not blocking).
- `warn` rule on `enforce` policy → Warning.
- clean pass → no violations.
- compile error → blocking Violation with `Severity == "not-ready"`; not cached.
- missing referenced policy → blocking Violation, `Severity == "not-ready"`.
- bumping the policy `Generation` recompiles; unchanged generation reuses the cache.
- `input` is the manifest object (a `deny` rule keyed on `input.kind` matches).

- [ ] **Step 1: Write `evaluator_test.go`**

```go
package conftest

import (
	"context"
	"testing"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

const (
	denyMissingLabel = `package main
deny[msg] {
	input.kind == "Deployment"
	not input.metadata.labels.app
	msg := "Deployment missing app label"
}
`
	violateBadImage = `package main
violation[msg] {
	input.kind == "Deployment"
	input.spec.template.spec.containers[_].image == "bad:latest"
	msg := "uses bad image"
}
`
	warnNoLimits = `package main
warn[msg] {
	input.kind == "Deployment"
	not input.spec.template.spec.containers[0].resources.limits
	msg := "no cpu/memory limits"
}
`
	brokenRego = `package main
deny { syntax error here
`
)

func deployment(name string, labels map[string]string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetKind("Deployment")
	u.SetAPIVersion("apps/v1")
	u.SetName(name)
	u.SetLabels(labels)
	return u
}

func makePolicy(name, rego string, enforcement paprikav1.ConftestEnforcementMode, gen int64) *paprikav1.ConftestPolicy {
	p := &paprikav1.ConftestPolicy{Spec: paprikav1.ConftestPolicySpec{Rego: rego, Enforcement: enforcement}}
	p.SetName(name)
	p.SetUID(types.UID(name + "-uid"))
	p.SetGeneration(gen)
	p.SetGroupVersionKind(paprikav1.GroupVersion.WithKind("ConftestPolicy"))
	return p
}

func TestEvaluate(t *testing.T) {
	cases := []struct {
		name       string
		policy     *paprikav1.ConftestPolicy
		manifests  []*unstructured.Unstructured
		wantBlock  int
		wantWarn   int
		wantErr    bool
	}{
		{
			name:      "enforce deny blocks on missing label",
			policy:    makePolicy("p", denyMissingLabel, paprikav1.ConftestEnforce, 1),
			manifests: []*unstructured.Unstructured{deployment("d1", nil)},
			wantBlock: 1,
		},
		{
			name:      "enforce deny passes when label present",
			policy:    makePolicy("p", denyMissingLabel, paprikav1.ConftestEnforce, 1),
			manifests: []*unstructured.Unstructured{deployment("d1", map[string]string{"app": "x"})},
			wantBlock: 0,
		},
		{
			name:      "violation rule treated as deny and blocks",
			policy:    makePolicy("p", violateBadImage, paprikav1.ConftestEnforce, 1),
			manifests:  []*unstructured.Unstructured{deploymentWithImage("d1", "bad:latest")},
			wantBlock: 1,
		},
		{
			name:      "warn policy deny becomes warning not blocking",
			policy:    makePolicy("p", denyMissingLabel, paprikav1.ConftestWarn, 1),
			manifests: []*unstructured.Unstructured{deployment("d1", nil)},
			wantWarn:  1,
			wantBlock: 0,
		},
		{
			name:      "warn rule on enforce policy is warning not blocking",
			policy:    makePolicy("p", warnNoLimits, paprikav1.ConftestEnforce, 1),
			manifests: []*unstructured.Unstructured{deployment("d1", map[string]string{"app": "x"})},
			wantWarn:  1,
			wantBlock: 0,
		},
		{
			name:      "clean pass no violations",
			policy:    makePolicy("p", denyMissingLabel, paprikav1.ConftestEnforce, 1),
			manifests: []*unstructured.Unstructured{deployment("d1", map[string]string{"app": "x"})},
			wantBlock: 0,
			wantWarn:  0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scheme := runtime.NewScheme()
			require.NoError(t, paprikav1.AddToScheme(scheme))
			c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(tc.policy).Build()
			e := NewEvaluator(c)
			vs, err := e.Evaluate(context.Background(), "default",
				[]paprikav1.ConftestPolicyRef{{Name: tc.policy.Name}}, tc.manifests)
			if tc.wantErr {
				require.Error(t, err)
				return
			}
			require.NoError(t, err)
			assert.Len(t, vs.Blocking(), tc.wantBlock, "blocking")
			assert.Len(t, vs.Warnings(), tc.wantWarn, "warnings")
		})
	}
}

func TestEvaluateMissingPolicyIsBlockingNotReady(t *testing.T) {
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	e := NewEvaluator(fake.NewClientBuilder().WithScheme(scheme).Build())
	vs, err := e.Evaluate(context.Background(), "default",
		[]paprikav1.ConftestPolicyRef{{Name: "ghost"}}, []*unstructured.Unstructured{deployment("d", nil)})
	require.NoError(t, err)
	blocking := vs.Blocking()
	require.Len(t, blocking, 1)
	assert.Equal(t, "not-ready", blocking[0].Severity)
	assert.Equal(t, governance.PolicyActionEnforce, blocking[0].Action)
}

func TestEvaluateCompileErrorIsBlockingNotReady(t *testing.T) {
	p := makePolicy("bad", brokenRego, paprikav1.ConftestEnforce, 1)
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(p).Build()
	e := NewEvaluator(c)
	vs, err := e.Evaluate(context.Background(), "default",
		[]paprikav1.ConftestPolicyRef{{Name: "bad"}}, []*unstructured.Unstructured{deployment("d", nil)})
	require.NoError(t, err)
	blocking := vs.Blocking()
	require.Len(t, blocking, 1)
	assert.Equal(t, "not-ready", blocking[0].Severity)
}

func TestCacheRecompilesOnGenerationBump(t *testing.T) {
	p := makePolicy("p", denyMissingLabel, paprikav1.ConftestEnforce, 1)
	scheme := runtime.NewScheme()
	require.NoError(t, paprikav1.AddToScheme(scheme))
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(p).Build()
	e := NewEvaluator(c)
	// First eval compiles.
	_, err := e.Evaluate(context.Background(), "default",
		[]paprikav1.ConftestPolicyRef{{Name: "p"}}, []*unstructured.Unstructured{deployment("d", nil)})
	require.NoError(t, err)
	require.Len(t, e.cache, 1, "expected a cached entry")

	// Bump generation; the cache entry should be replaced.
	p.SetGeneration(2)
	require.NoError(t, c.Update(context.Background(), p))
	_, err = e.Evaluate(context.Background(), "default",
		[]paprikav1.ConftestPolicyRef{{Name: "p"}}, []*unstructured.Unstructured{deployment("d", nil)})
	require.NoError(t, err)
	require.Len(t, e.cache, 1)
	require.Equal(t, int64(2), e.cache[p.UID].generation)
}

func deploymentWithImage(name, image string) *unstructured.Unstructured {
	u := deployment(name, map[string]string{"app": "x"})
	u.Object["spec"] = map[string]interface{}{
		"template": map[string]interface{}{
			"spec": map[string]interface{}{
				"containers": []interface{}{
					map[string]interface{}{"name": "c", "image": image},
				},
			},
		},
	}
	return u
}

// silence unused import of metav1 when not otherwise referenced
var _ metav1.ObjectMeta
```

> NOTE on `e.cache` access: the test reaches into the unexported `cache` map. Because the test is in `package conftest` (white-box), this is allowed. If the implementer prefers black-box, expose a small `CachedGenerations() map[types.UID]int64` test helper instead.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/conftest/...`
Expected: FAIL — `NewEvaluator` and `Evaluate` do not exist yet.

- [ ] **Step 3: Commit the failing tests**

```bash
git add internal/conftest/evaluator_test.go
git commit -m "test(conftest): add evaluator behavior tests (red)"
```

### Task 7: Implement the evaluator

**Files:**
- Create: `internal/conftest/evaluator.go`

- [ ] **Step 1: Write `evaluator.go`**

```go
// Package conftest compiles and evaluates user-authored Rego policies against rendered
// manifests using OPA in-process with conftest rule conventions (deny / warn / violation).
package conftest

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/open-policy-agent/opa/ast"
	"github.com/open-policy-agent/opa/rego"
	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

const (
	ruleDeny        = "deny"
	ruleWarn        = "warn"
	ruleViolation   = "violation"
	severityNotReady = "not-ready"
	moduleName      = "policy.rego"
)

type compiledEntry struct {
	name        string
	generation  int64
	enforcement paprikav1.ConftestEnforcementMode
	queries     map[string]*rego.PreparedEvalQuery // keyed by rule (deny/warn/violation)
}

// Evaluator resolves, compiles (cached by UID+generation), and evaluates ConftestPolicies.
type Evaluator struct {
	client client.Client
	mu     sync.RWMutex
	cache  map[types.UID]*compiledEntry
}

// NewEvaluator returns an Evaluator that reads ConftestPolicy objects via c.
func NewEvaluator(c client.Client) *Evaluator {
	return &Evaluator{client: c, cache: make(map[types.UID]*compiledEntry)}
}

// Evaluate resolves, compiles, and evaluates the referenced policies against the manifests.
// Compile errors and missing referenced policies are returned as blocking governance.Violations
// (Severity == "not-ready"). Post-compile engine errors are returned as the Go error.
func (e *Evaluator) Evaluate(ctx context.Context, namespace string, refs []paprikav1.ConftestPolicyRef, manifests []*unstructured.Unstructured) (governance.Violations, error) {
	var out governance.Violations
	for _, ref := range refs {
		entry, loadViolations, err := e.load(ctx, namespace, ref)
		if err != nil {
			return nil, fmt.Errorf("load conftest policy %q: %w", ref.Name, err)
		}
		out = append(out, loadViolations...)
		if entry == nil {
			continue
		}
		for _, obj := range manifests {
			vs, err := entry.eval(ctx, obj)
			if err != nil {
				return nil, fmt.Errorf("evaluate conftest policy %q: %w", ref.Name, err)
			}
			out = append(out, vs...)
		}
	}
	return out, nil
}

func (e *Evaluator) load(ctx context.Context, namespace string, ref paprikav1.ConftestPolicyRef) (*compiledEntry, governance.Violations, error) {
	var policy paprikav1.ConftestPolicy
	if err := e.client.Get(ctx, types.NamespacedName{Name: ref.Name, Namespace: namespace}, &policy); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, governance.Violations{{
				Rule: ref.Name, Severity: severityNotReady,
				Message: fmt.Sprintf("conftest policy %q not found", ref.Name),
				Action:  governance.PolicyActionEnforce,
			}}, nil
		}
		return nil, nil, err
	}

	e.mu.RLock()
	entry, ok := e.cache[policy.UID]
	e.mu.RUnlock()
	if ok && entry.generation == policy.Generation {
		return entry, nil, nil
	}

	compiled, err := CompilePolicy(ctx, policy.Name, policy.Spec.Rego)
	if err != nil {
		// Do not cache failed compiles so a fixed policy takes effect on the next reconcile.
		return nil, governance.Violations{{
			Rule: policy.Name, Severity: severityNotReady,
			Message: fmt.Sprintf("compile conftest policy %q: %v", policy.Name, err),
			Action:  governance.PolicyActionEnforce,
		}}, nil
	}
	compiled.generation = policy.Generation
	compiled.enforcement = enforcementOrDefault(policy.Spec.Enforcement)

	e.mu.Lock()
	e.cache[policy.UID] = compiled
	// Opportunistic pruning: drop cache entries whose UID is no longer present is the
	// caller's job; the map is bounded by the number of ConftestPolicy objects.
	e.mu.Unlock()
	return compiled, nil, nil
}

// CompilePolicy parses and compiles a Rego source, preparing deny/warn/violation queries.
// Exposed so the status controller can validate policies without re-implementing compilation.
func CompilePolicy(ctx context.Context, name, regoSrc string) (*compiledEntry, error) {
	mod, err := ast.ParseModule(moduleName, regoSrc)
	if err != nil {
		return nil, err
	}
	if mod == nil || mod.Package == nil {
		return nil, fmt.Errorf("rego source has no package declaration")
	}
	pkgPath := strings.TrimPrefix(mod.Package.Path.String(), "data.")

	entry := &compiledEntry{name: name, queries: map[string]*rego.PreparedEvalQuery{}}
	for _, rule := range []string{ruleDeny, ruleWarn, ruleViolation} {
		q := fmt.Sprintf("data.%s.%s", pkgPath, rule)
		pq, err := rego.New(rego.Module(moduleName, regoSrc), rego.Query(q)).PrepareForEval(ctx)
		if err != nil {
			return nil, err
		}
		pqCopy := pq
		entry.queries[rule] = &pqCopy
	}
	return entry, nil
}

func enforcementOrDefault(m paprikav1.ConftestEnforcementMode) paprikav1.ConftestEnforcementMode {
	if m == "" {
		return paprikav1.ConftestEnforce
	}
	return m
}

func (e *compiledEntry) eval(ctx context.Context, obj *unstructured.Unstructured) (governance.Violations, error) {
	var out governance.Violations
	for _, rule := range []string{ruleDeny, ruleViolation, ruleWarn} {
		pq := e.queries[rule]
		if pq == nil {
			continue
		}
		results, err := pq.Eval(ctx, rego.EvalInput(obj.Object))
		if err != nil {
			return nil, err
		}
		out = append(out, toViolations(e.name, rule, e.actionFor(rule), results)...)
	}
	return out, nil
}

func (e *compiledEntry) actionFor(rule string) governance.PolicyAction {
	if rule == ruleWarn {
		return governance.PolicyActionWarn
	}
	if e.enforcement == paprikav1.ConftestWarn {
		return governance.PolicyActionWarn
	}
	return governance.PolicyActionEnforce
}

func toViolations(policyName, severity string, action governance.PolicyAction, results rego.ResultSet) governance.Violations {
	var out governance.Violations
	for _, r := range results {
		for _, expr := range r.Expressions {
			list, ok := expr.Value.([]interface{})
			if !ok {
				continue
			}
			for _, item := range list {
				msg, _ := item.(string)
				out = append(out, governance.Violation{
					Rule: policyName, Severity: severity, Message: msg, Action: action,
				})
			}
		}
	}
	return out
}
```

> **API verification note:** the implementer should confirm `rego.PreparedEvalQuery` is a value returned by `PrepareForEval` and that `rego.EvalInput(...)` is the correct input option for the pinned OPA version (run `go doc github.com/open-policy-agent/opa/rego PreparedEvalQuery` and `rego.EvalInput`). If `PrepareForEval` requires the query at construction (it does in current OPA), the code above is correct. If the pinned OPA version differs, adjust the query preparation while keeping the test contract intact.

- [ ] **Step 2: Run the tests to verify they pass**

Run: `go test ./internal/conftest/... -race`
Expected: PASS (all 5 top-level tests + subtests green, no race).

- [ ] **Step 3: Commit**

```bash
git add internal/conftest/evaluator.go
git commit -m "feat(conftest): implement in-process OPA evaluator with rule-convention mapping"
```

---

## Chunk 3: Gate integration in the release controller

### Task 8: Add the ConftestEvaluator interface and reconciler field

**Files:**
- Modify: `internal/controller/pipelines/conftest_gate.go` (new — create)
- Modify: `internal/controller/pipelines/release_controller.go` (struct field)

- [ ] **Step 1: Create `conftest_gate.go` with the interface and reason consts**

```go
package pipelines

import (
	"context"

	"github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// ConftestEvaluator resolves, compiles, and evaluates ConftestPolicies against rendered
// manifests. Compile errors and missing policies are returned as blocking governance.Violations.
type ConftestEvaluator interface {
	Evaluate(ctx context.Context, namespace string, refs []v1alpha1.ConftestPolicyRef, manifests []*unstructured.Unstructured) (governance.Violations, error)
}

const (
	conftestConditionType            = "ConftestPassed"
	conftestReasonPassed             = "Passed"
	conftestReasonPassedWithWarnings = "PassedWithWarnings"
	conftestReasonPolicyViolation    = "PolicyViolation"
	conftestReasonPolicyNotReady     = "PolicyNotReady"
	conftestSeverityNotReady         = "not-ready"
)
```

> NOTE: the import alias `v1alpha1` must match how `release_controller.go` imports the API package. Check the existing alias there (it is `paprikav1` in `release_controller.go`). Use the SAME alias when wiring to avoid two aliases. Adjust the interface signature's import accordingly: if `release_controller.go` uses `paprikav1`, declare the interface with `paprikav1.ConftestPolicyRef` and import as `paprikav1`. Confirm the alias before writing.

- [ ] **Step 2: Add the field to `ReleaseReconciler`**

In `release_controller.go`, add to the `ReleaseReconciler` struct (next to `PolicyEvaluator`):

```go
	ConftestEvaluator ConftestEvaluator
```

- [ ] **Step 3: Verify it builds**

Run: `go build ./internal/controller/pipelines/...`
Expected: clean (field is unused for now; that's fine).

- [ ] **Step 4: Commit**

```bash
git add internal/controller/pipelines/conftest_gate.go internal/controller/pipelines/release_controller.go
git commit -m "feat(conftest): add ConftestEvaluator interface and reconciler field"
```

### Task 9: Write the failing gate tests

**Files:**
- Create: `internal/controller/pipelines/conftest_gate_test.go`

- [ ] **Step 1: Write the test with a hand-rolled fake evaluator**

```go
package pipelines

import (
	"context"
	"errors"
	"testing"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type fakeConftestEvaluator struct {
	violations governance.Violations
	err        error
	calledRefs []paprikav1.ConftestPolicyRef
}

func (f *fakeConftestEvaluator) Evaluate(_ context.Context, _ string, refs []paprikav1.ConftestPolicyRef, _ []*unstructured.Unstructured) (governance.Violations, error) {
	f.calledRefs = refs
	return f.violations, f.err
}

func newReconcilerWithConftest(ev ConftestEvaluator) *ReleaseReconciler {
	r := NewReleaseReconciler(nil)
	r.ConftestEvaluator = ev
	return r
}

func TestRunConftestGateDisabled(t *testing.T) {
	r := NewReleaseReconciler(nil) // nil evaluator
	rel := &paprikav1.Release{}
	rel.SetGeneration(1)
	app := &paprikav1.Application{}
	require.NoError(t, r.runConftestGate(context.Background(), rel, app, nil))
	assert.Empty(t, rel.Status.Conditions)

	// evaluator set but no policies bound
	r2 := newReconcilerWithConftest(&fakeConftestEvaluator{})
	app2 := &paprikav1.Application{}
	require.NoError(t, r2.runConftestGate(context.Background(), rel, app2, nil))
}

func TestRunConftestGateBlocksOnEnforceViolation(t *testing.T) {
	ev := &fakeConftestEvaluator{violations: governance.Violations{
		{Rule: "p", Severity: "deny", Message: "no label", Action: governance.PolicyActionEnforce},
	}}
	r := newReconcilerWithConftest(ev)
	app := &paprikav1.Application{Spec: paprikav1.ApplicationSpec{ConftestPolicies: []paprikav1.ConftestPolicyRef{{Name: "p"}}}}
	rel := &paprikav1.Release{}
	rel.SetGeneration(1)
	err := r.runConftestGate(context.Background(), rel, app, nil)
	require.Error(t, err)
	// reason is PolicyViolation (no not-ready severity present)
	found := false
	for _, c := range rel.Status.Conditions {
		if c.Type == conftestConditionType && c.Reason == conftestReasonPolicyViolation {
			found = true
		}
	}
	assert.True(t, found, "expected PolicyViolation condition")
}

func TestRunConftestGateNotReadyWhenPolicyUncompilable(t *testing.T) {
	ev := &fakeConftestEvaluator{violations: governance.Violations{
		{Rule: "p", Severity: conftestSeverityNotReady, Message: "compile error", Action: governance.PolicyActionEnforce},
	}}
	r := newReconcilerWithConftest(ev)
	app := &paprikav1.Application{Spec: paprikav1.ApplicationSpec{ConftestPolicies: []paprikav1.ConftestPolicyRef{{Name: "p"}}}}
	rel := &paprikav1.Release{}
	rel.SetGeneration(1)
	err := r.runConftestGate(context.Background(), rel, app, nil)
	require.Error(t, err)
	found := false
	for _, c := range rel.Status.Conditions {
		if c.Type == conftestConditionType && c.Reason == conftestReasonPolicyNotReady {
			found = true
		}
	}
	assert.True(t, found, "expected PolicyNotReady condition")
}

func TestRunConftestGatePassesWithWarnings(t *testing.T) {
	ev := &fakeConftestEvaluator{violations: governance.Violations{
		{Rule: "p", Severity: "warn", Message: "soft", Action: governance.PolicyActionWarn},
	}}
	r := newReconcilerWithConftest(ev)
	app := &paprikav1.Application{Spec: paprikav1.ApplicationSpec{ConftestPolicies: []paprikav1.ConftestPolicyRef{{Name: "p"}}}}
	rel := &paprikav1.Release{}
	rel.SetGeneration(1)
	require.NoError(t, r.runConftestGate(context.Background(), rel, app, nil))
	found := false
	for _, c := range rel.Status.Conditions {
		if c.Type == conftestConditionType && c.Reason == conftestReasonPassedWithWarnings && c.Status == "True" {
			found = true
		}
	}
	assert.True(t, found, "expected PassedWithWarnings=True")
}

func TestRunConftestGateEngineErrorSurfacesNoCondition(t *testing.T) {
	ev := &fakeConftestEvaluator{err: errors.New("boom")}
	r := newReconcilerWithConftest(ev)
	app := &paprikav1.Application{Spec: paprikav1.ApplicationSpec{ConftestPolicies: []paprikav1.ConftestPolicyRef{{Name: "p"}}}}
	rel := &paprikav1.Release{}
	rel.SetGeneration(1)
	err := r.runConftestGate(context.Background(), rel, app, nil)
	require.Error(t, err)
	for _, c := range rel.Status.Conditions {
		assert.NotEqual(t, conftestConditionType, c.Type, "engine error must not set a conftest condition")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test ./internal/controller/pipelines/ -run TestRunConftestGate`
Expected: FAIL — `runConftestGate` does not exist.

- [ ] **Step 3: Commit the failing tests**

```bash
git add internal/controller/pipelines/conftest_gate_test.go
git commit -m "test(conftest): add runConftestGate behavior tests (red)"
```

### Task 10: Implement `runConftestGate`

**Files:**
- Modify: `internal/controller/pipelines/conftest_gate.go` (append the gate function + condition helper)

- [ ] **Step 1: Append the implementation to `conftest_gate.go`**

```go
import (
	"context"
	"fmt"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/governance"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/klog/v2"
)

// runConftestGate evaluates the application's ConftestPolicies against the rendered
// manifests. It is a no-op when the evaluator is nil or no policies are bound. Blocking
// violations abort promotion (fail-closed) and set a ConftestPassed=False condition; the
// release is left non-terminal so the next reconcile retries after the policy/manifest is
// fixed. A non-nil engine error is surfaced as a reconcile error WITHOUT setting a condition.
func (r *ReleaseReconciler) runConftestGate(ctx context.Context, release *paprikav1.Release, app *paprikav1.Application, manifests []*unstructured.Unstructured) error {
	if r.ConftestEvaluator == nil || len(app.Spec.ConftestPolicies) == 0 {
		return nil
	}
	log := klog.FromContext(ctx)

	violations, err := r.ConftestEvaluator.Evaluate(ctx, release.Namespace, app.Spec.ConftestPolicies, manifests)
	if err != nil {
		return fmt.Errorf("evaluate conftest policies: %w", err)
	}

	if blocking := violations.Blocking(); len(blocking) > 0 {
		reason := conftestReasonPolicyViolation
		for _, v := range blocking {
			if v.Severity == conftestSeverityNotReady {
				reason = conftestReasonPolicyNotReady
				break
			}
		}
		r.setReleaseConftestCondition(release, false, reason, blocking[0].Message)
		if r.EventRecorder != nil {
			r.EventRecorder.Eventf(release, corev1.EventTypeWarning, reason, "%s", blocking[0].Message)
		}
		if patchErr := r.patchReleaseStatus(ctx, release, release.Status.Phase); patchErr != nil {
			log.Error(patchErr, "Failed to patch release status after conftest violation",
				"release", release.Name, "namespace", release.Namespace)
		}
		return fmt.Errorf("conftest %s: %s", reason, blocking[0].Message)
	}

	if warnings := violations.Warnings(); len(warnings) > 0 {
		r.setReleaseConftestCondition(release, true, conftestReasonPassedWithWarnings,
			"Conftest checks passed with warnings: "+warnings[0].Message)
	} else {
		r.setReleaseConftestCondition(release, true, conftestReasonPassed, "Conftest checks passed")
	}
	return nil
}

func (r *ReleaseReconciler) setReleaseConftestCondition(release *paprikav1.Release, status bool, reason, message string) {
	conditionStatus := metav1.ConditionFalse
	if status {
		conditionStatus = metav1.ConditionTrue
	}
	metav1.SetStatusCondition(&release.Status.Conditions, metav1.Condition{
		Type:               conftestConditionType,
		Status:             conditionStatus,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: metav1.Now(),
	})
}
```

> Verify the imports match the file: `release_controller.go` uses `logf`/`klog` for logging and `meta` (from `k8s.io/apimachinery/pkg/api/meta`) for `SetStatusCondition`. Use the SAME packages the governance gate uses (see `setReleaseGovernanceCondition` at `release_controller.go:788`). If that helper uses `meta.SetStatusCondition`, use `meta` here too; if it uses `metav1.SetStatusCondition`, match that. Reconcile the import block so there is exactly one alias per package.

- [ ] **Step 2: Run the gate tests to verify they pass**

Run: `go test ./internal/controller/pipelines/ -run TestRunConftestGate -race`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add internal/controller/pipelines/conftest_gate.go
git commit -m "feat(conftest): implement runConftestGate with condition + fail-closed abort"
```

### Task 11: Hook the gate into all three governance sites

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go` (insert calls at ~692, ~1852, ~1898)

All three sites share the identical pattern:

```go
	app, err := r.runGovernanceGate(ctx, release, manifestObjects)
	if err != nil {
		return fmt.Errorf("run governance gate: %w", err)
	}
```

- [ ] **Step 1: Insert the conftest gate call after each of the three sites**

Immediately after each `runGovernanceGate` error-check block (at the three sites around lines 692, 1852, 1898), insert:

```go
	if err := r.runConftestGate(ctx, release, app, manifestObjects); err != nil {
		return fmt.Errorf("run conftest gate: %w", err)
	}
```

- [ ] **Step 2: Verify all three insertions**

Run: `grep -n "runConftestGate" internal/controller/pipelines/release_controller.go`
Expected: exactly 4 lines — 1 definition site reference is NOT in this file; expect 3 call sites here (plus the definition is in `conftest_gate.go`). So expect exactly 3 matches in `release_controller.go`.

- [ ] **Step 3: Build and run the full pipelines test suite**

Run: `go build ./... && go test ./internal/controller/pipelines/... -run TestRunConftestGate -race`
Expected: build clean, gate tests green.

- [ ] **Step 4: Commit**

```bash
git add internal/controller/pipelines/release_controller.go
git commit -m "feat(conftest): evaluate conftest policies at all three promotion sites"
```

---

## Chunk 4: Status controller, wiring, samples

### Task 12: Implement the ConftestPolicy status controller

**Files:**
- Modify: `internal/controller/pipelines/conftestpolicy_controller.go` (replace the kubebuilder scaffold)

- [ ] **Step 1: Replace the scaffolded reconciler**

```go
package pipelines

import (
	"context"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
	"github.com/benebsworth/paprika/internal/conftest"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
)

// ConftestPolicyReconciler compiles a ConftestPolicy and writes an informational Ready
// condition. It writes status only; it never gates promotion (the release controller's
// evaluator is authoritative — see the design spec, "Source of truth").
type ConftestPolicyReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=conftestpolicies,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=conftestpolicies/status,verbs=get;update;patch

func (r *ConftestPolicyReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := log.FromContext(ctx)

	var policy paprikav1.ConftestPolicy
	if err := r.Get(ctx, req.NamespacedName, &policy); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}

	_, compileErr := conftest.CompilePolicy(ctx, policy.Name, policy.Spec.Rego)

	status := metav1.ConditionFalse
	reason := "CompileError"
	message := ""
	if compileErr == nil {
		status = metav1.ConditionTrue
		reason = "Compiled"
		message = "Policy compiled successfully"
	} else {
		message = compileErr.Error()
		log.Info("ConftestPolicy failed to compile", "policy", policy.Name, "error", compileErr)
	}

	patch := client.MergeFrom(policy.DeepCopy())
	metav1.SetStatusCondition(&policy.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: policy.Generation,
		LastTransitionTime: metav1.Now(),
	})
	policy.Status.ObservedGeneration = policy.Generation

	if err := r.Status().Patch(ctx, &policy, patch); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// SetupWithManager registers the reconciler to watch ConftestPolicy resources.
func (r *ConftestPolicyReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).For(&paprikav1.ConftestPolicy{}).Complete(r)
}
```

- [ ] **Step 2: Build**

Run: `go build ./...`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add internal/controller/pipelines/conftestpolicy_controller.go
git commit -m "feat(conftest): add ConftestPolicy status controller (Ready condition)"
```

### Task 13: Wire the evaluator and register the status controller

**Files:**
- Modify: `cmd/main_controllers.go`

- [ ] **Step 1: Inject the evaluator into the release reconciler**

In `setupReleaseController` (around line 238, after `releaseRec.PolicyEvaluator = policyEvaluator`), add:

```go
	releaseRec.ConftestEvaluator = conftest.NewEvaluator(mgr.GetClient())
```

Add the import: `"github.com/benebsworth/paprika/internal/conftest"`.

- [ ] **Step 2: Register the status controller**

In `setupPipelineControllers` (alongside the other `SetupWithManager` calls, e.g. after the `NotificationConfigReconciler` registration around line 153), add:

```go
	if err := (&pipelines.ConftestPolicyReconciler{Client: mgr.GetClient(), Scheme: mgr.GetScheme()}).SetupWithManager(mgr); err != nil {
		return fmt.Errorf("conftestpolicy controller: %w", err)
	}
```

Use the package alias that `cmd/main_controllers.go` already uses for `internal/controller/pipelines` (confirm it — it registers other controllers from that package). Match the existing error-wrapping style.

- [ ] **Step 3: Build and run the unit tests**

Run: `go build ./... && go test ./internal/conftest/... ./internal/controller/pipelines/... -run 'Conftest|ConftestGate' -race`
Expected: clean + green.

- [ ] **Step 4: Commit**

```bash
git add cmd/main_controllers.go
git commit -m "feat(conftest): wire ConftestEvaluator and register status controller"
```

### Task 14: Add a sample CR

**Files:**
- Create: `config/samples/pipelines_v1alpha1_conftestpolicy.yaml`

- [ ] **Step 1: Write the sample**

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: ConftestPolicy
metadata:
  name: require-app-label
spec:
  enforcement: enforce
  rego: |
    package main

    deny[msg] {
      input.kind == "Deployment"
      not input.metadata.labels.app
      msg := sprintf("Deployment %s must have an 'app' label", [input.metadata.name])
    }
```

- [ ] **Step 2: Commit**

```bash
git add config/samples/pipelines_v1alpha1_conftestpolicy.yaml
git commit -m "feat(conftest): add ConftestPolicy sample"
```

### Task 15: Regenerate, lint, and run the full suite

- [ ] **Step 1: Regenerate manifests + RBAC**

Run: `make manifests generate`
Expected: the release-controller RBAC gains no conftest verbs it doesn't already have via the manager client; the ConftestPolicyReconciler RBAC markers produce `conftestpolicies/status` rules. Verify with:

Run: `grep -n "conftestpolicies" config/rbac/role.yaml`
Expected: matches for `conftestpolicies` and `conftestpolicies/status`.

- [ ] **Step 2: Lint**

Run: `make lint`
Expected: clean. Fix any issues (run `make lint-fix` if minor).

- [ ] **Step 3: Full unit/envtest suite**

Run: `make test`
Expected: green (this also runs `manifests generate fmt vet`).

- [ ] **Step 4: Commit regenerated artifacts**

```bash
git add config/ api/
git commit -m "feat(conftest): regenerate RBAC for conftest policy status controller"
```

---

## Chunk 5: E2E test

### Task 16: Add a Ginkgo e2e spec

**Files:**
- Modify: `test/e2e/e2e_test.go` (or a new `test/e2e/conftest_test.go` following the existing e2e file conventions)

- [ ] **Step 1: Add an e2e spec (mirror the existing e2e style in `test/e2e/`)**

The spec should:

1. Create a `ConftestPolicy` (`require-app-label`, `enforce`) that denies Deployments missing `metadata.labels.app`.
2. Create an `Application` that references it (`spec.conftestPolicies: [{name: require-app-label}]`) and whose source/template renders a Deployment **without** the label.
3. Create/trigger a `Release`.
4. Assert the Release does **not** reach a terminal/success phase and that its `ConftestPassed` condition is `False` with reason `PolicyViolation`.
5. Switch the policy `enforcement` to `warn` (or fix the manifest) and assert the next reconcile promotes successfully and the condition reflects the outcome.

Follow the helper patterns (client construction, namespace, eventual-consistency helpers) already used in `test/e2e/e2e_test.go`. Match its `Describe`/`It` Ginkgo style and timeout/backoff helpers.

- [ ] **Step 2: Run the e2e suite locally on an isolated Kind cluster (optional)**

Run: `make test-e2e`
Expected: green. (If no local Kind cluster is desired, rely on the on-demand `E2E Tests` workflow.)

- [ ] **Step 3: Trigger the on-demand CI e2e workflow**

```bash
gh workflow run "E2E Tests" --repo paprikacd/paprika -f ginkgo_focus=Conftest
```

- [ ] **Step 4: Commit the e2e test**

```bash
git add test/e2e/
git commit -m "test(conftest): e2e coverage for enforce-blocks and warn-passes"
```

---

## Final Verification

- [ ] `make manifests generate` — clean
- [ ] `make lint` — clean
- [ ] `make test` — green
- [ ] `go test -race ./internal/conftest/... ./internal/controller/pipelines/...` — green, no races
- [ ] `grep -n "runConftestGate" internal/controller/pipelines/release_controller.go` — exactly 3 call sites
- [ ] On-demand `E2E Tests` run — success

## Notes for the implementer

- **Aliases:** `release_controller.go` imports the API package as `paprikav1`; `conftest_gate.go` and `conftest_gate_test.go` (same package `pipelines`) must use the SAME alias. The `ConftestEvaluator` interface in `conftest_gate.go` must reference `paprikav1.ConftestPolicyRef`.
- **OPA API:** verify `rego.PreparedEvalQuery` / `rego.EvalInput` against the pinned OPA version with `go doc`. The behavior is pinned by tests, so keep the test contract intact if the API call shape changes.
- **Condition helper:** mirror `setReleaseGovernanceCondition` (`release_controller.go:788`) exactly for logging/import consistency.
- **No protobuf changes** in v1 (the gate surfaces via release conditions + events only).
- **Fail-closed:** a referenced policy that does not compile or is missing blocks promotion — this is intentional and covered by tests.
