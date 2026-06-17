# `paprika apply -f` Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the `paprika apply -f` command and its supporting platform features: a `Policy` CRD, an `ApplyBundle` API, inline Application/Release source types, and a Bubble Tea TUI for watching rollouts.

**Architecture:** The CLI renders manifests locally and submits them via `ApplyBundle`. The API server evaluates policies, creates an Application/Stage/Release, and stores a snapshot ConfigMap. The existing controllers apply the snapshot and monitor health. A new `policy` package provides CEL-based policy evaluation.

**Tech Stack:** Go 1.26, Kubebuilder, controller-runtime, cel-go, Connect-RPC, Cobra, Bubble Tea, Next.js.

---

## Chunk 1: Policy CRD and evaluator package

This chunk creates the `Policy` CRD, registers it in the scheme, and builds a reusable policy evaluator that can be unit-tested in isolation.

### Task 1.1: Scaffold `Policy` CRD

**Files:**
- Create: `api/policy/v1alpha1/policy_types.go` (via `kubebuilder create api`, then edited)
- Create: `api/policy/v1alpha1/groupversion_info.go` (via `kubebuilder create api`)
- Create: `api/policy/v1alpha1/zz_generated.deepcopy.go` (via `make generate`)
- Modify: `cmd/main.go`
- Modify: `PROJECT`

> **Convention:** Per `AGENTS.md`, use `kubebuilder create api` to scaffold. Do not hand-write `groupversion_info.go` or `_types.go` from scratch.

- [ ] **Step 1: Scaffold the Policy API**

```bash
kubebuilder create api --group policy --version v1alpha1 --kind Policy --namespaced=false
```

Expected: `api/policy/v1alpha1/` created with `policy_types.go`, `groupversion_info.go`, `zz_generated.deepcopy.go`, and `config/crd/bases/policy.paprika.io_policies.yaml`.

- [ ] **Step 2: Edit `api/policy/v1alpha1/policy_types.go`**

Replace the scaffolded `PolicySpec` with:

```go
type PolicySeverity string
const (
    PolicySeverityCritical PolicySeverity = "critical"
    PolicySeverityWarning  PolicySeverity = "warning"
)

type PolicyAction string
const (
    PolicyActionEnforce PolicyAction = "enforce"
    PolicyActionWarn    PolicyAction = "warn"
)

type PolicyMatch struct {
    APIGroups     []string              `json:"apiGroups,omitempty"`
    Kinds         []string              `json:"kinds,omitempty"`
    Namespaces    []string              `json:"namespaces,omitempty"`
    LabelSelector *metav1.LabelSelector `json:"labelSelector,omitempty"`
}

type PolicySpec struct {
    Description   string         `json:"description,omitempty"`
    // +kubebuilder:validation:Enum=critical;warning
    Severity      PolicySeverity `json:"severity"`
    // +kubebuilder:validation:Enum=enforce;warn
    DefaultAction PolicyAction   `json:"defaultAction,omitempty"`
    Match         PolicyMatch    `json:"match"`
    Expression    string         `json:"expression"`
}

type PolicyStatus struct{}
```

Use the project convention `json:"metadata,omitzero"` for `Policy` and `PolicyList`.

Add markers:

```go
// +kubebuilder:object:root=true
// +kubebuilder:resource:scope=Cluster
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Severity",type=string,JSONPath=".spec.severity"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"
```

- [ ] **Step 3: Register policy scheme in operator mode**

Modify `cmd/main.go` to import and register `policyv1alpha1`:

```go
policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
```

```go
utilruntime.Must(policyv1alpha1.AddToScheme(scheme))
```

- [ ] **Step 4: Register policy scheme in API-only mode**

Find `createAPIClient` (or equivalent) in `cmd/main.go` and add:

```go
utilruntime.Must(policyv1alpha1.AddToScheme(apiScheme))
```

- [ ] **Step 5: Generate deepcopy and CRDs**

Run:
```bash
make generate
make manifests
```

Expected: `api/policy/v1alpha1/zz_generated.deepcopy.go` and `config/crd/bases/policy.paprika.io_policies.yaml` are created without errors.

- [ ] **Step 6: Verify `PROJECT` file**

Open `PROJECT` and confirm a new `policy.paprika.io/v1alpha1 Policy` resource entry exists.

- [ ] **Step 7: Commit**

```bash
git add api/policy cmd/main.go config/crd/bases PROJECT
git commit -m "feat(policy): add Policy CRD scaffolding"
```

### Task 1.2: Build the policy evaluator

**Files:**
- Create: `policy/interfaces.go`
- Create: `policy/evaluator.go`
- Create: `policy/evaluator_test.go`
- Create: `policy/defaults.go`

- [ ] **Step 1: Write failing unit test**

Create `policy/evaluator_test.go`:

```go
package policy

import (
    "context"
    "testing"

    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
    "github.com/stretchr/testify/require"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

func TestEvaluator_PassesValidManifest(t *testing.T) {
    policies := []policyv1alpha1.Policy{{
        ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
        Spec: policyv1alpha1.PolicySpec{
            Severity: policyv1alpha1.PolicySeverityCritical,
            Match: policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
            Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
        },
    }}
    bundle := []byte(`
apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
        - name: nginx
          image: nginx:1.25
`)
    eval := NewEvaluator(policies)
    res, err := eval.Evaluate(context.Background(), bundle, EvaluateOptions{})
    require.NoError(t, err)
    require.True(t, res.Passed)
    require.False(t, res.Blocked)
}
```

- [ ] **Step 2: Run the test and confirm it fails**

```bash
go test ./policy/... -run TestEvaluator_PassesValidManifest -v
```

Expected: compile or test failure.

- [ ] **Step 3: Implement the evaluator**

Create `policy/interfaces.go`:

```go
package policy

import (
    "context"

    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
)

type Action string
const (
    EnforceAction Action = "enforce"
    WarnAction    Action = "warn"
)

type EvaluateOptions struct {
    Namespace       string
    ApplicationName string
    SkipPolicies    []string
    PolicyOverrides map[string]Action
}

type Result struct {
    Name     string
    Severity string
    Action   string
    Passed   bool
    Message  string
}

type EvaluationResult struct {
    Passed  bool
    Results []Result
    Blocked bool
    Message string
}

type Evaluator interface {
    Evaluate(ctx context.Context, bundle []byte, opts EvaluateOptions) (*EvaluationResult, error)
}
```

Create `policy/defaults.go`:

```go
package policy

import policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"

func defaultAction(sev policyv1alpha1.PolicySeverity) policyv1alpha1.PolicyAction {
    if sev == policyv1alpha1.PolicySeverityWarning {
        return policyv1alpha1.PolicyActionWarn
    }
    return policyv1alpha1.PolicyActionEnforce
}
```

Create `policy/evaluator.go`:

```go
package policy

import (
    "context"
    "fmt"
    "strings"

    "github.com/google/cel-go/cel"
    "github.com/google/cel-go/common/types/ref"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/labels"
    "k8s.io/apimachinery/pkg/util/yaml"

    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
)

type evaluator struct {
    policies []policyv1alpha1.Policy
}

func NewEvaluator(policies []policyv1alpha1.Policy) Evaluator {
    return &evaluator{policies: policies}
}

func (e *evaluator) Evaluate(ctx context.Context, bundle []byte, opts EvaluateOptions) (*EvaluationResult, error) {
    docs := splitYAMLDocuments(bundle)
    var results []Result
    for _, doc := range docs {
        obj := &unstructured.Unstructured{}
        if err := yaml.Unmarshal(doc, &obj.Object); err != nil {
            return nil, fmt.Errorf("unmarshal manifest: %w", err)
        }
        if obj.Object == nil {
            continue
        }
        for _, pol := range e.policies {
            if skip(opts.SkipPolicies, pol.Name) {
                continue
            }
            if !match(pol.Spec.Match, obj, opts.Namespace) {
                continue
            }
            passed, msg := e.evalPolicy(ctx, pol.Spec.Expression, obj)
            action := resolveAction(pol, opts.PolicyOverrides)
            results = append(results, Result{
                Name:     pol.Name,
                Severity: string(pol.Spec.Severity),
                Action:   string(action),
                Passed:   passed,
                Message:  msg,
            })
        }
    }
    return aggregate(results), nil
}

func skip(list []string, name string) bool {
    for _, n := range list {
        if n == name {
            return true
        }
    }
    return false
}

func resolveAction(pol policyv1alpha1.Policy, overrides map[string]Action) policyv1alpha1.PolicyAction {
    if overrides != nil {
        if a, ok := overrides[pol.Name]; ok {
            return policyv1alpha1.PolicyAction(a)
        }
    }
    if pol.Spec.DefaultAction != "" {
        return pol.Spec.DefaultAction
    }
    return defaultAction(pol.Spec.Severity)
}

func contains(list []string, val string) bool {
    for _, v := range list {
        if v == val {
            return true
        }
    }
    return false
}

func matchAPIGroups(groups []string, apiVersion string) bool {
    if len(groups) == 0 {
        return true
    }
    group := ""
    if i := strings.Index(apiVersion, "/"); i >= 0 {
        group = apiVersion[:i]
    }
    return contains(groups, group)
}

func match(m policyv1alpha1.PolicyMatch, obj *unstructured.Unstructured, namespace string) bool {
    if !matchAPIGroups(m.APIGroups, obj.GetAPIVersion()) {
        return false
    }
    if len(m.Kinds) > 0 && !contains(m.Kinds, obj.GetKind()) {
        return false
    }
    // match.namespaces filters by the resource's own namespace.
    if len(m.Namespaces) > 0 && !contains(m.Namespaces, obj.GetNamespace()) {
        return false
    }
    if m.LabelSelector != nil {
        selector, err := metav1.LabelSelectorAsSelector(m.LabelSelector)
        if err == nil && !selector.Matches(labels.Set(obj.GetLabels())) {
            return false
        }
    }
    return true
}

func splitYAMLDocuments(bundle []byte) [][]byte {
    return engine.SplitYAMLDocuments(bundle)
}

func (e *evaluator) evalPolicy(ctx context.Context, expr string, obj *unstructured.Unstructured) (bool, string) {
    env, err := cel.NewEnv(
        cel.Variable("object", cel.MapType(cel.StringType, cel.AnyType)),
        cel.Variable("kind", cel.StringType),
        cel.Variable("apiVersion", cel.StringType),
        cel.Variable("name", cel.StringType),
        cel.Variable("namespace", cel.StringType),
        cel.Variable("labels", cel.MapType(cel.StringType, cel.StringType)),
        cel.Variable("annotations", cel.MapType(cel.StringType, cel.StringType)),
        cel.Variable("spec", cel.MapType(cel.StringType, cel.AnyType)),
    )
    if err != nil {
        return false, fmt.Sprintf("env error: %v", err)
    }
    ast, iss := env.Compile(expr)
    if iss != nil {
        return false, fmt.Sprintf("compile error: %v", iss.Err())
    }
    prg, err := env.Program(ast)
    if err != nil {
        return false, fmt.Sprintf("program error: %v", err)
    }
    labels := obj.GetLabels()
    if labels == nil {
        labels = map[string]string{}
    }
    annotations := obj.GetAnnotations()
    if annotations == nil {
        annotations = map[string]string{}
    }
    spec, ok := obj.Object["spec"].(map[string]interface{})
    if !ok || spec == nil {
        spec = map[string]interface{}{}
    }
    vars := map[string]interface{}{
        "object":      obj.Object,
        "kind":        obj.GetKind(),
        "apiVersion":  obj.GetAPIVersion(),
        "name":        obj.GetName(),
        "namespace":   obj.GetNamespace(),
        "labels":      labels,
        "annotations": annotations,
        "spec":        spec,
    }
    out, _, err := prg.Eval(vars)
    if err != nil {
        return false, fmt.Sprintf("eval error: %v", err)
    }
    val := out.Value()
    if b, ok := val.(bool); ok {
        return b, ""
    }
    return false, "policy did not return boolean"
}

func aggregate(results []Result) *EvaluationResult {
    ev := &EvaluationResult{Passed: true, Results: results}
    for _, r := range results {
        if !r.Passed && r.Action == string(policyv1alpha1.PolicyActionEnforce) {
            ev.Passed = false
            ev.Blocked = true
            ev.Message = fmt.Sprintf("policy %s failed", r.Name)
            return ev
        }
        if !r.Passed {
            ev.Message = fmt.Sprintf("policy %s warned", r.Name)
        }
    }
    return ev
}
```

- [ ] **Step 4: Run tests until they pass**

```bash
go test ./policy/... -v
```

Expected: PASS.

- [ ] **Step 5: Add comprehensive tests**

Add tests covering:
- A failing enforce policy blocks.
- A warning policy does not block.
- `--skip-policy` skips.
- `--policy-override` changes action.
- `matchAPIGroups` with core group and named group.
- `match` with `labelSelector` and `namespaces`.
- Empty match matches all resources.

- [ ] **Step 6: Commit**

```bash
git add policy/
git commit -m "feat(policy): add CEL policy evaluator"
```

---

## Chunk 2: CRD changes for inline source and policy results

This chunk extends the existing `Application` and `Release` CRDs and updates generated code.

### Task 2.1: Extend `ApplicationSource`

**Files:**
- Modify: `api/pipelines/v1alpha1/application_types.go`
- Modify: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` (via `make generate`)
- Modify: `config/crd/bases/pipelines.paprika.io_applications.yaml` (via `make manifests`)

- [ ] **Step 1: Add inline source type**

Modify `api/pipelines/v1alpha1/application_types.go`:

```go
const SourceTypeInline = "inline"

type InlineSourceSpec struct {
    ConfigMapRef string `json:"configMapRef,omitempty"`
}

type ApplicationSource struct {
    // ... existing fields ...
    Inline *InlineSourceSpec `json:"inline,omitempty"`
}
```

Update the enum marker:

```go
// +kubebuilder:validation:Enum=git;helm;s3;oci;inline
```

- [ ] **Step 2: Regenerate CRDs**

```bash
make generate
make manifests
```

Expected: no errors; CRD YAML updated.

- [ ] **Step 3: Commit**

```bash
git add api/pipelines/v1alpha1/application_types.go config/crd/bases/pipelines.paprika.io_applications.yaml
git commit -m "feat(api): add inline source type to Application"
```

### Task 2.2: Extend `Release` with manifest source and policy results

**Files:**
- Modify: `api/pipelines/v1alpha1/release_types.go`
- Modify: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` (via `make generate`)
- Modify: `config/crd/bases/pipelines.paprika.io_releases.yaml` (via `make manifests`)

- [ ] **Step 1: Add types**

Modify `api/pipelines/v1alpha1/release_types.go`:

```go
type ManifestSource struct {
    ConfigMapRef string `json:"configMapRef,omitempty"`
}

type ReleasePolicyResult struct {
    Name     string `json:"name"`
    Severity string `json:"severity"`
    Action   string `json:"action"`
    Passed   bool   `json:"passed"`
    Message  string `json:"message,omitempty"`
}

type ReleaseSpec struct {
    // ... existing fields ...
    ManifestSource *ManifestSource `json:"manifestSource,omitempty"`
}

type ReleaseStatus struct {
    // ... existing fields ...
    PolicyResults []ReleasePolicyResult `json:"policyResults,omitempty"`
    RolledBackTo  string                `json:"rolledBackTo,omitempty"`
}
```

- [ ] **Step 2: Regenerate**

```bash
make generate
make manifests
```

- [ ] **Step 3: Commit**

```bash
git add api/pipelines/v1alpha1/release_types.go config/crd/bases/pipelines.paprika.io_releases.yaml
git commit -m "feat(api): add manifest source and policy results to Release"
```

---

## Chunk 3: Protobuf and API server

This chunk adds the `ApplyBundle` RPC, regenerates protobuf code, and implements the handler.

### Task 3.1: Update protobuf schema

**Files:**
- Modify: `proto/paprika/v1/api.proto`
- Modify: generated `internal/api/paprika/v1/api.pb.go`
- Modify: generated `internal/api/paprika/v1/v1connect/api.connect.go`

- [ ] **Step 1: Edit `proto/paprika/v1/api.proto`**

Add:

```protobuf
message ApplyBundleRequest {
  string namespace = 1;
  string name = 2;
  bytes manifests = 3;
  repeated string skip_policies = 4;
  map<string, string> policy_overrides = 5;
  bool dry_run = 6;
}

message ApplyBundleResponse {
  Application application = 1;
  Release release = 2;
  repeated PolicyResult policy_results = 3;
  bool blocked = 4;
  string block_reason = 5;
}

message PolicyResult {
  string name = 1;
  string severity = 2;
  string action = 3;
  bool passed = 4;
  string message = 5;
}

message InlineSource {
  string config_map_ref = 1;
}

message ManifestSource {
  string config_map_ref = 1;
}

// Extend ApplicationSource
message ApplicationSource {
  // existing fields 1-11
  InlineSource inline = 12;
}

// Extend Release
message Release {
  // existing fields 1-8
  ManifestSource manifest_source = 9;
  repeated PolicyResult policy_results = 10;
  string rolled_back_to = 11;
}

service PaprikaService {
  // existing RPCs
  rpc ApplyBundle(ApplyBundleRequest) returns (ApplyBundleResponse);
}
```

- [ ] **Step 2: Regenerate protobuf Go code**

The project uses `buf generate`. Run:

```bash
buf generate
```

Expected: `internal/api/paprika/v1/api.pb.go` and `internal/api/paprika/v1/v1connect/api.connect.go` updated.

- [ ] **Step 3: Commit**

```bash
git add proto/paprika/v1/api.proto internal/api/paprika/v1/
git commit -m "feat(proto): add ApplyBundle RPC and inline/manifest source messages"
```

### Task 3.2: Implement `ApplyBundle` handler

**Files:**
- Modify: `internal/api/server.go`
- Create: `internal/api/apply_bundle.go`
- Modify: `internal/api/server.go` converter functions

- [ ] **Step 1: Create `internal/api/apply_bundle.go`**

```go
package api

import (
    "context"
    "crypto/sha256"
    "encoding/hex"
    "fmt"
    "strconv"
    "strings"
    "time"

    "connectrpc.com/connect"
    corev1 "k8s.io/api/core/v1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/types"
    "k8s.io/apimachinery/pkg/util/yaml"
    "sigs.k8s.io/controller-runtime/pkg/client"

    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
    paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "github.com/benebsworth/paprika/policy"
    paprikarpc "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

type ApplyBundleHandler struct {
    client.Client
}

func (h *ApplyBundleHandler) Handle(ctx context.Context, req *connect.Request[paprikarpc.ApplyBundleRequest]) (*connect.Response[paprikarpc.ApplyBundleResponse], error) {
    ns := req.Msg.Namespace
    if ns == "" {
        return nil, connect.NewError(connect.CodeInvalidArgument, fmt.Errorf("namespace is required"))
    }
    appName := req.Msg.Name
    if appName == "" {
        appName = deriveAppName(req.Msg.Manifests)
    }

    // Ensure namespace exists
    if err := h.ensureNamespace(ctx, ns); err != nil {
        return nil, fmt.Errorf("ensure namespace: %w", err)
    }

    // Load and evaluate policies
    var policyList policyv1alpha1.PolicyList
    if err := h.List(ctx, &policyList); err != nil {
        return nil, fmt.Errorf("list policies: %w", err)
    }
    eval := policy.NewEvaluator(policyList.Items)
    evalRes, err := eval.Evaluate(ctx, req.Msg.Manifests, policy.EvaluateOptions{
        Namespace:       ns,
        ApplicationName: appName,
        SkipPolicies:    req.Msg.SkipPolicies,
        PolicyOverrides: convertOverrides(req.Msg.PolicyOverrides),
    })
    if err != nil {
        return nil, fmt.Errorf("evaluate policies: %w", err)
    }
    if evalRes.Blocked {
        return connect.NewResponse(&paprikarpc.ApplyBundleResponse{
            Blocked:       true,
            BlockReason:   evalRes.Message,
            PolicyResults: convertPolicyResults(evalRes.Results),
        }), nil
    }
    if req.Msg.DryRun {
        return connect.NewResponse(&paprikarpc.ApplyBundleResponse{
            PolicyResults: convertPolicyResults(evalRes.Results),
        }), nil
    }

    fullHash := sha256.Sum256(req.Msg.Manifests)
    shortHash := hex.EncodeToString(fullHash[:])[:7]
    hashStr := hex.EncodeToString(fullHash[:])

    // Idempotency: if the active Release is Complete and has the same manifest hash, return it.
    var existingApp paprikav1.Application
    if err := h.Get(ctx, types.NamespacedName{Name: appName, Namespace: ns}, &existingApp); err == nil && existingApp.Status.ReleaseRef != "" {
        var active paprikav1.Release
        if err := h.Get(ctx, types.NamespacedName{Name: existingApp.Status.ReleaseRef, Namespace: ns}, &active); err == nil {
            if active.Annotations["paprika.io/manifest-sha"] == hashStr && active.Status.Phase == paprikav1.ReleaseComplete {
                return connect.NewResponse(&paprikarpc.ApplyBundleResponse{
                    Application:   convertApplication(&existingApp),
                    Release:       convertRelease(&active),
                    PolicyResults: convertPolicyResults(evalRes.Results),
                }), nil
            }
        }
    }

    ts := strconv.FormatInt(time.Now().Unix(), 10)

    // Optimistic-lock loop
    const maxRetries = 5
    var orphanRelease, orphanCM string
    for attempt := 0; attempt < maxRetries; attempt++ {
        if orphanRelease != "" {
            _ = h.Delete(ctx, &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: orphanRelease, Namespace: ns}})
            _ = h.Delete(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: orphanCM, Namespace: ns}})
            orphanRelease = ""
            orphanCM = ""
        }

        releaseName := fmt.Sprintf("%s-release-%s-%s-%d", appName, shortHash, ts, attempt)
        cmName := fmt.Sprintf("%s-manifests-%s-%s-%d", appName, shortHash, ts, attempt)

        app, err := h.ensureApplication(ctx, ns, appName, cmName)
        if err != nil {
            return nil, fmt.Errorf("ensure application: %w", err)
        }
        oldReleaseRef := app.Status.ReleaseRef

        // Refuse concurrent applies while a previous Release is still active.
        if oldReleaseRef != "" {
            var old paprikav1.Release
            if err := h.Get(ctx, types.NamespacedName{Name: oldReleaseRef, Namespace: ns}, &old); err == nil {
                if !isReleaseTerminal(&old) {
                    return nil, connect.NewError(connect.CodeAborted, fmt.Errorf("previous release %s is still %s; wait for it to finish before re-applying", old.Name, old.Status.Phase))
                }
            }
        }

        original := app.DeepCopy()
        app.Spec.Source.Type = paprikav1.SourceTypeInline
        app.Spec.Source.Inline = &paprikav1.InlineSourceSpec{ConfigMapRef: cmName}
        if len(app.Spec.Stages) == 0 {
            app.Spec.Stages = []paprikav1.ApplicationPromotionStage{{Name: "default", Ring: 1}}
        }

        patch := client.MergeFromWithOptions(original, client.MergeFromWithOptimisticLock{})
        if err := h.Patch(ctx, app, patch); err != nil {
            if apierrors.IsConflict(err) {
                continue
            }
            return nil, fmt.Errorf("patch application spec: %w", err)
        }

        stageName := fmt.Sprintf("%s-default", appName)
        stage, err := h.ensureStage(ctx, app, stageName)
        if err != nil {
            return nil, fmt.Errorf("ensure stage: %w", err)
        }

        release := buildRelease(app, stage, releaseName, cmName, fullHash, evalRes.Results)
        if err := h.Create(ctx, release); err != nil {
            return nil, fmt.Errorf("create release: %w", err)
        }

        labeled := injectLabels(req.Msg.Manifests, appName, releaseName)
        cm := buildSnapshotConfigMap(release, appName, cmName, labeled)
        if err := h.Create(ctx, cm); err != nil {
            _ = h.Delete(ctx, release)
            return nil, fmt.Errorf("create snapshot configmap: %w", err)
        }

        statusOriginal := app.DeepCopy()
        app.Status.ReleaseRef = releaseName
        statusPatch := client.MergeFromWithOptions(statusOriginal, client.MergeFromWithOptimisticLock{})
        if err := h.Status().Patch(ctx, app, statusPatch); err != nil {
            if apierrors.IsConflict(err) {
                orphanRelease = releaseName
                orphanCM = cmName
                continue
            }
            _ = h.Delete(ctx, &paprikav1.Release{ObjectMeta: metav1.ObjectMeta{Name: releaseName, Namespace: ns}})
            _ = h.Delete(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: cmName, Namespace: ns}})
            return nil, fmt.Errorf("patch application status: %w", err)
        }

        // Supersede previous terminal release
        if oldReleaseRef != "" {
            _ = h.supersedeRelease(ctx, ns, oldReleaseRef)
        }

        return connect.NewResponse(&paprikarpc.ApplyBundleResponse{
            Application:   convertApplication(app),
            Release:       convertRelease(release),
            PolicyResults: convertPolicyResults(evalRes.Results),
        }), nil
    }

    return nil, connect.NewError(connect.CodeAborted, fmt.Errorf("apply bundle conflict after %d retries", maxRetries))
}

func buildRelease(app *paprikav1.Application, stage *paprikav1.Stage, releaseName, cmName string, fullHash [32]byte, results []policy.Result) *paprikav1.Release {
    return &paprikav1.Release{
        ObjectMeta: metav1.ObjectMeta{
            Name:      releaseName,
            Namespace: app.Namespace,
            Labels: map[string]string{
                "app.paprika.io/managed-by": "paprika",
                "app.paprika.io/name":       app.Name,
                "app.paprika.io/release":    releaseName,
                "app.paprika.io/history":    "true",
            },
            OwnerReferences: []metav1.OwnerReference{{
                APIVersion: paprikav1.GroupVersion.String(),
                Kind:       "Application",
                Name:       app.Name,
                UID:        app.UID,
                Controller: boolPtr(true),
            }},
            Annotations: map[string]string{
                "paprika.io/manifest-sha": hex.EncodeToString(fullHash[:]),
            },
        },
        Spec: paprikav1.ReleaseSpec{
            Target:         stage.Name,
            ManifestSource: &paprikav1.ManifestSource{ConfigMapRef: cmName},
            OnFailure:      app.Spec.OnFailure,
            Verify:         stage.Spec.Gates,
        },
        Status: paprikav1.ReleaseStatus{
            PolicyResults: convertToCRDPolicyResults(results),
        },
    }
}

func buildSnapshotConfigMap(release *paprikav1.Release, appName, cmName string, manifests []byte) *corev1.ConfigMap {
    return &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      cmName,
            Namespace: release.Namespace,
            Labels: map[string]string{
                "app.paprika.io/managed-by": "paprika",
                "app.paprika.io/name":       appName,
                "app.paprika.io/release":    release.Name,
                "app.paprika.io/history":    "true",
            },
            OwnerReferences: []metav1.OwnerReference{{
                APIVersion: paprikav1.GroupVersion.String(),
                Kind:       "Release",
                Name:       release.Name,
                UID:        release.UID,
                Controller: boolPtr(true),
            }},
        },
        Data: map[string]string{"manifests.yaml": string(manifests)},
    }
}

func (h *ApplyBundleHandler) supersedeRelease(ctx context.Context, ns, name string) error {
    var release paprikav1.Release
    if err := h.Get(ctx, types.NamespacedName{Name: name, Namespace: ns}, &release); err != nil {
        return err
    }
    // Only supersede failed/rolled-back releases. Keep the previous Complete release
    // available for rollback until the janitor removes it based on history limits.
    if release.Status.Phase == paprikav1.ReleaseFailed || release.Status.Phase == paprikav1.ReleaseRolledBack {
        release.Status.Phase = paprikav1.ReleaseSuperseded
        return h.Status().Update(ctx, &release)
    }
    return nil
}

func isReleaseTerminal(r *paprikav1.Release) bool {
    switch r.Status.Phase {
    case paprikav1.ReleaseComplete, paprikav1.ReleaseFailed, paprikav1.ReleaseRolledBack, paprikav1.ReleaseSuperseded:
        return true
    }
    return false
}

func deriveAppName(manifests []byte) string {
    docs := splitYAMLDocuments(manifests)
    for _, doc := range docs {
        var obj struct {
            Metadata struct {
                Name string `json:"name"`
            } `json:"metadata"`
        }
        if err := yaml.Unmarshal(doc, &obj); err == nil && obj.Metadata.Name != "" {
            return obj.Metadata.Name
        }
    }
    return "app"
}

func convertOverrides(in map[string]string) map[string]policy.Action {
    out := make(map[string]policy.Action, len(in))
    for k, v := range in {
        out[k] = policy.Action(v)
    }
    return out
}

func convertToCRDPolicyResults(results []policy.Result) []paprikav1.ReleasePolicyResult {
    out := make([]paprikav1.ReleasePolicyResult, len(results))
    for i, r := range results {
        out[i] = paprikav1.ReleasePolicyResult{
            Name:     r.Name,
            Severity: r.Severity,
            Action:   r.Action,
            Passed:   r.Passed,
            Message:  r.Message,
        }
    }
    return out
}

func boolPtr(b bool) *bool { return &b }

func (h *ApplyBundleHandler) ensureNamespace(ctx context.Context, ns string) error {
    var namespace corev1.Namespace
    err := h.Get(ctx, types.NamespacedName{Name: ns}, &namespace)
    if err == nil {
        return nil
    }
    if !apierrors.IsNotFound(err) {
        return err
    }
    namespace.Name = ns
    return h.Create(ctx, &namespace)
}

func (h *ApplyBundleHandler) ensureApplication(ctx context.Context, ns, name, cmName string) (*paprikav1.Application, error) {
    var app paprikav1.Application
    err := h.Get(ctx, types.NamespacedName{Name: name, Namespace: ns}, &app)
    if err == nil {
        return &app, nil
    }
    if !apierrors.IsNotFound(err) {
        return nil, err
    }
    app = paprikav1.Application{
        ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
        Spec: paprikav1.ApplicationSpec{
            Source: paprikav1.ApplicationSource{
                Type:   paprikav1.SourceTypeInline,
                Inline: &paprikav1.InlineSourceSpec{ConfigMapRef: cmName},
            },
            Stages: []paprikav1.ApplicationPromotionStage{{Name: "default", Ring: 1}},
        },
    }
    if err := h.Create(ctx, &app); err != nil {
        return nil, err
    }
    return &app, nil
}

func (h *ApplyBundleHandler) ensureStage(ctx context.Context, app *paprikav1.Application, stageName string) (*paprikav1.Stage, error) {
    stage := &paprikav1.Stage{
        ObjectMeta: metav1.ObjectMeta{Name: stageName, Namespace: app.Namespace},
        Spec: paprikav1.StageSpec{
            Name:      "default",
            Ring:      1,
            Templates: []string{},
        },
    }
    if err := ctrl.SetControllerReference(app, stage, h.Scheme()); err != nil {
        return nil, err
    }
    var existing paprikav1.Stage
    if err := h.Get(ctx, types.NamespacedName{Name: stageName, Namespace: app.Namespace}, &existing); err == nil {
        existing.Spec = stage.Spec
        return &existing, h.Update(ctx, &existing)
    } else if apierrors.IsNotFound(err) {
        return stage, h.Create(ctx, stage)
    }
    return nil, err
}

func injectLabels(manifests []byte, appName, releaseName string) []byte {
    docs := strings.Split(string(manifests), "\n---")
    var out []string
    for _, doc := range docs {
        var obj map[string]interface{}
        if err := yaml.Unmarshal([]byte(doc), &obj); err != nil || obj == nil {
            out = append(out, doc)
            continue
        }
        meta, ok := obj["metadata"].(map[string]interface{})
        if !ok {
            meta = map[string]interface{}{}
            obj["metadata"] = meta
        }
        lbls, ok := meta["labels"].(map[string]interface{})
        if !ok {
            lbls = map[string]interface{}{}
            meta["labels"] = lbls
        }
        lbls["app.paprika.io/managed-by"] = "paprika"
        lbls["app.paprika.io/name"] = appName
        lbls["app.paprika.io/release"] = releaseName
        b, _ := yaml.Marshal(obj)
        out = append(out, string(b))
    }
    return []byte(strings.Join(out, "\n---\n"))
}
```

- [ ] **Step 2: Wire handler into `PaprikaServer`**

Modify `internal/api/server.go` to add `ApplyBundle` method that delegates to `ApplyBundleHandler`:

```go
func (s *PaprikaServer) ApplyBundle(ctx context.Context, req *connect.Request[paprikav1.ApplyBundleRequest]) (*connect.Response[paprikav1.ApplyBundleResponse], error) {
    h := &ApplyBundleHandler{Client: s.client}
    return h.Handle(ctx, req)
}
```

- [ ] **Step 3: Update converters**

Add `convertPolicyResults`, update `convertRelease` to map `ManifestSource` and `PolicyResults`, and update `convertApplication` to map `Source.Inline`.

Example changes in `internal/api/server.go`:

```go
func convertApplication(a *paprikav1.Application) *paprikav1.Application {
    // ... existing mapping ...
    if a.Spec.Source.Inline != nil {
        out.Source.Inline = &paprikav1.InlineSource{
            ConfigMapRef: a.Spec.Source.Inline.ConfigMapRef,
        }
    }
    return out
}

func convertRelease(r *paprikav1.Release) *paprikav1.Release {
    // ... existing mapping ...
    if r.Spec.ManifestSource != nil {
        out.ManifestSource = &paprikav1.ManifestSource{
            ConfigMapRef: r.Spec.ManifestSource.ConfigMapRef,
        }
    }
    if len(r.Status.PolicyResults) > 0 {
        out.PolicyResults = convertPolicyResults(r.Status.PolicyResults)
    }
    out.RolledBackTo = r.Status.RolledBackTo
    return out
}

func convertPolicyResults(in []paprikav1.ReleasePolicyResult) []*paprikav1.PolicyResult {
    out := make([]*paprikav1.PolicyResult, len(in))
    for i, r := range in {
        out[i] = &paprikav1.PolicyResult{
            Name:     r.Name,
            Severity: r.Severity,
            Action:   r.Action,
            Passed:   r.Passed,
            Message:  r.Message,
        }
    }
    return out
}
```

- [ ] **Step 4: Add RBAC markers to handler file**

Add the following markers at the top of `internal/api/apply_bundle.go`:

```go
// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies,verbs=get;list;watch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=stages,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=releases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core,resources=namespaces,verbs=get;list;watch;create
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
```

> **Note:** Add required imports (`ctrl "sigs.k8s.io/controller-runtime"`, `yaml "sigs.k8s.io/yaml"`) and ensure it compiles. Remove the `k8s.io/apimachinery/pkg/util/yaml` import if it conflicts.

- [x] **Step 5: Add integration tests for `ApplyBundle` handler**

Create `internal/api/apply_bundle_test.go`:

```go
package api

import (
    "context"
    "testing"

    "connectrpc.com/connect"
    "github.com/stretchr/testify/require"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
    paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    paprikarpc "github.com/benebsworth/paprika/internal/api/paprika/v1"
)

func TestApplyBundle_BlockedByPolicy(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = paprikav1.AddToScheme(scheme)
    _ = policyv1alpha1.AddToScheme(scheme)
    _ = corev1.AddToScheme(scheme)

    pol := &policyv1alpha1.Policy{
        ObjectMeta: metav1.ObjectMeta{Name: "no-latest"},
        Spec: policyv1alpha1.PolicySpec{
            Severity: policyv1alpha1.PolicySeverityCritical,
            Match:    policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
            Expression: `object.spec.template.spec.containers.all(c, c.image != "latest")`,
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pol).Build()

    handler := &ApplyBundleHandler{Client: c}
    res, err := handler.Handle(context.Background(), connect.NewRequest(&paprikarpc.ApplyBundleRequest{
        Namespace: "dev",
        Name:      "my-app",
        Manifests: []byte(`apiVersion: apps/v1
kind: Deployment
metadata:
  name: nginx
spec:
  template:
    spec:
      containers:
      - name: nginx
        image: latest
`),
    }))
    require.NoError(t, err)
    require.True(t, res.Msg.Blocked)
}
```

Add tests for:
- Dry-run returns policy results without creating resources.
- Successful apply creates Application, Stage, Release, and ConfigMap.
- Policy results are persisted in `Release.status.policyResults`.
- Previous terminal Release is marked `Superseded`.
- Re-applying the same manifest returns the existing Complete Release (idempotency).
- Re-applying while the previous Release is non-terminal returns an error.
- Status patch conflict cleans up orphan Release and ConfigMap.
- `deriveAppName` extracts the first manifest name.
- `injectLabels` adds release and managed-by labels.
- `parsePolicyOverrides` rejects invalid actions.

- [ ] **Step 6: Run tests**

```bash
go test ./internal/api/... -v
make test
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add internal/api/
git commit -m "feat(api): implement ApplyBundle handler with tests"
```

---

## Chunk 4a: Release controller inline manifest path

This chunk adapts the Release controller to load manifests from a snapshot ConfigMap for inline sources.

### Task 4a.1: Release controller inline manifest path

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`
- Modify: `internal/controller/pipelines/release_controller_test.go`

- [ ] **Step 1: Add `loadManifestsFromConfigMap`**

Add to `internal/controller/pipelines/release_controller.go`:

```go
func (r *ReleaseReconciler) loadManifestsFromConfigMap(ctx context.Context, release *paprikav1.Release) ([]byte, error) {
    if release.Spec.ManifestSource == nil || release.Spec.ManifestSource.ConfigMapRef == "" {
        return nil, fmt.Errorf("release has no inline manifest source")
    }
    var cm corev1.ConfigMap
    ns := release.Namespace
    key := types.NamespacedName{Name: release.Spec.ManifestSource.ConfigMapRef, Namespace: ns}
    if err := r.Get(ctx, key, &cm); err != nil {
        // Backward compatibility: try operator namespace for snapshots created before this change.
        if r.Namespace != "" && r.Namespace != ns {
            key.Namespace = r.Namespace
            if fallbackErr := r.Get(ctx, key, &cm); fallbackErr == nil {
                return []byte(cm.Data["manifests.yaml"]), nil
            }
        }
        return nil, err
    }
    return []byte(cm.Data["manifests.yaml"]), nil
}
```

- [ ] **Step 2: Branch `promote()` for inline sources**

Replace the body of `promote()` with:

```go
func (r *ReleaseReconciler) promote(ctx context.Context, release *paprikav1.Release) error {
    log := logf.FromContext(ctx)

    stage, _, err := r.fetchStageAndTemplates(ctx, release)
    if err != nil {
        return err
    }

    var manifests []byte
    if release.Spec.ManifestSource != nil && release.Spec.ManifestSource.ConfigMapRef != "" {
        manifests, err = r.loadManifestsFromConfigMap(ctx, release)
        if err != nil {
            return fmt.Errorf("load inline manifests: %w", err)
        }
    } else {
        params := r.buildPromoteParams(release)
        templates, tErr := r.fetchStageTemplates(ctx, release, stage)
        if tErr != nil {
            return tErr
        }
        manifests, err = r.TemplateRenderer.RenderAll(ctx, templates, params)
        if err != nil {
            return fmt.Errorf("template rendering failed: %w", err)
        }
    }

    // Ensure the release label is present for cleanup regardless of source.
    manifests = r.ensureReleaseLabel(manifests, release.Name)

    snapshotName := stage.Name + "-manifest-snapshot"
    if release.Spec.ManifestSource != nil && release.Spec.ManifestSource.ConfigMapRef != "" {
        // For inline sources, reuse the handler-created snapshot for rollback.
        snapshotName = release.Spec.ManifestSource.ConfigMapRef
    }
    if err = r.storeManifestSnapshot(ctx, release, stage, snapshotName, manifests); err != nil {
        return fmt.Errorf("failed to store manifest snapshot: %w", err)
    }

    release.Status.RenderedManifestSnapshot = snapshotName

    if err := r.applyPromotedManifests(ctx, release, stage, manifests); err != nil {
        return err
    }
    log.Info("Applied rendered manifests to cluster", "stage", stage.Name, "bytes", len(manifests))

    log.Info("Promotion rendered manifests", "stage", stage.Name, "bytes", len(manifests))
    return nil
}
```

Add helper:

```go
func (r *ReleaseReconciler) ensureReleaseLabel(manifests []byte, releaseName string) []byte {
    docs := engine.SplitYAMLDocuments(manifests)
    var out []string
    for _, doc := range docs {
        var obj map[string]interface{}
        if err := yaml.Unmarshal(doc, &obj); err != nil || obj == nil {
            out = append(out, string(doc))
            continue
        }
        meta, ok := obj["metadata"].(map[string]interface{})
        if !ok {
            meta = map[string]interface{}{}
            obj["metadata"] = meta
        }
        labels, ok := meta["labels"].(map[string]interface{})
        if !ok {
            labels = map[string]interface{}{}
            meta["labels"] = labels
        }
        labels["app.paprika.io/release"] = releaseName
        labels["app.paprika.io/managed-by"] = engine.ManagedByLabelValue
        b, _ := yaml.Marshal(obj)
        out = append(out, string(b))
    }
    return []byte(strings.Join(out, "\n---\n"))
}
```

- [ ] **Step 3: Move snapshots to Release namespace**

Update `storeManifestSnapshot`:

```go
func (r *ReleaseReconciler) storeManifestSnapshot(ctx context.Context, release *paprikav1.Release, stage *paprikav1.Stage, name string, manifests []byte) error {
    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      name,
            Namespace: release.Namespace,
            Labels: map[string]string{
                "paprika.io/stage":    stage.Name,
                "paprika.io/release":  release.Name,
                "app.paprika.io/name": release.Labels["app.paprika.io/name"],
            },
        },
        Data: map[string]string{"manifests.yaml": string(manifests)},
    }

    existing := &corev1.ConfigMap{}
    if err := r.Get(ctx, types.NamespacedName{Name: name, Namespace: release.Namespace}, existing); err == nil {
        existing.Data = cm.Data
        existing.Labels = cm.Labels
        if err := r.Update(ctx, existing); err != nil {
            return fmt.Errorf("updating manifest snapshot: %w", err)
        }
        return nil
    }

    if err := r.Create(ctx, cm); err != nil {
        return fmt.Errorf("creating manifest snapshot: %w", err)
    }
    return nil
}
```

Update `rollback` to read from `release.Namespace` (with backward-compatible fallback to `r.Namespace`):

```go
var cm corev1.ConfigMap
key := types.NamespacedName{Name: release.Status.RenderedManifestSnapshot, Namespace: release.Namespace}
if err := r.Get(ctx, key, &cm); err != nil {
    if r.Namespace != "" && r.Namespace != release.Namespace {
        key.Namespace = r.Namespace
        if fallbackErr := r.Get(ctx, key, &cm); fallbackErr != nil {
            return fmt.Errorf("failed to fetch manifest snapshot %q: %w", release.Status.RenderedManifestSnapshot, err)
        }
    } else {
        return fmt.Errorf("failed to fetch manifest snapshot %q: %w", release.Status.RenderedManifestSnapshot, err)
    }
}
```

- [ ] **Step 4: Dynamic cleanup by discovered GVRs**

Replace `cleanup()` with:

```go
func (r *ReleaseReconciler) cleanup(ctx context.Context, release *paprikav1.Release) error {
    log := logf.FromContext(ctx)

    // Delete the snapshot ConfigMap(s) for this release.
    cmName := release.Status.RenderedManifestSnapshot
    if cmName != "" {
        for _, ns := range []string{release.Namespace, r.Namespace} {
            if ns == "" {
                continue
            }
            cm := &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: cmName, Namespace: ns}}
            if err := r.Delete(ctx, cm); err != nil && !apierrors.IsNotFound(err) {
                return fmt.Errorf("deleting manifest snapshot ConfigMap: %w", err)
            }
        }
        log.Info("Deleted manifest snapshot ConfigMap", "configmap", cmName)
    }

    // Load the snapshot to discover which GVRs were managed.
    manifests, err := r.loadSnapshotManifests(ctx, release)
    if err != nil {
        log.Error(err, "Could not load snapshot for cleanup; falling back to known GVRs")
    }

    var gvrs []schema.GroupVersionResource
    if len(manifests) > 0 {
        gvrs = r.discoverGVRs(manifests)
    } else {
        gvrs = managedGVRs
    }

    labelSelector := labels.Set{"app.paprika.io/release": release.Name}.String()
    for _, gvr := range gvrs {
        items, err := r.DynamicClient.Resource(gvr).Namespace(release.Namespace).List(ctx, metav1.ListOptions{LabelSelector: labelSelector})
        if err != nil {
            return fmt.Errorf("listing %s: %w", gvr.Resource, err)
        }
        for _, item := range items.Items {
            if err := r.DynamicClient.Resource(gvr).Namespace(release.Namespace).Delete(ctx, item.GetName(), metav1.DeleteOptions{}); err != nil && !apierrors.IsNotFound(err) {
                return fmt.Errorf("deleting %s/%s: %w", gvr.Resource, item.GetName(), err)
            }
            log.Info("Deleted managed resource", "resource", gvr.Resource, "name", item.GetName())
        }
    }

    return nil
}

func (r *ReleaseReconciler) loadSnapshotManifests(ctx context.Context, release *paprikav1.Release) ([]byte, error) {
    if release.Status.RenderedManifestSnapshot == "" {
        return nil, nil
    }
    var cm corev1.ConfigMap
    key := types.NamespacedName{Name: release.Status.RenderedManifestSnapshot, Namespace: release.Namespace}
    if err := r.Get(ctx, key, &cm); err != nil {
        if r.Namespace != "" && r.Namespace != release.Namespace {
            key.Namespace = r.Namespace
            if fallbackErr := r.Get(ctx, key, &cm); fallbackErr != nil {
                return nil, err
            }
        } else {
            return nil, err
        }
    }
    return []byte(cm.Data["manifests.yaml"]), nil
}

func (r *ReleaseReconciler) discoverGVRs(manifests []byte) []schema.GroupVersionResource {
    docs := engine.SplitYAMLDocuments(manifests)
    seen := map[schema.GroupVersionResource]struct{}{}
    for _, doc := range docs {
        var obj struct {
            APIVersion string `json:"apiVersion"`
            Kind       string `json:"kind"`
        }
        if err := yaml.Unmarshal(doc, &obj); err != nil || obj.Kind == "" {
            continue
        }
        gvk := schema.FromAPIVersionAndKind(obj.APIVersion, obj.Kind)
        mapping, err := r.RESTMapper().RESTMapping(gvk.GroupKind(), gvk.Version)
        if err != nil {
            // Fallback to heuristic for known kinds.
            group, version := parseAPIVersion(obj.APIVersion)
            gvr, err := r.gvrFromKind(obj.Kind, group, version)
            if err != nil {
                continue
            }
            seen[gvr] = struct{}{}
            continue
        }
        seen[mapping.Resource] = struct{}{}
    }
    out := make([]schema.GroupVersionResource, 0, len(seen))
    for gvr := range seen {
        out = append(out, gvr)
    }
    return out
}
```

> **Note:** For full cluster-scoped resource support, update `applyDocument` to query `r.RESTMapper().RESTMapping(...)` and call `dynClient.Resource(gvr)` without `.Namespace(...)` when the mapping indicates a cluster-scoped kind. Phase 1 can rely on the fallback heuristic, which works for namespaced resources.

- [ ] **Step 5: Add RBAC markers**

Add to the RBAC markers in `release_controller.go`:

```go
// +kubebuilder:rbac:groups=pipelines.paprika.io,resources=applications/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
```

> **Note:** Inline bundles may contain arbitrary resource kinds. Add explicit RBAC markers for every kind your bundles use (e.g., `batch`/`jobs`, `rbac.authorization.k8s.io`/`clusterroles`). For end-to-end testing with the sample Deployment, the existing `apps/deployments`, `core/services`, and `core/configmaps` permissions are sufficient.

- [ ] **Step 6: Commit**

```bash
git add internal/controller/pipelines/release_controller.go
git commit -m "feat(controller): support inline manifest source in Release controller"
```

## Chunk 4b: Application controller inline source handling

This chunk adapts the Application controller to skip Template creation, wait for the handler-created Release, and prune old Releases.

### Task 4b.1: Application controller inline source handling

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go`

- [ ] **Step 1: Skip Template creation for inline**

In `reconcileApp`, wrap `reconcileTemplate`:

```go
if app.Spec.Source.Type != paprikav1.SourceTypeInline {
    if err := r.reconcileTemplate(ctx, app); err != nil {
        log.Error(err, "Failed to reconcile Template")
        r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "TemplateReconciliationFailed", err.Error())
        return ctrl.Result{}, err
    }
}
```

- [ ] **Step 2: Empty Templates list in Stage**

Update `buildStageSpec`:

```go
templates := []string{templateName}
if app.Spec.Source.Type == paprikav1.SourceTypeInline {
    templates = []string{}
}

return &paprikav1.Stage{
    // ... metadata ...
    Spec: paprikav1.StageSpec{
        Name:      promotionStage.Name,
        Ring:      promotionStage.Ring,
        Cluster:   promotionStage.Cluster,
        Templates: templates,
        Gates:     promotionStage.Gates,
        Canary:    stageCanary,
    },
}
```

- [ ] **Step 3: Handle inline diff in `evaluateDiff`**

Update `evaluateDiff` to load the active Release's snapshot when the source is inline:

```go
func (r *ApplicationReconciler) evaluateDiff(ctx context.Context, app *paprikav1.Application) {
    log := log.FromContext(ctx)

    if r.DiffEngine == nil {
        return
    }

    var manifests []byte
    var err error

    if app.Spec.Source.Type == paprikav1.SourceTypeInline {
        manifests, err = r.loadActiveReleaseManifests(ctx, app)
        if err != nil {
            log.Error(err, "Failed to load inline manifests for diff")
            return
        }
    } else {
        templateName := app.Name + "-template"
        var tmpl paprikav1.Template
        if err = r.Get(ctx, types.NamespacedName{Name: templateName, Namespace: app.Namespace}, &tmpl); err != nil {
            log.Error(err, "Failed to get template for diff")
            return
        }

        renderer := r.TemplateRenderer
        if renderer == nil {
            renderer = engine.NewHelmSDKRenderer(r.WorkDir)
        }
        manifests, err = renderer.Render(ctx, &tmpl, app.Spec.Parameters)
        if err != nil {
            log.Error(err, "Failed to render template for diff")
            return
        }
    }

    docs := engine.SplitYAMLDocuments(manifests)
    var desired []unstructured.Unstructured
    for _, doc := range docs {
        var obj map[string]interface{}
        if uErr := yaml.Unmarshal(doc, &obj); uErr != nil {
            continue
        }
        if obj == nil {
            continue
        }
        u := unstructured.Unstructured{Object: obj}
        desired = append(desired, u)
    }

    labelSelector := engine.ManagedByAppSelector(app.Name).String()
    result, err := r.DiffEngine.ComputeDiff(ctx, desired, engine.DiffOptions{
        Namespace:       app.Namespace,
        LabelSelector:   labelSelector,
        ApplicationName: app.Name,
    })
    if err != nil {
        log.Error(err, "Failed to compute diff")
        return
    }

    app.Status.Resources = convertDiffToResourceSyncs(result.ResourceSyncs())
    app.Status.OutOfSync = result.OutOfSyncCount()
    app.Status.PrunedResources = len(result.Deleted)
}

func (r *ApplicationReconciler) loadActiveReleaseManifests(ctx context.Context, app *paprikav1.Application) ([]byte, error) {
    if app.Status.ReleaseRef == "" {
        return nil, fmt.Errorf("no active release")
    }
    var rel paprikav1.Release
    if err := r.Get(ctx, types.NamespacedName{Name: app.Status.ReleaseRef, Namespace: app.Namespace}, &rel); err != nil {
        return nil, err
    }
    if rel.Spec.ManifestSource == nil || rel.Spec.ManifestSource.ConfigMapRef == "" {
        return nil, fmt.Errorf("active release has no inline manifest source")
    }
    var cm corev1.ConfigMap
    if err := r.Get(ctx, types.NamespacedName{Name: rel.Spec.ManifestSource.ConfigMapRef, Namespace: rel.Namespace}, &cm); err != nil {
        return nil, err
    }
    return []byte(cm.Data["manifests.yaml"]), nil
}
```

- [ ] **Step 4: Short-circuit `checkSourceChanged`**

Update `resolveSourceHash`:

```go
func (r *ApplicationReconciler) resolveSourceHash(ctx context.Context, app *paprikav1.Application) (hash, revision string, err error) {
    if app.Spec.Source.Type == paprikav1.SourceTypeInline {
        return "", "", nil
    }
    if app.Spec.Source.Type == paprikav1.SourceTypeGit || app.Spec.Source.Type == paprikav1.SourceTypeS3 {
        return r.resolveVCSSourceHash(ctx, app)
    }
    hash, err = r.resolveHelmSourceHash(ctx, app)
    if err != nil {
        return "", "", err
    }
    return hash, "", nil
}
```

- [ ] **Step 5: Guard `reconcileRelease` for inline**

At the start of `reconcileRelease`:

```go
if app.Spec.Source.Type == paprikav1.SourceTypeInline && app.Status.ReleaseRef == "" {
    r.updatePhase(ctx, app, paprikav1.ApplicationPending, "AwaitingInlineRelease", "waiting for ApplyBundle to create release")
    return ctrl.Result{RequeueAfter: defaultRequeue}, nil
}
```

> **Race safety:** `ApplyBundle` writes `Application.status.releaseRef` after creating the Release, which races with the Application controller's status updates. Ensure `patchAppStatus` preserves an existing `releaseRef` from the live object when the in-memory status does not set it, otherwise the controller can overwrite the field and stay stuck in `AwaitingInlineRelease`.

- [x] **Step 5: Guard `reconcileRelease` for inline**

- [x] **Step 6: Add snapshot janitor**

In `reconcileApp`, after handling inline source, add:

```go
if app.Spec.Source.Type == paprikav1.SourceTypeInline {
    if err := r.pruneOldReleases(ctx, app); err != nil {
        log.Error(err, "Failed to prune old releases")
    }
}
```

Also add the same call at the top of `handleHealthyPhase` so pruning continues after the Application becomes `Healthy`:

```go
func (r *ApplicationReconciler) handleHealthyPhase(ctx context.Context, app *paprikav1.Application) (ctrl.Result, error) {
    if app.Spec.Source.Type == paprikav1.SourceTypeInline {
        if err := r.pruneOldReleases(ctx, app); err != nil {
            log.FromContext(ctx).Error(err, "Failed to prune old releases")
        }
    }
    // ... existing polling logic ...
}
```

Implement `pruneOldReleases`:

```go
const defaultReleaseHistoryLimit = 10

func (r *ApplicationReconciler) pruneOldReleases(ctx context.Context, app *paprikav1.Application) error {
    var list paprikav1.ReleaseList
    if err := r.List(ctx, &list, client.InNamespace(app.Namespace), client.MatchingLabels{"app.paprika.io/name": app.Name}); err != nil {
        return err
    }

    limit := defaultReleaseHistoryLimit

    var all []*paprikav1.Release
    for i := range list.Items {
        all = append(all, &list.Items[i])
    }

    // Sort newest first.
    sort.Slice(all, func(i, j int) bool {
        return all[i].CreationTimestamp.After(all[j].CreationTimestamp.Time)
    })

    keep := map[string]struct{}{}
    // Always protect the active release.
    for _, rel := range all {
        if rel.Name == app.Status.ReleaseRef {
            keep[rel.Name] = struct{}{}
            break
        }
    }
    // Protect the most recent non-superseded release for rollback.
    for _, rel := range all {
        if _, ok := keep[rel.Name]; ok {
            continue
        }
        if rel.Status.Phase != paprikav1.ReleaseSuperseded {
            keep[rel.Name] = struct{}{}
            break
        }
    }
    // Protect up to the history limit (including protected releases).
    kept := 0
    for _, rel := range all {
        if _, ok := keep[rel.Name]; ok {
            kept++
            continue
        }
        if kept < limit {
            keep[rel.Name] = struct{}{}
            kept++
        }
    }

    deleted := 0
    for _, rel := range all {
        if _, ok := keep[rel.Name]; ok {
            continue
        }
        if err := r.Delete(ctx, rel); err != nil && !apierrors.IsNotFound(err) {
            r.recordEvent(app, corev1.EventTypeWarning, "PruneReleaseFailed", fmt.Sprintf("Failed to prune release %s: %v", rel.Name, err))
            return err
        }
        deleted++
    }
    if deleted > 0 {
        r.recordEvent(app, corev1.EventTypeNormal, "PrunedReleases", fmt.Sprintf("Pruned %d old releases", deleted))
    }
    return nil
}

func (r *ApplicationReconciler) recordEvent(app *paprikav1.Application, eventType, reason, message string) {
    if r.EventRecorder != nil {
        r.EventRecorder.Event(app, eventType, reason, message)
    }
}
```

Add `EventRecorder record.EventRecorder` to the `ApplicationReconciler` struct and initialize it in `SetupWithManager` via `mgr.GetEventRecorderFor("application-controller")`.

- [x] **Step 7: Add imports**

Ensure `application_controller.go` imports:

```go
import (
    // ... existing imports ...
    "sort"

    corev1 "k8s.io/api/core/v1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    // ... existing imports ...
)
```

- [x] **Step 8: Add RBAC markers**

Add to the RBAC markers in `application_controller.go`:

```go
// +kubebuilder:rbac:groups=core,resources=configmaps,verbs=get;list;watch
// +kubebuilder:rbac:groups=core,resources=events,verbs=create;patch
```

- [x] **Step 9: Commit**

```bash
git add internal/controller/pipelines/application_controller.go
git commit -m "feat(controller): handle inline source in Application controller"
```

## Chunk 4c: True rollback

This chunk implements rollback to a previous Release's snapshot and snapshot cleanup.

### Task 4c.1: Implement true rollback

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`

- [x] **Step 1: Find previous Complete Release for same Application**

```go
func (r *ReleaseReconciler) findRollbackTarget(ctx context.Context, release *paprikav1.Release) (*paprikav1.Release, error) {
    appName := release.Labels["app.paprika.io/name"]
    if appName == "" {
        return nil, fmt.Errorf("release missing app.paprika.io/name label")
    }

    var list paprikav1.ReleaseList
    if err := r.List(ctx, &list, client.InNamespace(release.Namespace), client.MatchingLabels{"app.paprika.io/name": appName}); err != nil {
        return nil, err
    }

    isViable := func(r *paprikav1.Release) bool {
        return r.Status.Phase == paprikav1.ReleaseComplete ||
            (r.Status.Phase != paprikav1.ReleaseFailed && r.Status.Phase != paprikav1.ReleaseSuperseded && r.Status.RenderedManifestSnapshot != "")
    }

    var target *paprikav1.Release
    for i := range list.Items {
        other := &list.Items[i]
        if other.Name == release.Name {
            continue
        }
        if other.Spec.Target != release.Spec.Target {
            continue
        }
        if !isViable(other) {
            continue
        }
        if target == nil || other.CreationTimestamp.After(target.CreationTimestamp.Time) {
            target = other
        }
    }
    return target, nil
}
```

- [x] **Step 2: Implement rollback execution**

Replace `handleFailedRollback()`:

```go
func (r *ReleaseReconciler) handleFailedRollback(ctx context.Context, release *paprikav1.Release, result *string) (ctrl.Result, error) {
    log := logf.FromContext(ctx)

    target, err := r.findRollbackTarget(ctx, release)
    if err != nil {
        *result = resultError
        return ctrl.Result{}, fmt.Errorf("find rollback target: %w", err)
    }

    if target == nil || target.Status.RenderedManifestSnapshot == "" {
        log.Info("No rollback target available", "release", release.Name)
        release.Status.Phase = paprikav1.ReleaseRolledBack
        release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
            Type: "RolledBack", Status: metav1.ConditionTrue,
            LastTransitionTime: metav1.Now(),
            Reason: "NoSnapshot", Message: "No rollback snapshot available",
        })
        if err := r.patchReleaseStatus(ctx, release); err != nil {
            *result = resultError
            return ctrl.Result{}, err
        }
        return ctrl.Result{}, nil
    }

    var cm corev1.ConfigMap
    key := types.NamespacedName{Name: target.Status.RenderedManifestSnapshot, Namespace: target.Namespace}
    if err := r.Get(ctx, key, &cm); err != nil {
        if r.Namespace != "" && r.Namespace != target.Namespace {
            key.Namespace = r.Namespace
            if fallbackErr := r.Get(ctx, key, &cm); fallbackErr != nil {
                *result = resultError
                return ctrl.Result{}, fmt.Errorf("load rollback snapshot: %w", err)
            }
        } else {
            *result = resultError
            return ctrl.Result{}, fmt.Errorf("load rollback snapshot: %w", err)
        }
    }

    raw, ok := cm.Data["manifests.yaml"]
    if !ok || strings.TrimSpace(raw) == "" {
        *result = resultError
        return ctrl.Result{}, fmt.Errorf("rollback snapshot %s is empty", cm.Name)
    }

    stage, _, err := r.fetchStageAndTemplates(ctx, release)
    if err != nil {
        *result = resultError
        return ctrl.Result{}, fmt.Errorf("fetch stage for rollback: %w", err)
    }

    appName := release.Labels["app.paprika.io/name"]
    if err := r.applyManifestsForCluster(ctx, release.Namespace, &stage.Spec.Cluster, appName, []byte(raw)); err != nil {
        *result = resultError
        return ctrl.Result{}, fmt.Errorf("apply rollback manifests: %w", err)
    }

    release.Status.Phase = paprikav1.ReleaseRolledBack
    release.Status.RolledBackTo = target.Name
    release.Status.Conditions = append(release.Status.Conditions, metav1.Condition{
        Type: "RolledBack", Status: metav1.ConditionTrue,
        LastTransitionTime: metav1.Now(),
        Reason: "RollbackComplete", Message: fmt.Sprintf("Rolled back to %s", target.Name),
    })
    if err := r.patchReleaseStatus(ctx, release); err != nil {
        *result = resultError
        return ctrl.Result{}, err
    }

    // Patch Application.status.releaseRef back to the target Release using optimistic locking.
    var app paprikav1.Application
    if err := r.Get(ctx, types.NamespacedName{Name: appName, Namespace: release.Namespace}, &app); err == nil {
        original := app.DeepCopy()
        app.Status.ReleaseRef = target.Name
        patch := client.MergeFromWithOptions(original, client.MergeFromWithOptimisticLock{})
        if err := r.Status().Patch(ctx, &app, patch); err != nil {
            log.Error(err, "Failed to update Application releaseRef after rollback")
        }
    }

    metrics.ReleasePhaseTotal.WithLabelValues(release.Name, release.Namespace, "RolledBack").Inc()
    return ctrl.Result{}, nil
}
```

- [x] **Step 3: Ensure rollback is reachable**

Modify `reconcileReleasePhase` in `internal/controller/pipelines/release_controller.go` so that rollback is attempted before the terminal-phase short-circuit:

```go
func (r *ReleaseReconciler) reconcileReleasePhase(ctx context.Context, req ctrl.Request, release *paprikav1.Release, start time.Time, result *string) (ctrl.Result, error) {
    if r.shouldRollback(release) {
        return r.handleFailedRollback(ctx, release, result)
    }

    if r.isReleaseTerminal(release) {
        return ctrl.Result{}, nil
    }

    // ... rest of existing logic ...
}
```

This ensures a `Failed` Release with `OnFailure: rollback` is rolled back instead of short-circuited.

- [x] **Step 4: Add unit tests**

Create `internal/controller/pipelines/release_controller_inline_test.go`:

```go
package controller

import (
    "context"
    "testing"

    "github.com/stretchr/testify/require"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    paprikav1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestReleaseReconciler_LoadManifestsFromConfigMap(t *testing.T) {
    scheme := runtime.NewScheme()
    _ = paprikav1.AddToScheme(scheme)
    _ = corev1.AddToScheme(scheme)

    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{Name: "snap", Namespace: "dev"},
        Data:       map[string]string{"manifests.yaml": "apiVersion: v1\nkind: ConfigMap"},
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cm).Build()
    r := &ReleaseReconciler{Client: c}

    release := &paprikav1.Release{
        ObjectMeta: metav1.ObjectMeta{Name: "rel", Namespace: "dev"},
        Spec: paprikav1.ReleaseSpec{
            ManifestSource: &paprikav1.ManifestSource{ConfigMapRef: "snap"},
        },
    }
    data, err := r.loadManifestsFromConfigMap(context.Background(), release)
    require.NoError(t, err)
    require.Contains(t, string(data), "kind: ConfigMap")
}
```

- [ ] **Step 4: Add rollback envtest**

Add integration test in `internal/controller/pipelines/release_controller_test.go` that:
- Creates two Releases for the same Application, one Complete with a snapshot, one Failed.
- Reconciles the Failed Release with `OnFailure: rollback`.
- Asserts the Failed Release becomes `RolledBack` and `Application.status.releaseRef` points to the Complete Release.

- [ ] **Step 5: Commit**

```bash
git add internal/controller/pipelines/release_controller.go internal/controller/pipelines/release_controller_test.go internal/controller/pipelines/release_controller_inline_test.go
git commit -m "feat(controller): implement true rollback to previous snapshot"
```

---

## Chunk 5: CLI apply command and TUI

This chunk adds the `paprika apply` command with input detection and a Bubble Tea watch UI.

### Task 5.1: CLI rendering and input detection

**Files:**
- Create: `cmd/paprika-cli/apply.go`
- Create: `cmd/paprika-cli/render_input.go`
- Create: `cmd/paprika-cli/render_input_test.go`

- [ ] **Step 1: Add render helpers**

Create `cmd/paprika-cli/render_input.go`:

```go
package main

import (
    "bytes"
    "context"
    "fmt"
    "os"
    "path/filepath"
    "sort"
    "strings"

    "github.com/benebsworth/paprika/engine"
)

type RenderedBundle struct {
    Manifests []byte
    Count     int
}

func renderInputs(ctx context.Context, paths []string) (*RenderedBundle, error) {
    var parts [][]byte
    for _, p := range paths {
        data, err := renderPath(ctx, p)
        if err != nil {
            return nil, fmt.Errorf("render %s: %w", p, err)
        }
        parts = append(parts, data)
    }
    joined := bytes.Join(parts, []byte("\n---\n"))
    docs := engine.SplitYAMLDocuments(joined)
    count := 0
    for _, d := range docs {
        if strings.TrimSpace(string(d)) != "" {
            count++
        }
    }
    return &RenderedBundle{Manifests: joined, Count: count}, nil
}

func renderPath(ctx context.Context, p string) ([]byte, error) {
    fi, err := os.Stat(p)
    if err != nil {
        return nil, err
    }
    if fi.IsDir() {
        return renderDir(ctx, p)
    }
    return renderFile(ctx, p)
}

func renderDir(ctx context.Context, p string) ([]byte, error) {
    if _, err := os.Stat(filepath.Join(p, "kustomization.yaml")); err == nil {
        return nil, fmt.Errorf("kustomize support is Phase 2")
    }
    if _, err := os.Stat(filepath.Join(p, "Chart.yaml")); err == nil {
        return nil, fmt.Errorf("helm chart support is Phase 2")
    }
    entries, err := os.ReadDir(p)
    if err != nil {
        return nil, err
    }
    sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
    var parts [][]byte
    for _, e := range entries {
        if e.IsDir() {
            continue
        }
        name := e.Name()
        if strings.HasSuffix(name, ".yaml") || strings.HasSuffix(name, ".yml") {
            data, err := os.ReadFile(filepath.Join(p, name))
            if err != nil {
                return nil, err
            }
            parts = append(parts, data)
        }
    }
    return bytes.Join(parts, []byte("\n---\n")), nil
}

func renderFile(ctx context.Context, p string) ([]byte, error) {
    if strings.HasSuffix(p, ".tgz") || strings.HasSuffix(p, ".tar.gz") {
        return nil, fmt.Errorf("helm chart archive support is Phase 2")
    }
    return os.ReadFile(p)
}
```

- [ ] **Step 2: Add tests**

Create `cmd/paprika-cli/render_input_test.go` with tests for:
- Single YAML file
- Directory of YAMLs
- Kustomize dir returns Phase 2 error
- Helm chart dir returns Phase 2 error

- [ ] **Step 3: Run tests**

```bash
go test ./cmd/paprika-cli/... -run TestRender -v
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add cmd/paprika-cli/render_input.go cmd/paprika-cli/render_input_test.go
git commit -m "feat(cli): add input rendering for apply command"
```

### Task 5.2: Add Bubble Tea TUI

**Files:**
- Create: `cmd/paprika-cli/apply_tui.go`
- Modify: `cmd/paprika-cli/apply.go`

- [ ] **Step 1: Add Bubble Tea dependency**

```bash
go get github.com/charmbracelet/bubbletea
go get github.com/charmbracelet/lipgloss
```

- [ ] **Step 2: Create TUI model**

Create `cmd/paprika-cli/apply_tui.go`:

```go
package main

import (
    "context"
    "fmt"
    "time"

    "github.com/charmbracelet/bubbletea"
    "connectrpc.com/connect"

    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
    "github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

type applyModel struct {
    client        v1connect.PaprikaServiceClient
    name          string
    namespace     string
    timeout       time.Duration
    start         time.Time
    phase         string
    health        string
    resources     []*paprikav1.ResourceHealth
    policyResults []*paprikav1.PolicyResult
    err           error
    done          bool
    lastMessage   string
}

type tickMsg struct{}
type errMsg struct{ err error }

func (m applyModel) Init() tea.Cmd {
    return tea.Batch(
        func() tea.Msg { return tickMsg{} },
        tea.Tick(2*time.Second, func(time.Time) tea.Msg { return tickMsg{} }),
    )
}

func (m applyModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
    switch msg := msg.(type) {
    case tea.KeyMsg:
        if msg.String() == "q" || msg.String() == "ctrl+c" {
            return m, tea.Quit
        }
    case errMsg:
        m.err = msg.err
        m.done = true
        return m, tea.Quit
    case tickMsg:
        if time.Since(m.start) > m.timeout {
            m.err = fmt.Errorf("watch timed out after %s", m.timeout)
            m.done = true
            return m, tea.Quit
        }
        res, err := m.client.GetApplication(context.Background(), connect.NewRequest(&paprikav1.GetApplicationRequest{
            Name: m.name, Namespace: m.namespace,
        }))
        if err != nil {
            return m, func() tea.Msg { return errMsg{err: err} }
        }
        app := res.Msg.Application
        m.phase = app.Phase
        m.health = app.Health
        m.resources = app.ResourceHealth
        if terminalPhase(app.Phase) {
            m.done = true
            if app.Phase == "Healthy" {
                m.lastMessage = fmt.Sprintf("✓ %s is %s", m.name, app.Phase)
            } else {
                m.lastMessage = fmt.Sprintf("✗ %s is %s", m.name, app.Phase)
            }
            return m, tea.Quit
        }
        return m, tea.Tick(2*time.Second, func(time.Time) tea.Msg { return tickMsg{} })
    }
    return m, nil
}

func (m applyModel) View() string {
    if m.err != nil {
        return fmt.Sprintf("Error: %v\n", m.err)
    }
    s := fmt.Sprintf("Apply: %s/%s\nPhase: %s\nHealth: %s\n", m.namespace, m.name, m.phase, m.health)
    if len(m.policyResults) > 0 {
        s += "\nPolicies:\n"
        for _, r := range m.policyResults {
            status := "passed"
            if !r.Passed {
                status = "failed"
            }
            s += fmt.Sprintf("  [%s/%s] %s: %s\n", r.Severity, r.Action, r.Name, status)
        }
    }
    s += "\nResources:\n"
    for _, r := range m.resources {
        s += fmt.Sprintf("  %s/%s/%s: %s\n", r.Kind, r.Namespace, r.Name, r.Health)
    }
    if m.done {
        s += "\n" + m.lastMessage + "\n"
    }
    return s
}

func terminalPhase(phase string) bool {
    switch phase {
    case "Healthy", "Degraded", "Failed", "RolledBack":
        return true
    }
    return false
}
```

- [ ] **Step 3: Create `apply.go` command**

Create `cmd/paprika-cli/apply.go`:

```go
package main

import (
    "context"
    "fmt"
    "io"
    "os"
    "strings"
    "time"

    "connectrpc.com/connect"
    "github.com/charmbracelet/bubbletea"
    "github.com/mattn/go-isatty"
    "github.com/spf13/cobra"

    paprikav1 "github.com/benebsworth/paprika/internal/api/paprika/v1"
    "github.com/benebsworth/paprika/internal/api/paprika/v1/v1connect"
)

func newApplyCmd(clientFn func() (v1connect.PaprikaServiceClient, error), nsFn func() string, output *string) *cobra.Command {
    var (
        files           []string
        appName         string
        skipPolicies    []string
        policyOverrides []string
        dryRun          bool
        wait            bool
        timeout         int
    )
    cmd := &cobra.Command{
        Use:   "apply -f <path> [-f <path> ...]",
        Short: "Apply manifests with Paprika intelligence",
        RunE: func(cmd *cobra.Command, args []string) error {
            ctx := cmd.Context()
            client, err := clientFn()
            if err != nil {
                return err
            }
            bundle, err := renderInputs(ctx, files)
            if err != nil {
                return err
            }
            overrides, err := parsePolicyOverrides(policyOverrides)
            if err != nil {
                return err
            }
            res, err := client.ApplyBundle(ctx, connect.NewRequest(&paprikav1.ApplyBundleRequest{
                Namespace:       nsFn(),
                Name:            appName,
                Manifests:       bundle.Manifests,
                SkipPolicies:    skipPolicies,
                PolicyOverrides: overrides,
                DryRun:          dryRun,
            }))
            if err != nil {
                return fmt.Errorf("apply bundle: %w", err)
            }
            if res.Msg.Blocked {
                printPolicyResults(cmd.OutOrStdout(), res.Msg.PolicyResults)
                return fmt.Errorf("apply blocked: %s", res.Msg.BlockReason)
            }
            if dryRun {
                printPolicyResults(cmd.OutOrStdout(), res.Msg.PolicyResults)
                fmt.Fprintln(cmd.OutOrStdout(), "Dry run complete")
                return nil
            }
            if res.Msg.Application == nil {
                return fmt.Errorf("apply returned no application")
            }
            if !wait {
                return writeApplication(cmd.OutOrStdout(), *output, res.Msg.Application)
            }
            if isatty.IsTerminal(os.Stdout.Fd()) {
                finalModel, err := tea.NewProgram(applyModel{
                    client:        client,
                    name:          res.Msg.Application.Name,
                    namespace:     res.Msg.Application.Namespace,
                    timeout:       time.Duration(timeout) * time.Second,
                    start:         time.Now(),
                    policyResults: res.Msg.PolicyResults,
                }).Run()
                if err != nil {
                    return err
                }
                m := finalModel.(applyModel)
                if m.err != nil {
                    return m.err
                }
                if isFailurePhase(m.phase) {
                    return fmt.Errorf("rollout %s", m.phase)
                }
                return nil
            }
            return watchPlain(cmd.OutOrStdout(), client, res.Msg.Application.Name, res.Msg.Application.Namespace, timeout)
        },
    }
    cmd.Flags().StringArrayVarP(&files, "file", "f", nil, "Manifest file, directory, or archive")
    _ = cmd.MarkFlagRequired("file")
    cmd.Flags().StringVar(&appName, "name", "", "Application name")
    cmd.Flags().StringArrayVar(&skipPolicies, "skip-policy", nil, "Skip a policy")
    cmd.Flags().StringArrayVar(&policyOverrides, "policy-override", nil, "Override policy action")
    cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Render and evaluate policies without applying")
    cmd.Flags().BoolVar(&wait, "wait", true, "Wait for rollout to complete")
    cmd.Flags().IntVar(&timeout, "timeout", 300, "Watch timeout")
    return cmd
}

func parsePolicyOverrides(in []string) (map[string]string, error) {
    out := make(map[string]string, len(in))
    for _, s := range in {
        parts := strings.SplitN(s, "=", 2)
        if len(parts) != 2 {
            return nil, fmt.Errorf("invalid policy override %q (expected name=action)", s)
        }
        if parts[1] != "enforce" && parts[1] != "warn" {
            return nil, fmt.Errorf("invalid action %q (expected enforce or warn)", parts[1])
        }
        out[parts[0]] = parts[1]
    }
    return out, nil
}

func printPolicyResults(w io.Writer, results []*paprikav1.PolicyResult) {
    for _, r := range results {
        status := "passed"
        if !r.Passed {
            status = "failed"
        }
        fmt.Fprintf(w, "[%s/%s] %s: %s\n", r.Severity, r.Action, r.Name, status)
        if r.Message != "" {
            fmt.Fprintf(w, "  %s\n", r.Message)
        }
    }
}

func isFailurePhase(phase string) bool {
    switch phase {
    case "Failed", "Degraded", "RolledBack":
        return true
    }
    return false
}

func watchPlain(w io.Writer, client v1connect.PaprikaServiceClient, name, namespace string, timeoutSec int) error {
    ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutSec)*time.Second)
    defer cancel()
    ticker := time.NewTicker(2 * time.Second)
    defer ticker.Stop()
    var lastPhase string
    for {
        res, err := client.GetApplication(ctx, connect.NewRequest(&paprikav1.GetApplicationRequest{
            Name: name, Namespace: namespace,
        }))
        if err != nil {
            return err
        }
        app := res.Msg.Application
        lastPhase = app.Phase
        fmt.Fprintf(w, "[%s] phase: %s health: %s\n", time.Now().Format(time.RFC3339), app.Phase, app.Health)
        if terminalPhase(app.Phase) {
            if isFailurePhase(app.Phase) {
                return fmt.Errorf("rollout %s", app.Phase)
            }
            return nil
        }
        select {
        case <-ctx.Done():
            return fmt.Errorf("watch timed out (last phase: %s)", lastPhase)
        case <-ticker.C:
        }
    }
}
```

- [ ] **Step 4: Register command in `main.go`**

Modify `cmd/paprika-cli/main.go`:

```go
root.AddCommand(newApplyCmd(clientFn, nsFn, &globalOutput))
```

- [ ] **Step 5: Add dependency**

```bash
go get github.com/mattn/go-isatty
go get github.com/charmbracelet/bubbletea
```

- [ ] **Step 6: Build CLI**

```bash
make build-cli
```

Expected: `bin/paprika` builds successfully.

- [ ] **Step 7: Commit**

```bash
git add cmd/paprika-cli/apply.go cmd/paprika-cli/apply_tui.go cmd/paprika-cli/main.go go.mod go.sum
git commit -m "feat(cli): add paprika apply command with TUI"
```

---

## Chunk 6: UI, RBAC manifests, and final integration

### Task 6.1: Regenerate RBAC and install manifests

**Files:**
- Modify: `config/rbac/role.yaml` (via `make manifests`)
- Modify: `dist/install.yaml` (via `make build-installer`)

- [ ] **Step 1: Regenerate RBAC**

```bash
make manifests
```

Expected: `config/rbac/role.yaml` includes new Policy and ConfigMap permissions.

- [ ] **Step 2: Build installer**

```bash
make build-installer IMG=ghcr.io/benebsworth/paprika:latest
```

Expected: `dist/install.yaml` updated.

- [ ] **Step 3: Commit**

```bash
git add config/rbac/role.yaml dist/install.yaml
git commit -m "chore(manifests): regenerate RBAC for apply and policies"
```

### Task 6.2: Dashboard updates

**Files:**
- Modify: `ui/src/app/dashboard/page.tsx`
- Modify: `ui/src/components/dashboard/application-card.tsx`
- Create: `ui/src/app/dashboard/applications/[name]/page.tsx`

- [ ] **Step 1: Extend ApplicationCard to show policy results**

Modify `ui/src/components/dashboard/application-card.tsx` to display:
- Current Release name
- Number of policy warnings
- Rollout phase

- [x] **Step 2: Add Application detail page**

Created `ui/src/app/dashboard/application/page.tsx` (query-param route for static export) showing:
- Release history list
- Managed resources table
- Policy results
- Rollback button (Phase 3)

- [ ] **Step 3: Add UI generate script and regenerate protobuf client**

Ensure `ui/package.json` has a `generate` script that runs from the project root so it finds `buf.gen.yaml`:

```json
"scripts": {
  "generate": "cd .. && buf generate"
}
```

Also ensure the UI protoc plugins are installed:

```bash
cd ui && npm install -D @bufbuild/protoc-gen-es @connectrpc/protoc-gen-connect-es
```

Then run:

```bash
cd ui && npm run generate
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/
git commit -m "feat(ui): show apply policy results and release history"
```

### Task 6.3: Integration and E2E tests

**Files:**
- Create: `test/e2e/apply_test.go`
- Modify: `internal/api/server_test.go` if exists

- [x] **Step 1: Add E2E test**

Create `test/e2e/apply_test.go`:

```go
package e2e

import (
    "context"
    "testing"

    "github.com/stretchr/testify/require"
)

func TestApplyRawYAML(t *testing.T) {
    // Setup kind cluster, deploy operator
    // Run paprika apply -f testdata/deployment.yaml --name e2e-apply
    // Assert Application/Release created, Deployment healthy
}
```

- [ ] **Step 2: Run E2E**

```bash
make test-e2e
```

Expected: PASS (may take several minutes).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/
git commit -m "test(e2e): add apply -f end-to-end test"
```

### Task 6.4: Final integration check

- [x] **Step 1: Run full test suite**

```bash
make test
make lint
make build-cli
```

Expected: all pass.

- [x] **Step 2: Update CLI documentation**

Update `docs/cli.md` with `paprika apply` reference:
- Usage examples for raw YAML, directories, dry-run, and policy overrides.
- Explanation of `--wait`, `--timeout`, and TUI behavior.

- [x] **Step 3: Update API documentation**

Update `docs/api.md` with the new `ApplyBundle` RPC:
- Request/response message reference.
- Behavior for blocked, dry-run, and idempotent applies.
- Policy result semantics.

- [ ] **Step 4: Final commit**

```bash
git add docs/cli.md docs/api.md
git commit -m "docs(cli,api): document paprika apply and ApplyBundle RPC"
```

### Task 6.5: Add protobuf generation to Makefile

**Files:**
- Modify: `Makefile`

- [ ] **Step 1: Add `buf` and protoc plugin tool definitions**

Add the tool definitions near the other tool definitions in `Makefile` (e.g., next to `CONTROLLER_GEN`):

```makefile
BUF ?= $(LOCALBIN)/buf
PROTOC_GEN_GO ?= $(LOCALBIN)/protoc-gen-go
PROTOC_GEN_CONNECT_GO ?= $(LOCALBIN)/protoc-gen-connect-go

.PHONY: buf
buf: $(BUF) ## Download buf locally if necessary.
$(BUF): $(LOCALBIN)
	$(call go-install-tool,$(BUF),github.com/bufbuild/buf/cmd/buf,v1.50.0)

.PHONY: protoc-gen-go
protoc-gen-go: $(PROTOC_GEN_GO) ## Download protoc-gen-go locally if necessary.
$(PROTOC_GEN_GO): $(LOCALBIN)
	$(call go-install-tool,$(PROTOC_GEN_GO),google.golang.org/protobuf/cmd/protoc-gen-go,v1.36.0)

.PHONY: protoc-gen-connect-go
protoc-gen-connect-go: $(PROTOC_GEN_CONNECT_GO) ## Download protoc-gen-connect-go locally if necessary.
$(PROTOC_GEN_CONNECT_GO): $(LOCALBIN)
	$(call go-install-tool,$(PROTOC_GEN_CONNECT_GO),connectrpc.com/connect/cmd/protoc-gen-connect-go,v1.18.0)
```

> **Note:** For the UI, ensure `protoc-gen-es` and `protoc-gen-connect-es` are installed via `npm install -D @bufbuild/protoc-gen-es @connectrpc/protoc-gen-connect-es` and available on `PATH`, or use `npx` in `ui/package.json`.

Add the `generate-proto` target near `generate`:

```makefile
.PHONY: generate-proto
generate-proto: buf protoc-gen-go protoc-gen-connect-go ## Generate Connect-RPC Go code from protobuf definitions.
	PATH="$(LOCALBIN):$$PATH" $(BUF) generate
```

- [ ] **Step 2: Wire proto generation into `generate`**

Update the `generate` target to depend on `generate-proto`:

```makefile
.PHONY: generate
generate: generate-proto controller-gen ## Generate code containing DeepCopy, DeepCopyInto, and DeepCopyObject method implementations.
	"$(CONTROLLER_GEN)" object:headerFile="hack/boilerplate.go.txt",year=$(YEAR) paths="./..."
```

- [ ] **Step 3: Commit**

```bash
git add Makefile
git commit -m "build(make): add generate-proto target"
```

### Task 6.6: Fix PROJECT file drift

**Files:**
- Modify: `PROJECT`

- [x] **Step 1: Correct Application path**

Open `PROJECT` and ensure the `Application` resource entry uses:

```yaml
path: github.com/benebsworth/paprika/api/pipelines/v1alpha1
```

(not `api/v1alpha1`).

- [ ] **Step 2: Commit**

```bash
git add PROJECT
git commit -m "chore(project): fix Application API path"
```

### Task 6.7: Package Policy CRD

**Files:**
- Modify: `config/crd/kustomization.yaml`
- Modify: `charts/chart/templates/` if generated CRDs are packaged there

- [x] **Step 1: Add Policy CRD to kustomization**

After `make manifests`, add `policy.paprika.io_policies.yaml` to `config/crd/kustomization.yaml` under `resources:`.

- [ ] **Step 2: Verify Helm chart packaging**

If `charts/chart/templates/` does not include the new Policy CRD, copy or regenerate the Helm chart after CRD generation.

- [ ] **Step 3: Commit**

```bash
git add config/crd/kustomization.yaml charts/
git commit -m "chore(manifests): package Policy CRD with kustomize and helm"
```

---

## Chunk 7: Validation webhooks

### Task 7.1: Add Application source validation webhook

**Files:**
- Modify: `internal/webhook/pipelines/v1alpha1/application_webhook.go`
- Modify: `internal/api/server.go` if necessary

- [x] **Step 1: Validate inline source consistency**

Modify `validateSource` in `internal/webhook/pipelines/v1alpha1/application_webhook.go`:

```go
func (v *ApplicationCustomValidator) validateSource(app *pipelinesv1alpha1.Application) field.ErrorList {
    var allErrs field.ErrorList
    sourcePath := field.NewPath("spec").Child("source")

    if app.Spec.Source.Type == "" {
        allErrs = append(allErrs, field.Required(sourcePath.Child("type"), "Source type is required"))
        return allErrs
    }

    switch app.Spec.Source.Type {
    case pipelinesv1alpha1.SourceTypeInline:
        if app.Spec.Source.Inline == nil || app.Spec.Source.Inline.ConfigMapRef == "" {
            allErrs = append(allErrs, field.Required(sourcePath.Child("inline").Child("configMapRef"), "configMapRef is required for inline source"))
        }
    case pipelinesv1alpha1.SourceTypeGit:
        if app.Spec.Source.RepoURL == "" {
            allErrs = append(allErrs, field.Required(sourcePath.Child("repoUrl"), "Repo URL is required for git sources"))
        }
    case pipelinesv1alpha1.SourceTypeOCI:
        if app.Spec.Source.Image == "" {
            allErrs = append(allErrs, field.Required(sourcePath.Child("image"), "Image is required for oci sources"))
        }
    }
    return allErrs
}
```

- [x] **Step 2: Skip repo authorization for inline sources**

Update `validateApplication`:

```go
func (v *ApplicationCustomValidator) validateApplication(ctx context.Context, app *pipelinesv1alpha1.Application) error {
    allErrs := v.validateSource(app)

    if len(app.Spec.Stages) == 0 {
        allErrs = append(allErrs, field.Required(field.NewPath("spec").Child("stages"), "At least one stage is required"))
    }

    if app.Spec.Project != "" && v.enforcer != nil && app.Spec.Source.Type != pipelinesv1alpha1.SourceTypeInline {
        if err := v.enforcer.AuthorizeApplication(ctx, app.Namespace, app.Spec.Project, app.Spec.Source.RepoURL, app.Spec.Source.RepoRef, ""); err != nil {
            allErrs = append(allErrs, field.Forbidden(field.NewPath("spec").Child("project"), err.Error()))
        }
        stageErrs := v.enforcer.AuthorizeDestinations(ctx, app.Namespace, app.Spec.Project, app.Spec.Stages)
        allErrs = append(allErrs, stageErrs...)
    }

    if len(allErrs) == 0 {
        return nil
    }
    return apierrors.NewInvalid(
        schema.GroupKind{Group: "pipelines.paprika.io", Kind: "Application"},
        app.Name,
        allErrs,
    )
}
```

- [x] **Step 3: Add webhook tests**

Add table-driven tests in `internal/webhook/pipelines/v1alpha1/application_webhook_test.go`:
- Inline source without `configMapRef` is rejected.
- Inline source with `configMapRef` is accepted.
- Inline source with a project does not require repo authorization.

- [ ] **Step 4: Run webhook tests**

```bash
go test ./internal/webhook/... -v
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/webhook/
git commit -m "feat(webhook): validate Application inline source"
```

---

## Execution Notes

- Follow TDD: write a failing test before each production change.
- Keep commits small and focused (one concern per commit).
- Run `make lint` and `make test` before each commit.
- If a task grows beyond 2-5 minutes, split it into smaller steps.
- Coordinate with @superpowers:subagent-driven-development for parallel execution of independent chunks.
