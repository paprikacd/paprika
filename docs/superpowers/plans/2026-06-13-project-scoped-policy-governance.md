# Project-Scoped Policy & Multi-Tenancy Governance Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a shared `internal/governance` package, enforce `AppProject` boundaries and `Policy` rules in webhooks/controllers/API, and scope API authorization by project.

**Architecture:** Centralize all governance logic in `internal/governance`. Webhooks and the Application controller use it for lightweight structural checks; the Release controller uses it for full manifest-boundary + policy evaluation before apply. API authorization extends the existing `internal/api/auth` stack with `ProjectAuthorizer` and `RBACRule.Projects`. A permissive `default` `AppProject` is bootstrapped in the operator namespace on startup for migration.

**Tech Stack:** Go, Kubebuilder/controller-runtime, CEL, protocol buffers (buf), Ginkgo/Gomega, testify, envtest, Kind.

---

## File Structure

### New files

- `internal/governance/violation.go` — `Violation` type and helpers.
- `internal/governance/resolver.go` — `ProjectResolver`.
- `internal/governance/cluster_resolver.go` — `ClusterResolver`.
- `internal/governance/validator.go` — `ProjectValidator`.
- `internal/governance/policy_evaluator.go` — `PolicyEvaluator`.
- `internal/governance/resolver_test.go`
- `internal/governance/validator_test.go`
- `internal/governance/policy_evaluator_test.go`
- `internal/api/auth/project_authorizer.go` — `ProjectAuthorizer`.
- `internal/api/auth/project_authorizer_test.go`
- `internal/controller/bootstrap/default_project.go`
- `test/e2e/governance_test.go`

### Modified files

- `api/policy/v1alpha1/policy_types.go`
- `api/pipelines/v1alpha1/application_types.go`
- `config/crd/bases/*.yaml`
- `api/*/zz_generated.deepcopy.go`
- `proto/paprika/v1/api.proto`
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`
- `internal/webhook/pipelines/v1alpha1/application_webhook.go`
- `internal/webhook/core/v1alpha1/appproject_webhook.go`
- `internal/webhook/policy/v1alpha1/policy_webhook.go`
- `internal/webhook/pipelines/v1alpha1/webhook_suite_test.go`
- `internal/controller/pipelines/application_controller.go`
- `internal/controller/pipelines/release_controller.go`
- `internal/api/apply_bundle.go`
- `internal/api/auth/authz.go`
- `internal/api/auth/middleware.go`
- `internal/api/auth/auth_test.go`
- `internal/api/server.go`
- `cmd/main.go`
- `cmd/cloud-run/main.go`

---

## Chunk 1: `internal/governance` package

### Task 1.1: Create `internal/governance/violation.go`

**Files:**
- Create: `internal/governance/violation.go`

- [ ] **Step 1: Write the file**

```go
package governance

import policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"

type PolicyAction string

const (
    PolicyActionEnforce PolicyAction = string(policyv1alpha1.PolicyActionEnforce)
    PolicyActionWarn    PolicyAction = string(policyv1alpha1.PolicyActionWarn)
)

type Violation struct {
    Rule     string
    Severity string
    Message  string
    Action   PolicyAction
}

func (v Violation) Blocking() bool {
    return v.Action == PolicyActionEnforce
}

type Violations []Violation

func (vs Violations) Blocking() Violations {
    var out Violations
    for _, v := range vs {
        if v.Blocking() {
            out = append(out, v)
        }
    }
    return out
}

func (vs Violations) Warnings() Violations {
    var out Violations
    for _, v := range vs {
        if !v.Blocking() {
            out = append(out, v)
        }
    }
    return out
}
```

- [ ] **Step 2: Build**

Run: `go build ./internal/governance/...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add internal/governance/violation.go
git commit -m "feat(governance): add Violation type"
```

### Task 1.2: Create `internal/governance/resolver.go`

**Files:**
- Create: `internal/governance/resolver.go`
- Test: `internal/governance/resolver_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/governance/resolver_test.go`:

```go
package governance

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    corev1 "k8s.io/api/core/v1"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/runtime"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func TestProjectResolver_ResolveApplication(t *testing.T) {
    scheme := runtime.NewScheme()
    require.NoError(t, corev1alpha1.AddToScheme(scheme))
    require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
    require.NoError(t, corev1.AddToScheme(scheme))

    project := &corev1alpha1.AppProject{
        ObjectMeta: metav1.ObjectMeta{Name: "payments", Namespace: "default"},
    }
    app := &pipelinesv1alpha1.Application{
        ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
        Spec: pipelinesv1alpha1.ApplicationSpec{
            Project: "payments",
            Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://example.com"},
            Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(project, app).Build()
    r := NewProjectResolver(c)

    got, err := r.Resolve(context.Background(), app)
    require.NoError(t, err)
    assert.Equal(t, "payments", got.Name)
    assert.Equal(t, "default", got.Namespace)
}

func TestProjectResolver_MissingProject(t *testing.T) {
    scheme := runtime.NewScheme()
    require.NoError(t, corev1alpha1.AddToScheme(scheme))
    require.NoError(t, pipelinesv1alpha1.AddToScheme(scheme))
    require.NoError(t, corev1.AddToScheme(scheme))

    app := &pipelinesv1alpha1.Application{
        ObjectMeta: metav1.ObjectMeta{Name: "app", Namespace: "default"},
        Spec: pipelinesv1alpha1.ApplicationSpec{
            Project: "missing",
            Source:  pipelinesv1alpha1.ApplicationSource{Type: pipelinesv1alpha1.SourceTypeGit, RepoURL: "https://example.com"},
            Stages:  []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(app).Build()
    r := NewProjectResolver(c)

    _, err := r.Resolve(context.Background(), app)
    require.Error(t, err)
}
```

- [ ] **Step 2: Run the failing test**

Run: `go test ./internal/governance/... -run TestProjectResolver -v`
Expected: FAIL (undefined NewProjectResolver)

- [ ] **Step 3: Implement `resolver.go`**

```go
package governance

import (
    "context"
    "fmt"

    corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

type ProjectResolver struct {
    client client.Reader
}

func NewProjectResolver(c client.Reader) *ProjectResolver {
    return &ProjectResolver{client: c}
}

func (r *ProjectResolver) Resolve(ctx context.Context, obj client.Object) (*corev1alpha1.AppProject, error) {
    switch t := obj.(type) {
    case *pipelinesv1alpha1.Application:
        return r.resolveByName(ctx, t.Namespace, t.Spec.Project)
    case *pipelinesv1alpha1.Template:
        app, err := r.resolveOwnerApplication(ctx, t.Namespace, t.OwnerReferences)
        if err != nil {
            return nil, err
        }
        return r.resolveByName(ctx, app.Namespace, app.Spec.Project)
    case *pipelinesv1alpha1.Stage:
        app, err := r.resolveOwnerApplication(ctx, t.Namespace, t.OwnerReferences)
        if err != nil {
            return nil, err
        }
        return r.resolveByName(ctx, app.Namespace, app.Spec.Project)
    default:
        return nil, fmt.Errorf("unsupported object type %T", obj)
    }
}

func (r *ProjectResolver) resolveOwnerApplication(ctx context.Context, namespace string, owners []metav1.OwnerReference) (*pipelinesv1alpha1.Application, error) {
    for _, ref := range owners {
        if ref.Kind == "Application" && ref.APIVersion == pipelinesv1alpha1.GroupVersion.String() {
            var app pipelinesv1alpha1.Application
            if err := r.client.Get(ctx, client.ObjectKey{Name: ref.Name, Namespace: namespace}, &app); err != nil {
                return nil, err
            }
            return &app, nil
        }
    }
    return nil, fmt.Errorf("no Application owner reference found")
}

func (r *ProjectResolver) resolveByName(ctx context.Context, namespace, name string) (*corev1alpha1.AppProject, error) {
    if name == "" {
        name = "default"
    }
    var project corev1alpha1.AppProject
    if err := r.client.Get(ctx, client.ObjectKey{Name: name, Namespace: namespace}, &project); err != nil {
        if apierrors.IsNotFound(err) && name == "default" {
            return permissiveDefaultProject(namespace), nil
        }
        return nil, fmt.Errorf("get appproject %s/%s: %w", namespace, name, err)
    }
    return &project, nil
}

func permissiveDefaultProject(namespace string) *corev1alpha1.AppProject {
    return &corev1alpha1.AppProject{
        ObjectMeta: metav1.ObjectMeta{Name: "default", Namespace: namespace},
        Spec: corev1alpha1.AppProjectSpec{
            Description: "Auto-generated permissive default project",
            Destinations: []corev1alpha1.AppProjectDestination{
                {Server: "*", Namespace: "*"},
            },
            SourceRepos: []string{"*"},
            Kinds: []string{"*"},
            ClusterResourceWhitelist: []string{"*"},
        },
    }
}
```

- [ ] **Step 4: Run the test**

Run: `go test ./internal/governance/... -run TestProjectResolver -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/governance/resolver.go internal/governance/resolver_test.go
git commit -m "feat(governance): add ProjectResolver"
```

### Task 1.3: Create `internal/governance/cluster_resolver.go`

**Files:**
- Create: `internal/governance/cluster_resolver.go`

- [ ] **Step 1: Write the file**

```go
package governance

import (
    "context"
    "fmt"

    clustersv1alpha1 "github.com/benebsworth/paprika/api/clusters/v1alpha1"
    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

type ClusterResolver interface {
    ResolveServer(ctx context.Context, defaultNs string, ref pipelinesv1alpha1.ClusterRef) (string, error)
}

func NewClusterResolver(c client.Reader) ClusterResolver {
    return &clusterResolver{client: c}
}

type clusterResolver struct {
    client client.Reader
}

func (r *clusterResolver) ResolveServer(ctx context.Context, defaultNs string, ref pipelinesv1alpha1.ClusterRef) (string, error) {
    if ref.Server != "" {
        return ref.Server, nil
    }
    if ref.Name == "" {
        return "https://kubernetes.default.svc", nil
    }
    ns := ref.Namespace
    if ns == "" {
        ns = defaultNs
    }
    var cluster clustersv1alpha1.Cluster
    if err := r.client.Get(ctx, client.ObjectKey{Name: ref.Name, Namespace: ns}, &cluster); err != nil {
        return "", fmt.Errorf("get cluster %s/%s: %w", ns, ref.Name, err)
    }
    if cluster.Spec.Server != "" {
        return cluster.Spec.Server, nil
    }
    return "https://kubernetes.default.svc", nil
}
```

- [ ] **Step 2: Build**

Run: `go build ./internal/governance/...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add internal/governance/cluster_resolver.go
git commit -m "feat(governance): add ClusterResolver interface"
```

### Task 1.4: Move shared matching helpers from `auth` to `governance`

**Files:**
- Create: `internal/governance/match.go`
- Modify: `internal/api/auth/project_enforcer.go`

- [ ] **Step 1: Write `internal/governance/match.go`**

```go
package governance

import (
    "fmt"
    "strings"
)

func StringEqual(a, b string) bool {
    return a == b
}

func CheckList(items []string, value string, match func(string, string) bool, format string, args ...any) error {
    if len(items) == 0 {
        return nil
    }
    for _, item := range items {
        if match(item, value) {
            return nil
        }
    }
    return fmt.Errorf(format, args...)
}

func CheckDenyList(items []string, value string, match func(string, string) bool, format string, args ...any) error {
    for _, item := range items {
        if match(item, value) {
            return fmt.Errorf(format, args...)
        }
    }
    return nil
}

func GlobMatch(pattern, s string) bool {
    if pattern == "" {
        return s == ""
    }
    if pattern == "*" {
        return true
    }
    parts := strings.Split(pattern, "*")
    if len(parts) == 1 {
        return pattern == s
    }
    if !strings.HasPrefix(s, parts[0]) {
        return false
    }
    s = s[len(parts[0]):]
    for i, part := range parts[1:] {
        idx := strings.Index(s, part)
        if idx == -1 {
            return false
        }
        // The final non-empty part must match the suffix exactly.
        if i == len(parts)-2 && part != "" && len(s) > idx+len(part) {
            return false
        }
        s = s[idx+len(part):]
    }
    return true
}
```

- [ ] **Step 2: Update `internal/api/auth/project_enforcer.go`**

Replace the local helpers with imports from `internal/governance`:

```go
import "github.com/benebsworth/paprika/internal/governance"
```

Then replace usages:
- `checkList(..., globMatch, ...)` → `governance.CheckList(..., governance.GlobMatch, ...)`
- `checkDenyList(..., globMatch, ...)` → `governance.CheckDenyList(..., governance.GlobMatch, ...)`
- `checkList(..., kindMatch, ...)` → `governance.CheckList(..., governance.GlobMatch, ...)`
- `checkDenyList(..., kindMatch, ...)` → `governance.CheckDenyList(..., governance.GlobMatch, ...)`
- `checkList(..., stringEqual, ...)` → `governance.CheckList(..., governance.StringEqual, ...)`
- Delete the old local `kindMatch`, `stringEqual`, `checkList`, `checkDenyList`, `globMatch` helpers.

- [ ] **Step 3: Build**

Run: `go build ./internal/governance/... ./internal/api/auth/...`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/governance/match.go internal/api/auth/project_enforcer.go
git commit -m "refactor(governance): share matching helpers between auth and governance"
```

### Task 1.5: Create `internal/governance/validator.go`

**Files:**
- Create: `internal/governance/validator.go`
- Test: `internal/governance/validator_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/governance/validator_test.go`:

```go
package governance

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

    corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
)

func makeAppProject() *corev1alpha1.AppProject {
    return &corev1alpha1.AppProject{
        Spec: corev1alpha1.AppProjectSpec{
            SourceRepos:  []string{"https://github.com/acme/*"},
            Repositories: []string{"payments-repo"},
            Destinations: []corev1alpha1.AppProjectDestination{
                {Server: "https://kubernetes.default.svc", Namespace: "payments-*"},
            },
            Kinds: []string{"Deployment", "Service"},
        },
    }
}

func TestProjectValidator_Validate_AllowsCompliant(t *testing.T) {
    v := NewProjectValidator(nil, &clusterResolver{}, nil)
    app := &pipelinesv1alpha1.Application{
        Spec: pipelinesv1alpha1.ApplicationSpec{
            Project: "payments",
            Source: pipelinesv1alpha1.ApplicationSource{
                Type:    pipelinesv1alpha1.SourceTypeGit,
                RepoURL: "https://github.com/acme/payments.git",
                RepoRef: "payments-repo",
            },
            Stages: []pipelinesv1alpha1.ApplicationPromotionStage{
                {Name: "prod", Ring: 1, Cluster: pipelinesv1alpha1.ClusterRef{Server: "https://kubernetes.default.svc"}},
            },
        },
    }
    violations, err := v.Validate(context.Background(), app, nil, makeAppProject())
    require.NoError(t, err)
    assert.Empty(t, violations)
}

func TestProjectValidator_Validate_RejectsBadKind(t *testing.T) {
    v := NewProjectValidator(nil, &clusterResolver{}, nil)
    app := &pipelinesv1alpha1.Application{
        Spec: pipelinesv1alpha1.ApplicationSpec{
            Project: "payments",
            Source: pipelinesv1alpha1.ApplicationSource{
                Type:    pipelinesv1alpha1.SourceTypeGit,
                RepoURL: "https://github.com/acme/payments.git",
            },
            Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "prod", Ring: 1}},
        },
    }
    manifests := []*unstructured.Unstructured{
        {Object: map[string]interface{}{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]interface{}{"name": "app", "namespace": "payments-prod"}}},
    }
    violations, err := v.Validate(context.Background(), app, manifests, makeAppProject())
    require.NoError(t, err)
    require.Len(t, violations, 1)
    assert.True(t, violations[0].Blocking())
}
```

- [ ] **Step 2: Run the failing test**

Run: `go test ./internal/governance/... -run TestProjectValidator -v`
Expected: FAIL (undefined NewProjectValidator)

- [ ] **Step 3: Implement `validator.go`**

```go
package governance

import (
    "context"
    "fmt"

    corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
    pipelinesv1alpha1 "github.com/benebsworth/paprika/api/pipelines/v1alpha1"
    "k8s.io/apimachinery/pkg/api/meta"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime/schema"
)

type ProjectValidator struct {
    resolver        *ProjectResolver
    clusterResolver ClusterResolver
    restMapper      meta.RESTMapper
}

func NewProjectValidator(resolver *ProjectResolver, clusterResolver ClusterResolver, restMapper meta.RESTMapper) *ProjectValidator {
    return &ProjectValidator{
        resolver:        resolver,
        clusterResolver: clusterResolver,
        restMapper:      restMapper,
    }
}

// ResolveProject looks up an AppProject by namespace and name.
func (v *ProjectValidator) ResolveProject(ctx context.Context, namespace, name string) (*corev1alpha1.AppProject, error) {
    return v.resolver.resolveByName(ctx, namespace, name)
}

func (v *ProjectValidator) Validate(ctx context.Context, app *pipelinesv1alpha1.Application, manifests []*unstructured.Unstructured, project *corev1alpha1.AppProject) (Violations, error) {
    return v.validate(ctx, project, app.Spec.Source, app.Spec.Stages, app.Namespace, "", manifests)
}

// ValidateBundle validates a bundle. defaultNs is the namespace to use when a ClusterRef has no namespace.
// server is the destination Kubernetes API server for the manifests; if empty it defaults to the in-cluster server.
func (v *ProjectValidator) ValidateBundle(ctx context.Context, project *corev1alpha1.AppProject, source pipelinesv1alpha1.ApplicationSource, stages []pipelinesv1alpha1.ApplicationPromotionStage, defaultNs, server string, manifests []*unstructured.Unstructured) (Violations, error) {
    return v.validate(ctx, project, source, stages, defaultNs, server, manifests)
}

func (v *ProjectValidator) validate(ctx context.Context, project *corev1alpha1.AppProject, source pipelinesv1alpha1.ApplicationSource, stages []pipelinesv1alpha1.ApplicationPromotionStage, defaultNs, server string, manifests []*unstructured.Unstructured) (Violations, error) {
    var violations Violations

    if source.RepoURL != "" {
        if err := CheckDenyList(project.Spec.SourceReposDeny, source.RepoURL, GlobMatch, "source repo %q denied by project %s", source.RepoURL, project.Name); err != nil {
            violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
        } else if err := CheckList(project.Spec.SourceRepos, source.RepoURL, GlobMatch, "source repo %q not allowed by project %s", source.RepoURL, project.Name); err != nil {
            violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
        }
    }
    if source.RepoRef != "" {
        if err := CheckList(project.Spec.Repositories, source.RepoRef, StringEqual, "repository %q not allowed by project %s", source.RepoRef, project.Name); err != nil {
            violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
        }
    }

    for _, stage := range stages {
        server, err := v.clusterResolver.ResolveServer(ctx, defaultNs, stage.Cluster)
        if err != nil {
            return violations, fmt.Errorf("resolve cluster for stage %q: %w", stage.Name, err)
        }
        if !destinationAllowed(project.Spec.Destinations, server, stage.Cluster.Name) {
            violations = append(violations, Violation{
                Rule:    "project",
                Message: fmt.Sprintf("stage %q cluster not allowed by project %s", stage.Name, project.Name),
                Action:  PolicyActionEnforce,
            })
        }
        if len(project.Spec.Destinations) > 0 && !namespaceAllowed(project.Spec.Destinations, server, defaultNs) {
            violations = append(violations, Violation{
                Rule:    "project",
                Message: fmt.Sprintf("stage %q namespace %q not allowed by project %s", stage.Name, defaultNs, project.Name),
                Action:  PolicyActionEnforce,
            })
        }
    }

    const defaultServer = "https://kubernetes.default.svc"
    manifestServer := server
    if manifestServer == "" {
        manifestServer = defaultServer
    }
    for _, m := range manifests {
        kind := m.GetKind()
        if kind != "" {
            if err := CheckDenyList(project.Spec.KindsDeny, kind, GlobMatch, "kind %q denied by project %s", kind, project.Name); err != nil {
                violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
            } else if err := CheckList(project.Spec.Kinds, kind, GlobMatch, "kind %q not allowed by project %s", kind, project.Name); err != nil {
                violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
            }
        }

        clusterScoped, err := v.isClusterScoped(m)
        if err != nil {
            return violations, err
        }
        if clusterScoped {
            if err := CheckDenyList(project.Spec.ClusterResourceBlacklist, kind, GlobMatch, "cluster-scoped kind %q denied by project %s", kind, project.Name); err != nil {
                violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
            } else if err := CheckList(project.Spec.ClusterResourceWhitelist, kind, GlobMatch, "cluster-scoped kind %q not allowed by project %s", kind, project.Name); err != nil {
                violations = append(violations, Violation{Rule: "project", Message: err.Error(), Action: PolicyActionEnforce})
            }
        }

        ns := m.GetNamespace()
        if ns != "" && len(project.Spec.Destinations) > 0 {
            if !namespaceAllowed(project.Spec.Destinations, manifestServer, ns) {
                violations = append(violations, Violation{
                    Rule:    "project",
                    Message: fmt.Sprintf("namespace %q not allowed by project %s", ns, project.Name),
                    Action:  PolicyActionEnforce,
                })
            }
        }
    }

    return violations, nil
}

func (v *ProjectValidator) isClusterScoped(obj *unstructured.Unstructured) (bool, error) {
    if v.restMapper == nil {
        return obj.GetNamespace() == "", nil
    }
    mapping, err := v.restMapper.RESTMapping(obj.GroupVersionKind().GroupKind())
    if err != nil {
        return obj.GetNamespace() == "", nil
    }
    return mapping.Scope.Name() == meta.RESTScopeNameRoot, nil
}

func destinationAllowed(destinations []corev1alpha1.AppProjectDestination, server, name string) bool {
    if len(destinations) == 0 {
        return true
    }
    for _, d := range destinations {
        if d.Server != "" && !GlobMatch(d.Server, server) {
            continue
        }
        if d.Name != "" && !GlobMatch(d.Name, name) {
            continue
        }
        return true
    }
    return false
}

func namespaceAllowed(destinations []corev1alpha1.AppProjectDestination, server, namespace string) bool {
    if len(destinations) == 0 {
        return true
    }
    for _, d := range destinations {
        if d.Server != "" && !GlobMatch(d.Server, server) {
            continue
        }
        if d.Namespace != "" && !GlobMatch(d.Namespace, namespace) {
            continue
        }
        return true
    }
    return false
}
```

- [ ] **Step 4: Run the test**

Run: `go test ./internal/governance/... -run TestProjectValidator -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/governance/validator.go internal/governance/validator_test.go
git commit -m "feat(governance): add ProjectValidator"
```

### Task 1.6: Create `internal/governance/policy_evaluator.go`

**Files:**
- Create: `internal/governance/policy_evaluator.go`
- Test: `internal/governance/policy_evaluator_test.go`

- [ ] **Step 1: Write the failing test**

Create `internal/governance/policy_evaluator_test.go`:

```go
package governance

import (
    "context"
    "testing"

    "github.com/stretchr/testify/assert"
    "github.com/stretchr/testify/require"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "k8s.io/apimachinery/pkg/runtime"
    "sigs.k8s.io/controller-runtime/pkg/client/fake"

    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
    "github.com/benebsworth/paprika/policy"
)

func TestPolicyEvaluator_SelectsByProject(t *testing.T) {
    scheme := runtime.NewScheme()
    require.NoError(t, policyv1alpha1.AddToScheme(scheme))

    pol := &policyv1alpha1.Policy{
        ObjectMeta: metav1.ObjectMeta{Name: "require-labels"},
        Spec: policyv1alpha1.PolicySpec{
            Severity:      policyv1alpha1.PolicySeverityCritical,
            DefaultAction: policyv1alpha1.PolicyActionEnforce,
            Projects:      []string{"payments"},
            Match: policyv1alpha1.PolicyMatch{
                Kinds: []string{"Deployment"},
            },
            Expression: `has(object.metadata.labels.app)`,
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pol).Build()
    e := NewPolicyEvaluator(c)

    manifests := []*unstructured.Unstructured{
        {Object: map[string]interface{}{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]interface{}{"name": "app", "namespace": "payments"}}},
    }
    violations, err := e.Evaluate(context.Background(), "payments", manifests, policy.EvaluateOptions{Namespace: "payments"})
    require.NoError(t, err)
    require.Len(t, violations, 1)
    assert.True(t, violations[0].Blocking())
}

func TestPolicyEvaluator_SkipsOtherProjects(t *testing.T) {
    scheme := runtime.NewScheme()
    require.NoError(t, policyv1alpha1.AddToScheme(scheme))

    pol := &policyv1alpha1.Policy{
        ObjectMeta: metav1.ObjectMeta{Name: "require-labels"},
        Spec: policyv1alpha1.PolicySpec{
            Severity:      policyv1alpha1.PolicySeverityCritical,
            DefaultAction: policyv1alpha1.PolicyActionEnforce,
            Projects:      []string{"payments"},
            Match:         policyv1alpha1.PolicyMatch{Kinds: []string{"Deployment"}},
            Expression:    `has(object.metadata.labels.app)`,
        },
    }
    c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pol).Build()
    e := NewPolicyEvaluator(c)

    manifests := []*unstructured.Unstructured{
        {Object: map[string]interface{}{"apiVersion": "apps/v1", "kind": "Deployment", "metadata": map[string]interface{}{"name": "app"}}},
    }
    violations, err := e.Evaluate(context.Background(), "other", manifests, policy.EvaluateOptions{})
    require.NoError(t, err)
    assert.Empty(t, violations)
}
```

- [ ] **Step 2: Run the failing test**

Run: `go test ./internal/governance/... -run TestPolicyEvaluator -v`
Expected: FAIL (undefined NewPolicyEvaluator)

- [ ] **Step 3: Implement `policy_evaluator.go`**

```go
package governance

// +kubebuilder:rbac:groups=policy.paprika.io,resources=policies,verbs=get;list;watch

import (
    "context"
    "fmt"

    policyv1alpha1 "github.com/benebsworth/paprika/api/policy/v1alpha1"
    "github.com/benebsworth/paprika/policy"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "sigs.k8s.io/yaml"
)

type PolicyEvaluator struct {
    client client.Reader
}

func NewPolicyEvaluator(c client.Reader) *PolicyEvaluator {
    return &PolicyEvaluator{client: c}
}

func (e *PolicyEvaluator) Evaluate(ctx context.Context, project string, manifests []*unstructured.Unstructured, opts policy.EvaluateOptions) (Violations, error) {
    var list policyv1alpha1.PolicyList
    if err := e.client.List(ctx, &list); err != nil {
        return nil, fmt.Errorf("list policies: %w", err)
    }

    var selected []policyv1alpha1.Policy
    for _, p := range list.Items {
        if policyAppliesToProject(p, project) {
            selected = append(selected, p)
        }
    }

    bundle, err := renderBundle(manifests)
    if err != nil {
        return nil, fmt.Errorf("render bundle: %w", err)
    }

    result, err := policy.NewEvaluator(selected).Evaluate(ctx, bundle, opts)
    if err != nil {
        return nil, fmt.Errorf("evaluate policies: %w", err)
    }

    var violations Violations
    for _, r := range result.Results {
        if r.Passed {
            continue
        }
        action := PolicyAction(r.Action)
        if action == "" {
            action = PolicyActionEnforce
        }
        violations = append(violations, Violation{
            Rule:     r.Name,
            Severity: r.Severity,
            Message:  r.Message,
            Action:   action,
        })
    }
    return violations, nil
}

func policyAppliesToProject(p policyv1alpha1.Policy, project string) bool {
    if len(p.Spec.Projects) == 0 {
        return true
    }
    for _, pr := range p.Spec.Projects {
        if pr == "*" || pr == project {
            return true
        }
    }
    return false
}

func renderBundle(manifests []*unstructured.Unstructured) ([]byte, error) {
    var out []byte
    for i, m := range manifests {
        if i > 0 {
            out = append(out, []byte("\n---\n")...)
        }
        b, err := yaml.Marshal(m.Object)
        if err != nil {
            return nil, err
        }
        out = append(out, b...)
    }
    return out, nil
}
```

- [ ] **Step 4: Run the test**

Run: `go test ./internal/governance/... -run TestPolicyEvaluator -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/governance/policy_evaluator.go internal/governance/policy_evaluator_test.go
git commit -m "feat(governance): add PolicyEvaluator with project selection"
```

### Task 1.7: Run the full governance package tests

- [ ] **Step 1: Run tests**

Run: `go test ./internal/governance/... -v`
Expected: all PASS

- [ ] **Step 2: Run lint**

Run: `make lint`
Expected: no issues in new files

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "chore(governance): lint fixes" || true
```

---

## Chunk 2: CRD and proto changes

### Task 2.1: Add `Projects` to `Policy` types

**Files:**
- Modify: `api/policy/v1alpha1/policy_types.go`

- [ ] **Step 1: Edit the file**

Add `Projects` to `PolicySpec` after `Expression`:

```go
    // Projects restricts this policy to named AppProjects. Empty means all projects.
    // The value "*" means all projects.
    // +optional
    Projects []string `json:"projects,omitempty"`
```

- [ ] **Step 2: Build**

Run: `go build ./api/policy/...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add api/policy/v1alpha1/policy_types.go
git commit -m "feat(policy): add projects field to Policy"
```

### Task 2.2: Add default to `Application` project field

**Files:**
- Modify: `api/pipelines/v1alpha1/application_types.go`

- [ ] **Step 1: Edit the file**

Change:

```go
    // Project references the AppProject that governs this application.
    // +optional
    Project string `json:"project,omitempty"`
```

To:

```go
    // Project references the AppProject that governs this application.
    // +optional
    // +kubebuilder:default="default"
    Project string `json:"project,omitempty"`
```

- [ ] **Step 2: Build**

Run: `go build ./api/pipelines/...`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add api/pipelines/v1alpha1/application_types.go
git commit -m "feat(application): default spec.project to default"
```

### Task 2.3: Regenerate CRDs and DeepCopy

- [ ] **Step 1: Run manifests and generate**

Run: `make manifests generate`
Expected: success.

- [ ] **Step 2: Verify diff**

Run: `git diff --stat config/crd/bases api/*/zz_generated.deepcopy.go`
Expected: only expected generated changes.

- [ ] **Step 3: Commit**

```bash
git add config/crd/bases api/*/zz_generated.deepcopy.go
git commit -m "chore(manifests): regenerate CRDs and deepcopy for governance"
```

### Task 2.4: Add `project` to proto request messages

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1: Edit the file**

Add `string project = N;` to:
- `ApplyBundleRequest` (field 7)
- `Application` message (field 24; next available after `repeated GateStatus gates = 23;`)
- `ListApplicationsRequest` (field 2)
- `ListReleasesRequest` (field 2)
- `ListStagesRequest` (field 2)
- `ListPipelinesRequest` (field 2)

- [ ] **Step 2: Regenerate stubs**

Run: `buf generate`
Expected: generated files updated.

- [ ] **Step 3: Build**

Run: `go build ./internal/api/...`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add proto/paprika/v1/api.proto internal/api/paprika/v1 ui/src/gen/paprika/v1
git commit -m "feat(proto): add project field to bundle and list requests"
```

---

## Chunk 3: Webhooks

### Task 3.1: Application defaulting webhook

**Files:**
- Modify: `internal/webhook/pipelines/v1alpha1/application_webhook.go`

- [ ] **Step 1: Edit the defaulter**

Replace the no-op `Default` method with:

```go
func (d *ApplicationCustomDefaulter) Default(_ context.Context, obj *pipelinesv1alpha1.Application) error {
    applicationlog.Info("Defaulting for Application", "name", obj.GetName())
    if obj.Spec.Project == "" {
        obj.Spec.Project = "default"
    }
    return nil
}
```

- [ ] **Step 2: Add a test**

In `internal/webhook/pipelines/v1alpha1/application_webhook_test.go`, add:

```go
func TestApplicationCustomDefaulter_DefaultsProject(t *testing.T) {
    d := &ApplicationCustomDefaulter{}
    app := &pipelinesv1alpha1.Application{ObjectMeta: metav1.ObjectMeta{Name: "app"}}
    require.NoError(t, d.Default(context.Background(), app))
    assert.Equal(t, "default", app.Spec.Project)
}
```

- [ ] **Step 3: Run tests**

Run: `go test ./internal/webhook/pipelines/v1alpha1/... -run TestApplicationCustomDefaulter -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/webhook/pipelines/v1alpha1/application_webhook.go internal/webhook/pipelines/v1alpha1/application_webhook_test.go
git commit -m "feat(webhook): default Application spec.project"
```

### Task 3.2: Application validating webhook uses governance

**Files:**
- Modify: `internal/webhook/pipelines/v1alpha1/application_webhook.go`

- [ ] **Step 1: Inject governance validator**

Update `SetupApplicationWebhookWithManager`:

```go
func SetupApplicationWebhookWithManager(mgr ctrl.Manager) error {
    resolver := governance.NewProjectResolver(mgr.GetClient())
    validator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(mgr.GetClient()), mgr.GetRESTMapper())
    if err := ctrl.NewWebhookManagedBy(mgr, &pipelinesv1alpha1.Application{}).
        WithValidator(&ApplicationCustomValidator{validator: validator}).
        WithDefaulter(&ApplicationCustomDefaulter{}).
        Complete(); err != nil {
        return fmt.Errorf("setting up application webhook: %w", err)
    }
    return nil
}
```

Add import:

```go
"github.com/benebsworth/paprika/internal/governance"
```

Remove the `internal/api/auth` import if `ProjectEnforcer` was the only use.

- [ ] **Step 2: Update validateApplication**

After structural checks, add:

```go
    if app.Spec.Project == "" {
        allErrs = append(allErrs, field.Required(field.NewPath("spec").Child("project"), "project is required"))
    } else {
        project, err := v.validator.ResolveProject(ctx, app.Namespace, app.Spec.Project)
        if err != nil {
            allErrs = append(allErrs, field.Forbidden(field.NewPath("spec").Child("project"), err.Error()))
        } else if violations, err := v.validator.Validate(ctx, app, nil, project); err != nil {
            allErrs = append(allErrs, field.InternalError(field.NewPath("spec").Child("project"), err))
        } else if blocking := violations.Blocking(); len(blocking) > 0 {
            allErrs = append(allErrs, field.Forbidden(field.NewPath("spec").Child("project"), blocking[0].Message))
        }
    }
```

- [ ] **Step 3: Update existing webhook test**

In `internal/webhook/pipelines/v1alpha1/application_webhook_test.go`, remove the `internal/api/auth` import, add `github.com/benebsworth/paprika/internal/governance`, and update the constructor call from `{enforcer: auth.NewProjectEnforcer(c)}` to `{validator: governance.NewProjectValidator(...)}` or remove it if the test only checks structural validation.

- [ ] **Step 4: Update webhook suite registration**

In `internal/webhook/pipelines/v1alpha1/webhook_suite_test.go`, ensure `SetupApplicationWebhookWithManager(mgr)` is called inside `BeforeSuite`.

- [ ] **Step 5: Remove obsolete ProjectEnforcer**

Once the webhook no longer references `internal/api/auth/project_enforcer.go`, delete `internal/api/auth/project_enforcer.go` and any dedicated tests for it.

- [ ] **Step 6: Run webhook tests**

Run: `go test ./internal/webhook/pipelines/v1alpha1/... ./internal/api/auth/... -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add internal/webhook/pipelines/v1alpha1/application_webhook.go internal/webhook/pipelines/v1alpha1/webhook_suite_test.go internal/api/auth/project_enforcer.go
git commit -m "feat(webhook): switch Application validation to governance.ProjectValidator"
```

### Task 3.3: AppProject webhook destination and kind validation

**Files:**
- Modify: `internal/webhook/core/v1alpha1/appproject_webhook.go`

- [ ] **Step 1: Extend validateAppProject**

Add after overlap checks:

```go
    for i, d := range project.Spec.Destinations {
        if d.Server == "" && d.Namespace == "" && d.Name == "" {
            allErrs = append(allErrs, field.Required(specPath.Child("destinations").Index(i), "at least one of server, namespace, or name is required"))
        }
    }
    for i, k := range project.Spec.Kinds {
        if k == "" {
            allErrs = append(allErrs, field.Required(specPath.Child("kinds").Index(i), "kind must not be empty"))
        }
    }
    for i, k := range project.Spec.ClusterResourceWhitelist {
        if k == "" {
            allErrs = append(allErrs, field.Required(specPath.Child("clusterResourceWhitelist").Index(i), "kind must not be empty"))
        }
    }
    for i, k := range project.Spec.ClusterResourceBlacklist {
        if k == "" {
            allErrs = append(allErrs, field.Required(specPath.Child("clusterResourceBlacklist").Index(i), "kind must not be empty"))
        }
    }
```

- [ ] **Step 2: Add a test**

In `internal/webhook/core/v1alpha1/appproject_webhook_test.go`:

```go
func TestAppProjectValidator_RejectsEmptyDestination(t *testing.T) {
    v := &AppProjectCustomValidator{}
    project := &corev1alpha1.AppProject{
        ObjectMeta: metav1.ObjectMeta{Name: "bad"},
        Spec: corev1alpha1.AppProjectSpec{
            Destinations: []corev1alpha1.AppProjectDestination{{}},
        },
    }
    err := v.ValidateCreate(context.Background(), project)
    require.Error(t, err)
}
```

- [ ] **Step 3: Run tests**

Run: `go test ./internal/webhook/core/v1alpha1/... -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/webhook/core/v1alpha1/appproject_webhook.go internal/webhook/core/v1alpha1/appproject_webhook_test.go
git commit -m "feat(webhook): validate AppProject destinations and kinds"
```

### Task 3.4: Policy webhook projects validation

**Files:**
- Modify: `internal/webhook/policy/v1alpha1/policy_webhook.go`

- [ ] **Step 1: Extend validatePolicy**

Add before the final aggregate:

```go
    seen := map[string]bool{}
    for i, pr := range p.Spec.Projects {
        if pr == "" {
            allErrs = append(allErrs, field.Required(path.Child("projects").Index(i), "project must not be empty"))
            continue
        }
        // "*" is accepted per the design spec and matches all projects.
        if seen[pr] {
            allErrs = append(allErrs, field.Duplicate(path.Child("projects").Index(i), pr))
            continue
        }
        seen[pr] = true
    }
```

- [ ] **Step 2: Add a test**

In `internal/webhook/policy/v1alpha1/policy_webhook_test.go`:

```go
func TestPolicyValidator_RejectsDuplicateProjects(t *testing.T) {
    v := &PolicyCustomValidator{}
    p := &policyv1alpha1.Policy{
        ObjectMeta: metav1.ObjectMeta{Name: "bad"},
        Spec: policyv1alpha1.PolicySpec{
            Severity:      policyv1alpha1.PolicySeverityCritical,
            DefaultAction: policyv1alpha1.PolicyActionEnforce,
            Expression:    "true",
            Projects:      []string{"payments", "payments"},
        },
    }
    err := v.ValidateCreate(context.Background(), p)
    require.Error(t, err)
}
```

- [ ] **Step 3: Run tests**

Run: `go test ./internal/webhook/policy/v1alpha1/... -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/webhook/policy/v1alpha1/policy_webhook.go internal/webhook/policy/v1alpha1/policy_webhook_test.go
git commit -m "feat(webhook): validate Policy projects field"
```

---

## Chunk 4: Controllers

### Task 4.1: Application controller lightweight governance gate

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go`

- [ ] **Step 1: Add fields**

Add to `ApplicationReconciler` struct:

```go
    EventRecorder    record.EventRecorder
    ProjectValidator *governance.ProjectValidator
```

Add imports:

```go
    corev1 "k8s.io/api/core/v1"
    "k8s.io/apimachinery/pkg/api/meta"
    "k8s.io/client-go/tools/record"
    "github.com/benebsworth/paprika/internal/governance"
```

- [ ] **Step 2: Normalize project at start of reconcileApp**

Insert at the top of `reconcileApp`:

```go
    if app.Spec.Project == "" {
        app.Spec.Project = "default"
    }
```

- [ ] **Step 3: Lightweight validation after stages**

After `reconcileStages` succeeds and before `reconcileReleaseFlow`, insert:

```go
    project, err := r.ProjectValidator.ResolveProject(ctx, app.Namespace, app.Spec.Project)
    if err != nil {
        log.Error(err, "Failed to resolve AppProject")
        r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "ProjectResolutionFailed", err.Error())
        return ctrl.Result{}, err
    }

    if violations, err := r.ProjectValidator.Validate(ctx, app, nil, project); err != nil {
        log.Error(err, "Failed to validate project boundaries")
        r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "ProjectValidationError", err.Error())
        return ctrl.Result{}, err
    } else if blocking := violations.Blocking(); len(blocking) > 0 {
        msg := blocking[0].Message
        r.setGovernanceCondition(ctx, app, false, "ProjectViolation", msg)
        r.updatePhase(ctx, app, paprikav1.ApplicationFailed, "GovernanceViolation", msg)
        r.EventRecorder.Eventf(app, corev1.EventTypeWarning, "ProjectViolation", "%s", msg)
        return ctrl.Result{}, nil
    } else if warnings := violations.Warnings(); len(warnings) > 0 {
        msg := warnings[0].Message
        r.setGovernanceCondition(ctx, app, true, "Passed", fmt.Sprintf("Governance checks passed with warnings: %s", msg))
        r.EventRecorder.Eventf(app, corev1.EventTypeWarning, "GovernanceWarning", "%s", msg)
    } else {
        r.setGovernanceCondition(ctx, app, true, "Passed", "Governance checks passed")
    }
```

Add helper:

```go
func (r *ApplicationReconciler) setGovernanceCondition(ctx context.Context, app *paprikav1.Application, status bool, reason, message string) {
    conditionStatus := metav1.ConditionTrue
    if !status {
        conditionStatus = metav1.ConditionFalse
    }
    meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
        Type:               "GovernanceChecked",
        Status:             conditionStatus,
        Reason:             reason,
        Message:            message,
        LastTransitionTime: metav1.Now(),
    })
}
```

- [ ] **Step 4: Add test**

Add an envtest test that creates an `AppProject` restricting namespaces and an `Application` violating it, then asserts `GovernanceChecked=False`.

- [ ] **Step 5: Run tests**

Run: `go test ./internal/controller/pipelines/... -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add internal/controller/pipelines/application_controller.go internal/controller/pipelines/application_controller_test.go
git commit -m "feat(controller): lightweight project-boundary gate in Application reconciliation"
```

### Task 4.2: Release controller full governance gate

**Files:**
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: Add fields**

Add to `ReleaseReconciler` struct:

```go
    EventRecorder    record.EventRecorder
    ProjectValidator *governance.ProjectValidator
    PolicyEvaluator  *governance.PolicyEvaluator
```

Ensure imports include (alias `k8s.io/apimachinery/pkg/util/yaml` as `k8syaml`):

```go
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    "k8s.io/apimachinery/pkg/api/meta"
    "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
    k8syaml "k8s.io/apimachinery/pkg/util/yaml"
    "github.com/benebsworth/paprika/engine"
    "github.com/benebsworth/paprika/internal/governance"
    "github.com/benebsworth/paprika/policy"
```

Rename all existing `yaml.Unmarshal` calls in `release_controller.go` to `k8syaml.Unmarshal` (e.g. in `parseManifest`). Remove the old unaliased yaml import.

- [ ] **Step 2: Refactor render/snapshot ordering**

`resolveManifests` currently renders templates and immediately stores the manifest snapshot. Split it so rendering returns the snapshot name and raw manifests, and `promote` stores the snapshot only after governance passes.

1. Rename `resolveManifests` to `renderManifests` and remove the `storeManifestSnapshot` call and the `RenderedManifestSnapshot` assignment. Return the raw `manifests` and the intended `snapshotName`:

```go
func (r *ReleaseReconciler) renderManifests(ctx context.Context, release *pipelinesv1alpha1.Release, stage *pipelinesv1alpha1.Stage) (manifests []byte, snapshotName string, err error) {
    if r.hasInlineManifests(release) {
        manifests, err := r.loadManifestsFromConfigMap(ctx, release)
        if err != nil {
            return nil, "", fmt.Errorf("load inline manifests: %w", err)
        }
        return manifests, release.Spec.ManifestSource.ConfigMapRef, nil
    }
    templates, err := r.fetchStageTemplates(ctx, release, stage)
    if err != nil {
        return nil, "", err
    }
    params := r.buildPromoteParams(release)
    manifests, err = r.TemplateRenderer.RenderAll(ctx, templates, params)
    if err != nil {
        return nil, "", fmt.Errorf("template rendering failed: %w", err)
    }
    return manifests, stage.Name + "-manifest-snapshot", nil
}
```

2. In `promote`, call `renderManifests`, run the governance gate, then store and apply:

```go
    manifests, snapshotName, err := r.renderManifests(ctx, release, stage)
    if err != nil {
        return err
    }

    // Governance gate: parse, normalize, validate, evaluate policies.
    manifestObjects, err := parseManifests(manifests)
    if err != nil {
        return fmt.Errorf("parse manifests: %w", err)
    }
    normalizeManifestNamespaces(manifestObjects, release.Namespace)
    app, err := r.runGovernanceGate(ctx, release, manifestObjects)
    if err != nil {
        return err
    }

    project := app.Spec.Project
    if project == "" {
        project = "default"
    }

    if err := r.storeManifestSnapshot(ctx, release, stage, snapshotName, project, manifests); err != nil {
        return fmt.Errorf("store manifest snapshot: %w", err)
    }
    release.Status.RenderedManifestSnapshot = snapshotName

    if err := r.applyPromotedManifests(ctx, release, stage, manifests); err != nil {
        return err
    }
```

Replace the rest of the old `promote` body so the snapshot is stored and manifests applied only after governance passes.

Add helpers:

```go
func parseManifests(bundle []byte) ([]*unstructured.Unstructured, error) {
    docs := engine.SplitYAMLDocuments(bundle)
    var out []*unstructured.Unstructured
    for _, doc := range docs {
        obj := &unstructured.Unstructured{}
        if err := k8syaml.Unmarshal(doc, &obj.Object); err != nil {
            return nil, err
        }
        if obj.Object != nil {
            out = append(out, obj)
        }
    }
    return out, nil
}

func normalizeManifestNamespaces(objects []*unstructured.Unstructured, ns string) {
    for _, obj := range objects {
        if obj.GetNamespace() == "" {
            obj.SetNamespace(ns)
        }
    }
}

func (r *ReleaseReconciler) resolveOwningApplication(ctx context.Context, release *pipelinesv1alpha1.Release) (*pipelinesv1alpha1.Application, error) {
    for _, ref := range release.OwnerReferences {
        if ref.APIVersion == pipelinesv1alpha1.GroupVersion.String() && ref.Kind == "Application" {
            var app pipelinesv1alpha1.Application
            if err := r.Get(ctx, types.NamespacedName{Namespace: release.Namespace, Name: ref.Name}, &app); err != nil {
                return nil, err
            }
            return &app, nil
        }
    }
    return nil, fmt.Errorf("release %s/%s has no Application owner reference", release.Namespace, release.Name)
}

func (r *ReleaseReconciler) resolveStageServer(ctx context.Context, release *pipelinesv1alpha1.Release) (string, error) {
    var stage pipelinesv1alpha1.Stage
    if err := r.Get(ctx, types.NamespacedName{Namespace: release.Namespace, Name: release.Spec.Target}, &stage); err != nil {
        if apierrors.IsNotFound(err) {
            return "", nil
        }
        return "", err
    }
    resolved, err := r.resolveClusterRef(ctx, &stage.Spec.Cluster, release.Namespace)
    if err != nil {
        return "", err
    }
    return resolved.Server, nil
}

func (r *ReleaseReconciler) setReleaseGovernanceCondition(release *pipelinesv1alpha1.Release, status bool, reason, message string) {
    conditionStatus := metav1.ConditionTrue
    if !status {
        conditionStatus = metav1.ConditionFalse
    }
    meta.SetStatusCondition(&release.Status.Conditions, metav1.Condition{
        Type:               "GovernanceChecked",
        Status:             conditionStatus,
        Reason:             reason,
        Message:            message,
        LastTransitionTime: metav1.Now(),
    })
}

func (r *ReleaseReconciler) runGovernanceGate(ctx context.Context, release *pipelinesv1alpha1.Release, manifestObjects []*unstructured.Unstructured) (*pipelinesv1alpha1.Application, error) {
    app, err := r.resolveOwningApplication(ctx, release)
    if err != nil {
        return nil, fmt.Errorf("resolve owning application: %w", err)
    }
    projectName := app.Spec.Project
    if projectName == "" {
        projectName = "default"
    }

    project, err := r.ProjectValidator.ResolveProject(ctx, app.Namespace, projectName)
    if err != nil {
        return nil, fmt.Errorf("resolve appproject: %w", err)
    }

    stageServer, err := r.resolveStageServer(ctx, release)
    if err != nil {
        return nil, fmt.Errorf("resolve stage server: %w", err)
    }

    if violations, err := r.ProjectValidator.ValidateBundle(ctx, project, app.Spec.Source, app.Spec.Stages, app.Namespace, stageServer, manifestObjects); err != nil {
        return nil, fmt.Errorf("validate bundle: %w", err)
    } else if blocking := violations.Blocking(); len(blocking) > 0 {
        r.setReleaseGovernanceCondition(release, false, "ProjectViolation", blocking[0].Message)
        r.EventRecorder.Eventf(release, corev1.EventTypeWarning, "ProjectViolation", "%s", blocking[0].Message)
        return nil, fmt.Errorf("project boundary violation: %s", blocking[0].Message)
    }

    if violations, err := r.PolicyEvaluator.Evaluate(ctx, projectName, manifestObjects, policy.EvaluateOptions{Namespace: release.Namespace, ApplicationName: app.Name}); err != nil {
        return nil, fmt.Errorf("evaluate policies: %w", err)
    } else if blocking := violations.Blocking(); len(blocking) > 0 {
        r.setReleaseGovernanceCondition(release, false, "PolicyViolation", blocking[0].Message)
        r.EventRecorder.Eventf(release, corev1.EventTypeWarning, "PolicyViolation", "%s", blocking[0].Message)
        return nil, fmt.Errorf("policy violation: %s", blocking[0].Message)
    } else if warnings := violations.Warnings(); len(warnings) > 0 {
        r.setReleaseGovernanceCondition(release, true, "Passed", fmt.Sprintf("Governance checks passed with warnings: %s", warnings[0].Message))
        r.EventRecorder.Eventf(release, corev1.EventTypeWarning, "PolicyWarning", "%s", warnings[0].Message)
    } else {
        r.setReleaseGovernanceCondition(release, true, "Passed", "Governance checks passed")
    }
    return app, nil
}
```

- [ ] **Step 3: Gate canary render paths**

Call `runGovernanceGate` before storing/applying manifests in `applyCanaryWeight` and `promoteCanary`:

```go
    manifestObjects, err := parseManifests(manifests)
    if err != nil {
        return fmt.Errorf("parse manifests: %w", err)
    }
    normalizeManifestNamespaces(manifestObjects, release.Namespace)
    app, err := r.runGovernanceGate(ctx, release, manifestObjects)
    if err != nil {
        return err
    }
    project := app.Spec.Project
    if project == "" {
        project = "default"
    }
```

- [ ] **Step 4: Propagate Release governance failure to Application**

In the Application controller's `reconcileReleaseFlow`, after calling the Release reconcile:

```go
    if err := r.reconcileReleaseFlow(ctx, app); err != nil {
        // Mirror governance failures onto the Application so users see them on the primary resource.
        var release pipelinesv1alpha1.Release
        relErr := r.Get(ctx, types.NamespacedName{Namespace: app.Namespace, Name: app.Status.ReleaseRef}, &release)
        if relErr == nil {
            if cond := meta.FindStatusCondition(release.Status.Conditions, "GovernanceChecked"); cond != nil && cond.Status == metav1.ConditionFalse {
                meta.SetStatusCondition(&app.Status.Conditions, metav1.Condition{
                    Type:               "GovernanceChecked",
                    Status:             metav1.ConditionFalse,
                    Reason:             "GovernanceViolation",
                    Message:            cond.Message,
                    LastTransitionTime: metav1.Now(),
                })
                _ = r.Status().Update(ctx, app)
            }
        }
        return ctrl.Result{}, err
    }
```

Ensure the governance gate in Task 4.2 Step 2 runs **before** `storeManifestSnapshot` so a blocked release does not create a manifest snapshot ConfigMap.

- [ ] **Step 5: Add tests**

Add a release controller unit test that creates a Release with a manifest snapshot, an owning Application in a restrictive project, and asserts apply is blocked.

- [ ] **Step 6: Run tests**

Run: `go test ./internal/controller/pipelines/... -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add internal/controller/pipelines/release_controller.go internal/controller/pipelines/release_controller_test.go
git commit -m "feat(controller): full governance gate in Release apply"
```

### Task 4.3: Propagate project label to child resources

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go`
- Modify: `internal/controller/pipelines/release_controller.go`

- [ ] **Step 1: Add project label in Application controller**

Whenever the Application controller creates a `Template`, `Pipeline`, `Stage`, or `Release`, add or merge the label. Ensure `internal/controller/pipelines/application_controller.go` imports the `engine` package (`github.com/benebsworth/paprika/engine`).

```go
func withProjectLabels(app *pipelinesv1alpha1.Application, labels map[string]string) map[string]string {
    if labels == nil {
        labels = map[string]string{}
    }
    project := app.Spec.Project
    if project == "" {
        project = "default"
    }
    labels["app.paprika.io/project"] = project
    return labels
}
```

Call it in every place that builds child `ObjectMeta`. Examples:

Template:
```go
    template.ObjectMeta.Labels = withProjectLabels(app, template.ObjectMeta.Labels)
```

Pipeline:
```go
    pipeline.ObjectMeta.Labels = withProjectLabels(app, pipeline.ObjectMeta.Labels)
```

Stage:
```go
    stage.ObjectMeta.Labels = withProjectLabels(app, map[string]string{
        engine.ManagedByLabelKey:    engine.ManagedByLabelValue,
        engine.ApplicationNameLabelKey: app.Name,
    })
```

Release:
```go
    release.ObjectMeta.Labels = withProjectLabels(app, map[string]string{
        engine.ManagedByLabelKey:    engine.ManagedByLabelValue,
        engine.ApplicationNameLabelKey: app.Name,
        releaseLabelKey:             release.Name,
    })
```

Define the release label key at the top of the file (or reuse an existing engine constant if present):

```go
const releaseLabelKey = "app.paprika.io/release"
```

At minimum update:
- `reconcileTemplate` (Template labels)
- `reconcilePipeline` (Pipeline labels)
- `buildStageSpec` or `ensureStage` (Stage labels)
- `buildRelease` or `reconcileReleaseFlow` (Release labels)

- [ ] **Step 2: Add project label in Release controller**

Change `storeManifestSnapshot` to accept a `project string` and set the label on the ConfigMap. Ensure `internal/controller/pipelines/release_controller.go` imports the `engine` package (`github.com/benebsworth/paprika/engine`).

Add a small pointer helper at the bottom of the package if one does not already exist:

```go
func ptr[T any](v T) *T { return &v }
```

Then update `storeManifestSnapshot`:

```go
func (r *ReleaseReconciler) storeManifestSnapshot(ctx context.Context, release *pipelinesv1alpha1.Release, stage *pipelinesv1alpha1.Stage, name, project string, manifests []byte) error {
    cm := &corev1.ConfigMap{
        ObjectMeta: metav1.ObjectMeta{
            Name:      name,
            Namespace: release.Namespace,
            Labels: map[string]string{
                engine.ManagedByLabelKey:       engine.ManagedByLabelValue,
                engine.ApplicationNameLabelKey: release.Labels[engine.ApplicationNameLabelKey],
                "app.paprika.io/project":       project,
            },
            OwnerReferences: []metav1.OwnerReference{{
                APIVersion: pipelinesv1alpha1.GroupVersion.String(),
                Kind:       "Release",
                Name:       release.Name,
                UID:        release.UID,
                Controller: ptr(true),
            }},
        },
        Data: map[string]string{
            "manifests.yaml": string(manifests),
        },
    }
    if err := r.Create(ctx, cm); err != nil {
        return fmt.Errorf("create manifest snapshot: %w", err)
    }
    return nil
}
```

Update all call sites (`promote`, `applyCanaryWeight`, `promoteCanary`) to pass the project resolved by `runGovernanceGate`.

- [ ] **Step 3: Run tests**

Run: `go test ./internal/controller/pipelines/... -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/controller/pipelines/application_controller.go internal/controller/pipelines/release_controller.go
git commit -m "feat(controller): propagate app.paprika.io/project label to child resources"
```

---

## Chunk 5: ApplyBundle integration

### Task 5.1: Propagate project and validate bundle

**Files:**
- Modify: `internal/api/apply_bundle.go`

- [ ] **Step 1: Read and normalize project**

At the top of `ApplyBundle`, after namespace/appName checks:

```go
    project := req.Msg.Project
    if project == "" {
        project = "default"
    }
```

- [ ] **Step 2: Validate project boundaries and evaluate policies**

After `prepareBundle`, add project boundary validation and then choose the project-aware evaluator when available:

```go
    source := pipelinesv1alpha1.ApplicationSource{
        Type:   pipelinesv1alpha1.SourceTypeInline,
        Inline: &pipelinesv1alpha1.InlineSourceSpec{ConfigMapRef: ""},
    }

    projectObj, err := s.governanceValidator.ResolveProject(ctx, namespace, project)
    if err != nil {
        return nil, fmt.Errorf("resolve project: %w", err)
    }

    manifests, err := manifestsFromBundle(bundle)
    if err != nil {
        return nil, fmt.Errorf("parse bundle: %w", err)
    }
    boundaryResults := make([]policy.Result, 0)
    if violations, err := s.governanceValidator.ValidateBundle(ctx, projectObj, source, nil, namespace, "", manifests); err != nil {
        return nil, fmt.Errorf("validate bundle: %w", err)
    } else if blocking := violations.Blocking(); len(blocking) > 0 {
        return connect.NewResponse(&paprikav1.ApplyBundleResponse{
            PolicyResults: convertViolationsToPolicyResults(violations),
            Blocked:       true,
            BlockReason:   blocking[0].Message,
        }), nil
    } else {
        boundaryResults = toPolicyResults(violations)
    }

> **Note:** The synthetic `ApplicationSource{Type: SourceTypeInline, Inline: &InlineSourceSpec{}}` intentionally represents an already-materialized bundle. It does not carry `RepoURL`/`RepoRef`, so repository-level source constraints are skipped, while `allowed_sources` type checks and namespace/cluster boundary rules still run.

    var evResult *policy.EvaluationResult
    if s.governancePolicyEvaluator != nil {
        evResult, err = s.evaluatePoliciesForProject(ctx, project, manifests, namespace, appName, req.Msg.SkipPolicies, req.Msg.PolicyOverrides)
    } else {
        evResult, err = s.evaluatePolicies(ctx, bundle, namespace, appName, req.Msg.SkipPolicies, req.Msg.PolicyOverrides)
    }
    if err != nil {
        return nil, fmt.Errorf("evaluate policies: %w", err)
    }
    evResult.Results = append(evResult.Results, boundaryResults...)
```

Keep the existing `if evResult.Blocked { ... }` and dry-run handling that follows; the boundary results will now appear in the returned `PolicyResults`.

Create helper `manifestsFromBundle`:

```go
func manifestsFromBundle(bundle []byte) ([]*unstructured.Unstructured, error) {
    docs := engine.SplitYAMLDocuments(bundle)
    var out []*unstructured.Unstructured
    for _, doc := range docs {
        obj := &unstructured.Unstructured{}
        if err := k8syaml.Unmarshal(doc, &obj.Object); err != nil {
            return nil, err
        }
        if obj.Object != nil {
            out = append(out, obj)
        }
    }
    return out, nil
}
```

Ensure `internal/governance` is imported in `apply_bundle.go` so `convertViolationsToPolicyResults` and `toPolicyResults` can reference `governance.Violations`.

- [ ] **Step 3: Store project on Application and child resources**

In `buildApplication`, set the project and label:

```go
    app.Spec.Project = project
    app.Labels["app.paprika.io/project"] = project
```

Change `baseLabels` to accept the project and add the project label. Update all call sites:

```go
func (s *PaprikaServer) baseLabels(appName, releaseName, project string) map[string]string {
    return map[string]string{
        managedByLabel:          "paprika",
        nameLabel:               appName,
        releaseLabel:            releaseName,
        historyLabel:            "true",
        "app.paprika.io/project": project,
    }
}
```

Update callers:
- `createOrUpdateApplication`: change signature to `createOrUpdateApplication(ctx, appName, namespace, snapshotName, project string)` and forward `project` to `buildApplication`.
- `ensureStage`: `s.baseLabels(appName, releaseName, project)`
- `createSnapshot`: `s.baseLabels(appName, releaseName, project)`
- `buildRelease`: change signature to `buildRelease(appName, namespace, snapshotName, project string, bundle []byte, policyResults []policy.Result)` and call `s.baseLabels(appName, releaseName, project)`. Update both `applyInline` and the dry-run branch in `ApplyBundle` to pass `project`.
- `buildApplication`: change signature to `buildApplication(appName, namespace, snapshotName, project string)` so the dry-run and apply paths can pass it.

- [ ] **Step 4: Add evaluatePoliciesForProject helper**

```go
func (s *PaprikaServer) evaluatePoliciesForProject(ctx context.Context, project string, manifests []*unstructured.Unstructured, namespace, appName string, skip []string, overrides map[string]string) (*policy.EvaluationResult, error) {
    opts := policy.EvaluateOptions{
        Namespace:       namespace,
        ApplicationName: appName,
        SkipPolicies:    skip,
        PolicyOverrides: toPolicyActions(overrides),
    }
    violations, err := s.governancePolicyEvaluator.Evaluate(ctx, project, manifests, opts)
    if err != nil {
        return nil, err
    }
    results := make([]policy.Result, 0, len(violations))
    passed := true
    blocked := false
    var message string
    for _, v := range violations {
        results = append(results, policy.Result{
            Name:     v.Rule,
            Severity: v.Severity,
            Action:   string(v.Action),
            Passed:   false,
            Message:  v.Message,
        })
        if v.Blocking() {
            passed = false
            blocked = true
            message = v.Message
        }
    }
    return &policy.EvaluationResult{Passed: passed, Blocked: blocked, Message: message, Results: results}, nil
}

func toPolicyResults(violations governance.Violations) []policy.Result {
    out := make([]policy.Result, 0, len(violations))
    for _, v := range violations {
        out = append(out, policy.Result{
            Name:     v.Rule,
            Severity: v.Severity,
            Action:   string(v.Action),
            Passed:   false,
            Message:  v.Message,
        })
    }
    return out
}

func convertViolationsToPolicyResults(violations governance.Violations) []*paprikav1.PolicyResult {
    out := make([]*paprikav1.PolicyResult, 0, len(violations))
    for _, v := range violations {
        out = append(out, &paprikav1.PolicyResult{
            Name:     v.Rule,
            Severity: v.Severity,
            Action:   string(v.Action),
            Passed:   false,
            Message:  v.Message,
        })
    }
    return out
}
```

- [ ] **Step 5: Add PaprikaServer governance fields and setters**

Add to `PaprikaServer` struct (use distinct names to avoid shadowing the existing `evaluator policy.Evaluator`):

```go
    governanceValidator        *governance.ProjectValidator
    governancePolicyEvaluator  *governance.PolicyEvaluator
```

Add setters:

```go
func (s *PaprikaServer) SetGovernanceValidator(v *governance.ProjectValidator) {
    s.governanceValidator = v
}

func (s *PaprikaServer) SetGovernancePolicyEvaluator(e *governance.PolicyEvaluator) {
    s.governancePolicyEvaluator = e
}
```

- [ ] **Step 6: Run tests**

Run: `go test ./internal/api/... -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add internal/api/apply_bundle.go
git commit -m "feat(api): propagate project through ApplyBundle and validate boundaries"
```

### Task 5.2: CLI `--project` flag

**Files:**
- Modify: `cmd/paprika/apply.go`

- [ ] **Step 1: Add flag and field**

Add to `applyOptions`:

```go
    project string
```

Add the flag in `newApplyCmd`:

```go
    cmd.Flags().StringVar(&opts.project, "project", "", "AppProject that governs this application (defaults to default)")
```

- [ ] **Step 2: Send project in request**

Set `Project: opts.project` in the `ApplyBundleRequest`.

- [ ] **Step 3: Run tests**

Run: `go test ./cmd/paprika/... -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add cmd/paprika/apply.go
git commit -m "feat(cli): add --project flag to apply"
```

---

## Chunk 6: API authorization

### Task 6.1: Extend RBACRule with Projects

**Files:**
- Modify: `internal/api/auth/authz.go`

- [ ] **Step 1: Add Projects field**

Add to `RBACRule`:

```go
    // Projects allowed. Use * for all. Empty means apply regardless of project.
    Projects []string `json:"projects,omitempty"`
```

- [ ] **Step 2: Update Authorizer interface and matches**

Change `Authorizer` interface:

```go
type Authorizer interface {
    Authorize(ctx context.Context, p *Principal, action Action, resource Resource, namespace, project string) error
}
```

Update `RBACAuthorizer.Authorize` signature and add:

```go
        if !r.matchesProjects(rule, project) {
            continue
        }
```

Add helper:

```go
func (r *RBACAuthorizer) matchesProjects(rule *RBACRule, project string) bool {
    if len(rule.Projects) == 0 || project == "" {
        return true
    }
    for _, p := range rule.Projects {
        if p == "*" || p == project {
            return true
        }
    }
    return false
}
```

Update `AllowAllAuthorizer` signature.

Update `internal/api/auth/middleware.go` so the `authz.Authorize` call passes an empty project for now:

```go
    if err := authz.Authorize(ctx, principal, action, resource, namespace, ""); err != nil {
```

- [ ] **Step 3: Update tests**

Update `internal/api/auth/auth_test.go` so every `Authorize` call includes a project argument, e.g.:

```go
err := authz.Authorize(ctx, principal, auth.ActionRead, auth.ResourceApplications, "", "")
```

Add a test for project-scoped rules:

```go
func TestRBACAuthorizer_Projects(t *testing.T) {
    authz := NewRBACAuthorizer([]RBACRule{{
        Subjects:  []string{"alice"},
        Actions:   []string{"read"},
        Resources: []string{"applications"},
        Projects:  []string{"payments"},
    }})
    require.NoError(t, authz.Authorize(context.Background(), &Principal{Subject: "alice"}, ActionRead, ResourceApplications, "", "payments"))
    require.Error(t, authz.Authorize(context.Background(), &Principal{Subject: "alice"}, ActionRead, ResourceApplications, "", "other"))
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./internal/api/auth/... -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/auth/authz.go internal/api/auth/middleware.go internal/api/auth/auth_test.go
git commit -m "feat(auth): add Projects to RBACRule"
```

### Task 6.2: Add ProjectAuthorizer to auth package

**Files:**
- Create: `internal/api/auth/project_authorizer.go`
- Test: `internal/api/auth/project_authorizer_test.go`

- [ ] **Step 1: Write the file**

```go
package auth

import (
    "context"
    "fmt"
    "strings"

    corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

type ProjectAuthorizer struct {
    client client.Reader
}

func NewProjectAuthorizer(c client.Reader) *ProjectAuthorizer {
    return &ProjectAuthorizer{client: c}
}

func (a *ProjectAuthorizer) Authorize(ctx context.Context, p *Principal, action Action, resource Resource, namespace, project string) error {
    if project == "" {
        return nil
    }
    if namespace == "" {
        namespace = "default"
    }
    var ap corev1alpha1.AppProject
    if err := a.client.Get(ctx, client.ObjectKey{Name: project, Namespace: namespace}, &ap); err != nil {
        if apierrors.IsNotFound(err) && project == "default" {
            return nil
        }
        return fmt.Errorf("get appproject %s/%s: %w", namespace, project, err)
    }

    for _, role := range ap.Spec.Roles {
        if !actionAllowed(role.Actions, action) {
            continue
        }
        if subjectMatches(role.Subjects, p) {
            return nil
        }
    }
    return fmt.Errorf("%w: principal %q cannot %s %s in project %q", ErrUnauthorized, p.Subject, action, resource, project)
}

// actionAllowed reports whether the supplied role actions permit action.
func actionAllowed(actions []string, action Action) bool {
    for _, a := range actions {
        if a == "*" || a == string(action) {
            return true
        }
        if a == "admin" {
            return true
        }
        if a == "write" && action == ActionRead {
            return true
        }
    }
    return false
}

// subjectMatches reports whether the principal matches one of the role subjects.
// Subjects are opaque strings; conventions such as "serviceaccount:<ns>:<name>"
// must match the principal subject produced by the configured authenticator.
func subjectMatches(subjects []string, p *Principal) bool {
    for _, s := range subjects {
        if s == "*" {
            return true
        }
        if s == p.Subject {
            return true
        }
        if strings.HasPrefix(s, "group:") {
            if p.IsInGroup(strings.TrimPrefix(s, "group:")) {
                return true
            }
        }
    }
    return false
}
```

- [ ] **Step 2: Add tests**

Add unit tests in `internal/api/auth/project_authorizer_test.go`.

- [ ] **Step 3: Run tests**

Run: `go test ./internal/api/auth/... -v`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/api/auth/project_authorizer.go internal/api/auth/project_authorizer_test.go
git commit -m "feat(auth): add ProjectAuthorizer based on AppProject roles"
```

### Task 6.3: Wire authorizers in the interceptor

**Files:**
- Modify: `internal/api/auth/middleware.go`

- [ ] **Step 1: Update Interceptor factory and add BuildAuthorizer**

Change `Interceptor(cfg Config)` to `Interceptor(cfg Config, reader client.Reader)` and update the internal call to `buildAuthnAuthz(cfg, reader)`.

Change `buildAuthnAuthz(cfg Config)` to `buildAuthnAuthz(cfg Config, reader client.Reader)` and replace its authorizer construction with:

```go
    authz, err := BuildAuthorizer(cfg, reader)
    if err != nil {
        return nil, nil, err
    }
```

Add the controller-runtime client import:

```go
    "sigs.k8s.io/controller-runtime/pkg/client"
```

Add exported `BuildAuthorizer`:

```go
// BuildAuthorizer creates the composed authorizer from config and a Kubernetes reader.
func BuildAuthorizer(cfg Config, reader client.Reader) (Authorizer, error) {
    var authorizers []Authorizer
    if len(cfg.RBACRules) > 0 {
        authorizers = append(authorizers, NewRBACAuthorizer(cfg.RBACRules))
    }
    if reader != nil {
        authorizers = append(authorizers, NewProjectAuthorizer(reader))
    }
    if len(authorizers) == 0 {
        return &AllowAllAuthorizer{}, nil
    }
    return &multiAuthorizer{authorizers: authorizers}, nil
}
```

Add `multiAuthorizer`:

```go
type multiAuthorizer struct {
    authorizers []Authorizer
}

func (m *multiAuthorizer) Authorize(ctx context.Context, p *Principal, action Action, resource Resource, namespace, project string) error {
    for _, a := range m.authorizers {
        if err := a.Authorize(ctx, p, action, resource, namespace, project); err != nil {
            return err
        }
    }
    return nil
}
```

- [ ] **Step 2: Extract project from requests**

Add helper:

```go
type projectGetter interface {
    GetProject() string
}

func projectFromRequest(req connect.AnyRequest) string {
    msg := req.Any()
    if g, ok := msg.(projectGetter); ok {
        return g.GetProject()
    }
    return ""
}
```

In the interceptor:

```go
    project := projectFromRequest(req)
    if err := authz.Authorize(ctx, principal, action, resource, namespace, project); err != nil {
        return nil, connect.NewError(connect.CodePermissionDenied, err)
    }
```

- [ ] **Step 3: Update callers**

- `cmd/main.go`:
  - Operator mode: pass `mgr.GetClient()` to `auth.Interceptor(authCfg, mgr.GetClient())`.
  - API mode: pass `apiClient` to `auth.Interceptor(authCfg, apiClient)`. Only build and set the authorizer when `authCfg.Enabled` is true:

```go
    if authCfg.Enabled {
        authz, err := auth.BuildAuthorizer(authCfg, apiClient)
        if err != nil {
            return fmt.Errorf("build authorizer: %w", err)
        }
        paprikaServer.SetAuthorizer(authz)
    }
```

  - Add `corev1alpha1.AddToScheme(scheme)` and `clustersv1alpha1.AddToScheme(scheme)` in `createAPIClient`.
- `cmd/cloud-run/main.go`:
  - Register `corev1alpha1.AddToScheme(scheme)`, `clustersv1alpha1.AddToScheme(scheme)`, and `policyv1alpha1.AddToScheme(scheme)`.
  - Pass `k8sClient` to `auth.Interceptor(authCfg, k8sClient)`. Only build and set the authorizer when `authCfg.Enabled` is true.
- Update `internal/api/auth/auth_test.go` so all `Interceptor(Config{...})` calls become `Interceptor(Config{...}, nil)`.

- [ ] **Step 4: Run auth tests**

Run: `go test ./internal/api/auth/... ./cmd/... -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add internal/api/auth/middleware.go cmd/main.go cmd/cloud-run/main.go
git commit -m "feat(auth): wire ProjectAuthorizer and extract project in interceptor"
```

### Task 6.4: Server list filtering and project conversion

**Files:**
- Modify: `internal/api/server.go`

- [ ] **Step 1: Add authorizer field**

Add the auth package import to `internal/api/server.go`:

```go
    "github.com/benebsworth/paprika/internal/api/auth"
```

Add to `PaprikaServer` struct:

```go
    authorizer auth.Authorizer
```

Add a setter:

```go
func (s *PaprikaServer) SetAuthorizer(a auth.Authorizer) {
    s.authorizer = a
}
```

- [ ] **Step 2: Add project to convertApplication**

In `convertApplication`, set:

```go
    Project: a.Spec.Project,
```

- [ ] **Step 3: Authorize single-resource RPCs**

In `GetApplication`, fetch the Application then call `s.authorizeProject(ctx, auth.ActionRead, auth.ResourceApplications, app.Namespace, project)` before returning.

In `SyncApplication` and `ApproveGate`, call `s.authorizeProject(ctx, auth.ActionWrite, auth.ResourceApplications, app.Namespace, project)` before mutating.

```go
    project := app.Spec.Project
    if project == "" {
        project = "default"
    }
    if err := s.authorizeProject(ctx, auth.ActionRead, auth.ResourceApplications, app.Namespace, project); err != nil {
        return nil, connect.NewError(connect.CodePermissionDenied, err)
    }
```

- [ ] **Step 4: Filter list responses**

For `ListApplications`, filter by the Application's `spec.project`:

```go
    filtered := make([]*paprikav1.Application, 0, len(apps.Items))
    for i := range apps.Items {
        app := &apps.Items[i]
        project := app.Spec.Project
        if project == "" {
            project = "default"
        }
        if err := s.authorizeProject(ctx, auth.ActionRead, auth.ResourceApplications, app.Namespace, project); err != nil {
            continue
        }
        filtered = append(filtered, convertApplication(app))
    }
    return connect.NewResponse(&paprikav1.ListApplicationsResponse{Applications: filtered}), nil
```

For child resources (`ListReleases`, `ListStages`, `ListPipelines`, `ListTemplates`), read the project from the `app.paprika.io/project` label and filter in memory. Example for `ListReleases`:

```go
    filtered := make([]*paprikav1.Release, 0, len(releases.Items))
    for i := range releases.Items {
        rel := &releases.Items[i]
        project := rel.Labels["app.paprika.io/project"]
        if project == "" {
            project = "default"
        }
        if err := s.authorizeProject(ctx, auth.ActionRead, auth.ResourceReleases, rel.Namespace, project); err != nil {
            continue
        }
        filtered = append(filtered, convertRelease(rel))
    }
    return connect.NewResponse(&paprikav1.ListReleasesResponse{Releases: filtered}), nil
```

Repeat the same pattern for `ListStages`, `ListPipelines`, and `ListTemplates`.

In operator mode, optionally register a field indexer for better performance:

```go
if err := mgr.GetFieldIndexer().IndexField(ctx, &pipelinesv1alpha1.Release{}, "projectLabel", func(obj client.Object) []string {
    return []string{obj.GetLabels()["app.paprika.io/project"]}
}); err != nil {
    return err
}
```

Repeat for `Stage`, `Pipeline`, and `Template`. The stateless API and Cloud Run planes do not support field indexers, so use in-memory filtering there.

- [ ] **Step 5: Add authorizeProject helper**

```go
func (s *PaprikaServer) authorizeProject(ctx context.Context, action auth.Action, resource auth.Resource, namespace, project string) error {
    if s.authorizer == nil {
        return nil
    }
    p := auth.PrincipalFromContext(ctx)
    if p == nil {
        return auth.ErrUnauthorized
    }
    return s.authorizer.Authorize(ctx, p, action, resource, namespace, project)
}
```

- [ ] **Step 6: Run tests**

Run: `go test ./internal/api/... -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add internal/api/server.go
git commit -m "feat(api): filter lists by project and include project in conversion"
```

---

## Chunk 7: Bootstrap, wiring, and E2E

### Task 7.1: Bootstrap default AppProject

**Files:**
- Create: `internal/controller/bootstrap/default_project.go`
- Modify: `cmd/main.go`

- [ ] **Step 1: Create bootstrap helper**

```go
package bootstrap

import (
    "context"

    corev1alpha1 "github.com/benebsworth/paprika/api/core/v1alpha1"
    apierrors "k8s.io/apimachinery/pkg/api/errors"
    metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
)

// EnsureDefaultAppProject creates the permissive default project if missing.
func EnsureDefaultAppProject(ctx context.Context, c client.Client, namespace string) error {
    project := &corev1alpha1.AppProject{
        ObjectMeta: metav1.ObjectMeta{
            Name:      "default",
            Namespace: namespace,
        },
        Spec: corev1alpha1.AppProjectSpec{
            SourceRepos: []string{"*"},
            Destinations: []corev1alpha1.AppProjectDestination{
                {Server: "*", Namespace: "*"},
            },
            Kinds: []string{"*"},
            Roles: []corev1alpha1.AppProjectRole{
                {Name: "default", Subjects: []string{"*"}, Actions: []string{"read", "write"}},
            },
        },
    }
    if err := c.Create(ctx, project); err != nil && !apierrors.IsAlreadyExists(err) {
        return err
    }
    return nil
}
```

- [ ] **Step 2: Call from cmd/main.go**

In `runOperatorMode` or `setupOperatorControllers`, register the bootstrap as a manager runnable so it runs after caches sync and the webhook server is ready. Ensure a default project in the operator namespace and in every namespace that already contains Applications.

Ensure `cmd/main.go` imports `sigs.k8s.io/controller-runtime/pkg/manager`; add the import if it is missing.

```go
    if err := mgr.Add(manager.RunnableFunc(func(ctx context.Context) error {
        if err := bootstrap.EnsureDefaultAppProject(ctx, mgr.GetClient(), namespace); err != nil {
            return fmt.Errorf("ensure operator namespace default appproject: %w", err)
        }
        var apps pipelinesv1alpha1.ApplicationList
        if err := mgr.GetClient().List(ctx, &apps); err != nil {
            return fmt.Errorf("list applications: %w", err)
        }
        seen := map[string]bool{namespace: true}
        for _, app := range apps.Items {
            if seen[app.Namespace] {
                continue
            }
            seen[app.Namespace] = true
            if err := bootstrap.EnsureDefaultAppProject(ctx, mgr.GetClient(), app.Namespace); err != nil {
                return fmt.Errorf("ensure default appproject in %s: %w", app.Namespace, err)
            }
        }
        <-ctx.Done()
        return nil
    })); err != nil {
        return fmt.Errorf("register default appproject bootstrap: %w", err)
    }
```

The bootstrap ensures a permissive `default` `AppProject` exists in the operator namespace and in every namespace that already contains Applications. `ProjectResolver` and `ProjectAuthorizer` also fall back to a synthetic permissive default project when no `AppProject` CR exists, protecting resources created before bootstrap runs.

- [ ] **Step 3: Build**

Run: `go build ./cmd/...`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add internal/controller/bootstrap/default_project.go cmd/main.go
git commit -m "feat(bootstrap): ensure permissive default AppProject on startup"
```

### Task 7.2: Wire reconciler dependencies in cmd/main.go

**Files:**
- Modify: `cmd/main.go`

- [ ] **Step 1: Build shared governance and auth objects in operator mode**

In `runOperatorMode`, after the manager is ready, build the auth config and governance objects once:

```go
    authCfg := buildAuthConfig(authEnabled, authBasicUsername, authBasicPassword, authBasicPasswordHash,
        authOIDCIssuerURL, authOIDCClientID, authOIDCClientSecret, authAllowUnauth)

    resolver := governance.NewProjectResolver(mgr.GetClient())
    projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(mgr.GetClient()), mgr.GetRESTMapper())
    policyEvaluator := governance.NewPolicyEvaluator(mgr.GetClient())

    var authz auth.Authorizer
    if authCfg.Enabled {
        var err error
        authz, err = auth.BuildAuthorizer(authCfg, mgr.GetClient())
        if err != nil {
            return fmt.Errorf("build authorizer: %w", err)
        }
    }
```

Pass `authCfg`, `projectValidator`, `policyEvaluator`, and `authz` into both `setupOperatorControllers` and `startOperatorUI`.

In operator mode, register the project-label field indexers before the controllers start. The best place is inside `setupOperatorControllers`, right after `mgr.GetFieldIndexer()` is available:

```go
    if err := mgr.GetFieldIndexer().IndexField(context.Background(), &pipelinesv1alpha1.Release{}, "projectLabel", func(obj client.Object) []string {
        return []string{obj.GetLabels()["app.paprika.io/project"]}
    }); err != nil {
        return fmt.Errorf("index release project label: %w", err)
    }
```

Repeat for `Stage`, `Pipeline`, and `Template`. Ensure `context` is imported. The API and Cloud Run planes do not support field indexers, so use in-memory filtering there.

- [ ] **Step 2: Update `setupOperatorControllers` and helper signatures**

Change `setupOperatorControllers(mgr, k8sClient, operatorNamespace, c, shardFilter, rateLimiter)` to also accept `projectValidator` and `policyEvaluator`. Pass them through to `setupApplicationController` and `setupReleaseController`, where the reconcilers are actually constructed. Update those helpers to accept and set the fields along with `EventRecorder`:

```go
func setupApplicationController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, cacheClient cache.Cache, shardFilter *sharding.Filter, rateLimiter *ratelimit.ControllerRateLimit, projectValidator *governance.ProjectValidator) error {
```

```go
    if err = (&controller.ApplicationReconciler{
        ...
        EventRecorder:    mgr.GetEventRecorderFor("application-controller"),
        ProjectValidator: projectValidator,
    }).SetupWithManager(mgr); err != nil {
```

```go
func setupReleaseController(mgr ctrl.Manager, k8sClient kubernetes.Interface, operatorNamespace string, cacheClient cache.Cache, shardFilter *sharding.Filter, rateLimiter *ratelimit.ControllerRateLimit, projectValidator *governance.ProjectValidator, policyEvaluator *governance.PolicyEvaluator) error {
```

```go
    if err = (&controller.ReleaseReconciler{
        ...
        EventRecorder:    mgr.GetEventRecorderFor("release-controller"),
        ProjectValidator: projectValidator,
        PolicyEvaluator:  policyEvaluator,
    }).SetupWithManager(mgr); err != nil {
```

- [ ] **Step 3: Update `startOperatorUI` signature**

Change `startOperatorUI` to accept `authCfg`, `projectValidator`, `policyEvaluator`, and `authz`. Move the `auth.Interceptor` construction into `startOperatorUI` using the manager client:

```go
    authInterceptor, err := auth.Interceptor(authCfg, mgr.GetClient())
    if err != nil {
        return fmt.Errorf("failed to build auth interceptor: %w", err)
    }

    paprikaServer := api.NewPaprikaServer(mgr.GetClient(), broker)
    paprikaServer.SetGovernanceValidator(projectValidator)
    paprikaServer.SetGovernancePolicyEvaluator(policyEvaluator)
    if authz != nil {
        paprikaServer.SetAuthorizer(authz)
    }
```

- [ ] **Step 4: Wire API and Cloud Run modes**

In `runAPIMode`, build governance objects from `apiClient` and set them on the server (the auth interceptor and authorizer were wired in Task 6.3):

```go
    resolver := governance.NewProjectResolver(apiClient)
    projectValidator := governance.NewProjectValidator(resolver, governance.NewClusterResolver(apiClient), nil)
    policyEvaluator := governance.NewPolicyEvaluator(apiClient)

    paprikaServer.SetGovernanceValidator(projectValidator)
    paprikaServer.SetGovernancePolicyEvaluator(policyEvaluator)
```

In `cmd/cloud-run/main.go`, build governance objects from `k8sClient` and set them the same way.

Also register `corev1alpha1.AddToScheme(scheme)` and `clustersv1alpha1.AddToScheme(scheme)` in `cmd/main.go` `createAPIClient`. The operator manager scheme already registers these. In `cmd/cloud-run/main.go`, register `corev1alpha1`, `clustersv1alpha1`, and `policyv1alpha1`.

Ensure `cmd/main.go` imports `github.com/benebsworth/paprika/internal/governance` and that `cmd/cloud-run/main.go` imports both `internal/governance` and `github.com/benebsworth/paprika/internal/api/auth`.

- [ ] **Step 5: Build**

Run: `go build ./cmd/...`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add cmd/main.go cmd/cloud-run/main.go
git commit -m "feat(main): wire governance dependencies across operator, API, and cloud-run"
```

### Task 7.3: E2E governance test

**Files:**
- Create: `test/e2e/governance_test.go`

- [ ] **Step 1: Write the test**

Use the existing `test/e2e/e2e_suite_test.go` pattern. The test should:
1. Apply an `AppProject` restricting namespaces to `payments-*`.
2. Apply a `Policy` requiring `app` label, scoped to the project.
3. Apply an `Application` targeting namespace `other` and missing the label.
4. Assert the `Application` condition `GovernanceChecked=False` and that no Deployment is created in `other`.
5. Fix the Application and assert it becomes `Healthy`.

- [ ] **Step 2: Run focused e2e test**

Run: `go test ./test/e2e -tags=e2e -ginkgo.focus="Governance" -v`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/e2e/governance_test.go
git commit -m "test(e2e): add governance enforcement test"
```

### Task 7.4: Final verification

- [ ] **Step 1: Run unit tests**

Run: `make test`
Expected: PASS (except e2e if no Kind cluster)

- [ ] **Step 2: Run lint**

Run: `make lint`
Expected: PASS

- [ ] **Step 3: Run e2e on Kind**

Run: `make test-e2e`
Expected: PASS

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "feat(governance): complete project-scoped policy and multi-tenancy governance" || true
```

### Task 7.5: Verify RBAC for AppProject reads

**Files:**
- Modify: `config/rbac/role.yaml` (via markers, then `make manifests`)

- [ ] **Step 1: Add RBAC markers**

Add the marker in the following files (controller-gen picks them up from any Go file):
- `internal/controller/bootstrap/default_project.go`
- `internal/governance/resolver.go`
- `internal/governance/validator.go`
- `internal/api/auth/project_authorizer.go`

```go
// +kubebuilder:rbac:groups=core.paprika.io,resources=appprojects,verbs=get;list;watch;create;update
```

- [ ] **Step 2: Regenerate manifests**

Run: `make manifests`

- [ ] **Step 3: Commit**

```bash
git add config/rbac/role.yaml
git commit -m "chore(rbac): allow manager to read and bootstrap AppProjects"
```

---

## Notes for implementers

- AppProjects are namespace-scoped and resolved from the Application's namespace, matching existing `ProjectEnforcer` behavior.
- The Application controller performs lightweight structural validation only; the Release controller performs full manifest-boundary + policy evaluation.
- `PolicyEvaluator` lists all cluster policies on each evaluation; this is acceptable for the first phase but should be revisited if the policy count grows large.
- Follow the existing controller pattern for status patching (`patchAppStatus`, `patchReleaseStatus`).
- Use `metav1.Condition` and `meta.SetStatusCondition` for `GovernanceChecked`.
- Do not hand-edit `config/crd/bases/*.yaml` or generated proto/DeepCopy files; always regenerate.
- When in doubt, fail closed (block) for project-boundary violations.
- @systematic-debugging for any test failures.
- @verification-before-completion before claiming the feature is done.
