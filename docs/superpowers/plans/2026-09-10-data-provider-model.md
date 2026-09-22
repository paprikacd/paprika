# Data Provider Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator declare where capacity data comes from, scoped to part of the fleet, so the console's capacity meters show real numbers on a default install and honestly absent ones otherwise.

**Architecture:** A new `providers.paprika.io/v1alpha1` API group holds `CapacityProvider` (names an implementation from a compile-time registry, plus its config) and `DataProviderBinding` (attaches a provider to a scope). A resolver answers "for this scope and class, which provider wins, and in what state". Two registry implementations land here: `KubernetesCapacity` (allocatable and requested from the core API) and `MetricsServer` (used). Neither makes an outbound HTTP call, so no SSRF surface is created by this plan.

**Tech Stack:** Go 1.26, controller-runtime, kubebuilder CRDs (`multigroup: true`), `k8s.io/metrics` for the metrics-server client, `internal/kube` for protobuf-negotiated cached clients, testify + `k8s.io/client-go/kubernetes/fake`.

**Spec:** `docs/superpowers/specs/2026-09-10-data-provider-model-design.md`

## Global Constraints

- Go verification per `AGENTS.md`: `go build ./...`, `go vet ./internal/... ./cmd/...`, `go test ./internal/engine ./internal/controller/pipelines -count=1`.
- `golangci-lint` is strict and `.golangci.yml` must not be weakened: `cyclop` max 10, `funlen`, `dupl`, `errcheck` with `check-blank` and `check-type-assertions`, and `exhaustive` — every enum member must be named in a switch; a `default:` clause does not satisfy it.
- New metrics use the OTel SDK, not the Prometheus client directly.
- CRD regeneration: `go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1 crd:allowDangerousTypes=true paths=./api/... output:crd:artifacts:config=config/crd/bases`, then copy to `charts/chart/templates/crd/`.
- Chart changes require `helm lint charts/chart/` and `helm template paprika charts/chart/`.
- Implementations in this plan MUST NOT make outbound network calls. Egress arrives with `Prometheus` in a later increment, behind an allowlist.
- Only `DATA_STATE_STALE` may carry populated numerics among the non-OK states. Every other non-OK state MUST zero them.
- No secrets in log lines, error strings, map keys or metric labels.

---

### Task 1: API group scaffolding and types

**Files:**
- Create: `api/providers/v1alpha1/groupversion_info.go`
- Create: `api/providers/v1alpha1/capacityprovider_types.go`
- Create: `api/providers/v1alpha1/dataproviderbinding_types.go`
- Modify: `PROJECT` (append two resource entries, `group: providers`)
- Test: `api/providers/v1alpha1/types_test.go`

**Interfaces:**
- Produces: `CapacityProvider`, `CapacityProviderSpec{Provider string, Config runtime.RawExtension, StaleAfter metav1.Duration}`, `DataProviderBinding`, `DataProviderBindingSpec{ProviderRef ProviderReference, Scope BindingScope}`, `ProviderReference{Kind, Name string}`, `BindingScope{Kind ScopeKind, Name string, Selector *metav1.LabelSelector}`, and `ScopeKind` constants `ScopeNamespace`, `ScopeCluster`, `ScopeProject`, `ScopeGlobal`.

- [ ] **Step 1: Write the failing test**

```go
package v1alpha1

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestScopeKindsAreOrderedMostSpecificFirst(t *testing.T) {
	t.Parallel()
	// The resolver depends on this order. Declaring it beside the types keeps
	// the precedence chain and the enum from drifting apart.
	require.Equal(t,
		[]ScopeKind{ScopeNamespace, ScopeCluster, ScopeProject, ScopeGlobal},
		ScopeKindsBySpecificity(),
	)
}

func TestGroupVersionIsRegistered(t *testing.T) {
	t.Parallel()
	require.Equal(t, "providers.paprika.io", GroupVersion.Group)
	require.Equal(t, "v1alpha1", GroupVersion.Version)
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `go test ./api/providers/v1alpha1/ -run TestScopeKinds -v`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Write `groupversion_info.go`**

Copy `api/clusters/v1alpha1/groupversion_info.go` verbatim and change the group to `providers.paprika.io`.

- [ ] **Step 4: Write the two type files**

```go
// ScopeKind names a level of the binding precedence chain.
// +kubebuilder:validation:Enum=Namespace;Cluster;Project;Global
type ScopeKind string

const (
	ScopeNamespace ScopeKind = "Namespace"
	ScopeCluster   ScopeKind = "Cluster"
	ScopeProject   ScopeKind = "Project"
	ScopeGlobal    ScopeKind = "Global"
)

// ScopeKindsBySpecificity returns the precedence chain, most specific first.
//
// Paprika has no organisation or tenant type today, so no Org level exists. If
// one arrives, it is one constant and one entry here — nothing already bound
// changes meaning.
func ScopeKindsBySpecificity() []ScopeKind {
	return []ScopeKind{ScopeNamespace, ScopeCluster, ScopeProject, ScopeGlobal}
}

type CapacityProviderSpec struct {
	// Provider is the registry key of the implementation, e.g.
	// "KubernetesCapacity". Unknown keys are rejected at admission.
	// +kubebuilder:validation:Required
	Provider string `json:"provider"`

	// Config is the implementation's own configuration. Each implementation
	// supplies its schema and validates this at admission, so the CRD does not
	// become a union of every implementation's fields.
	// +optional
	// +kubebuilder:pruning:PreserveUnknownFields
	Config runtime.RawExtension `json:"config,omitempty"`

	// StaleAfter is the age past which a reading is reported STALE rather than
	// current. Defaults to 90s.
	// +optional
	StaleAfter *metav1.Duration `json:"staleAfter,omitempty"`
}
```

Write `DataProviderBindingSpec` with `ProviderRef ProviderReference` and `Scope BindingScope` per the Interfaces block. Mark both kinds `// +kubebuilder:object:root=true` and `// +kubebuilder:subresource:status` and register them in `init()`.

- [ ] **Step 5: Generate deepcopy and run the test**

Run: `make generate && go test ./api/providers/v1alpha1/ -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add api/providers PROJECT
git commit -m "feat(providers): add CapacityProvider and DataProviderBinding types"
```

---

### Task 2: The registry and the implementation interface

**Files:**
- Create: `internal/dataprovider/registry.go`
- Create: `internal/dataprovider/reading.go`
- Test: `internal/dataprovider/registry_test.go`

**Interfaces:**
- Consumes: nothing from Task 1 — this package must not import the API types, so implementations stay unit-testable without a cluster.
- Produces:
  - `type Sample struct { Value float64; State DataState; Reason string }`
  - `type Meter struct { Used, Requested, Allocatable Sample; ObservedAt time.Time }`
  - `type CapacityReading struct { CPUMillicores, MemoryBytes Meter }`
  - `type Field string` with `FieldUsed`, `FieldRequested`, `FieldAllocatable`
  - `type Descriptor struct { Name string; Supplies []Field; NeedsEgress bool }` with method `func (d Descriptor) CanSupply(Field) bool`
  - `type ReadRequest struct { ClusterKey string; Namespace string; Config json.RawMessage }`
  - `type CapacitySource interface { Descriptor() Descriptor; ValidateConfig(json.RawMessage) error; Read(context.Context, ReadRequest) (CapacityReading, error) }`
  - `type Registry struct{...}` with `RegisterCapacity(CapacitySource)`, `Capacity(name string) (CapacitySource, bool)`, `CapacityNames() []string`
  - `DataState` mirroring the proto enum: `StateOK`, `StateNotConfigured`, `StateNotAvailable`, `StateStale`, `StateError`, `StateForbidden`

- [ ] **Step 1: Write the failing test**

```go
func TestRegistryRejectsDuplicateNames(t *testing.T) {
	t.Parallel()
	r := NewRegistry()
	require.NoError(t, r.RegisterCapacity(stubSource{name: "A"}))
	// Two implementations answering to one name is a startup bug, not a
	// runtime condition to resolve by picking one.
	require.Error(t, r.RegisterCapacity(stubSource{name: "A"}))
}

func TestUnknownProviderIsNotFound(t *testing.T) {
	t.Parallel()
	_, ok := NewRegistry().Capacity("NoSuchThing")
	require.False(t, ok)
}

func TestSuppliesGovernsWhichFieldsMayReportOK(t *testing.T) {
	t.Parallel()
	d := Descriptor{Name: "used-only", Supplies: []Field{FieldUsed}}
	require.True(t, d.CanSupply(FieldUsed))
	// An implementation that cannot measure allocatable must never cause it to
	// be reported as OK.
	require.False(t, d.CanSupply(FieldAllocatable))
}
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `go test ./internal/dataprovider/ -v`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Implement `reading.go` and `registry.go`**

Registry holds `map[string]CapacitySource` behind a `sync.RWMutex`. Registration happens once at startup, so a mutex is correct here — unlike the read-mostly caches in `internal/kube`, this map is not read on a hot path.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/dataprovider/ -race -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/dataprovider
git commit -m "feat(dataprovider): add provider registry and reading types"
```

---

### Task 3: Scope resolution and precedence

**Files:**
- Create: `internal/dataprovider/resolver.go`
- Test: `internal/dataprovider/resolver_test.go`

**Interfaces:**
- Consumes: `ScopeKindsBySpecificity()` from Task 1; `Registry` from Task 2.
- Produces: `type Scope struct { Namespace, Cluster, Project string }`, `type Binding struct { ProviderName string; ScopeKind providersv1alpha1.ScopeKind; ScopeName string }`, `func Resolve(scope Scope, bindings []Binding) (Binding, bool)`.

- [ ] **Step 1: Write the failing test**

```go
func TestResolvePrefersTheMostSpecificBinding(t *testing.T) {
	t.Parallel()
	scope := Scope{Namespace: "team-a", Cluster: "prod-eu-1", Project: "payments"}
	bindings := []Binding{
		{ProviderName: "global", ScopeKind: v1alpha1.ScopeGlobal},
		{ProviderName: "project", ScopeKind: v1alpha1.ScopeProject, ScopeName: "payments"},
		{ProviderName: "cluster", ScopeKind: v1alpha1.ScopeCluster, ScopeName: "prod-eu-1"},
	}
	got, ok := Resolve(scope, bindings)
	require.True(t, ok)
	require.Equal(t, "cluster", got.ProviderName)
}

func TestResolveIgnoresBindingsForOtherScopes(t *testing.T) {
	t.Parallel()
	scope := Scope{Cluster: "prod-eu-1"}
	_, ok := Resolve(scope, []Binding{
		{ProviderName: "other", ScopeKind: v1alpha1.ScopeCluster, ScopeName: "staging-1"},
	})
	require.False(t, ok, "a binding for another cluster must not win by default")
}

func TestResolveReturnsFalseWhenNothingIsBound(t *testing.T) {
	t.Parallel()
	_, ok := Resolve(Scope{Cluster: "prod-eu-1"}, nil)
	require.False(t, ok)
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `go test ./internal/dataprovider/ -run TestResolve -v`
Expected: FAIL — `Resolve` undefined.

- [ ] **Step 3: Implement `Resolve`**

Walk `ScopeKindsBySpecificity()` in order; return the first binding whose kind matches and whose `ScopeName` equals the corresponding field of `Scope` (or, for `ScopeGlobal`, matches unconditionally). Ties within one level are an admission concern, not a resolution one — see Task 4.

Use a `switch` over every `ScopeKind` member; `exhaustive` will reject a `default:`-only switch.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/dataprovider/ -race -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/dataprovider
git commit -m "feat(dataprovider): resolve bindings most-specific-first"
```

---

### Task 4: Admission validation

**Files:**
- Create: `internal/webhook/providers/v1alpha1/capacityprovider_webhook.go`
- Create: `internal/webhook/providers/v1alpha1/dataproviderbinding_webhook.go`
- Test: `internal/webhook/providers/v1alpha1/capacityprovider_webhook_test.go`
- Test: `internal/webhook/providers/v1alpha1/dataproviderbinding_webhook_test.go`

**Interfaces:**
- Consumes: `Registry.Capacity`, `CapacitySource.ValidateConfig` from Task 2.
- Produces: `NewCapacityProviderValidator(*dataprovider.Registry)`, `NewBindingValidator(client.Client)`.

Test helpers `registryWith`, `providerWith`, `binding` and `fakeClientWith` are written in the test files: `registryWith(names ...string)` returns a registry populated with stub sources under those names (one of which, `"Fussy"`, rejects any config); `providerWith(provider string, config []byte)` returns a `*CapacityProvider`; `binding(name string, kind ScopeKind, scopeName string)` returns a `*DataProviderBinding`; `fakeClientWith(objs ...client.Object)` returns a controller-runtime fake client.

Follow the existing webhook shape in `internal/webhook/pipelines/v1alpha1/application_webhook.go`.

- [ ] **Step 1: Write the failing tests**

```go
func TestUnknownProviderKeyIsRejected(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("KubernetesCapacity"))
	_, err := v.ValidateCreate(t.Context(), providerWith("NoSuchThing", nil))
	require.ErrorContains(t, err, "unknown provider")
}

func TestConfigIsValidatedByTheImplementation(t *testing.T) {
	t.Parallel()
	v := NewCapacityProviderValidator(registryWith("Fussy"))
	_, err := v.ValidateCreate(t.Context(), providerWith("Fussy", []byte(`{"bad":true}`)))
	// Rejected at apply time, not discovered broken on first fetch.
	require.Error(t, err)
}

func TestDuplicateBindingForOneScopeAndClassIsRejected(t *testing.T) {
	t.Parallel()
	existing := binding("a", v1alpha1.ScopeCluster, "prod-eu-1")
	v := NewBindingValidator(fakeClientWith(existing))
	_, err := v.ValidateCreate(t.Context(), binding("b", v1alpha1.ScopeCluster, "prod-eu-1"))
	require.ErrorContains(t, err, "already bound")
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `go test ./internal/webhook/providers/... -v`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Implement both validators**

`CapacityProvider`: look the key up in the registry; reject unknown; delegate `spec.config` to `ValidateConfig`; reject any inline credential field (a `secretRef` is required for credentials).

`DataProviderBinding`: list existing bindings, reject when another binding already covers the same `(providerRef.kind, scope.kind, scope.name)`.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/webhook/providers/... -race -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/webhook/providers
git commit -m "feat(providers): validate provider config and reject duplicate bindings"
```

---

### Task 5: `KubernetesCapacity` implementation

**Files:**
- Create: `internal/dataprovider/kubernetescapacity.go`
- Test: `internal/dataprovider/kubernetescapacity_test.go`

**Interfaces:**
- Consumes: `CapacitySource`, `CapacityReading`, `Meter`, `Sample` from Task 2; `kube.Clients` from `internal/kube`.
- Produces:
  - `func NewKubernetesCapacity(clients *kube.Clients) *KubernetesCapacity` satisfying `CapacitySource`, with `Descriptor().Name == "KubernetesCapacity"`, `Supplies == []Field{FieldRequested, FieldAllocatable}`, `NeedsEgress == false`.
  - `func newKubernetesCapacityWithClientset(kubernetes.Interface) *KubernetesCapacity` — unexported test seam that bypasses the per-cluster cache, so the tests below need no `kube.Clients`.

Test helpers `node`, `scheduledPod`, `pendingPod` and `scheduledPodNoRequests` are written in the test file itself; each returns a `*corev1.Node` or `*corev1.Pod` built from the arguments shown.

- [ ] **Step 1: Write the failing test**

```go
func TestKubernetesCapacitySumsAllocatableAndRequested(t *testing.T) {
	t.Parallel()
	clientset := fake.NewSimpleClientset(
		node("node-a", "4", "8Gi"),
		node("node-b", "2", "4Gi"),
		scheduledPod("web", "node-a", "500m", "1Gi"),
		scheduledPod("api", "node-b", "250m", "512Mi"),
	)
	src := newKubernetesCapacityWithClientset(clientset)

	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)

	require.Equal(t, StateOK, got.CPUMillicores.Allocatable.State)
	require.InDelta(t, 6000, got.CPUMillicores.Allocatable.Value, 0.001)
	require.InDelta(t, 750, got.CPUMillicores.Requested.Value, 0.001)

	// This implementation cannot measure usage; it must say so rather than
	// report a zero that reads as "nothing is running".
	require.Equal(t, StateNotConfigured, got.CPUMillicores.Used.State)
	require.Zero(t, got.CPUMillicores.Used.Value)
}

func TestKubernetesCapacityIgnoresUnscheduledPods(t *testing.T) {
	t.Parallel()
	clientset := fake.NewSimpleClientset(
		node("node-a", "4", "8Gi"),
		pendingPod("waiting", "1", "1Gi"), // no nodeName: not consuming anything
	)
	src := newKubernetesCapacityWithClientset(clientset)
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Zero(t, got.CPUMillicores.Requested.Value)
}

func TestKubernetesCapacityToleratesPodsWithoutRequests(t *testing.T) {
	t.Parallel()
	clientset := fake.NewSimpleClientset(
		node("node-a", "4", "8Gi"),
		scheduledPodNoRequests("best-effort", "node-a"),
	)
	src := newKubernetesCapacityWithClientset(clientset)
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Zero(t, got.CPUMillicores.Requested.Value)
	require.Equal(t, StateOK, got.CPUMillicores.Requested.State)
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `go test ./internal/dataprovider/ -run TestKubernetesCapacity -v`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement it**

Sum `Node.Status.Allocatable` for cpu and memory. Sum container `Resources.Requests` across pods with a non-empty `Spec.NodeName` and a non-terminal phase. Set `Used` to `Sample{State: StateNotConfigured, Reason: "no usage source is bound; bind a MetricsServer or Prometheus provider"}`.

Use `resource.Quantity.MilliValue()` for cpu and `.Value()` for memory. List pods with a field selector on `spec.nodeName` where possible and page the list — a large cluster's pod list is the expensive call here.

- [ ] **Step 4: Run tests**

Run: `go test ./internal/dataprovider/ -race -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/dataprovider
git commit -m "feat(dataprovider): add KubernetesCapacity provider"
```

---

### Task 6: `MetricsServer` implementation

**Files:**
- Create: `internal/dataprovider/metricsserver.go`
- Test: `internal/dataprovider/metricsserver_test.go`
- Modify: `go.mod` (add `k8s.io/metrics`)

**Interfaces:**
- Produces:
  - `func NewMetricsServer(*kube.Clients) *MetricsServer` satisfying `CapacitySource`, with `Supplies == []Field{FieldUsed}`, `NeedsEgress == false`.
  - `func newMetricsServerWithClient(versioned.Interface) *MetricsServer` — unexported test seam taking a `k8s.io/metrics/pkg/client/clientset/versioned` interface.

Test helpers `nodeMetrics` and `clientReturning` are written in the test file: the first returns a `*metricsv1beta1.NodeMetrics`, the second a fake whose list call always returns the given error.

- [ ] **Step 1: Add the dependency**

Run: `go get k8s.io/metrics@v0.36.2 && go mod tidy`
The version must match the other `k8s.io/*` modules already in `go.mod`.

- [ ] **Step 2: Write the failing test**

```go
func TestMetricsServerReportsUsage(t *testing.T) {
	t.Parallel()
	mc := metricsfake.NewSimpleClientset(
		nodeMetrics("node-a", "1500m", "2Gi"),
		nodeMetrics("node-b", "500m", "1Gi"),
	)
	src := newMetricsServerWithClient(mc)
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err)
	require.Equal(t, StateOK, got.CPUMillicores.Used.State)
	require.InDelta(t, 2000, got.CPUMillicores.Used.Value, 0.001)
}

func TestMetricsServerAbsentReportsNotAvailableNotZero(t *testing.T) {
	t.Parallel()
	// metrics.k8s.io is frequently not installed. That is a different
	// condition from "usage is zero", and the console renders it differently.
	src := newMetricsServerWithClient(clientReturning(apierrors.NewNotFound(
		schema.GroupResource{Group: "metrics.k8s.io", Resource: "nodemetrics"}, "")))
	got, err := src.Read(t.Context(), ReadRequest{ClusterKey: "fleet/prod"})
	require.NoError(t, err, "an absent metrics API is a state, not a call failure")
	require.Equal(t, StateNotAvailable, got.CPUMillicores.Used.State)
	require.Zero(t, got.CPUMillicores.Used.Value)
	require.NotEmpty(t, got.CPUMillicores.Used.Reason)
}
```

- [ ] **Step 3: Run and confirm failure**

Run: `go test ./internal/dataprovider/ -run TestMetricsServer -v`
Expected: FAIL — undefined.

- [ ] **Step 4: Implement it**

Sum `NodeMetrics.Usage` for cpu and memory. Map a `NotFound` or `IsServiceUnavailable` error on the metrics group to `StateNotAvailable` with a safe reason; map any other error to `StateError` with a sanitized reason. Leave `Requested` and `Allocatable` as `StateNotConfigured` — this implementation does not supply them, and `Descriptor().Supplies` says so.

- [ ] **Step 5: Run tests**

Run: `go test ./internal/dataprovider/ -race -count=1`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/dataprovider go.mod go.sum
git commit -m "feat(dataprovider): add MetricsServer provider"
```

---

### Task 7: Merge readings and serve them

**Files:**
- Create: `internal/dataprovider/merge.go`
- Modify: `internal/api/cluster_handler.go` (replace the capacity stub)
- Modify: `internal/api/detail_handler.go` (`GetDataSources` reports the resolved state)
- Test: `internal/dataprovider/merge_test.go`
- Test: `internal/api/cluster_handler_test.go`

**Interfaces:**
- Consumes: `Resolve` (Task 3), `CapacitySource` (Task 2).
- Produces: `func Merge(readings ...CapacityReading) CapacityReading` — later readings fill fields earlier ones left non-OK, so `KubernetesCapacity` and `MetricsServer` compose into one meter.

- [ ] **Step 1: Write the failing test**

```go
func TestMergeCombinesComplementaryProviders(t *testing.T) {
	t.Parallel()
	structural := CapacityReading{CPUMillicores: Meter{
		Allocatable: Sample{Value: 6000, State: StateOK},
		Requested:   Sample{Value: 750, State: StateOK},
		Used:        Sample{State: StateNotConfigured},
	}}
	usage := CapacityReading{CPUMillicores: Meter{
		Used: Sample{Value: 2000, State: StateOK},
	}}

	got := Merge(structural, usage)
	require.Equal(t, StateOK, got.CPUMillicores.Allocatable.State)
	require.InDelta(t, 6000, got.CPUMillicores.Allocatable.Value, 0.001)
	require.Equal(t, StateOK, got.CPUMillicores.Used.State)
	require.InDelta(t, 2000, got.CPUMillicores.Used.Value, 0.001)
}

func TestMergeNeverLetsAnAbsentFieldOverwriteARealOne(t *testing.T) {
	t.Parallel()
	real := CapacityReading{CPUMillicores: Meter{Used: Sample{Value: 2000, State: StateOK}}}
	absent := CapacityReading{CPUMillicores: Meter{Used: Sample{State: StateNotAvailable}}}
	got := Merge(real, absent)
	require.Equal(t, StateOK, got.CPUMillicores.Used.State)
	require.InDelta(t, 2000, got.CPUMillicores.Used.Value, 0.001)
}
```

- [ ] **Step 2: Run and confirm failure**

Run: `go test ./internal/dataprovider/ -run TestMerge -v`
Expected: FAIL — `Merge` undefined.

- [ ] **Step 3: Implement `Merge`, then wire the handlers**

`ListClusters`/`GetCluster` populate `ResourceMeter` from the merged reading, translating `Sample.State` to the proto `DataState` and leaving numerics zero for every non-OK state except `STALE`.

`GetDataSources` reports `CLUSTER_CAPACITY` as `OK` when a provider resolves and reads, `NOT_CONFIGURED` when nothing is bound, and the implementation's own state otherwise.

- [ ] **Step 4: Run the suite**

Run: `go test ./internal/dataprovider/ ./internal/api/ -race -count=1`
Expected: PASS. The Phase 0 honesty tests in `internal/api/console_stub_test.go` must still pass unchanged for every class other than capacity.

- [ ] **Step 5: Commit**

```bash
git add internal/dataprovider internal/api
git commit -m "feat(api): serve capacity from resolved providers"
```

---

### Task 8: Controller wiring, CRDs, RBAC and chart

**Files:**
- Modify: `cmd/main_controllers.go:451` (register the binding controller alongside `clusters-cluster`)
- Modify: `cmd/main_operator.go` (build the registry, register both implementations)
- Create: `config/crd/bases/providers.paprika.io_capacityproviders.yaml` (generated)
- Create: `config/crd/bases/providers.paprika.io_dataproviderbindings.yaml` (generated)
- Create: `charts/chart/templates/crd/capacityproviders.providers.paprika.io.yaml`
- Create: `charts/chart/templates/crd/dataproviderbindings.providers.paprika.io.yaml`
- Modify: `charts/chart/templates/` manager ClusterRole — add `nodes` and `pods` list/watch, and the new group

- [ ] **Step 1: Register the implementations at startup**

```go
registry := dataprovider.NewRegistry()
if err := registry.RegisterCapacity(dataprovider.NewKubernetesCapacity(clients)); err != nil {
	return fmt.Errorf("registering KubernetesCapacity: %w", err)
}
if err := registry.RegisterCapacity(dataprovider.NewMetricsServer(clients)); err != nil {
	return fmt.Errorf("registering MetricsServer: %w", err)
}
```

- [ ] **Step 2: Generate CRDs and copy to the chart**

Run:
```bash
go run sigs.k8s.io/controller-tools/cmd/controller-gen@v0.20.1 \
  crd:allowDangerousTypes=true paths=./api/... \
  output:crd:artifacts:config=config/crd/bases
for f in config/crd/bases/providers.paprika.io_*.yaml; do
  base=$(basename "$f")
  chart=$(echo "$base" | sed 's/providers.paprika.io_//;s/\.yaml$/.providers.paprika.io.yaml/')
  cp "$f" "charts/chart/templates/crd/$chart"
done
```

- [ ] **Step 3: Extend the manager ClusterRole**

`KubernetesCapacity` reads nodes and pods on **target** clusters. Add `nodes` and `pods` `get;list;watch` to the chart-managed manager role and to the remote credential's role. Per `AGENTS.md`, never resolve a permission error by binding cluster-admin.

- [ ] **Step 4: Verify the chart**

Run: `helm lint charts/chart/ && helm template paprika charts/chart/ >/dev/null`
Expected: both succeed.

- [ ] **Step 5: Full verification**

Run:
```bash
go build ./...
go vet ./internal/... ./cmd/...
go test ./internal/dataprovider/ ./internal/api/ ./internal/engine ./internal/controller/pipelines -count=1
./bin/golangci-lint run ./internal/dataprovider/... ./internal/webhook/providers/... --timeout 5m
```
Expected: all pass, lint reports 0 issues.

- [ ] **Step 6: Commit**

```bash
git add cmd config charts
git commit -m "feat(providers): wire provider registry into the operator"
```

---

## Defined but not yet wired

`CapacityProviderSpec.StaleAfter` (Task 1) is part of the API from the start but
nothing in this increment consumes it. Both implementations here read the
Kubernetes API directly on each request — cheap, local, and never stale enough
to matter. Staleness becomes real with `Prometheus`, which needs a cache in
front of it precisely so a slow provider degrades to `STALE` rather than
stalling a request.

It is declared now rather than added later because adding a field to a served
CRD is a migration, and because `Descriptor().NeedsEgress` already tells the
future caching layer which providers require one. An implementer should not
wire it in this increment and should not be surprised to find it unused.

## Out of scope for this plan

Deliberately deferred, per the spec's build order:

- `RateCard` (cost) and `Prometheus` (signals, egress) implementations.
- `SignalProvider` and `CostProvider` kinds.
- Any outbound HTTP call, and therefore the egress allowlist, link-local block and redirect refusal — those are entry criteria for the `Prometheus` increment, not this one.
- Console changes beyond what Task 7 already surfaces through the existing `DataState` contract. `capacity-meter.tsx`'s NOT_CONFIGURED/NOT_AVAILABLE conflation (audit finding B7) becomes fixable once real states flow, and is tracked separately.
