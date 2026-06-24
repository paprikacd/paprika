> **I'm using the writing-plans skill to create the implementation plan.**

# Pipeline Step Artifacts Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface pipeline-produced OCI and ConfigMap artifacts in the API and dashboard step detail panel.

**Architecture:** Extend the existing `Pipeline` and `Artifact` CRDs to record step-level outputs, harden the Artifact controller to verify both OCI and ConfigMap references, enrich the pipeline controller to create/update artifacts and publish their status via SSE, extend the protobuf API with artifact RPCs, and update the dashboard step detail panel to show artifacts.

**Tech Stack:** Go, Kubernetes controller-runtime, kubebuilder markers, Protocol Buffers (connectrpc), TypeScript/React/Next.js, shadcn, vitest.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `api/pipelines/v1alpha1/pipeline_types.go` | `PipelineStep.Outputs`, `PipelineOutput.Step`, `PipelineArtifactRef`, `PipelineArtifactPhase`, `PipelineStatus.ArtifactRefs` |
| `api/pipelines/v1alpha1/artifact_types.go` | `ArtifactProvenance.Step`, `ArtifactSpec.Type` enum |
| `internal/controller/pipelines/artifact_controller.go` | Reconcile OCI and ConfigMap artifacts, set Ready conditions |
| `internal/controller/pipelines/artifact_controller_test.go` | Unit tests for artifact reconciliation |
| `internal/controller/pipelines/artifact_reference.go` | Helpers: `parseArtifactReference`, `parseConfigMapReference`, `resolveConfigMapKey` |
| `internal/controller/pipelines/artifact_reference_test.go` | Unit tests for reference helpers |
| `internal/controller/pipelines/artifact_name.go` | Helper: `sanitizeArtifactName` |
| `internal/controller/pipelines/artifact_name_test.go` | Unit tests for name sanitization |
| `internal/controller/pipelines/pipeline_controller.go` | Create/update artifacts, upsert PipelineArtifactRefs, watch owned artifacts, stale cleanup, SSE events |
| `internal/controller/pipelines/pipeline_controller_test.go` | Unit tests for artifact creation/cleanup |
| `internal/controller/pipelines/artifact_convert.go` | Helper: `convertArtifactToPipelineArtifactRef` |
| `proto/paprika/v1/api.proto` | Extended `ArtifactRef`, new `GetArtifact`/`ListArtifacts` RPCs and messages |
| `internal/api/paprika/v1/*.go` | (regenerated) protobuf Go types |
| `internal/api/paprika/v1/v1connect/*.go` | (regenerated) connect-go service definitions |
| `internal/api/server.go` | `GetArtifact`, `ListArtifacts`, `convertPipeline` update, `buildConfigMapDownloadURL` |
| `internal/api/server_test.go` | Unit tests for artifact RPCs |
| `internal/api/auth/auth.go` | `ResourceArtifacts` constant |
| `ui/src/gen/paprika/v1/*` | (regenerated) protobuf TypeScript types |
| `ui/src/lib/use-step-artifacts.ts` | Hook to filter artifacts by producing step |
| `ui/src/lib/use-step-artifacts.test.ts` | Hook tests |
| `ui/src/components/dashboard/artifact-card.tsx` | Reusable artifact card component |
| `ui/src/components/dashboard/artifact-card.test.tsx` | Artifact card tests |
| `ui/src/components/dashboard/step-detail-panel.tsx` | Render step artifacts subsection |
| `ui/src/app/dashboard/pipelines/detail/page.tsx` | Render pipeline-level artifacts subsection, SSE dispatch |
| `ui/src/lib/pipeline-sse.ts` | Handle `pipeline-artifact` SSE events |
| `config/crd/bases/*` | (regenerated) CRD YAML |
| `config/rbac/role.yaml` | (regenerated) RBAC from markers |

---

## Chunk 1: CRD Data Model

### Task 1: Extend `PipelineOutput` and `PipelineStep`

**Files:**
- Modify: `api/pipelines/v1alpha1/pipeline_types.go`
- Test: `api/pipelines/v1alpha1/pipeline_types_test.go` (create if missing)

- [ ] **Step 1: Write failing test for new fields**

```go
package v1alpha1

import "testing"

func TestPipelineStepOutputs(t *testing.T) {
    p := Pipeline{
        Spec: PipelineSpec{
            Steps: []PipelineStep{
                {
                    Name: "build",
                    Outputs: []PipelineOutput{
                        {Name: "image", Path: "oci://registry.io/repo:tag", Step: "build"},
                    },
                },
            },
        },
    }
    if len(p.Spec.Steps[0].Outputs) != 1 {
        t.Fatalf("expected 1 output, got %d", len(p.Spec.Steps[0].Outputs))
    }
    if p.Spec.Steps[0].Outputs[0].Name != "image" {
        t.Fatalf("expected output name image, got %s", p.Spec.Steps[0].Outputs[0].Name)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./api/pipelines/v1alpha1/... -run TestPipelineStepOutputs -v
```

Expected: FAIL with unknown field `Outputs`.

- [ ] **Step 3: Implement CRD changes**

Modify `api/pipelines/v1alpha1/pipeline_types.go`:

```go
// PipelineStep defines a step in a pipeline.
type PipelineStep struct {
    Name    string   `json:"name"`
    Depends []string `json:"depends,omitempty"`
    Image   string   `json:"image"`
    Script  string   `json:"script"`
    // +optional
    Timeout int `json:"timeout,omitempty"`
    // +optional
    Retry int `json:"retry,omitempty"`
    // +optional
    Outputs []PipelineOutput `json:"outputs,omitempty"`
}
```

```go
// PipelineOutput defines an output artifact of a pipeline.
type PipelineOutput struct {
    Name string `json:"name"`
    Path string `json:"path"`
    // +optional
    Step string `json:"step,omitempty"`
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./api/pipelines/v1alpha1/... -run TestPipelineStepOutputs -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/pipelines/v1alpha1/pipeline_types.go api/pipelines/v1alpha1/pipeline_types_test.go
git commit -m "feat(api): add PipelineStep.Outputs and PipelineOutput.Step"
```

---

### Task 2: Add `PipelineArtifactRef` and `PipelineStatus.ArtifactRefs`

**Files:**
- Modify: `api/pipelines/v1alpha1/pipeline_types.go`
- Test: `api/pipelines/v1alpha1/pipeline_types_test.go`

- [ ] **Step 1: Write failing test for artifact ref fields**

```go
func TestPipelineStatusArtifactRefs(t *testing.T) {
    p := Pipeline{
        Status: PipelineStatus{
            ArtifactRefs: []PipelineArtifactRef{
                {
                    Name:          "my-artifact",
                    Kind:          "oci",
                    Phase:         PipelineArtifactPhaseReady,
                    ProducingStep: "build",
                    CreatedAt:     1782000000,
                },
            },
        },
    }
    if len(p.Status.ArtifactRefs) != 1 {
        t.Fatalf("expected 1 artifact ref, got %d", len(p.Status.ArtifactRefs))
    }
    if p.Status.ArtifactRefs[0].Phase != PipelineArtifactPhaseReady {
        t.Fatalf("expected Ready phase")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./api/pipelines/v1alpha1/... -run TestPipelineStatusArtifactRefs -v
```

Expected: FAIL with unknown types.

- [ ] **Step 3: Implement types**

Add to `api/pipelines/v1alpha1/pipeline_types.go` before `PipelineStatus`:

```go
// PipelineArtifactPhase represents the verification phase of a pipeline artifact.
// +kubebuilder:validation:Enum=Pending;Ready;Failed
type PipelineArtifactPhase string

const (
    PipelineArtifactPhasePending PipelineArtifactPhase = "Pending"
    PipelineArtifactPhaseReady   PipelineArtifactPhase = "Ready"
    PipelineArtifactPhaseFailed  PipelineArtifactPhase = "Failed"
)

// PipelineArtifactRef records an artifact produced by a pipeline run.
type PipelineArtifactRef struct {
    Name              string                `json:"name"`
    Kind              string                `json:"kind"`
    Reference         string                `json:"reference,omitempty"`
    ResolvedReference string                `json:"resolvedReference,omitempty"`
    Digest            string                `json:"digest,omitempty"`
    Phase             PipelineArtifactPhase `json:"phase,omitempty"`
    ProducingStep     string                `json:"producingStep,omitempty"`
    CreatedAt         int64                 `json:"createdAt,omitempty"`
}
```

Add field to `PipelineStatus`:

```go
// +optional
ArtifactRefs []PipelineArtifactRef `json:"artifactRefs,omitempty"`
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./api/pipelines/v1alpha1/... -run TestPipelineStatusArtifactRefs -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add api/pipelines/v1alpha1/pipeline_types.go api/pipelines/v1alpha1/pipeline_types_test.go
git commit -m "feat(api): add PipelineArtifactRef and PipelineStatus.ArtifactRefs"
```

---

### Task 3: Extend `ArtifactProvenance` and `ArtifactSpec.Type` enum

**Files:**
- Modify: `api/pipelines/v1alpha1/artifact_types.go`
- Test: `api/pipelines/v1alpha1/artifact_types_test.go` (create if missing)

- [ ] **Step 1: Write failing test**

```go
package v1alpha1

import "testing"

func TestArtifactProvenanceStep(t *testing.T) {
    a := Artifact{
        Spec: ArtifactSpec{
            Type: "configmap",
            Provenance: ArtifactProvenance{
                Pipeline: "my-pipeline",
                Step:     "build",
            },
        },
    }
    if a.Spec.Provenance.Step != "build" {
        t.Fatalf("expected step build, got %s", a.Spec.Provenance.Step)
    }
    if a.Spec.Type != "configmap" {
        t.Fatalf("expected type configmap")
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./api/pipelines/v1alpha1/... -run TestArtifactProvenanceStep -v
```

Expected: FAIL.

- [ ] **Step 3: Implement changes**

Modify `api/pipelines/v1alpha1/artifact_types.go`:

```go
type ArtifactProvenance struct {
    Pipeline string `json:"pipeline,omitempty"`
    Build    string `json:"build,omitempty"`
    // +optional
    Step string `json:"step,omitempty"`
}
```

```go
// +kubebuilder:validation:Enum=oci;configmap
Type string `json:"type"`
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./api/pipelines/v1alpha1/... -run TestArtifactProvenanceStep -v
```

Expected: PASS.

- [ ] **Step 5: Regenerate deepcopy and CRDs**

```bash
make generate manifests
```

- [ ] **Step 6: Run tests and lint**

```bash
make lint
go test ./api/...
```

Expected: PASS, 0 lint issues.

- [ ] **Step 7: Commit**

```bash
git add api/pipelines/v1alpha1/artifact_types.go api/pipelines/v1alpha1/artifact_types_test.go api/pipelines/v1alpha1/zz_generated.deepcopy.go config/crd/bases/
git commit -m "feat(api): add ArtifactProvenance.Step and configmap artifact type"
```

---

## Chunk 2: Artifact Controller Helpers

### Task 4: Add artifact reference parser helpers

**Files:**
- Create: `internal/controller/pipelines/artifact_reference.go`
- Create: `internal/controller/pipelines/artifact_reference_test.go`

- [ ] **Step 1: Write failing tests**

```go
package pipelines

import "testing"

func TestParseArtifactReference(t *testing.T) {
    cases := []struct {
        path     string
        wantKind string
        wantRef  string
    }{
        {"oci://registry.io/repo:tag", "oci", "registry.io/repo:tag"},
        {"configmap://my-cm/my-key", "configmap", "my-cm/my-key"},
        {"configmap://my-cm", "configmap", "my-cm"},
    }
    for _, tc := range cases {
        kind, ref, err := parseArtifactReference(tc.path)
        if err != nil {
            t.Fatalf("path %q: %v", tc.path, err)
        }
        if kind != tc.wantKind || ref != tc.wantRef {
            t.Fatalf("path %q: got (%s, %s), want (%s, %s)", tc.path, kind, ref, tc.wantKind, tc.wantRef)
        }
    }
}

func TestParseConfigMapReference(t *testing.T) {
    cases := []struct {
        ref     string
        wantName string
        wantKey  string
        wantErr  bool
    }{
        {"my-cm/my-key", "my-cm", "my-key", false},
        {"my-cm", "my-cm", "", false},
        {"", "", "", true},
    }
    for _, tc := range cases {
        name, key, err := parseConfigMapReference(tc.ref)
        if (err != nil) != tc.wantErr {
            t.Fatalf("ref %q: unexpected error status", tc.ref)
        }
        if name != tc.wantName || key != tc.wantKey {
            t.Fatalf("ref %q: got (%s, %s), want (%s, %s)", tc.ref, name, key, tc.wantName, tc.wantKey)
        }
    }
}

func TestResolveConfigMapKey(t *testing.T) {
    cm := corev1.ConfigMap{
        Data: map[string]string{"a": "1", "b": "2"},
    }
    if _, err := resolveConfigMapKey(cm, ""); err == nil {
        t.Fatalf("expected ambiguous error")
    }
    single := corev1.ConfigMap{Data: map[string]string{"only": "x"}}
    key, err := resolveConfigMapKey(single, "")
    if err != nil || key != "only" {
        t.Fatalf("expected only key, got %q %v", key, err)
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
go test ./internal/controller/pipelines/... -run TestParse -v
```

Expected: FAIL.

- [ ] **Step 3: Implement helpers**

Create `internal/controller/pipelines/artifact_reference.go`:

```go
package pipelines

import (
    "fmt"
    "strings"

    corev1 "k8s.io/api/core/v1"
)

func parseArtifactReference(path string) (kind, reference string, err error) {
    if strings.HasPrefix(path, "oci://") {
        return "oci", strings.TrimPrefix(path, "oci://"), nil
    }
    if strings.HasPrefix(path, "configmap://") {
        return "configmap", strings.TrimPrefix(path, "configmap://"), nil
    }
    return "", "", fmt.Errorf("unsupported artifact reference scheme: %s", path)
}

func parseConfigMapReference(ref string) (name, key string, err error) {
    parts := strings.SplitN(ref, "/", 2)
    if parts[0] == "" {
        return "", "", fmt.Errorf("invalid configmap reference: %q", ref)
    }
    if len(parts) == 1 {
        return parts[0], "", nil
    }
    return parts[0], parts[1], nil
}

type configMapKeyError struct {
    reason, message string
}

func (e *configMapKeyError) Error() string { return e.message }

func resolveConfigMapKey(cm corev1.ConfigMap, key string) (string, error) {
    if key != "" {
        if _, ok := cm.Data[key]; ok {
            return key, nil
        }
        if _, ok := cm.BinaryData[key]; ok {
            return key, nil
        }
        return "", &configMapKeyError{reason: "KeyNotFound", message: fmt.Sprintf("key %s not found in configmap %s", key, cm.Name)}
    }
    allKeys := []string{}
    for k := range cm.Data {
        allKeys = append(allKeys, k)
    }
    for k := range cm.BinaryData {
        allKeys = append(allKeys, k)
    }
    if len(allKeys) == 1 {
        return allKeys[0], nil
    }
    return "", &configMapKeyError{reason: "AmbiguousKeys", message: fmt.Sprintf("configmap %s has multiple keys; specify a key in reference", cm.Name)}
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./internal/controller/pipelines/... -run TestParse -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/controller/pipelines/artifact_reference.go internal/controller/pipelines/artifact_reference_test.go
git commit -m "feat(artifacts): add artifact reference parsers"
```

---

### Task 5: Add artifact name sanitizer

**Files:**
- Create: `internal/controller/pipelines/artifact_name.go`
- Create: `internal/controller/pipelines/artifact_name_test.go`

- [ ] **Step 1: Write failing tests**

```go
package pipelines

import "testing"

func TestSanitizeArtifactName(t *testing.T) {
    cases := []struct {
        pipeline, step, output, wantPrefix string
    }{
        {"my-pipeline", "build", "image", "my-pipeline-build-image"},
        {"MyPipeline", "Build_Step", "Image", "mypipeline-build-step-image"},
        {"very-long-pipeline-name-that-needs-truncation", "build", "image", "very-long-pipeline-name-that-needs-truncat-build-image"},
    }
    for _, tc := range cases {
        got := sanitizeArtifactName(tc.pipeline, tc.step, tc.output)
        if !strings.HasPrefix(got, tc.wantPrefix) && len(got) > 63 {
            t.Fatalf("sanitize(%q,%q,%q) = %q (len %d)", tc.pipeline, tc.step, tc.output, got, len(got))
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
go test ./internal/controller/pipelines/... -run TestSanitizeArtifactName -v
```

Expected: FAIL.

- [ ] **Step 3: Implement sanitizer**

Create `internal/controller/pipelines/artifact_name.go`:

```go
package pipelines

import (
    "fmt"
    "regexp"
    "strings"
)

var invalidNameChars = regexp.MustCompile(`[^a-z0-9]+`)

func sanitizeSegment(s string) string {
    s = strings.ToLower(s)
    s = invalidNameChars.ReplaceAllString(s, "-")
    s = strings.Trim(s, "-")
    if s == "" {
        return "x"
    }
    return s
}

func sanitizeArtifactName(pipeline, step, output string) string {
    pipeline = sanitizeSegment(pipeline)
    step = sanitizeSegment(step)
    output = sanitizeSegment(output)

    var parts []string
    if step != "" && step != "x" {
        parts = []string{pipeline, step, output}
    } else {
        parts = []string{pipeline, output}
    }

    name := strings.Join(parts, "-")
    if len(name) <= 63 {
        return name
    }

    // Truncate longest segment first
    for len(name) > 63 {
        longest := 0
        for i, p := range parts {
            if len(p) > len(parts[longest]) {
                longest = i
            }
        }
        parts[longest] = parts[longest][:len(parts[longest])-1]
        parts[longest] = strings.Trim(parts[longest], "-")
        if parts[longest] == "" {
            parts[longest] = "x"
        }
        name = strings.Join(parts, "-")
    }
    name = strings.Trim(name, "-")
    if name == "" {
        return "artifact"
    }
    return name
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
go test ./internal/controller/pipelines/... -run TestSanitizeArtifactName -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/controller/pipelines/artifact_name.go internal/controller/pipelines/artifact_name_test.go
git commit -m "feat(artifacts): add artifact name sanitizer"
```

---

## Chunk 3: Artifact Controller

### Task 6: Add ConfigMap verification to Artifact controller

**Files:**
- Modify: `internal/controller/pipelines/artifact_controller.go`
- Modify: `internal/controller/pipelines/artifact_controller_test.go` (create if missing)

- [ ] **Step 1: Read current artifact controller**

```bash
wc -l internal/controller/pipelines/artifact_controller.go
```

- [ ] **Step 2: Write failing test for ConfigMap artifact verification**

```go
package pipelines

import (
    "context"
    "testing"

    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "k8s.io/apimachinery/pkg/types"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"
    "sigs.k8s.io/controller-runtime/pkg/reconcile"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestArtifactReconciler_ConfigMapReady(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = pipelinesv1alpha1.AddToScheme(scheme)
    _ = corev1.AddToScheme(scheme)

    artifact := &pipelinesv1alpha1.Artifact{
        ObjectMeta: metav1.ObjectMeta{Name: "cm-artifact", Namespace: "default"},
        Spec: pipelinesv1alpha1.ArtifactSpec{
            Type:      "configmap",
            Reference: "my-cm/my-key",
        },
    }
    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{Name: "my-cm", Namespace: "default"},
        Data:       map[string]string{"my-key": "my-value"},
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(artifact, cm).Build()
    r := &ArtifactReconciler{client: c, verify: &nopVerifier{}}

    _, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "cm-artifact", Namespace: "default"}})
    if err != nil {
        t.Fatalf("reconcile failed: %v", err)
    }

    var got pipelinesv1alpha1.Artifact
    if err := c.Get(context.Background(), types.NamespacedName{Name: "cm-artifact", Namespace: "default"}, &got); err != nil {
        t.Fatalf("get artifact: %v", err)
    }
    if !got.Status.Verified {
        t.Fatalf("expected artifact verified")
    }
    cond := meta.FindStatusCondition(got.Status.Conditions, "Ready")
    if cond == nil || cond.Status != metav1.ConditionTrue {
        t.Fatalf("expected Ready condition true, got %+v", cond)
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

```bash
go test ./internal/controller/pipelines/... -run TestArtifactReconciler_ConfigMapReady -v
```

Expected: FAIL (configmap branch missing).

- [ ] **Step 4: Implement ConfigMap verification**

Modify `internal/controller/pipelines/artifact_controller.go`:

- Add `k8sClient kubernetes.Interface` or use existing `client.Client`.
- In `Reconcile`, branch on `artifact.Spec.Type`:
  - `oci`: existing logic.
  - `configmap`: parse reference, get ConfigMap, check key, set condition.
- Set `ObservedGeneration`.

```go
func (r *ArtifactReconciler) reconcileConfigMapArtifact(ctx context.Context, artifact *pipelinesv1alpha1.Artifact) error {
    name, key, err := parseConfigMapReference(artifact.Spec.Reference)
    if err != nil {
        return r.setFailed(ctx, artifact, "InvalidReference", err.Error())
    }
    var cm corev1.ConfigMap
    if err := r.client.Get(ctx, types.NamespacedName{Name: name, Namespace: artifact.Namespace}, &cm); err != nil {
        if apierrors.IsNotFound(err) {
            return r.setFailed(ctx, artifact, "ConfigMapNotFound", fmt.Sprintf("configmap %s not found", name))
        }
        return err
    }
    resolvedKey, keyErr := resolveConfigMapKey(cm, key)
    if keyErr != nil {
        e := keyErr.(*configMapKeyError)
        return r.setFailed(ctx, artifact, e.reason, e.message)
    }
    artifact.Status.Verified = true
    artifact.Status.ObservedGeneration = artifact.Generation
    meta.SetStatusCondition(&artifact.Status.Conditions, metav1.Condition{
        Type:    "Ready",
        Status:  metav1.ConditionTrue,
        Reason:  "Verified",
        Message: fmt.Sprintf("key %s verified", resolvedKey),
    })
    return r.client.Status().Update(ctx, artifact)
}

func (r *ArtifactReconciler) setFailed(ctx context.Context, artifact *pipelinesv1alpha1.Artifact, reason, message string) error {
    artifact.Status.Verified = false
    artifact.Status.ObservedGeneration = artifact.Generation
    meta.SetStatusCondition(&artifact.Status.Conditions, metav1.Condition{
        Type:    "Ready",
        Status:  metav1.ConditionFalse,
        Reason:  reason,
        Message: message,
    })
    return r.client.Status().Update(ctx, artifact)
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
go test ./internal/controller/pipelines/... -run TestArtifactReconciler_ConfigMapReady -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/controller/pipelines/artifact_controller.go internal/controller/pipelines/artifact_controller_test.go
git commit -m "feat(artifacts): verify configmap artifacts"
```

---

### Task 7: Add failure-mode tests for ConfigMap artifacts

**Files:**
- Modify: `internal/controller/pipelines/artifact_controller_test.go`

- [ ] **Step 1: Write tests for not-found, missing key, ambiguous keys**

```go
func TestArtifactReconciler_ConfigMapNotFound(t *testing.T) { /* assert Ready=False, Reason=ConfigMapNotFound */ }
func TestArtifactReconciler_ConfigMapKeyNotFound(t *testing.T) { /* assert Ready=False, Reason=KeyNotFound */ }
func TestArtifactReconciler_ConfigMapAmbiguousKeys(t *testing.T) { /* assert Ready=False, Reason=AmbiguousKeys */ }
```

- [ ] **Step 2: Run tests to verify they pass**

```bash
go test ./internal/controller/pipelines/... -run TestArtifactReconciler_ConfigMap -v
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add internal/controller/pipelines/artifact_controller_test.go
git commit -m "test(artifacts): cover configmap failure modes"
```

---

### Task 8: Add Ready condition to OCI artifacts

**Files:**
- Modify: `internal/controller/pipelines/artifact_controller.go`
- Modify: `internal/controller/pipelines/artifact_controller_test.go`

- [ ] **Step 1: Write failing test for OCI Ready condition**

```go
func TestArtifactReconciler_OCIReady(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = pipelinesv1alpha1.AddToScheme(scheme)

    artifact := &pipelinesv1alpha1.Artifact{
        ObjectMeta: metav1.ObjectMeta{Name: "oci-artifact", Namespace: "default"},
        Spec: pipelinesv1alpha1.ArtifactSpec{
            Type:      "oci",
            Reference: "registry.io/repo:tag",
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(artifact).Build()
    r := &ArtifactReconciler{client: c, verify: &fakeVerifier{digest: "sha256:abc123"}}

    _, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "oci-artifact", Namespace: "default"}})
    if err != nil {
        t.Fatalf("reconcile failed: %v", err)
    }

    var got pipelinesv1alpha1.Artifact
    _ = c.Get(context.Background(), types.NamespacedName{Name: "oci-artifact", Namespace: "default"}, &got)
    cond := meta.FindStatusCondition(got.Status.Conditions, "Ready")
    if cond == nil || cond.Status != metav1.ConditionTrue {
        t.Fatalf("expected Ready true, got %+v", cond)
    }
    if got.Status.ResolvedDigest != "sha256:abc123" {
        t.Fatalf("expected resolved digest sha256:abc123, got %s", got.Status.ResolvedDigest)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./internal/controller/pipelines/... -run TestArtifactReconciler_OCIReady -v
```

Expected: FAIL (no Ready condition).

- [ ] **Step 3: Implement Ready condition for OCI**

After successful OCI verification:

```go
meta.SetStatusCondition(&artifact.Status.Conditions, metav1.Condition{
    Type:    "Ready",
    Status:  metav1.ConditionTrue,
    Reason:  "Verified",
    Message: fmt.Sprintf("resolved digest %s", artifact.Status.ResolvedDigest),
})
```

On failure:

```go
meta.SetStatusCondition(&artifact.Status.Conditions, metav1.Condition{
    Type:    "Ready",
    Status:  metav1.ConditionFalse,
    Reason:  reason,
    Message: message,
})
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./internal/controller/pipelines/... -run TestArtifactReconciler_OCIReady -v
```

Expected: PASS.

- [ ] **Step 5: Add OCI failure tests**

```go
func TestArtifactReconciler_OCIDigestMismatch(t *testing.T) { /* assert Ready=False, Reason=DigestMismatch */ }
func TestArtifactReconciler_OCIInvalidReference(t *testing.T) { /* assert Ready=False, Reason=InvalidReference */ }
```

- [ ] **Step 6: Commit**

```bash
git add internal/controller/pipelines/artifact_controller.go internal/controller/pipelines/artifact_controller_test.go
git commit -m "feat(artifacts): add Ready condition to OCI artifacts and cover failures"
```

---

### Task 9: Add ConfigMap RBAC markers

**Files:**
- Modify: `internal/controller/pipelines/artifact_controller.go`

- [ ] **Step 1: Add RBAC markers**

At the top of `artifact_controller.go` near existing markers:

```go
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get;list
// +kubebuilder:rbac:groups="",resources=configmaps/status,verbs=get
```

- [ ] **Step 2: Regenerate RBAC**

```bash
make manifests
```

- [ ] **Step 3: Verify role.yaml includes configmaps**

```bash
grep -n "configmaps" config/rbac/role.yaml
```

Expected: configmaps get/list entries present.

- [ ] **Step 4: Commit**

```bash
git add internal/controller/pipelines/artifact_controller.go config/rbac/role.yaml
git commit -m "chore(rbac): allow artifact controller to read configmaps"
```

---

## Chunk 4: Pipeline Controller

### Task 10: Refactor `createArtifact` to label, annotate, and set owner references

**Files:**
- Modify: `internal/controller/pipelines/pipeline_controller.go`
- Modify: `internal/controller/pipelines/pipeline_controller_test.go`

- [ ] **Step 1: Read current `createArtifact` implementation**

```bash
grep -n "func (r \*PipelineReconciler) createArtifact" internal/controller/pipelines/pipeline_controller.go
```

- [ ] **Step 2: Write failing test for artifact labels and owner ref**

```go
func TestCreateArtifact_SetsLabelsAndOwnerRef(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = pipelinesv1alpha1.AddToScheme(scheme)

    pipeline := &pipelinesv1alpha1.Pipeline{
        ObjectMeta: metav1.ObjectMeta{Name: "my-pipeline", Namespace: "default", UID: "uid-1"},
        Spec: pipelinesv1alpha1.PipelineSpec{
            Steps: []pipelinesv1alpha1.PipelineStep{
                {Name: "build", Outputs: []pipelinesv1alpha1.PipelineOutput{{Name: "image", Path: "oci://repo:tag"}}},
            },
        },
        Status: pipelinesv1alpha1.PipelineStatus{LastExecutionID: "run-1"},
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline).Build()
    r := &PipelineReconciler{client: c, Scheme: scheme}

    err := r.createArtifact(context.Background(), pipeline, "build", pipeline.Spec.Steps[0].Outputs[0])
    if err != nil {
        t.Fatalf("createArtifact failed: %v", err)
    }

    var got pipelinesv1alpha1.ArtifactList
    if err := c.List(context.Background(), &got); err != nil {
        t.Fatalf("list artifacts: %v", err)
    }
    if len(got.Items) != 1 {
        t.Fatalf("expected 1 artifact, got %d", len(got.Items))
    }
    a := got.Items[0]
    if a.Labels["paprika.io/pipeline"] != "my-pipeline" {
        t.Fatalf("missing pipeline label")
    }
    if a.Labels["paprika.io/step"] != "build" {
        t.Fatalf("missing step label")
    }
    if len(a.OwnerReferences) != 1 || a.OwnerReferences[0].UID != "uid-1" {
        t.Fatalf("missing owner ref")
    }
    if a.Spec.Provenance.Step != "build" {
        t.Fatalf("expected provenance step build, got %s", a.Spec.Provenance.Step)
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

```bash
go test ./internal/controller/pipelines/... -run TestCreateArtifact_SetsLabelsAndOwnerRef -v
```

Expected: FAIL.

- [ ] **Step 4: Implement refactored `createArtifact`**

Modify `internal/controller/pipelines/pipeline_controller.go`:

```go
func (r *PipelineReconciler) createArtifact(
    ctx context.Context,
    pipeline *pipelinesv1alpha1.Pipeline,
    stepName string,
    output pipelinesv1alpha1.PipelineOutput,
) (string, error) {
    artifactName := sanitizeArtifactName(pipeline.Name, stepName, output.Name)
    producingStep := stepName
    if producingStep == "" {
        producingStep = output.Step
    }

    kind, reference := parseArtifactReference(output.Path)

    artifact := &pipelinesv1alpha1.Artifact{}
    err := r.client.Get(ctx, types.NamespacedName{Name: artifactName, Namespace: pipeline.Namespace}, artifact)
    if client.IgnoreNotFound(err) != nil {
        return "", fmt.Errorf("getting artifact %s: %w", artifactName, err)
    }

    artifact.Name = artifactName
    artifact.Namespace = pipeline.Namespace
    if artifact.Labels == nil {
        artifact.Labels = map[string]string{}
    }
    artifact.Labels["paprika.io/pipeline"] = pipeline.Name
    artifact.Labels["paprika.io/output"] = output.Name
    if stepName != "" {
        artifact.Labels["paprika.io/step"] = stepName
    } else {
        delete(artifact.Labels, "paprika.io/step")
    }
    if artifact.Annotations == nil {
        artifact.Annotations = map[string]string{}
    }
    if producingStep != "" {
        artifact.Annotations["paprika.io/producing-step"] = producingStep
    } else {
        delete(artifact.Annotations, "paprika.io/producing-step")
    }
    if err := controllerutil.SetControllerReference(pipeline, artifact, r.Scheme); err != nil {
        return "", fmt.Errorf("setting owner reference: %w", err)
    }
    copyProjectLabels(pipeline, artifact)

    digest := ""
    if kind == "oci" {
        digest = extractOCIDigest(reference)
    }

    artifact.Spec = pipelinesv1alpha1.ArtifactSpec{
        Type:      kind,
        Reference: reference,
        Digest:    digest,
        Provenance: pipelinesv1alpha1.ArtifactProvenance{
            Pipeline: pipeline.Name,
            Build:    pipeline.Status.LastExecutionID,
            Step:     producingStep,
        },
    }

    if artifact.Generation == 0 {
        if err := r.client.Create(ctx, artifact); err != nil {
            return "", fmt.Errorf("creating artifact %s: %w", artifactName, err)
        }
    } else {
        if err := r.client.Update(ctx, artifact); err != nil {
            return "", fmt.Errorf("updating artifact %s: %w", artifactName, err)
        }
    }
    return artifactName, nil
}
```

Add helper `copyProjectLabels` and `extractOCIDigest`.

- [ ] **Step 5: Run test to verify it passes**

```bash
go test ./internal/controller/pipelines/... -run TestCreateArtifact_SetsLabelsAndOwnerRef -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/controller/pipelines/pipeline_controller.go internal/controller/pipelines/pipeline_controller_test.go
git commit -m "feat(pipelines): label, annotate, and own artifacts"
```

---

### Task 11: Upsert `Pipeline.Status.ArtifactRefs`

**Files:**
- Modify: `internal/controller/pipelines/pipeline_controller.go`
- Modify: `internal/controller/pipelines/pipeline_controller_test.go`

- [ ] **Step 1: Write failing test for status upsert**

```go
func TestReconcilePipeline_UpsertsArtifactRefs(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = pipelinesv1alpha1.AddToScheme(scheme)

    pipeline := &pipelinesv1alpha1.Pipeline{
        ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "default"},
        Spec: pipelinesv1alpha1.PipelineSpec{
            Steps: []pipelinesv1alpha1.PipelineStep{
                {Name: "build", Outputs: []pipelinesv1alpha1.PipelineOutput{{Name: "image", Path: "oci://repo:tag"}}},
            },
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline).Build()
    r := &PipelineReconciler{client: c, Scheme: scheme, Clock: clock.Real{}}

    _, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "p", Namespace: "default"}})
    if err != nil {
        t.Fatalf("reconcile failed: %v", err)
    }

    var got pipelinesv1alpha1.Pipeline
    _ = c.Get(context.Background(), types.NamespacedName{Name: "p", Namespace: "default"}, &got)
    if len(got.Status.ArtifactRefs) != 1 {
        t.Fatalf("expected 1 artifact ref, got %d", len(got.Status.ArtifactRefs))
    }
    if got.Status.ArtifactRefs[0].Phase != pipelinesv1alpha1.PipelineArtifactPhasePending {
        t.Fatalf("expected Pending phase, got %s", got.Status.ArtifactRefs[0].Phase)
    }
    if got.Status.ArtifactRefs[0].ProducingStep != "build" {
        t.Fatalf("expected producing step build, got %s", got.Status.ArtifactRefs[0].ProducingStep)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./internal/controller/pipelines/... -run TestReconcilePipeline_UpsertsArtifactRefs -v
```

Expected: FAIL.

- [ ] **Step 3: Implement upsert**

Add helper:

```go
func upsertPipelineArtifactRef(
    status *pipelinesv1alpha1.PipelineStatus,
    ref pipelinesv1alpha1.PipelineArtifactRef,
) {
    for i := range status.ArtifactRefs {
        if status.ArtifactRefs[i].Name == ref.Name && status.ArtifactRefs[i].ProducingStep == ref.ProducingStep {
            status.ArtifactRefs[i] = ref
            return
        }
    }
    status.ArtifactRefs = append(status.ArtifactRefs, ref)
}
```

After artifact creation in pipeline reconcile:

```go
upsertPipelineArtifactRef(&pipeline.Status, pipelinesv1alpha1.PipelineArtifactRef{
    Name:          artifactName,
    Kind:          kind,
    Reference:     output.Path,
    Phase:         pipelinesv1alpha1.PipelineArtifactPhasePending,
    ProducingStep: producingStep,
    CreatedAt:     r.now().Unix(),
})
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./internal/controller/pipelines/... -run TestReconcilePipeline_UpsertsArtifactRefs -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/controller/pipelines/pipeline_controller.go internal/controller/pipelines/pipeline_controller_test.go
git commit -m "feat(pipelines): upsert Pipeline.Status.ArtifactRefs on reconcile"
```

---

### Task 12: Watch owned artifacts and update pipeline status

**Files:**
- Modify: `internal/controller/pipelines/pipeline_controller.go`
- Create: `internal/controller/pipelines/artifact_convert.go`
- Modify: `internal/controller/pipelines/pipeline_controller_test.go`

- [ ] **Step 1: Add watch to SetupWithManager**

Modify `SetupWithManager` in `internal/controller/pipelines/pipeline_controller.go`:

```go
return ctrl.NewControllerManagedBy(mgr).
    For(&pipelinesv1alpha1.Pipeline{}).
    Owns(&pipelinesv1alpha1.Artifact{}).
    Complete(r)
```

- [ ] **Step 2: Create artifact convert helper**

Create `internal/controller/pipelines/artifact_convert.go`:

```go
package pipelines

import (
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/api/meta"

    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func convertArtifactToPipelineArtifactRef(a *pipelinesv1alpha1.Artifact) pipelinesv1alpha1.PipelineArtifactRef {
    phase := pipelinesv1alpha1.PipelineArtifactPhasePending
    cond := meta.FindStatusCondition(a.Status.Conditions, "Ready")
    if cond != nil {
        switch cond.Status {
        case metav1.ConditionTrue:
            phase = pipelinesv1alpha1.PipelineArtifactPhaseReady
        case metav1.ConditionFalse:
            phase = pipelinesv1alpha1.PipelineArtifactPhaseFailed
        }
    }
    return pipelinesv1alpha1.PipelineArtifactRef{
        Name:              a.Name,
        Kind:              a.Spec.Type,
        Reference:         artifactReferenceToPath(a.Spec),
        ResolvedReference: buildResolvedReference(a),
        Digest:            a.Status.ResolvedDigest,
        Phase:             phase,
        ProducingStep:     a.Spec.Provenance.Step,
        CreatedAt:         a.CreationTimestamp.Unix(),
    }
}
```

- [ ] **Step 3: Implement status update from owned artifacts**

In `reconcilePipeline`, after step execution, list owned artifacts and sync status:

```go
var artifactList pipelinesv1alpha1.ArtifactList
if err := r.client.List(ctx, &artifactList, client.InNamespace(pipeline.Namespace), client.MatchingOwnerReference(pipeline)); err != nil {
    return ctrl.Result{}, fmt.Errorf("listing owned artifacts: %w", err)
}
for i := range artifactList.Items {
    a := &artifactList.Items[i]
    ref := convertArtifactToPipelineArtifactRef(a)
    upsertPipelineArtifactRef(&pipeline.Status, ref)
}
```

- [ ] **Step 4: Write test**

```go
func TestReconcilePipeline_SyncsArtifactStatus(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = pipelinesv1alpha1.AddToScheme(scheme)

    pipeline := &pipelinesv1alpha1.Pipeline{
        ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "default", UID: "uid-1"},
        Spec: pipelinesv1alpha1.PipelineSpec{
            Steps: []pipelinesv1alpha1.PipelineStep{
                {Name: "build", Outputs: []pipelinesv1alpha1.PipelineOutput{{Name: "image", Path: "oci://repo:tag"}}},
            },
        },
        Status: pipelinesv1alpha1.PipelineStatus{
            LastExecutionID: "run-1",
            ArtifactRefs: []pipelinesv1alpha1.PipelineArtifactRef{
                {Name: "p-build-image", Kind: "oci", Phase: pipelinesv1alpha1.PipelineArtifactPhasePending, ProducingStep: "build"},
            },
        },
    }
    artifact := &pipelinesv1alpha1.Artifact{
        ObjectMeta: metav1.ObjectMeta{
            Name: "p-build-image", Namespace: "default",
            OwnerReferences: []metav1.OwnerReference{{APIVersion: "pipelines.paprika.io/v1alpha1", Kind: "Pipeline", Name: "p", UID: "uid-1", Controller: boolPtr(true)}},
        },
        Spec: pipelinesv1alpha1.ArtifactSpec{Type: "oci"},
        Status: pipelinesv1alpha1.ArtifactStatus{
            Verified:       true,
            ResolvedDigest: "sha256:abc",
            Conditions: []metav1.Condition{{Type: "Ready", Status: metav1.ConditionTrue, Reason: "Verified"}},
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline, artifact).Build()
    r := &PipelineReconciler{client: c, Scheme: scheme, Clock: clock.Real{}}

    _, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "p", Namespace: "default"}})
    if err != nil {
        t.Fatalf("reconcile failed: %v", err)
    }

    var got pipelinesv1alpha1.Pipeline
    _ = c.Get(context.Background(), types.NamespacedName{Name: "p", Namespace: "default"}, &got)
    if got.Status.ArtifactRefs[0].Phase != pipelinesv1alpha1.PipelineArtifactPhaseReady {
        t.Fatalf("expected Ready phase, got %s", got.Status.ArtifactRefs[0].Phase)
    }
    if got.Status.ArtifactRefs[0].Digest != "sha256:abc" {
        t.Fatalf("expected digest sha256:abc, got %s", got.Status.ArtifactRefs[0].Digest)
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
go test ./internal/controller/pipelines/... -run TestReconcilePipeline_SyncsArtifactStatus -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/controller/pipelines/pipeline_controller.go internal/controller/pipelines/artifact_convert.go internal/controller/pipelines/pipeline_controller_test.go
git commit -m "feat(pipelines): watch owned artifacts and sync status"
```

---

### Task 13: Stale artifact cleanup

**Files:**
- Modify: `internal/controller/pipelines/pipeline_controller.go`
- Modify: `internal/controller/pipelines/pipeline_controller_test.go`

- [ ] **Step 1: Write failing test for stale cleanup**

```go
func TestReconcilePipeline_DeletesStaleArtifacts(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = pipelinesv1alpha1.AddToScheme(scheme)

    pipeline := &pipelinesv1alpha1.Pipeline{
        ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "default", UID: "uid-1"},
        Spec: pipelinesv1alpha1.PipelineSpec{
            Steps: []pipelinesv1alpha1.PipelineStep{
                {Name: "build", Outputs: []pipelinesv1alpha1.PipelineOutput{{Name: "image", Path: "oci://repo:tag"}}},
            },
        },
        Status: pipelinesv1alpha1.PipelineStatus{LastExecutionID: "run-1"},
    }
    stale := &pipelinesv1alpha1.Artifact{
        ObjectMeta: metav1.ObjectMeta{
            Name: "p-build-old", Namespace: "default",
            Labels: map[string]string{"paprika.io/pipeline": "p", "paprika.io/step": "build", "paprika.io/output": "old"},
            OwnerReferences: []metav1.OwnerReference{{APIVersion: "pipelines.paprika.io/v1alpha1", Kind: "Pipeline", Name: "p", UID: "uid-1", Controller: boolPtr(true)}},
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline, stale).Build()
    r := &PipelineReconciler{client: c, Scheme: scheme, Clock: clock.Real{}}

    _, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "p", Namespace: "default"}})
    if err != nil {
        t.Fatalf("reconcile failed: %v", err)
    }

    var artifacts pipelinesv1alpha1.ArtifactList
    _ = c.List(context.Background(), &artifacts)
    if len(artifacts.Items) != 1 {
        t.Fatalf("expected 1 artifact after cleanup, got %d", len(artifacts.Items))
    }
    if artifacts.Items[0].Name != "p-build-image" {
        t.Fatalf("expected p-build-image to remain, got %s", artifacts.Items[0].Name)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./internal/controller/pipelines/... -run TestReconcilePipeline_DeletesStaleArtifacts -v
```

Expected: FAIL.

- [ ] **Step 3: Implement cleanup**

After creating expected artifacts, build a set of expected label tuples and delete
unexpected owned artifacts:

```go
expected := map[string]bool{}
for _, step := range pipeline.Spec.Steps {
    for _, output := range step.Outputs {
        expected[artifactKey(pipeline.Name, step.Name, output.Name)] = true
    }
}
for _, output := range pipeline.Spec.Artifacts {
    expected[artifactKey(pipeline.Name, output.Step, output.Name)] = true
}

var artifactList pipelinesv1alpha1.ArtifactList
if err := r.client.List(ctx, &artifactList, client.InNamespace(pipeline.Namespace), client.MatchingOwnerReference(pipeline)); err != nil {
    return ctrl.Result{}, fmt.Errorf("listing owned artifacts: %w", err)
}
for i := range artifactList.Items {
    a := &artifactList.Items[i]
    step := a.Labels["paprika.io/step"]
    output := a.Labels["paprika.io/output"]
    key := artifactKey(pipeline.Name, step, output)
    if expected[key] {
        continue
    }
    if err := r.client.Delete(ctx, a); err != nil {
        return ctrl.Result{}, fmt.Errorf("deleting stale artifact %s: %w", a.Name, err)
    }
    removePipelineArtifactRef(&pipeline.Status, step, a.Name)
}
```

Helper:

```go
func artifactKey(pipeline, step, output string) string {
    if step == "" {
        return pipeline + "//" + output
    }
    return pipeline + "/" + step + "/" + output
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./internal/controller/pipelines/... -run TestReconcilePipeline_DeletesStaleArtifacts -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/controller/pipelines/pipeline_controller.go internal/controller/pipelines/pipeline_controller_test.go
git commit -m "feat(pipelines): delete stale artifacts and artifact refs"
```

---

### Task 14: Publish `pipeline-artifact` SSE events

**Files:**
- Modify: `internal/controller/pipelines/pipeline_controller.go`
- Modify: `internal/api/events/eventtypes.go` (add event type)
- Modify: `internal/controller/pipelines/pipeline_controller_test.go`

- [ ] **Step 1: Add event type constant**

In `internal/api/events/eventtypes.go`:

```go
const (
    // existing...
    EventTypePipelineArtifact = "pipeline-artifact"
)
```

- [ ] **Step 2: Write failing test for SSE publish**

```go
func TestReconcilePipeline_PublishesArtifactSSE(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = pipelinesv1alpha1.AddToScheme(scheme)

    pipeline := &pipelinesv1alpha1.Pipeline{
        ObjectMeta: metav1.ObjectMeta{Name: "p", Namespace: "default", UID: "uid-1"},
        Spec: pipelinesv1alpha1.PipelineSpec{
            Steps: []pipelinesv1alpha1.PipelineStep{
                {Name: "build", Outputs: []pipelinesv1alpha1.PipelineOutput{{Name: "image", Path: "oci://repo:tag"}}},
            },
        },
        Status: pipelinesv1alpha1.PipelineStatus{
            LastExecutionID: "run-1",
            ArtifactRefs: []pipelinesv1alpha1.PipelineArtifactRef{
                {Name: "p-build-image", Kind: "oci", Phase: pipelinesv1alpha1.PipelineArtifactPhasePending, ProducingStep: "build"},
            },
        },
    }
    artifact := &pipelinesv1alpha1.Artifact{
        ObjectMeta: metav1.ObjectMeta{
            Name: "p-build-image", Namespace: "default",
            OwnerReferences: []metav1.OwnerReference{{APIVersion: "pipelines.paprika.io/v1alpha1", Kind: "Pipeline", Name: "p", UID: "uid-1", Controller: boolPtr(true)}},
        },
        Spec: pipelinesv1alpha1.ArtifactSpec{Type: "oci", Provenance: pipelinesv1alpha1.ArtifactProvenance{Step: "build"}},
        Status: pipelinesv1alpha1.ArtifactStatus{
            Verified:       true,
            ResolvedDigest: "sha256:abc",
            Conditions: []metav1.Condition{{Type: "Ready", Status: metav1.ConditionTrue, Reason: "Verified"}},
        },
    }
    broker := events.NewBroker()
    var received *events.Event
    broker.Subscribe("pipeline-artifact", func(evt *events.Event) { received = evt })

    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pipeline, artifact).Build()
    r := &PipelineReconciler{client: c, Scheme: scheme, Clock: clock.Real{}, EventBroker: broker}

    _, err := r.Reconcile(context.Background(), reconcile.Request{NamespacedName: types.NamespacedName{Name: "p", Namespace: "default"}})
    if err != nil {
        t.Fatalf("reconcile failed: %v", err)
    }
    if received == nil {
        t.Fatalf("expected pipeline-artifact SSE event")
    }
}
```

- [ ] **Step 3: Implement SSE publishing**

When syncing artifact status, compare previous phase and emit if changed:

```go
prev := findPipelineArtifactRef(&pipeline.Status, ref.ProducingStep, ref.Name)
if prev == nil || prev.Phase != ref.Phase {
    r.publishPipelineArtifactEvent(ctx, pipeline, ref)
}
```

Implement `publishPipelineArtifactEvent` to build the event payload and call the event
broker.

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./internal/controller/pipelines/... -run TestReconcilePipeline_PublishesArtifactSSE -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/controller/pipelines/pipeline_controller.go internal/api/events/eventtypes.go internal/controller/pipelines/pipeline_controller_test.go
git commit -m "feat(pipelines): publish pipeline-artifact SSE events"
```

---

## Chunk 5: API & Protobuf

### Task 15: Extend protobuf definitions

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1: Extend `ArtifactRef`**

```protobuf
message ArtifactRef {
  string name = 1;
  string path = 2;
  string kind = 3;
  string reference = 4;
  string resolved_reference = 5;
  string digest = 6;
  string phase = 7;
  string producing_step = 8;
  int64 created_at = 9;
  string failed_reason = 10;
}
```

- [ ] **Step 2: Add `artifacts` to `Pipeline` message**

```protobuf
message Pipeline {
  // existing fields...
  string last_execution_id = 6;
  repeated ArtifactRef artifacts = 7;
}
```

(Use the next available field number; verify in `api.proto`.)

- [ ] **Step 3: Add artifact RPCs**

Add to `PaprikaService`:

```protobuf
rpc GetArtifact(GetArtifactRequest) returns (GetArtifactResponse);
rpc ListArtifacts(ListArtifactsRequest) returns (ListArtifactsResponse);

message GetArtifactRequest {
  string namespace = 1;
  string name = 2;
}

message GetArtifactResponse {
  ArtifactRef artifact = 1;
  string download_url = 2;
}

message ListArtifactsRequest {
  string namespace = 1;
  optional string pipeline_name = 2;
}

message ListArtifactsResponse {
  repeated ArtifactRef artifacts = 1;
}
```

- [ ] **Step 4: Regenerate protobuf clients**

```bash
make generate-proto
```

If protoc plugins are not installed, install them per project instructions or commit the
regenerated files after running in an environment with plugins.

- [ ] **Step 5: Verify generated files**

```bash
ls internal/api/paprika/v1/api.pb.go | xargs grep -n "GetArtifact\|ListArtifacts"
```

Expected: generated types present.

- [ ] **Step 6: Commit**

```bash
git add proto/paprika/v1/api.proto internal/api/paprika/v1/ internal/api/paprika/v1/v1connect/ ui/src/gen/paprika/v1/
git commit -m "feat(api): add artifact RPCs and extend ArtifactRef proto"
```

---

### Task 16: Implement `GetArtifact` and `ListArtifacts` handlers

**Files:**
- Modify: `internal/api/server.go`
- Create: `internal/api/artifact_handler_test.go`

- [ ] **Step 1: Add API server RBAC markers**

At the top of `internal/api/server.go` near existing markers:

```go
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=artifacts/status,verbs=get
// +kubebuilder:rbac:groups="",resources=configmaps,verbs=get
```

- [ ] **Step 2: Write failing test for `ListArtifacts`**

```go
package api

import (
    "context"
    "testing"

    "connectrpc.com/connect"
    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func TestListArtifacts(t *testing.T) {
    srv, client := newTestServer(t)
    resp, err := srv.ListArtifacts(context.Background(), connect.NewRequest(&paprikav1.ListArtifactsRequest{Namespace: "default"}))
    if err != nil {
        t.Fatalf("ListArtifacts failed: %v", err)
    }
    if len(resp.Msg.Artifacts) != 0 {
        t.Fatalf("expected 0 artifacts, got %d", len(resp.Msg.Artifacts))
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

```bash
go test ./internal/api/... -run TestListArtifacts -v
```

Expected: FAIL (method not implemented).

- [ ] **Step 4: Implement handlers**

Add to `internal/api/server.go`:

```go
func (s *PaprikaServer) ListArtifacts(ctx context.Context, req *connect.Request[paprikav1.ListArtifactsRequest]) (*connect.Response[paprikav1.ListArtifactsResponse], error) {
    var list pipelinesv1alpha1.ArtifactList
    opts := []client.ListOption{client.InNamespace(req.Msg.Namespace)}
    if err := s.client.List(ctx, &list, opts...); err != nil {
        return nil, fmt.Errorf("listing artifacts: %w", err)
    }
    artifacts := make([]*paprikav1.ArtifactRef, 0, len(list.Items))
    for i := range list.Items {
        a := &list.Items[i]
        if !s.authorizeProjectFromLabels(ctx, a, auth.ResourceArtifacts) {
            continue
        }
        if req.Msg.PipelineName != nil && !ownedByPipeline(a, *req.Msg.PipelineName) {
            continue
        }
        artifacts = append(artifacts, convertArtifact(a))
    }
    return connect.NewResponse(&paprikav1.ListArtifactsResponse{Artifacts: artifacts}), nil
}

func (s *PaprikaServer) GetArtifact(ctx context.Context, req *connect.Request[paprikav1.GetArtifactRequest]) (*connect.Response[paprikav1.GetArtifactResponse], error) {
    var a pipelinesv1alpha1.Artifact
    if err := s.client.Get(ctx, types.NamespacedName{Name: req.Msg.Name, Namespace: req.Msg.Namespace}, &a); err != nil {
        return nil, fmt.Errorf("getting artifact: %w", err)
    }
    if !s.authorizeProjectFromLabels(ctx, &a, auth.ResourceArtifacts) {
        return nil, connect.NewError(connect.CodePermissionDenied, errors.New("permission denied"))
    }
    ref := convertArtifact(&a)
    downloadURL := ""
    if ref.Kind == "configmap" && ref.Phase == "Ready" {
        var err error
        downloadURL, err = s.buildConfigMapDownloadURL(ctx, &a)
        if err != nil {
            return nil, err
        }
    }
    return connect.NewResponse(&paprikav1.GetArtifactResponse{Artifact: ref, DownloadUrl: downloadURL}), nil
}
```

Helper:

```go
func ownedByPipeline(a *pipelinesv1alpha1.Artifact, pipelineName string) bool {
    for _, ref := range a.OwnerReferences {
        if ref.APIVersion == "pipelines.paprika.io/v1alpha1" && ref.Kind == "Pipeline" && ref.Name == pipelineName {
            return true
        }
    }
    return false
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
go test ./internal/api/... -run TestListArtifacts -v
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/api/server.go internal/api/artifact_handler_test.go
git commit -m "feat(api): implement GetArtifact and ListArtifacts"
```

---

### Task 17: Implement ConfigMap download URL builder

**Files:**
- Modify: `internal/api/server.go`
- Modify: `internal/api/server_test.go`

- [ ] **Step 1: Write failing test**

```go
func TestBuildConfigMapDownloadURL(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = corev1.AddToScheme(scheme)
    _ = pipelinesv1alpha1.AddToScheme(scheme)

    artifact := &pipelinesv1alpha1.Artifact{
        ObjectMeta: metav1.ObjectMeta{Name: "a", Namespace: "default"},
        Spec: pipelinesv1alpha1.ArtifactSpec{Type: "configmap", Reference: "my-cm/my-key"},
    }
    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{Name: "my-cm", Namespace: "default"},
        Data:       map[string]string{"my-key": "my-value"},
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cm).Build()
    s := &PaprikaServer{client: c}

    url, err := s.buildConfigMapDownloadURL(context.Background(), artifact)
    if err != nil {
        t.Fatalf("build download url: %v", err)
    }
    if !strings.HasPrefix(url, "data:application/json;base64,") {
        t.Fatalf("expected data URI, got %s", url)
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./internal/api/... -run TestBuildConfigMapDownloadURL -v
```

Expected: FAIL.

- [ ] **Step 3: Implement builder**

Add to `internal/api/server.go`:

```go
const maxConfigMapDownloadBytes = 256 * 1024

func (s *PaprikaServer) buildConfigMapDownloadURL(ctx context.Context, a *pipelinesv1alpha1.Artifact) (string, error) {
    _, key, err := parseConfigMapReference(a.Spec.Reference)
    if err != nil {
        return "", fmt.Errorf("parsing configmap reference: %w", err)
    }
    var cm corev1.ConfigMap
    if err := s.client.Get(ctx, types.NamespacedName{Name: extractConfigMapName(a.Spec.Reference), Namespace: a.Namespace}, &cm); err != nil {
        return "", fmt.Errorf("getting configmap: %w", err)
    }
    resolvedKey, err := resolveConfigMapKey(cm, key)
    if err != nil {
        return "", fmt.Errorf("resolving configmap key: %w", err)
    }

    var value string
    var isBinary bool
    if v, ok := cm.Data[resolvedKey]; ok {
        value = v
    } else if v, ok := cm.BinaryData[resolvedKey]; ok {
        value = string(v)
        isBinary = true
    }

    if len(value) > maxConfigMapDownloadBytes {
        return "", nil
    }

    payload := map[string]string{resolvedKey: value}
    if isBinary {
        payload = map[string]string{"binary_value": base64.StdEncoding.EncodeToString([]byte(value))}
    }
    jsonBytes, err := json.Marshal(payload)
    if err != nil {
        return "", fmt.Errorf("marshaling payload: %w", err)
    }
    return "data:application/json;base64," + base64.StdEncoding.EncodeToString(jsonBytes), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./internal/api/... -run TestBuildConfigMapDownloadURL -v
```

Expected: PASS.

- [ ] **Step 5: Add too-large test**

```go
func TestBuildConfigMapDownloadURL_TooLarge(t *testing.T) { /* assert empty URL for value > 256 KiB */ }
```

- [ ] **Step 6: Commit**

```bash
git add internal/api/server.go internal/api/server_test.go
git commit -m "feat(api): build ConfigMap artifact download URLs"
```

---

### Task 18: Update `convertPipeline` to include artifact refs

**Files:**
- Modify: `internal/api/server.go`
- Modify: `internal/api/server_test.go`

- [ ] **Step 1: Write failing test for pipeline artifact conversion**

```go
func TestConvertPipeline_IncludesArtifacts(t *testing.T) {
    p := &pipelinesv1alpha1.Pipeline{
        Status: pipelinesv1alpha1.PipelineStatus{
            ArtifactRefs: []pipelinesv1alpha1.PipelineArtifactRef{
                {Name: "img", Kind: "oci", Phase: pipelinesv1alpha1.PipelineArtifactPhaseReady},
            },
        },
    }
    converted := convertPipeline(p)
    if len(converted.Artifacts) != 1 {
        t.Fatalf("expected 1 artifact, got %d", len(converted.Artifacts))
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

```bash
go test ./internal/api/... -run TestConvertPipeline_IncludesArtifacts -v
```

Expected: FAIL.

- [ ] **Step 3: Implement conversion**

Modify `convertPipeline` in `internal/api/server.go`:

```go
artifacts := make([]*paprikav1.ArtifactRef, 0, len(p.Status.ArtifactRefs))
for _, ref := range p.Status.ArtifactRefs {
    artifacts = append(artifacts, &paprikav1.ArtifactRef{
        Name:              ref.Name,
        Path:              ref.Reference,
        Kind:              ref.Kind,
        Reference:         ref.Reference,
        ResolvedReference: ref.ResolvedReference,
        Digest:            ref.Digest,
        Phase:             string(ref.Phase),
        ProducingStep:     ref.ProducingStep,
        CreatedAt:         ref.CreatedAt,
    })
}
pbPipeline.Artifacts = artifacts
```

- [ ] **Step 4: Run test to verify it passes**

```bash
go test ./internal/api/... -run TestConvertPipeline_IncludesArtifacts -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/api/server.go internal/api/server_test.go
git commit -m "feat(api): include artifact refs in GetPipeline response"
```

---

### Task 19: Add `ResourceArtifacts` authorization constant

**Files:**
- Modify: `internal/api/auth/auth.go` or wherever resource constants live
- Modify: `internal/api/auth/auth_test.go`

- [ ] **Step 1: Add constant**

```go
const (
    // existing...
    ResourceArtifacts = "artifacts"
)
```

- [ ] **Step 2: Commit**

```bash
git add internal/api/auth/
git commit -m "feat(auth): add ResourceArtifacts constant"
```

---

## Chunk 6: UI

### Task 20: Add `useStepArtifacts` hook

**Files:**
- Create: `ui/src/lib/use-step-artifacts.ts`
- Create: `ui/src/lib/use-step-artifacts.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { useStepArtifacts } from "./use-step-artifacts";
import { renderHook } from "@testing-library/react";
import type { ArtifactRef } from "@/gen/paprika/v1/api_pb";

const artifacts: ArtifactRef[] = [
  { name: "img", producingStep: "build", phase: "Ready" } as ArtifactRef,
  { name: "bin", producingStep: "test", phase: "Pending" } as ArtifactRef,
];

test("filters artifacts by producing step", () => {
  const { result } = renderHook(() => useStepArtifacts(artifacts, "build"));
  expect(result.current).toHaveLength(1);
  expect(result.current[0].name).toBe("img");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui && npm test -- use-step-artifacts.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement hook**

```ts
import { useMemo } from "react";
import type { ArtifactRef } from "@/gen/paprika/v1/api_pb";

export function useStepArtifacts(artifacts: ArtifactRef[], stepName: string): ArtifactRef[] {
  return useMemo(
    () => artifacts.filter((a) => a.producingStep === stepName),
    [artifacts, stepName]
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ui && npm test -- use-step-artifacts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/use-step-artifacts.ts ui/src/lib/use-step-artifacts.test.ts
git commit -m "feat(ui): add useStepArtifacts hook"
```

---

### Task 21: Create reusable `ArtifactCard` component

**Files:**
- Create: `ui/src/components/dashboard/artifact-card.tsx`
- Create: `ui/src/components/dashboard/artifact-card.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { ArtifactCard } from "./artifact-card";
import type { ArtifactRef } from "@/gen/paprika/v1/api_pb";

const artifact = {
  name: "img",
  kind: "oci",
  phase: "Ready",
  resolvedReference: "oci://repo@sha256:abc",
  createdAt: 1782000000n,
} as ArtifactRef;

test("renders artifact name and phase", () => {
  render(<ArtifactCard artifact={artifact} />);
  expect(screen.getByText("img")).toBeInTheDocument();
  expect(screen.getByText("Ready")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui && npm test -- artifact-card.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement component**

Create `ui/src/components/dashboard/artifact-card.tsx`:

```tsx
"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ArtifactRef } from "@/gen/paprika/v1/api_pb";

export function ArtifactCard({ artifact }: { artifact: ArtifactRef }) {
  const [error, setError] = useState<string | null>(null);
  const created = artifact.createdAt ? new Date(Number(artifact.createdAt) * 1000).toLocaleString() : "—";

  const handleDownload = async () => {
    try {
      const res = await fetch(`/api/artifacts/${artifact.name}/download`);
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = artifact.name;
      a.click();
      window.URL.revokeObjectURL(url);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleCopyReference = () => {
    if (artifact.resolvedReference) {
      navigator.clipboard.writeText(artifact.resolvedReference);
    }
  };

  const canDownload = artifact.kind === "configmap" && artifact.phase === "Ready";
  const showCopy = artifact.kind === "oci" || (artifact.kind === "configmap" && !canDownload);

  return (
    <div className="rounded border p-3" data-testid="artifact-card">
      <div className="flex items-center justify-between">
        <span className="font-medium">{artifact.name}</span>
        <div className="flex gap-2">
          <Badge variant="secondary">{artifact.kind}</Badge>
          <Badge variant={artifact.phase === "Ready" ? "default" : artifact.phase === "Failed" ? "destructive" : "outline"}>
            {artifact.phase}
          </Badge>
        </div>
      </div>
      <div className="mt-1 text-xs text-muted-foreground">
        {artifact.digest ? `Digest: ${artifact.digest.slice(0, 16)}...` : "—"} · {created}
      </div>
      <div className="mt-2 flex items-center gap-2">
        {canDownload && (
          <Button size="sm" variant="outline" onClick={handleDownload}>Download</Button>
        )}
        {showCopy && (
          <Button size="sm" variant="outline" onClick={handleCopyReference}>Copy reference</Button>
        )}
      </div>
      {error && <div className="mt-2 text-xs text-destructive">{error}</div>}
    </div>
  );
}

export function ArtifactCardSkeleton() {
  return <Skeleton className="h-24 w-full" />;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ui && npm test -- artifact-card.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/dashboard/artifact-card.tsx ui/src/components/dashboard/artifact-card.test.tsx
git commit -m "feat(ui): add reusable ArtifactCard component"
```

---

### Task 22: Render artifacts in step detail panel

**Files:**
- Modify: `ui/src/components/dashboard/step-detail-panel.tsx`
- Create: `ui/src/components/dashboard/step-detail-panel.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { render, screen } from "@testing-library/react";
import { StepDetailPanel } from "./step-detail-panel";
import type { Pipeline, ArtifactRef } from "@/gen/paprika/v1/api_pb";

test("renders artifacts for selected step", () => {
  const pipeline = {
    name: "p",
    artifacts: [
      { name: "img", producingStep: "build", kind: "oci", phase: "Ready", resolvedReference: "oci://repo@sha256:abc" } as ArtifactRef,
    ],
  } as Pipeline;
  render(<StepDetailPanel pipeline={pipeline} selectedStepName="build" />);
  expect(screen.getByText("Artifacts")).toBeInTheDocument();
  expect(screen.getByText("img")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ui && npm test -- step-detail-panel.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement artifacts subsection**

Modify `ui/src/components/dashboard/step-detail-panel.tsx`:

```tsx
import { useStepArtifacts } from "@/lib/use-step-artifacts";
import { ArtifactCard, ArtifactCardSkeleton } from "./artifact-card";

// inside the step panel component:
const stepArtifacts = useStepArtifacts(pipeline.artifacts, selectedStepName);
{stepArtifacts.length > 0 && (
  <div className="mt-4">
    <h4 className="mb-2 text-sm font-semibold">Artifacts</h4>
    <div className="grid gap-2">
      {stepArtifacts.map((a) => <ArtifactCard key={a.name} artifact={a} />)}
    </div>
  </div>
)}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cd ui && npm test -- step-detail-panel.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/dashboard/step-detail-panel.tsx ui/src/components/dashboard/step-detail-panel.test.tsx
git commit -m "feat(ui): render step artifacts in detail panel"
```

---

### Task 23: Handle `pipeline-artifact` SSE events

**Files:**
- Modify: `ui/src/lib/pipeline-sse.ts`
- Modify: `ui/src/app/dashboard/pipelines/detail/page.tsx`

- [ ] **Step 1: Add event type**

In `ui/src/lib/pipeline-sse.ts`:

```ts
export type PipelineSSEEvent =
  | { type: "pipeline"; pipeline: Pipeline }
  | { type: "pipeline-step"; step: StepStatus }
  | { type: "pipeline-artifact"; artifact: ArtifactRef };
```

- [ ] **Step 2: Parse `pipeline-artifact` events**

In the SSE parser:

```ts
case "pipeline-artifact":
  return { type: "pipeline-artifact", artifact: payload.artifact as ArtifactRef };
```

- [ ] **Step 3: Update detail page to refetch on artifact events**

In `ui/src/app/dashboard/pipelines/detail/page.tsx`:

```ts
const onPipelineEvent = useCallback((event: PipelineSSEEvent) => {
  if (event.type === "pipeline-artifact") {
    fetchPipeline();
  }
  // existing handling...
}, [fetchPipeline]);
```

- [ ] **Step 4: Run UI tests**

```bash
cd ui && npm test -- dashboard-sse.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/pipeline-sse.ts ui/src/app/dashboard/pipelines/detail/page.tsx
git commit -m "feat(ui): handle pipeline-artifact SSE events"
```

---

### Task 24: Add pipeline-level artifacts section

**Files:**
- Modify: `ui/src/app/dashboard/pipelines/detail/page.tsx`

- [ ] **Step 1: Filter pipeline-level artifacts**

```ts
const pipelineArtifacts = pipeline.artifacts.filter((a) => !a.producingStep);
```

- [ ] **Step 2: Render subsection**

Add a "Pipeline Artifacts" section on the detail page for artifacts with no
`producingStep`, reusing `ArtifactCard`.

```tsx
{pipelineArtifacts.length > 0 && (
  <section className="mt-6">
    <h3 className="mb-2 text-lg font-semibold">Pipeline Artifacts</h3>
    <div className="grid gap-2">
      {pipelineArtifacts.map((a) => <ArtifactCard key={a.name} artifact={a} />)}
    </div>
  </section>
)}
```

- [ ] **Step 3: Run UI tests**

```bash
cd ui && npm run test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/app/dashboard/pipelines/detail/page.tsx
git commit -m "feat(ui): render pipeline-level artifacts"
```

---

## Final Verification

### Task 25: Run full lint and test suite

- [ ] **Step 1: Regenerate manifests and protobuf**

```bash
make manifests generate
```

- [ ] **Step 2: Run backend lint**

```bash
make lint
```

Expected: 0 issues.

- [ ] **Step 3: Run backend tests**

```bash
make test
```

Expected: all packages pass.

- [ ] **Step 4: Run UI tests**

```bash
cd ui && npm run test
```

Expected: PASS.

- [ ] **Step 5: Build UI and manager**

```bash
make build-with-ui
```

Expected: successful build.

- [ ] **Step 6: Commit any regenerated files**

```bash
git add -A
git commit -m "chore: regenerate manifests and protobuf for pipeline step artifacts"
```

---

## Plan Review Checkpoints

After each chunk, dispatch the plan-document-reviewer subagent with:

- **Plan chunk:** path to this file and chunk heading
- **Spec:** `docs/superpowers/specs/2026-06-24-pipeline-step-artifacts-design.md`

Fix any issues before moving to the next chunk.
