# ArgoCD-compatible Resource Hooks (MVP) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ArgoCD-compatible resource hooks (PreSync/Sync/PostSync/SyncFail phases) so paprika correctly applies Helm charts that use `argocd.argoproj.io/hook` annotations.

**Architecture:** A new `internal/engine/hooks` package handles manifest classification into phase buckets and per-kind completion checking. The release controller's `promote()` path gains a `bytes.Contains` fast path (no behavior change when no hooks are present) and a full orchestration path that executes PreSync → Sync → PostSync with re-entrancy for in-flight hooks. The agent's duplicated apply path gets a parallel hook-execution implementation. Hooks are excluded from the diff engine so they don't appear as OutOfSync.

**Tech Stack:** Go, kubebuilder v4, controller-runtime, dynamic client, envtest, the existing `WorkflowEngine.watchJob` pattern at `internal/engine/workflow.go:321` for Job completion polling.

**Spec reference:** `docs/superpowers/specs/2026-06-29-sync-hooks-design.md` (v3, spec-review-approved).

---

## Conventions

- **Working directory:** `/Users/benebsworth/projects/paprika/.worktrees/sync-hooks` (worktree on `feature/sync-hooks`).
- **After editing `api/pipelines/v1alpha1/*_types.go`:** run `make manifests && make generate` before tests.
- **After any Go change:** run `bin/golangci-lint run` and `go test ./...` (or scoped) before committing.
- **Test framework:** plain `testing.T` for `internal/engine/hooks/` package unit tests; Ginkgo/envtest for controller integration tests (model on `internal/controller/rollouts/suite_test.go` and `rollout_controller_test.go` from the recent rollout-correctness work).
- **Commit style:** match the repo — `feat(sync-hooks): ...`, `fix(sync-hooks): ...`, `test(sync-hooks): ...`. One logical change per commit.
- **Logging:** K8s message style — capitalised first word, no trailing period, object-type-named.
- **NEVER edit** `config/crd/bases/*.yaml`, `config/rbac/role.yaml`, `**/zz_generated.*.go`, or `PROJECT`.
- **NEVER remove** `// +kubebuilder:scaffold:*` comments.

---

## File Structure

**Modify:**
- `api/pipelines/v1alpha1/application_types.go` — extend `SyncOptions` with `HookTimeoutSeconds`; extend `ApplicationStatus` with `HookStatuses`. Add the shared annotation constants here (so both controller and agent can import the API package without a cycle).
- `api/pipelines/v1alpha1/release_types.go` — extend `ReleaseStatus` with `HookStatuses`; add the `HookStatus` struct.
- `internal/engine/scalable_diff.go` — filter hook resources in `ComputeDiff`.
- `internal/engine/diff.go` — same filter for the non-scalable diff path.
- `internal/controller/pipelines/release_controller.go` — add `executeHooks` + sentinel errors + fast path + wire into `promote`.
- `internal/controller/pipelines/application_controller.go` — propagate `HookStatuses` from active Release to Application at line 1111–1113.
- `internal/agent/server/server.go` — add `executeHooks` mirror; wire into `Apply`.
- `internal/engine/helm_sdk_renderer.go` — export a small helper that pairs parsed objects with their source byte slices (used by `hooks.Classify`). Or do the pairing in the controller and pass both into Classify — see Task 1.1.

**Create:**
- `internal/engine/hooks/doc.go` — package doc, exported constants.
- `internal/engine/hooks/classify.go` — `Phase`, `Resource`, `Bucket`, `Classify`, `SyncDocs`, `HasHooks`.
- `internal/engine/hooks/classify_test.go` — full coverage of the parser.
- `internal/engine/hooks/completion.go` — `CompletionFunc`, `RegisterCompletionChecker`, `CompletionFor`, Job/Pod checkers.
- `internal/engine/hooks/completion_test.go` — Job/Pod completion coverage (uses fake dynamic client).
- `internal/controller/pipelines/hooks_envtest_test.go` — controller-level envtest for the full hook lifecycle (model on `internal/controller/rollouts/rollout_controller_test.go`). If `internal/controller/pipelines/suite_test.go` already exists (it does — the rollout-correctness work referenced it), append to it instead of creating new.

**Regenerate (DO NOT EDIT manually):**
- `api/pipelines/v1alpha1/zz_generated.deepcopy.go`
- `config/crd/bases/rollouts.paprika.io_rollouts.yaml` — wait, wrong CRD. The relevant ones are `pipelines.paprika.io_*.yaml` (Release, Application).
- `config/rbac/role.yaml`

---

## Chunk 0: CRD schema additions + constants

Pure additive — no behavior change. Existing tests must still pass.

### Task 0.1: Add `HookStatus` type + `ReleaseStatus.HookStatuses`

**Files:**
- Modify: `api/pipelines/v1alpha1/release_types.go:81-108` (the `ReleaseStatus` struct)

- [ ] **Step 1: Add the `HookStatus` struct**

Before the `ReleaseStatus` struct (line 81), insert:

```go
// HookStatus is the observed state of a single hook resource.
type HookStatus struct {
	Kind        string       `json:"kind"`
	Name        string       `json:"name"`
	Namespace   string       `json:"namespace,omitempty"`
	// Phase is the hook phase: PreSync, Sync, PostSync, or SyncFail.
	// +kubebuilder:validation:Enum=PreSync;Sync;PostSync;SyncFail
	Phase       string       `json:"phase"`
	// Status is the execution state: Running, Succeeded, Failed, or Terminated.
	// +kubebuilder:validation:Enum=Running;Succeeded;Failed;Terminated
	Status      string       `json:"status"`
	StartedAt   *metav1.Time `json:"startedAt,omitempty"`
	CompletedAt *metav1.Time `json:"completedAt,omitempty"`
	Message     string       `json:"message,omitempty"`
}
```

- [ ] **Step 2: Extend `ReleaseStatus`**

Inside `ReleaseStatus` (between line 107 and the closing brace at 108), add:

```go
	// HookStatuses tracks per-hook execution state across the four phases.
	// Cleared at the start of each promote. Populated as hooks run.
	// +optional
	HookStatuses []HookStatus `json:"hookStatuses,omitempty"`
```

- [ ] **Step 3: Regenerate**

```bash
make manifests generate
```

Expected: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` updates with `HookStatus.DeepCopyInto` and the slice copy in `ReleaseStatus.DeepCopyInto`. The Release/Application CRD yamls gain `hookStatuses` properties.

- [ ] **Step 4: Verify**

```bash
go build ./... && bin/golangci-lint run ./api/...
go test ./api/...
```

Expected: passes.

- [ ] **Step 5: Commit**

```bash
git add api/pipelines/v1alpha1/release_types.go \
        api/pipelines/v1alpha1/zz_generated.deepcopy.go \
        config/crd/bases/pipelines.paprika.io_releases.yaml
git commit -m "feat(sync-hooks): add HookStatus type and ReleaseStatus.HookStatuses"
```

---

### Task 0.2: Add `HookTimeoutSeconds` to `SyncOptions` + annotation constants

**Files:**
- Modify: `api/pipelines/v1alpha1/application_types.go:59-75` (the `SyncOptions` struct)

- [ ] **Step 1: Extend `SyncOptions`**

Inside `SyncOptions` (after `ApplyOutOfSyncOnly bool` at line 74, before the closing brace), add:

```go
	// HookTimeoutSeconds is the max time to wait for any single hook to reach
	// a terminal state. Default 300 (5 minutes). 0 means fire-and-forget
	// (skip the per-hook poll entirely).
	// +optional
	HookTimeoutSeconds int32 `json:"hookTimeoutSeconds,omitempty"`
```

- [ ] **Step 2: Add the annotation constants**

At the end of the file (after all existing type definitions, before the `init()` if any), add:

```go
// Shared annotation constants for ArgoCD-compatible resource hooks.
// Recognized on individual manifest documents during the Sync apply path.
const (
	// HookAnnotation identifies a resource as a hook. Value is a
	// comma-separated list of phases, e.g. "PreSync,PostSync".
	// Resources without this annotation (or with an empty value) are
	// treated as normal Sync-phase managed resources.
	HookAnnotation = "argocd.argoproj.io/hook"
	// HookDeletePolicyAnnotation controls when a hook resource is deleted.
	// MVP honors only "BeforeHookCreation" (the default when the annotation
	// is absent). Other values ("HookSucceeded", "HookFailed") are accepted
	// but treated as no-ops until prune-on-sync lands.
	HookDeletePolicyAnnotation = "argocd.argoproj.io/hook-delete-policy"
	// HookWeightAnnotation is parsed for forward-compat but ignored in MVP.
	// YAML declaration order is used within a phase.
	HookWeightAnnotation = "argocd.argoproj.io/hook-weight"
)
```

- [ ] **Step 3: Regenerate + verify**

```bash
make manifests generate
go build ./... && bin/golangci-lint run ./api/...
go test ./api/...
```

- [ ] **Step 4: Commit**

```bash
git add api/pipelines/v1alpha1/application_types.go \
        api/pipelines/v1alpha1/zz_generated.deepcopy.go \
        config/crd/bases/pipelines.paprika.io_applications.yaml
git commit -m "feat(sync-hooks): add HookTimeoutSeconds to SyncOptions and annotation constants"
```

---

### Task 0.3: Propagate `HookStatuses` to `ApplicationStatus`

**Files:**
- Modify: `api/pipelines/v1alpha1/application_types.go:519-585` (the `ApplicationStatus` struct)

- [ ] **Step 1: Extend `ApplicationStatus`**

Inside `ApplicationStatus`, near the existing `Resources []ResourceSync` field (around line 560), add:

```go
	// HookStatuses mirrors the active Release's HookStatuses for UI/API
	// consumption. Populated by the Application controller from the active
	// Release at each reconcile; cleared when no active Release exists.
	// +optional
	HookStatuses []HookStatus `json:"hookStatuses,omitempty"`
```

- [ ] **Step 2: Regenerate + verify**

```bash
make manifests generate
go build ./... && bin/golangci-lint run ./api/...
go test ./api/...
```

- [ ] **Step 3: Commit**

```bash
git add api/pipelines/v1alpha1/application_types.go \
        api/pipelines/v1alpha1/zz_generated.deepcopy.go \
        config/crd/bases/pipelines.paprika.io_applications.yaml
git commit -m "feat(sync-hooks): surface HookStatuses on ApplicationStatus"
```

---

## Chunk 1: `internal/engine/hooks` package

### Task 1.1: `Classify` + types

**Files:**
- Create: `internal/engine/hooks/doc.go`, `internal/engine/hooks/classify.go`, `internal/engine/hooks/classify_test.go`

- [ ] **Step 1: Write failing tests for the parser**

Create `internal/engine/hooks/classify_test.go`:

```go
package hooks

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func testObj(kind, name, ns string, annotations map[string]string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(schema.GroupVersionKind{Group: "batch", Version: "v1", Kind: kind})
	u.SetName(name)
	u.SetNamespace(ns)
	if annotations != nil {
		u.SetAnnotations(annotations)
	}
	return u
}

func TestClassify_NoHooks_AllInSync(t *testing.T) {
	objs := []*unstructured.Unstructured{
		testObj("Job", "regular-job", "default", nil),
		testObj("ConfigMap", "regular-cm", "default", nil),
	}
	bucket, err := Classify(objs, nil)
	require.NoError(t, err)
	assert.False(t, bucket.HasHooks())
	assert.Len(t, bucket.Sync, 2)
	assert.Empty(t, bucket.PreSync)
	assert.Empty(t, bucket.PostSync)
	assert.Empty(t, bucket.SyncFail)
}

func TestClassify_PreSyncHook_NotInSync(t *testing.T) {
	objs := []*unstructured.Unstructured{
		testObj("Job", "presync-job", "default", map[string]string{paprikav1.HookAnnotation: "PreSync"}),
		testObj("Deployment", "app", "default", nil),
	}
	bucket, err := Classify(objs, nil)
	require.NoError(t, err)
	assert.True(t, bucket.HasHooks())
	assert.Len(t, bucket.PreSync, 1)
	assert.Len(t, bucket.Sync, 1)
	assert.Equal(t, "presync-job", bucket.PreSync[0].Obj.GetName())
	assert.Equal(t, PhasePreSync, bucket.PreSync[0].Phase)
}

func TestClassify_MultiPhaseAnnotation_AppearsInBoth(t *testing.T) {
	objs := []*unstructured.Unstructured{
		testObj("Job", "multi", "default", map[string]string{paprikav1.HookAnnotation: "PreSync,PostSync"}),
	}
	bucket, err := Classify(objs, nil)
	require.NoError(t, err)
	assert.Len(t, bucket.PreSync, 1)
	assert.Len(t, bucket.PostSync, 1)
	assert.Empty(t, bucket.Sync, "multi-phase hook must NOT also be in Sync")
}

func TestClassify_SyncFailOnly(t *testing.T) {
	objs := []*unstructured.Unstructured{
		testObj("Job", "cleanup", "default", map[string]string{paprikav1.HookAnnotation: "SyncFail"}),
	}
	bucket, err := Classify(objs, nil)
	require.NoError(t, err)
	assert.Len(t, bucket.SyncFail, 1)
	assert.Empty(t, bucket.Sync)
}

func TestClassify_UnknownPhaseValue_TreatedAsNonHook(t *testing.T) {
	objs := []*unstructured.Unstructured{
		testObj("Job", "weird", "default", map[string]string{paprikav1.HookAnnotation: "Garbage"}),
	}
	bucket, err := Classify(objs, nil)
	require.NoError(t, err)
	assert.False(t, bucket.HasHooks())
	assert.Len(t, bucket.Sync, 1, "unknown phase value falls back to Sync")
}

func TestClassify_ExplicitSyncAnnotation_TreatedAsNonHook(t *testing.T) {
	// MVP divergence from ArgoCD: hook=Sync is treated as a non-hook.
	objs := []*unstructured.Unstructured{
		testObj("Job", "explicit-sync", "default", map[string]string{paprikav1.HookAnnotation: "Sync"}),
	}
	bucket, err := Classify(objs, nil)
	require.NoError(t, err)
	assert.False(t, bucket.HasHooks())
	assert.Len(t, bucket.Sync, 1)
}

func TestClassify_EmptyAnnotationValue_TreatedAsNonHook(t *testing.T) {
	objs := []*unstructured.Unstructured{
		testObj("Job", "empty", "default", map[string]string{paprikav1.HookAnnotation: ""}),
	}
	bucket, err := Classify(objs, nil)
	require.NoError(t, err)
	assert.False(t, bucket.HasHooks())
	assert.Len(t, bucket.Sync, 1)
}

func TestClassify_DeletePolicyCaptured(t *testing.T) {
	objs := []*unstructured.Unstructured{
		testObj("Job", "presync", "default", map[string]string{
			paprikav1.HookAnnotation:            "PreSync",
			paprikav1.HookDeletePolicyAnnotation: "HookSucceeded",
		}),
	}
	bucket, err := Classify(objs, nil)
	require.NoError(t, err)
	assert.Equal(t, "HookSucceeded", bucket.PreSync[0].DeletePolicy)
}

func TestSyncDocs_PreservesNonHookBytes(t *testing.T) {
	// Two raw docs separated by "\n---\n". The first is a hook; the second is not.
	raw := []byte("apiVersion: batch/v1\nkind: Job\nmetadata:\n  name: presync\n  annotations:\n    argocd.argoproj.io/hook: PreSync\n---\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: regular\n")
	objs := []*unstructured.Unstructured{
		testObj("Job", "presync", "default", map[string]string{paprikav1.HookAnnotation: "PreSync"}),
		testObj("ConfigMap", "regular", "default", nil),
	}
	// Pair each obj with its source bytes via the helper.
	paired := PairWithBytes(objs, raw)
	bucket, err := ClassifyPaired(paired)
	require.NoError(t, err)
	syncBytes := bucket.SyncDocs()
	assert.Contains(t, string(syncBytes), "kind: ConfigMap")
	assert.NotContains(t, string(syncBytes), "name: presync")
}
```

Note: the last test surfaces a `PairWithBytes`/`ClassifyPaired` API — a thin wrapper that lets Classify preserve the original per-doc byte slices. This avoids the re-serialization footgun flagged in the spec review.

Run: `go test ./internal/engine/hooks/...` — expected FAIL (package doesn't exist).

- [ ] **Step 2: Create `doc.go` with package doc + constants**

Create `internal/engine/hooks/doc.go`:

```go
// Package hooks partitions rendered manifests into ArgoCD-compatible hook
// phases (PreSync, Sync, PostSync, SyncFail) and provides per-kind
// completion checkers for hook resources that need to reach a terminal
// state before the next phase runs.
//
// Annotation compat: paprika recognizes the standard ArgoCD annotations:
//   - argocd.argoproj.io/hook             (comma-separated phase list)
//   - argocd.argoproj.io/hook-delete-policy
//   - argocd.argoproj.io/hook-weight      (parsed, ignored in MVP)
//
// The string constants live in paprikav1 (api/pipelines/v1alpha1) so both
// the controller and agent can import them without a cycle.
package hooks
```

- [ ] **Step 3: Create `classify.go` with types + Classify**

Create `internal/engine/hooks/classify.go`:

```go
package hooks

import (
	"bytes"
	"fmt"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// Phase is a hook execution phase. Matches ArgoCD semantics.
type Phase string

const (
	PhasePreSync  Phase = "PreSync"
	PhaseSync     Phase = "Sync"
	PhasePostSync Phase = "PostSync"
	PhaseSyncFail Phase = "SyncFail"
)

// PairedObj is a parsed manifest paired with its original raw bytes (so the
// Sync-phase docs can be re-emitted without re-serializing parsed objects,
// preserving YAML comments / key order / scalar formatting).
type PairedObj struct {
	Obj  *unstructured.Unstructured
	Raw  []byte
}

// PairWithBytes pairs each parsed object with its source bytes from rawDocs.
// rawDocs is split using the same separator engine.SplitYAMLDocuments uses
// ("\n---\n"). The lengths must match; mismatch is an error.
func PairWithBytes(objs []*unstructured.Unstructured, rawDocs []byte) ([]PairedObj, error) {
	docs := splitDocs(rawDocs)
	if len(docs) != len(objs) {
		return nil, fmt.Errorf("PairWithBytes: %d objects but %d raw docs", len(objs), len(docs))
	}
	out := make([]PairedObj, len(objs))
	for i := range objs {
		out[i] = PairedObj{Obj: objs[i], Raw: docs[i]}
	}
	return out, nil
}

// splitDocs mirrors engine.SplitYAMLDocuments without the import (avoids an
// import cycle when engine itself wants to use this package later).
func splitDocs(raw []byte) [][]byte {
	if len(raw) == 0 {
		return nil
	}
	parts := strings.Split(string(raw), "\n---\n")
	out := make([][]byte, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		out = append(out, []byte(p))
	}
	return out
}

// Resource is a single parsed manifest tagged with its phase.
type Resource struct {
	Obj          *unstructured.Unstructured
	Raw          []byte
	Phase        Phase
	DeletePolicy string // raw value of HookDeletePolicyAnnotation; "" = BeforeHookCreation default
}

// Bucket is the phase-partitioned manifest set for a single release.
type Bucket struct {
	PreSync  []Resource
	Sync     []Resource
	PostSync []Resource
	SyncFail []Resource
}

// HasHooks reports whether any phase bucket (other than Sync) is non-empty.
func (b *Bucket) HasHooks() bool {
	return len(b.PreSync) > 0 || len(b.PostSync) > 0 || len(b.SyncFail) > 0
}

// SyncDocs returns the original raw bytes for the Sync-phase (non-hook)
// documents, joined with "\n---\n" separators.
func (b *Bucket) SyncDocs() []byte {
	var buf bytes.Buffer
	for i, r := range b.Sync {
		if i > 0 {
			buf.WriteString("\n---\n")
		}
		buf.Write(r.Raw)
	}
	return buf.Bytes()
}

// ClassifyPaired partitions paired manifests into phase buckets. Resources
// without the hook annotation land in Sync. Hook resources appear ONLY in
// their declared phase(s) — a hook annotated "PreSync,PostSync" appears in
// both PreSync and PostSync but NOT in Sync.
//
// Phase values are validated against the four known phases; unknown values
// cause the resource to fall back to Sync (treated as non-hook). The value
// "Sync" explicitly is ALSO treated as non-hook in MVP (divergence from
// ArgoCD, where hook=Sync is a real hook phase with completion-wait).
func ClassifyPaired(objs []PairedObj) (*Bucket, error) {
	b := &Bucket{}
	for _, po := range objs {
		annotations := po.Obj.GetAnnotations()
		hookAnn := annotations[paprikav1.HookAnnotation]
		phases, explicit := parseHookPhases(hookAnn)
		deletePolicy := annotations[paprikav1.HookDeletePolicyAnnotation]

		if !explicit {
			// Non-hook: land in Sync.
			b.Sync = append(b.Sync, Resource{Obj: po.Obj, Raw: po.Raw, Phase: PhaseSync, DeletePolicy: deletePolicy})
			continue
		}

		for _, p := range phases {
			r := Resource{Obj: po.Obj, Raw: po.Raw, Phase: p, DeletePolicy: deletePolicy}
			switch p {
			case PhasePreSync:
				b.PreSync = append(b.PreSync, r)
			case PhasePostSync:
				b.PostSync = append(b.PostSync, r)
			case PhaseSyncFail:
				b.SyncFail = append(b.SyncFail, r)
			case PhaseSync:
				// Explicit "Sync" annotation: treat as non-hook in MVP.
				b.Sync = append(b.Sync, r)
			}
		}
	}
	return b, nil
}

// parseHookPhases parses the hook annotation value into a slice of phases.
// Returns (phases, explicit). explicit is false when the annotation is
// absent OR empty (the resource is a non-hook). Unknown phase values cause
// the entire annotation to be treated as non-hook (returns ([PhaseSync], false)).
func parseHookPhases(value string) ([]Phase, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, false
	}
	var phases []Phase
	for _, raw := range strings.Split(value, ",") {
		raw = strings.TrimSpace(raw)
		switch Phase(raw) {
		case PhasePreSync:
			phases = append(phases, PhasePreSync)
		case PhasePostSync:
			phases = append(phases, PhasePostSync)
		case PhaseSyncFail:
			phases = append(phases, PhaseSyncFail)
		case PhaseSync:
			// Explicit Sync annotation — include so ClassifyPaired can place
			// it in Sync (treated as non-hook per MVP divergence).
			phases = append(phases, PhaseSync)
		default:
			// Unknown phase value — treat the whole resource as non-hook.
			return nil, false
		}
	}
	return phases, true
}
```

The `Classify` function from the spec is `ClassifyPaired` here (renamed for clarity; the spec's "Classify(objs, rawDocs)" was a slight overload — splitting into `PairWithBytes` + `ClassifyPaired` makes the byte-pairing explicit).

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./internal/engine/hooks/... -v
```

Expected: all 9 tests pass.

- [ ] **Step 5: Commit**

```bash
git add internal/engine/hooks/
git commit -m "feat(sync-hooks): hooks package — Classify and phase bucketing"
```

---

### Task 1.2: Completion checkers (Job + Pod)

**Files:**
- Create: `internal/engine/hooks/completion.go`, `internal/engine/hooks/completion_test.go`

- [ ] **Step 1: Write failing tests**

Create `internal/engine/hooks/completion_test.go`:

```go
package hooks

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
)

func newFakeDynamicClient(t *testing.T, objs ...runtime.Object) dynamic.Interface {
	t.Helper()
	scheme := clientgoscheme.Scheme
	for _, o := range objs {
		_ = scheme.AddKnownTypes(schema.GroupVersion{Group: "", Version: "v1"}, o)
	}
	gvr := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "jobs"}
	gvr2 := schema.GroupVersionResource{Group: "", Version: "v1", Resource: "pods"}
	return dynamicfake.NewSimpleDynamicClient(scheme, objs...).Resource(gvr).Namespace("default")
	// (Note: the actual fake client setup will need both Job and Pod GVRs;
	// adjust the helper to return the raw client and let callers pick the
	// resource. The point of this test file is to test the completion funcs
	// themselves — see the actual func signatures below.)
}

func TestJobCompletion_Succeeded(t *testing.T) {
	// Build a Job with status.conditions[Complete=true] in *unstructured form.
	job := &batchv1.Job{
		TypeMeta:   metav1.TypeMeta{Kind: "Job", APIVersion: "batch/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "succeeded", Namespace: "default"},
		Status:     batchv1.JobStatus{Conditions: []batchv1.JobCondition{{Type: batchv1.JobComplete, Status: corev1.ConditionTrue}}},
	}
	u, err := runtime.DefaultUnstructuredConverter.ToUnstructured(job)
	require.NoError(t, err)
	obj := &unstructured.Unstructured{Object: u}

	done, succeeded, msg, err := jobCompletionFromObject(obj)
	require.NoError(t, err)
	assert.True(t, done)
	assert.True(t, succeeded)
	assert.NotEmpty(t, msg)
}

func TestJobCompletion_Failed(t *testing.T) {
	job := &batchv1.Job{
		TypeMeta:   metav1.TypeMeta{Kind: "Job", APIVersion: "batch/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "failed", Namespace: "default"},
		Status:     batchv1.JobStatus{Conditions: []batchv1.JobCondition{{Type: batchv1.JobFailed, Status: corev1.ConditionTrue}}},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(job)
	obj := &unstructured.Unstructured{Object: u}

	done, succeeded, _, _ := jobCompletionFromObject(obj)
	assert.True(t, done)
	assert.False(t, succeeded)
}

func TestJobCompletion_NotDone(t *testing.T) {
	job := &batchv1.Job{
		TypeMeta:   metav1.TypeMeta{Kind: "Job", APIVersion: "batch/v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "running", Namespace: "default"},
		Status:     batchv1.JobStatus{},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(job)
	obj := &unstructured.Unstructured{Object: u}

	done, _, _, _ := jobCompletionFromObject(obj)
	assert.False(t, done)
}

func TestPodCompletion_Succeeded(t *testing.T) {
	pod := &corev1.Pod{
		TypeMeta:   metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "ok", Namespace: "default"},
		Status:     corev1.PodStatus{Phase: corev1.PodSucceeded},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(pod)
	obj := &unstructured.Unstructured{Object: u}

	done, succeeded, _, _ := podCompletionFromObject(obj)
	assert.True(t, done)
	assert.True(t, succeeded)
}

func TestPodCompletion_Pending(t *testing.T) {
	pod := &corev1.Pod{
		TypeMeta:   metav1.TypeMeta{Kind: "Pod", APIVersion: "v1"},
		ObjectMeta: metav1.ObjectMeta{Name: "pending", Namespace: "default"},
		Status:     corev1.PodStatus{Phase: corev1.PodPending},
	}
	u, _ := runtime.DefaultUnstructuredConverter.ToUnstructured(pod)
	obj := &unstructured.Unstructured{Object: u}

	done, _, _, _ := podCompletionFromObject(obj)
	assert.False(t, done)
}

func TestCompletionFor_KnownKind(t *testing.T) {
	fn := CompletionFor("batch/v1, Kind=Job")
	assert.NotNil(t, fn)
}

func TestCompletionFor_UnknownKind_Nil(t *testing.T) {
	fn := CompletionFor("example.com/v1, Kind=Widget")
	assert.Nil(t, fn, "unknown GVK should return nil (fire-and-forget)")
}

// dummy use of time to silence unused imports if some tests are skipped
var _ = time.Second
var _ = context.Background
```

(Adjust the `newFakeDynamicClient` helper as needed — its placement above is illustrative; the real tests use `jobCompletionFromObject`/`podCompletionFromObject` which take an `*unstructured.Unstructured` directly, sidestepping the dynamic client entirely.)

Run: `go test ./internal/engine/hooks/...` — expected FAIL (functions undefined).

- [ ] **Step 2: Create `completion.go`**

Create `internal/engine/hooks/completion.go`:

```go
package hooks

import (
	"context"
	"fmt"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/dynamic"
)

// CompletionFunc reports whether a hook resource has reached a terminal
// state. Returns (done, succeeded, message, err). When done is false, the
// controller should re-check on the next reconcile. When done is true,
// succeeded indicates whether the hook succeeded.
type CompletionFunc func(ctx context.Context, client dynamic.Interface, ns, name string) (done, succeeded bool, message string, err error)

var completionRegistry = map[string]CompletionFunc{}

func init() {
	// Built-in checkers. Callers can add more via RegisterCompletionChecker.
	RegisterCompletionChecker("batch/v1, Kind=Job", jobCompletion)
	RegisterCompletionChecker("v1, Kind=Pod", podCompletion)
}

// RegisterCompletionChecker registers a completion checker for a GVK string
// formatted as "group/version, Kind=kind" (the same format GVK.String()
// produces). Safe to call from init() in any package.
func RegisterCompletionChecker(gvk string, fn CompletionFunc) {
	completionRegistry[gvk] = fn
}

// CompletionFor returns the registered checker for the given GVK, or nil
// (meaning "fire-and-forget" — creation is considered completion).
func CompletionFor(gvk string) CompletionFunc {
	return completionRegistry[gvk]
}

// jobCompletion fetches a Job and checks its status.conditions.
func jobCompletion(ctx context.Context, client dynamic.Interface, ns, name string) (bool, bool, string, error) {
	obj, err := client.Resource(jobGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false, false, "", err
	}
	return jobCompletionFromObject(obj)
}

// podCompletion fetches a Pod and checks its status.phase.
func podCompletion(ctx context.Context, client dynamic.Interface, ns, name string) (bool, bool, string, error) {
	obj, err := client.Resource(podGVR).Namespace(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return false, false, "", err
	}
	return podCompletionFromObject(obj)
}

func jobCompletionFromObject(obj *unstructured.Unstructured) (bool, bool, string, error) {
	var job batchv1.Job
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &job); err != nil {
		return false, false, "", fmt.Errorf("converting to Job: %w", err)
	}
	for _, c := range job.Status.Conditions {
		if c.Type == batchv1.JobComplete && c.Status == corev1.ConditionTrue {
			return true, true, "Job completed successfully", nil
		}
		if c.Type == batchv1.JobFailed && c.Status == corev1.ConditionTrue {
			msg := "Job failed"
			if c.Message != "" {
				msg = c.Message
			}
			return true, false, msg, nil
		}
	}
	if job.Status.Succeeded > 0 {
		return true, true, "Job succeeded", nil
	}
	if job.Status.Failed > 0 {
		return true, false, fmt.Sprintf("Job failed (%d pods failed)", job.Status.Failed), nil
	}
	return false, false, "", nil
}

func podCompletionFromObject(obj *unstructured.Unstructured) (bool, bool, string, error) {
	var pod corev1.Pod
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(obj.Object, &pod); err != nil {
		return false, false, "", fmt.Errorf("converting to Pod: %w", err)
	}
	switch pod.Status.Phase {
	case corev1.PodSucceeded:
		return true, true, "Pod succeeded", nil
	case corev1.PodFailed:
		msg := "Pod failed"
		if pod.Status.Message != "" {
			msg = pod.Status.Message
		}
		return true, false, msg, nil
	}
	return false, false, "", nil
}

var (
	jobGVR = batchv1.SchemeGroupVersion.WithResource("jobs")
	podGVR = corev1.SchemeGroupVersion.WithResource("pods")
)
```

Add `"k8s.io/apimachinery/pkg/apis/meta/v1"` to the imports (for `metav1.GetOptions{}`).

- [ ] **Step 3: Run tests**

```bash
go test ./internal/engine/hooks/... -v
```

Expected: all parser + completion tests pass (15 total).

- [ ] **Step 4: Lint**

```bash
bin/golangci-lint run ./internal/engine/hooks/...
```

- [ ] **Step 5: Commit**

```bash
git add internal/engine/hooks/completion.go internal/engine/hooks/completion_test.go
git commit -m "feat(sync-hooks): Job and Pod completion checkers"
```

---

## Chunk 2: Diff engine integration

### Task 2.1: Exclude hooks from `ComputeDiff`

**Files:**
- Modify: `internal/engine/scalable_diff.go:76` (the `ComputeDiff` method)
- Modify: `internal/engine/diff.go:56` (the non-scalable `ComputeDiff`)

- [ ] **Step 1: Add the helper**

Add to `internal/engine/hooks/doc.go` (or a new `internal/engine/hooks/filter.go`):

```go
package hooks

import (
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

// IsHook reports whether the given resource carries a non-empty hook
// annotation. Used by the diff engine to exclude hook resources from
// OutOfSync calculations (hooks are not "managed" resources).
func IsHook(obj *unstructured.Unstructured) bool {
	if obj == nil {
		return false
	}
	ann := obj.GetAnnotations()
	v, ok := ann[paprikav1.HookAnnotation]
	return ok && v != ""
}

// FilterHooks returns a copy of objs with hook resources removed.
func FilterHooks(objs []unstructured.Unstructured) []unstructured.Unstructured {
	out := make([]unstructured.Unstructured, 0, len(objs))
	for i := range objs {
		if !IsHook(&objs[i]) {
			out = append(out, objs[i])
		}
	}
	return out
}
```

Add a unit test:

```go
// in hooks/filter_test.go
package hooks

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"

	paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestIsHook_True(t *testing.T) {
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(schema.GroupVersionKind{Group: "batch", Version: "v1", Kind: "Job"})
	u.SetAnnotations(map[string]string{paprikav1.HookAnnotation: "PreSync"})
	assert.True(t, IsHook(u))
}

func TestIsHook_EmptyValue_False(t *testing.T) {
	u := &unstructured.Unstructured{}
	u.SetAnnotations(map[string]string{paprikav1.HookAnnotation: ""})
	assert.False(t, IsHook(u))
}

func TestIsHook_NoAnnotation_False(t *testing.T) {
	u := &unstructured.Unstructured{}
	assert.False(t, IsHook(u))
}

func TestFilterHooks(t *testing.T) {
	in := []unstructured.Unstructured{
		{}, // no annotation
		{}, // we'll set below
		{},
	}
	in[1].SetAnnotations(map[string]string{paprikav1.HookAnnotation: "PostSync"})
	out := FilterHooks(in)
	assert.Len(t, out, 2, "hook object should be filtered")
}
```

- [ ] **Step 2: Apply the filter in both ComputeDiff paths**

In `internal/engine/scalable_diff.go` `ComputeDiff` (around line 76), at the very TOP of the function (before any listing/comparison work), filter the desired set:

```go
// Import the hooks package.
desired = hooks.FilterHooks(desired)
```

Add the import: `"github.com/benebsworth/paprika/internal/engine/hooks"`.

Do the same in `internal/engine/diff.go:56` (the non-scalable variant).

For the live side: live resources with the hook annotation should also be excluded. The simplest way is to skip them when iterating the live list. In `scalable_diff.go`, where the live informer results are iterated, add a `if hooks.IsHook(liveObj) { continue }`.

- [ ] **Step 3: Run existing tests + new tests**

```bash
go test ./internal/engine/... -v
```

Existing diff tests should still pass (they don't use hooks). New filter tests pass.

- [ ] **Step 4: Commit**

```bash
git add internal/engine/hooks/ internal/engine/scalable_diff.go internal/engine/diff.go
git commit -m "feat(sync-hooks): exclude hook resources from diff engine"
```

---

## Chunk 3: Controller-side orchestration

### Task 3.1: `executeHooks` with re-entrancy state machine

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: Add sentinel errors + helper types**

Near the top of `release_controller.go`, after the existing error vars (search for `var (` near the package-level declarations):

```go
var (
	// errHookPhasePending indicates one or more hooks in a phase are still
	// Running. The caller should persist status and requeue.
	errHookPhasePending = errors.New("hook phase still in progress")
)
```

- [ ] **Step 2: Write the `executeHooks` method**

Append to `release_controller.go` (anywhere in the file's existing method block; pick a spot near the other apply methods):

```go
// executeHooks runs one phase's hooks in YAML-declaration order, honoring
// the re-entrancy contract from docs/superpowers/specs/2026-06-29-sync-hooks-design.md.
//
// Reads release.Status.HookStatuses for prior state. Mutates the slice in
// place; the caller persists via patchReleaseStatus.
//
// Returns nil when the phase is fully Succeeded. Returns errHookPhasePending
// when one or more hooks are still Running. Returns a wrapped error when any
// hook has Failed/Terminated.
func (r *ReleaseReconciler) executeHooks(
	ctx context.Context,
	release *paprikav1.Release,
	dynClient dynamic.Interface,
	resources []hooks.Resource,
	phase hooks.Phase,
) error {
	log := logf.FromContext(ctx)
	timeout := hookTimeout(release)

	for _, res := range resources {
		statusIdx, prior := findHookStatus(release, res.Obj, phase)

		switch {
		case prior != nil && prior.Status == "Succeeded":
			continue
		case prior != nil && (prior.Status == "Failed" || prior.Status == "Terminated"):
			return fmt.Errorf("hook %s/%s previously %s: %s", res.Obj.GetKind(), res.Obj.GetName(), prior.Status, prior.Message)
		case prior != nil && prior.Status == "Running":
			// Poll the live resource.
			done, succeeded, msg, pollErr := r.pollHook(ctx, dynClient, res.Obj, prior)
			if pollErr != nil {
				// Transient Get error — leave as Running, requeue.
				log.Error(pollErr, "Failed to poll hook", "kind", res.Obj.GetKind(), "name", res.Obj.GetName())
				continue
			}
			if !done {
				if timeout > 0 && time.Since(prior.StartedAt.Time) >= timeout {
					r.setHookStatus(release, statusIdx, res.Obj, phase, "Terminated", "hook timed out")
					return fmt.Errorf("hook %s/%s timed out after %s", res.Obj.GetKind(), res.Obj.GetName(), timeout)
				}
				// Still running — requeue via sentinel.
				return errHookPhasePending
			}
			finalStatus := "Succeeded"
			if !succeeded {
				finalStatus = "Failed"
			}
			r.setHookStatus(release, statusIdx, res.Obj, phase, finalStatus, msg)
			if !succeeded {
				return fmt.Errorf("hook %s/%s failed: %s", res.Obj.GetKind(), res.Obj.GetName(), msg)
			}
		default:
			// First sighting — apply.
			if res.DeletePolicy == "" || res.DeletePolicy == "BeforeHookCreation" {
				if err := r.deleteExistingHook(ctx, dynClient, res.Obj); err != nil {
					// Best-effort; the create may still succeed.
					log.Error(err, "Failed to delete existing hook before creation", "kind", res.Obj.GetKind(), "name", res.Obj.GetName())
				}
			}
			if err := r.applyHookObject(ctx, dynClient, res.Obj, release); err != nil {
				r.setHookStatus(release, -1, res.Obj, phase, "Failed", err.Error())
				return fmt.Errorf("apply hook %s/%s: %w", res.Obj.GetKind(), res.Obj.GetName(), err)
			}
			// Stamp Running.
			idx := r.setHookStatus(release, -1, res.Obj, phase, "Running", "")
			hs := &release.Status.HookStatuses[idx]
			now := metav1.NewTime(r.Clock.Now())
			hs.StartedAt = &now

			// Fire-and-forget when timeout == 0 OR no completion checker.
			if timeout == 0 {
				r.setHookStatus(release, idx, res.Obj, phase, "Succeeded", "fire-and-forget")
				continue
			}
			gvk := res.Obj.GroupVersionKind().String()
			if hooks.CompletionFor(gvk) == nil {
				r.setHookStatus(release, idx, res.Obj, phase, "Succeeded", "fire-and-forget (no completion checker)")
				continue
			}
			// Poll once on this reconcile.
			done, succeeded, msg, pollErr := r.pollHook(ctx, dynClient, res.Obj, &release.Status.HookStatuses[idx])
			if pollErr != nil {
				log.Error(pollErr, "Initial poll failed", "kind", res.Obj.GetKind(), "name", res.Obj.GetName())
				return errHookPhasePending
			}
			if done {
				finalStatus := "Succeeded"
				if !succeeded {
					finalStatus = "Failed"
				}
				r.setHookStatus(release, idx, res.Obj, phase, finalStatus, msg)
				if !succeeded {
					return fmt.Errorf("hook %s/%s failed: %s", res.Obj.GetKind(), res.Obj.GetName(), msg)
				}
			} else {
				return errHookPhasePending
			}
		}
	}
	return nil
}

// findHookStatus returns the index and pointer to the existing HookStatus
// entry for the given (kind, name, namespace, phase), or (-1, nil) if absent.
func findHookStatus(release *paprikav1.Release, obj *unstructured.Unstructured, phase hooks.Phase) (int, *paprikav1.HookStatus) {
	for i := range release.Status.HookStatuses {
		hs := &release.Status.HookStatuses[i]
		if hs.Kind == obj.GetKind() && hs.Name == obj.GetName() && hs.Namespace == obj.GetNamespace() && hs.Phase == string(phase) {
			return i, hs
		}
	}
	return -1, nil
}

// setHookStatus upserts a HookStatus entry. If idx == -1, appends; otherwise
// updates the existing entry. Returns the effective index.
func (r *ReleaseReconciler) setHookStatus(release *paprikav1.Release, idx int, obj *unstructured.Unstructured, phase hooks.Phase, status, msg string) int {
	now := metav1.NewTime(r.Clock.Now())
	if idx == -1 {
		release.Status.HookStatuses = append(release.Status.HookStatuses, paprikav1.HookStatus{
			Kind:      obj.GetKind(),
			Name:      obj.GetName(),
			Namespace: obj.GetNamespace(),
			Phase:     string(phase),
			Status:    status,
			StartedAt: &now,
			Message:   msg,
		})
		return len(release.Status.HookStatuses) - 1
	}
	hs := &release.Status.HookStatuses[idx]
	hs.Status = status
	hs.Message = msg
	if status == "Succeeded" || status == "Failed" || status == "Terminated" {
		hs.CompletedAt = &now
	}
	return idx
}

// pollHook calls the registered completion checker for the hook's GVK.
func (r *ReleaseReconciler) pollHook(ctx context.Context, dynClient dynamic.Interface, obj *unstructured.Unstructured, prior *paprikav1.HookStatus) (bool, bool, string, error) {
	gvk := obj.GroupVersionKind().String()
	fn := hooks.CompletionFor(gvk)
	if fn == nil {
		return true, true, "no completion checker", nil
	}
	return fn(ctx, dynClient, obj.GetNamespace(), obj.GetName())
}

// deleteExistingHook deletes any live resource with the same GVR/name/namespace.
func (r *ReleaseReconciler) deleteExistingHook(ctx context.Context, dynClient dynamic.Interface, obj *unstructured.Unstructured) error {
	// Resolve GVR (reuse existing controller helpers).
	gvr, err := r.gvrFromKind(obj.GetKind(), obj.GroupVersionKind().Group, obj.GroupVersionKind().Version)
	if err != nil {
		return err
	}
	err = dynClient.Resource(gvr).Namespace(obj.GetNamespace()).Delete(ctx, obj.GetName(), metav1.DeleteOptions{})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

// applyHookObject server-side-applies a hook manifest, stamping paprika labels.
func (r *ReleaseReconciler) applyHookObject(ctx context.Context, dynClient dynamic.Interface, obj *unstructured.Unstructured, release *paprikav1.Release) error {
	metadata, ok := obj.Object["metadata"].(map[string]interface{})
	if !ok {
		return errors.New("object missing metadata")
	}
	appName := ""
	if release.Labels != nil {
		appName = release.Labels["paprika.io/app"]
	}
	setPaprikaLabels(metadata, appName)
	gvr, err := r.gvrFromKind(obj.GetKind(), obj.GroupVersionKind().Group, obj.GroupVersionKind().Version)
	if err != nil {
		return err
	}
	_, err = dynClient.Resource(gvr).Namespace(obj.GetNamespace()).Apply(ctx, obj.GetName(), obj, metav1.ApplyOptions{FieldManager: "paprika"})
	return err
}

// hookTimeout resolves the per-hook timeout from release.Spec.SyncOptions.
// Returns 0 if fire-and-forget. Default 300s when nil.
func hookTimeout(release *paprikav1.Release) time.Duration {
	if release.Spec.SyncOptions == nil || release.Spec.SyncOptions.HookTimeoutSeconds == 0 {
		return 300 * time.Second
	}
	return time.Duration(release.Spec.SyncOptions.HookTimeoutSeconds) * time.Second
}
```

Add imports: `"github.com/benebsworth/paprika/internal/engine/hooks"`. The `time`, `metav1`, `dynamic`, `apierrors` imports should already be present from prior work.

- [ ] **Step 3: Verify it compiles**

```bash
go build ./internal/controller/...
```

- [ ] **Step 4: Commit (do NOT yet wire into promote — that's Task 3.2)**

```bash
git add internal/controller/pipelines/release_controller.go
git commit -m "feat(sync-hooks): executeHooks method with re-entrancy state machine"
```

---

### Task 3.2: Wire `executeHooks` into `promote` with fast path

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go:738` (the `promote` function)

- [ ] **Step 1: Add the fast-path branch in `promote`**

Locate `promote` at line 738. After the existing render → governance → conftest → snapshot sequence, but BEFORE the existing `applyPromotedManifests` call, insert the hook orchestration. The exact insertion point is between the existing `storeManifestSnapshot` call and the existing `applyPromotedManifests` call.

```go
// Fast path: if no hook annotation substring is present, behave exactly as
// before — no classify overhead, original bytes flow to applyPromotedManifests.
if !bytes.Contains(manifests, []byte(paprikav1.HookAnnotation)) {
	if err := r.applyPromotedManifests(ctx, release, stage, manifests); err != nil {
		return fmt.Errorf("apply promoted manifests: %w", err)
	}
	// ... existing post-apply logic (status patch, promote to next stage, etc.) ...
	// (Continue with the rest of promote's existing body verbatim.)
	return nil
}

// Hook path: classify, partition, execute phases with re-entrancy.
objs, parseErr := parseManifests(manifests)
if parseErr != nil {
	return fmt.Errorf("parse manifests for hooks: %w", parseErr)
}
paired, pairErr := hooks.PairWithBytes(objs, manifests)
if pairErr != nil {
	return fmt.Errorf("pair manifests: %w", pairErr)
}
bucket, classErr := hooks.ClassifyPaired(paired)
if classErr != nil {
	return fmt.Errorf("classify hooks: %w", classErr)
}

// Resolve the dynamic client once (mirrors applyManifestsForCluster's logic).
dynClient, dynErr := r.dynClientForRelease(ctx, release)
if dynErr != nil {
	return fmt.Errorf("resolve dynamic client: %w", dynErr)
}

// PreSync
if err := r.executeHooks(ctx, release, dynClient, bucket.PreSync, hooks.PhasePreSync); err != nil {
	if !errors.Is(err, errHookPhasePending) {
		_ = r.executeHooks(ctx, release, dynClient, bucket.SyncFail, hooks.PhaseSyncFail)
		return fmt.Errorf("pre-sync hooks: %w", err)
	}
	// Pending: persist status; requeue.
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		return fmt.Errorf("patch release status (PreSync pending): %w", err)
	}
	return errHookPhasePending // caller must requeue
}

// Sync
if err := r.applyPromotedManifests(ctx, release, stage, bucket.SyncDocs()); err != nil {
	_ = r.executeHooks(ctx, release, dynClient, bucket.SyncFail, hooks.PhaseSyncFail)
	return fmt.Errorf("apply promoted manifests: %w", err)
}

// PostSync
if err := r.executeHooks(ctx, release, dynClient, bucket.PostSync, hooks.PhypePostSync); err != nil {
	if !errors.Is(err, errHookPhasePending) {
		_ = r.executeHooks(ctx, release, dynClient, bucket.SyncFail, hooks.PhaseSyncFail)
		return fmt.Errorf("post-sync hooks: %w", err)
	}
	if err := r.patchReleaseStatus(ctx, release); err != nil {
		return fmt.Errorf("patch release status (PostSync pending): %w", err)
	}
	return errHookPhasePending
}

// (Continue with the rest of promote's existing body — status patch,
// promote to next stage, etc.)
```

Note: `promote`'s caller (`handlePromotingPhase`) must learn to handle `errHookPhasePending` by requeueing instead of advancing the release phase. Update `handlePromotingPhase` (search for `promote(` call site) to check `errors.Is(err, errHookPhasePending)` and return `ctrl.Result{RequeueAfter: 10 * time.Second}, nil` without changing the release phase.

The `dynClientForRelease` method may or may not exist (depends on the current `applyManifestsForCluster` shape — read lines 1003-1017 to confirm). If it doesn't exist as a named method, factor one out that returns the `dynamic.Interface` (or the agent path indicator) for the release's target cluster.

- [ ] **Step 2: Verify build + existing tests**

```bash
go build ./... && bin/golangci-lint run ./internal/controller/...
go test ./internal/controller/... -count=1
```

All existing pipeline controller tests must still pass. The fast path is byte-identical to before; the slow path is only entered when hooks are present.

- [ ] **Step 3: Commit**

```bash
git add internal/controller/pipelines/release_controller.go
git commit -m "feat(sync-hooks): wire executeHooks into promote with bytes.Contains fast path"
```

---

### Task 3.3: Controller-level envtest for the full hook lifecycle

**Files:**
- Modify: `internal/controller/pipelines/suite_test.go` (add the rollout types to the scheme if not already)
- Create or append: `internal/controller/pipelines/hooks_controller_test.go`

- [ ] **Step 1: Write the envtest**

Add a Ginkgo `Describe` block (model on `internal/controller/rollouts/rollout_controller_test.go`). Cover:

1. **Happy path:** PreSync Job → Sync ConfigMap → PostSync Pod. All three phases run in order, Release reaches Healthy.
2. **PreSync failure:** PreSync Job with `.status.conditions[Failed=true]` → Sync ConfigMap NOT applied, SyncFail hook (if any) runs, Release = Failed.
3. **Re-entrancy:** First reconcile creates PreSync Job, stamps Running. Second reconcile (without touching the Job) returns errHookPhasePending. Third reconcile marks the Job Succeeded, Sync phase runs.
4. **Timeout:** `HookTimeoutSeconds: 1`, Job never completes → after ~1s, hook is marked Terminated, Release = Failed.
5. **BeforeHookCreation:** Run the same Release twice; second run deletes the first hook's Job before applying.

For each scenario, pre-build a small `[]byte` manifest bundle with the appropriate `argocd.argoproj.io/hook` annotations. Use a helper:

```go
func hookBundle(docs ...string) []byte {
	return []byte(strings.Join(docs, "\n---\n"))
}
```

- [ ] **Step 2: Run**

```bash
go test ./internal/controller/pipelines/... -ginkgo.focus=hooks -v
```

Expected: all 5 scenarios pass.

- [ ] **Step 3: Commit**

```bash
git add internal/controller/pipelines/
git commit -m "test(sync-hooks): controller envtest covering happy/fail/requeue/timeout/recreate"
```

---

## Chunk 4: Agent-side parity

### Task 4.1: Mirror `executeHooks` in the agent

**Files:**
- Modify: `internal/agent/server/server.go:81` (the `Apply` handler)

- [ ] **Step 1: Add the agent-side `executeHooks`**

The agent's `Apply` handler already has a K8s client + RESTMapper. Add a `(*Server).executeHooks(...)` method that mirrors the controller-side one but uses the agent's local clients. The signature is identical; the body is too. **Copy the controller's `executeHooks` and adapt the client-resolution lines only.**

- [ ] **Step 2: Wire into `Apply`**

After parsing manifests in `Apply` (around line 81), insert the same fast-path + classify + execute-phases pattern as the controller. The agent doesn't have a "Release" object to write HookStatuses into — instead, populate `ApplyResponse.HookStatuses` (add this field to the `ApplyResponse` struct at line 75):

```go
type ApplyResponse struct {
	// ... existing fields ...
	// HookStatuses is populated when the request bundle contains hook
	// resources. Empty when no hooks were present (or when running against
	// an old agent that doesn't populate it — controller falls back to its
	// own classification).
	HookStatuses []paprikav1.HookStatus `json:"hookStatuses,omitempty"`
}
```

This is a JSON struct field addition — old controllers that don't read it just ignore it (JSON ignores unknown fields). Old agents that don't populate it leave it empty (controller treats empty as "agent didn't execute hooks" and stamps from its own classification per the version-skew policy).

- [ ] **Step 3: Test**

Add an envtest for the agent's `Apply` RPC with a hook bundle. Verify the response's `HookStatuses` shows the PreSync Job's Running→Succeeded transition.

If agent-side envtest infra doesn't exist (likely), this task may require setting up a minimal agent test harness — or marking this task as "deferred to integration test" and relying on the e2e workflow.

- [ ] **Step 4: Commit**

```bash
git add internal/agent/server/
git commit -m "feat(sync-hooks): agent-side executeHooks parity"
```

---

## Chunk 5: Application status propagation + e2e smoke

### Task 5.1: Propagate `HookStatuses` from active Release to Application

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go:1111-1113` (the status propagation block)

- [ ] **Step 1: Add the propagation**

In the `evaluateDiff` (or equivalent) block where `app.Status` is being populated from the active Release, add:

```go
// Propagate hook statuses from the active Release (if any).
if activeRelease := r.activeReleaseForApp(ctx, app); activeRelease != nil {
    app.Status.HookStatuses = activeRelease.Status.HookStatuses
} else {
    app.Status.HookStatuses = nil
}
```

The `activeReleaseForApp` helper may already exist (search for `activeRelease`); if not, it's a small lookup: `app.Status.ReleaseRef` → fetch the Release → return.

Place the propagation near line 1113 (right after the existing `app.Status.PrunedResources = ...` line).

- [ ] **Step 2: Test**

```go
// in application_controller_test.go or a new hooks_status_test.go
It("propagates HookStatuses from the active Release", func() {
    // Create an Application with an active Release that has HookStatuses.
    // Reconcile the Application.
    // Assert app.Status.HookStatuses matches the Release's.
})
```

- [ ] **Step 3: Commit**

```bash
git add internal/controller/pipelines/
git commit -m "feat(sync-hooks): propagate HookStatuses from active Release to Application"
```

---

### Task 5.2: E2E smoke test with a real Helm chart fixture

**Files:**
- Create: `test/e2e/hooks_test.go` (or append to the existing e2e suite)
- Create: `test/e2e/fixtures/hooks-chart/` (a tiny Helm-style chart with PreSync/PostSync hooks)

- [ ] **Step 1: Build the fixture chart**

A minimal chart with:
- `templates/deployment.yaml` — a normal Sync-phase Deployment.
- `templates/presync-job.yaml` — a Job with `annotations: {argocd.argoproj.io/hook: PreSync}`.
- `templates/postsync-job.yaml` — a Job with `annotations: {argocd.argoproj.io/hook: PostSync}`.

- [ ] **Step 2: Write the e2e**

Use the on-demand E2E workflow pattern. The test:
1. Applies an Application pointing at the fixture chart.
2. Waits for Release to reach Healthy.
3. Asserts: PreSync Job ran (in cluster), Deployment was applied, PostSync Job ran. HookStatuses on the Application reflect all three.

- [ ] **Step 3: Run via the on-demand workflow**

```bash
gh workflow run test-e2e.yml --ref feature/sync-hooks -f ginkgo_focus=hooks
```

- [ ] **Step 4: Commit**

```bash
git add test/e2e/
git commit -m "test(sync-hooks): e2e smoke test with ArgoCD-annotated fixture chart"
```

---

## Verification — run before declaring done

```bash
make manifests
make generate
bin/golangci-lint run
go test -count=1 ./internal/engine/hooks/... ./internal/controller/... ./internal/agent/...
```

All must pass. For e2e:

```bash
gh workflow run test-e2e.yml --ref feature/sync-hooks -f ginkgo_focus=hooks
```

## Out of scope (deferred)

- **PostDelete phase** — requires finalizer coordination.
- **`HookSucceeded` / `HookFailed` deletion policies** — require prune-on-sync.
- **Hook weights** (`argocd.argoproj.io/hook-weight`) — parsed but ignored.
- **Widening strict error propagation to the Sync-phase apply path** — `applyDocument` continues to swallow errors.
- **Custom hook completion checkers** beyond Job and Pod.
- **UI surface of `HookStatuses`** — Connect-ES types regenerated automatically; UI work is separate.

## References

- Spec: `docs/superpowers/specs/2026-06-29-sync-hooks-design.md` (v3, spec-review-approved)
- Apply path audit: stored in the explore-agent output; key files cited inline.
- Pattern reference for re-entrancy: the canary advancement state machine in `internal/rollout/canary/canary.go` (from the rollout-correctness work).
- Pattern reference for envtest: `internal/controller/rollouts/rollout_controller_test.go` (canary lifecycle, abort, rolling, etc.).
- Existing Job-watching helper: `internal/engine/workflow.go:321` (`watchJob`) — reusable if the polling model needs to shift to a watch.
