# OCI Support Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Paprika Applications to use OCI registries as a first-class source type for Helm charts, including private-registry authentication.

**Architecture:** Extend `ApplicationSource` with an `OCI` block that mirrors `TemplateSpec.OCI`. Wire the Application controller to build an OCI `TemplateSpec`, resolve `Repository` references, and let the existing `HelmSDKRenderer` pull the chart. Make `source.OCISource` authenticate using Secrets (dockerconfigjson or username/password). Extend the proto and UI so OCI sources are visible in the dashboard.

**Tech Stack:** Go, Kubernetes controller-runtime, Helm v3 SDK, Protocol Buffers (buf), Ginkgo/Gomega, envtest.

---

## Chunk 1: API Schema

### Task 1: Add `OCI` block to `ApplicationSource`

**Files:**
- Modify: `api/pipelines/v1alpha1/application_types.go`

- [ ] **Step 1: Replace the ad-hoc OCI fields on `ApplicationSource`**

Find the existing `ApplicationSource` struct and update it so OCI has a structured block, `SecretRef` is shared, and `Image` is kept for backward compatibility.

```go
// ApplicationSource defines the source of an application.
type ApplicationSource struct {
    // +kubebuilder:validation:Enum=git;helm;kustomize;s3;oci;inline
    Type string `json:"type"`
    // RepoRef references a core.paprika.io Repository by name. When set, takes
    // precedence over inline URL/credentials fields.
    // +optional
    RepoRef string `json:"repoRef,omitempty"`
    // Git repository URL (for type=git)
    RepoURL string `json:"repoUrl,omitempty"`
    // Git branch, tag, or commit (for type=git)
    Revision string `json:"revision,omitempty"`
    // Path within the repo to the chart/source (for type=git or type=s3)
    Path string `json:"path,omitempty"`
    // Helm chart reference (for type=helm)
    Chart ChartRef `json:"chart,omitempty"`
    // OCI registry reference (for type=oci)
    // +optional
    OCI *OCISourceSpec `json:"oci,omitempty"`
    // S3 bucket (for type=s3)
    Bucket string `json:"bucket,omitempty"`
    // S3 object key (for type=s3)
    Key string `json:"key,omitempty"`
    // S3 region (for type=s3)
    Region string `json:"region,omitempty"`
    // S3 endpoint URL (for type=s3, use LocalStack endpoint for testing)
    Endpoint string `json:"endpoint,omitempty"`
    // Secret reference for private repos, S3, or OCI credentials.
    // For OCI this should contain dockerconfigjson or username/password.
    SecretRef string `json:"secretRef,omitempty"`
    // Insecure allows plain HTTP for OCI registries (type=oci)
    // +optional
    Insecure bool `json:"insecure,omitempty"`
    // Poll interval for change detection (default 30s)
    // +kubebuilder:default="30s"
    PollInterval string `json:"pollInterval,omitempty"`
    // Inline references a manifest snapshot ConfigMap (for type=inline).
    // +optional
    Inline *InlineSourceSpec `json:"inline,omitempty"`
    // Deprecated: Image is the legacy OCI URL field. Use oci.url instead.
    // +optional
    Image string `json:"image,omitempty"`
}
```

- [ ] **Step 2: Add URL validation to `OCISourceSpec`**

In `api/pipelines/v1alpha1/template_types.go`, add a pattern marker to `OCISourceSpec.URL`:

```go
// OCISourceSpec defines an OCI registry source (for Helm charts or artifacts).
type OCISourceSpec struct {
    // URL of the OCI artifact, e.g. oci://registry.example.com/charts/mychart
    // +kubebuilder:validation:Pattern=^oci://
    URL string `json:"url"`
    // Tag or digest of the artifact (e.g. "1.2.3", "@sha256:...")
    Tag string `json:"tag,omitempty"`
    // Insecure allows plain HTTP for the OCI registry
    // +optional
    Insecure bool `json:"insecure,omitempty"`
    // SecretRef references a Secret with dockerconfigjson or .dockerconfigjson
    SecretRef string `json:"secretRef,omitempty"`
}
```

- [ ] **Step 3: Run `go fmt`**

```bash
go fmt ./api/pipelines/v1alpha1/...
```

### Task 2: Regenerate deepcopy and CRDs

- [ ] **Step 1: Run code generation**

```bash
make generate
```

Expected: `api/pipelines/v1alpha1/zz_generated.deepcopy.go` gains `DeepCopyInto` for the new pointer field on `ApplicationSource`.

- [ ] **Step 2: Run manifest generation**

```bash
make manifests
```

Expected changes:
- `config/crd/bases/pipelines.paprika.io_applications.yaml` gains `spec.source.oci` and deprecates the flat `image` field in favor of the structured block.
- `config/crd/bases/pipelines.paprika.io_templates.yaml` gains the `^oci://` pattern on `spec.oci.url`.
- `config/rbac/role.yaml` should be unchanged.

- [ ] **Step 3: Regenerate Helm chart CRDs**

```bash
make helm-generate
```

Verify with:

```bash
git diff -- charts/chart/templates/crd/applications.pipelines.paprika.io.yaml
```

Expected: new `oci` source block appears.

---

## Chunk 2: Source Authentication

### Task 3: Make `source.OCISource` authenticate with Secrets

**Files:**
- Modify: `source/oci.go`
- Modify: `source/interfaces.go` (optional mockgen)

- [ ] **Step 1: Add Kubernetes client and namespace fields**

```go
import (
    "context"
    "errors"
    "fmt"
    "os"
    "path/filepath"
    "strings"

    corev1 "k8s.io/api/core/v1"
    "sigs.k8s.io/controller-runtime/pkg/client"
    "helm.sh/helm/v3/pkg/chart/loader"
    "helm.sh/helm/v3/pkg/registry"
)

// OCISource represents an OCI registry source (Helm chart or artifact).
type OCISource struct {
    URL       string
    Tag       string
    Insecure  bool
    WorkDir   string
    SecretRef string
    Namespace string
    Client    client.Client
}
```

- [ ] **Step 2: Add credential loading helper**

Insert after the `OCISource` struct:

```go
// clientOptions returns registry client options including authentication.
func (o *OCISource) clientOptions(ctx context.Context) ([]registry.ClientOption, error) {
    opts := []registry.ClientOption{registry.ClientOptEnableCache(true)}
    if o.Insecure {
        opts = append(opts, registry.ClientOptPlainHTTP())
    }
    if o.SecretRef == "" || o.Client == nil {
        return opts, nil
    }

    var secret corev1.Secret
    if err := o.Client.Get(ctx, client.ObjectKey{Name: o.SecretRef, Namespace: o.Namespace}, &secret); err != nil {
        return nil, fmt.Errorf("get OCI secret %s/%s: %w", o.Namespace, o.SecretRef, err)
    }

    if dockerCfg := secret.Data[".dockerconfigjson"]; len(dockerCfg) > 0 {
        cfgDir := filepath.Join(o.WorkDir, "oci-docker-config", source.SanitizeName(o.URL))
        if err := os.MkdirAll(cfgDir, 0o750); err != nil {
            return nil, fmt.Errorf("create docker config dir: %w", err)
        }
        cfgPath := filepath.Join(cfgDir, "config.json")
        if err := os.WriteFile(cfgPath, dockerCfg, 0o600); err != nil {
            return nil, fmt.Errorf("write docker config: %w", err)
        }
        opts = append(opts, registry.ClientOptCredentialsFile(cfgPath))
        return opts, nil
    }

    username := string(secret.Data["username"])
    password := string(secret.Data["password"])
    if username != "" || password != "" {
        opts = append(opts, registry.ClientOptBasicAuth(username, password))
        return opts, nil
    }

    return opts, nil
}
```

- [ ] **Step 3: Wire `clientOptions` into `Resolve`**

Replace the current `clientOpts` construction in `Resolve`:

```go
func (o *OCISource) Resolve(ctx context.Context) (*ResolveResult, error) {
    if !IsOCIURL(o.URL) {
        return nil, fmt.Errorf("not an OCI URL: %s", o.URL)
    }

    clientOpts, err := o.clientOptions(ctx)
    if err != nil {
        return nil, err
    }

    ref := buildOCIRef(o.URL, o.Tag)
    // ... rest unchanged
}
```

- [ ] **Step 4: Update `source/interfaces.go` mockgen directive (optional)**

Add:

```go
//go:generate mockgen -destination=mocks/oci_source_resolver.go -package=mocks . OCISourceResolver

// OCISourceResolver resolves OCI sources.
type OCISourceResolver interface {
    Resolve(ctx context.Context) (*ResolveResult, error)
}
```

Regenerate mocks only if the project uses them:

```bash
go generate ./source/...
```

- [ ] **Step 5: Run `go fmt` and `go vet`**

```bash
go fmt ./source/...
go vet ./source/...
```

### Task 4: Unit test OCI credential loading

**Files:**
- Modify: `source/oci_test.go`

- [ ] **Step 1: Add table-driven tests for `clientOptions`**

Use a fake controller-runtime client to supply Secrets. Test that:
- dockerconfigjson is written to a temp file and `ClientOptCredentialsFile` is used.
- username/password produces `ClientOptBasicAuth`.
- missing Secret returns an error.
- no SecretRef returns only cache/plainHTTP options.

```go
func TestOCISource_clientOptions(t *testing.T) {
    // Build a fake client with Secrets in the "default" namespace.
    // Assert option count and types reflect the secret type.
}
```

- [ ] **Step 2: Run the new tests**

```bash
go test ./source -run TestOCISource -v
```

Expected: all tests pass.

---

## Chunk 3: Controller Wiring

### Task 5: Build OCI TemplateSpec in Application controller

**Files:**
- Modify: `internal/controller/pipelines/application_controller.go`

- [ ] **Step 1: Extend `buildTemplateSpec` for `SourceTypeOCI`**

Add a new case in the switch:

```go
case paprikav1.SourceTypeOCI:
    oci := app.Spec.Source.OCI
    if oci == nil && app.Spec.Source.Image != "" {
        oci = &paprikav1.OCISourceSpec{URL: app.Spec.Source.Image}
    }
    if oci != nil {
        secretRef := oci.SecretRef
        if secretRef == "" {
            secretRef = app.Spec.Source.SecretRef
        }
        spec.OCI = &paprikav1.OCISourceSpec{
            URL:       oci.URL,
            Tag:       oci.Tag,
            Insecure:  oci.Insecure || app.Spec.Source.Insecure,
            SecretRef: secretRef,
        }
    }
```

- [ ] **Step 2: Include OCI in source-hash resolution**

Find `resolveSourceHash` and extend the source type check:

```go
if app.Spec.Source.Type == paprikav1.SourceTypeGit ||
   app.Spec.Source.Type == paprikav1.SourceTypeS3 ||
   app.Spec.Source.Type == paprikav1.SourceTypeKustomize ||
   app.Spec.Source.Type == paprikav1.SourceTypeOCI {
    // existing resolution path
}
```

- [ ] **Step 3: Resolve Repository credentials when `RepoRef` is set**

Import `github.com/benebsworth/paprika/internal/repository` and add repository resolution to `buildTemplateSpec`:

```go
func (r *ApplicationReconciler) buildTemplateSpec(ctx context.Context, app *paprikav1.Application) paprikav1.TemplateSpec {
    spec := buildTemplateSpec(app)
    if app.Spec.Source.RepoRef == "" {
        return spec
    }
    resolver := repository.NewResolver(r.Client)
    resolved, err := resolver.ResolveTemplate(ctx, app.Namespace, &spec)
    if err != nil {
        // Surface the error via the existing reconcileTemplate error path.
        // For now return spec as-is; the caller can log the error.
        log.FromContext(ctx).Error(err, "Failed to resolve repository", "repoRef", app.Spec.Source.RepoRef)
        return spec
    }
    if resolved != nil {
        return resolved.Spec
    }
    return spec
}
```

Update `reconcileTemplate` to call `r.buildTemplateSpec(ctx, app)` instead of the package-level `buildTemplateSpec(app)`.

- [ ] **Step 4: Run `go fmt` and `go vet`**

```bash
go fmt ./internal/controller/pipelines/...
go vet ./internal/controller/pipelines/...
```

### Task 6: Unit test controller source mapping

**Files:**
- Create: `internal/controller/pipelines/source_mapping_test.go`

- [ ] **Step 1: Write table-driven tests for `buildTemplateSpec`**

Cover:
- OCI source maps URL, tag, insecure, secretRef.
- Legacy `Image` field maps to `OCI.URL`.
- `Source.SecretRef` is used when `OCI.SecretRef` is empty.
- `Source.Insecure == true` propagates to `OCI.Insecure`.
- Git/S3/Kustomize cases are unchanged.

- [ ] **Step 2: Run the tests**

```bash
go test ./internal/controller/pipelines -run TestBuildTemplateSpec -v
```

---

## Chunk 4: Proto and API Surface

### Task 7: Add `OCISource` message and field

**Files:**
- Modify: `proto/paprika/v1/api.proto`

- [ ] **Step 1: Add `OCISource` message before `ApplicationSource`**

```protobuf
message OCISource {
  string url = 1;
  string tag = 2;
  bool insecure = 3;
  string secret_ref = 4;
}
```

- [ ] **Step 2: Add `oci` field to `ApplicationSource`**

Add after `inline = 12;`:

```protobuf
  OCISource oci = 13;
```

### Task 8: Regenerate protobuf clients

- [ ] **Step 1: Run proto generation**

```bash
make generate-proto
```

Expected updates:
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

### Task 9: Map OCI in `convertApplication`

**Files:**
- Modify: `internal/api/server.go`

- [ ] **Step 1: Populate `source.oci` in `convertApplication`**

Inside the `if a.Spec.Source.Type != ""` block, after the inline handling:

```go
if a.Spec.Source.OCI != nil {
    source.Oci = &paprikav1.OCISource{
        Url:      a.Spec.Source.OCI.URL,
        Tag:      a.Spec.Source.OCI.Tag,
        Insecure: a.Spec.Source.OCI.Insecure,
        SecretRef: a.Spec.Source.OCI.SecretRef,
    }
}
```

- [ ] **Step 2: Run `go fmt` and `go vet`**

---

## Chunk 5: UI

### Task 10: Display OCI sources in the dashboard

**Files:**
- Modify: `ui/src/components/dashboard/application-card.tsx`

- [ ] **Step 1: Add `Container` icon import**

```tsx
import { GitBranch, Database, Package, ExternalLink, RefreshCw,
  CheckCircle2, AlertCircle, Loader2, Heart, XCircle,
  Clock, Activity, ArrowRight, Target, AlertTriangle, Container,
} from "lucide-react"
```

- [ ] **Step 2: Add oci to `SourceIcon`**

```tsx
case "oci":
  return <Container className="size-3.5 text-sky-500" />
```

- [ ] **Step 3: Add oci case to `SourceInfo`**

```tsx
case "oci":
  if (source.oci?.url) lines.push(source.oci.url)
  if (source.oci?.tag) lines.push(`tag: ${source.oci.tag}`)
  if (source.oci?.insecure) lines.push("insecure: true")
  break
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
cd ui && npm run typecheck
```

If the generated proto clients are stale, run `make generate-proto` first.

---

## Chunk 6: Integration and E2E Tests

### Task 11: Add envtest coverage

**Files:**
- Create: `internal/controller/pipelines/oci_envtest_test.go`

- [ ] **Step 1: Write envtest spec**

Create an Application with `source.type: oci` and assert:
- The controller creates a Template with `spec.oci.url` set.
- The Application `status.templateRef` is populated.

Stub the renderer by injecting a fake `TemplateRenderer` into the reconciler so the test does not require a real registry.

```go
var _ = ginkgo.Describe("Application Controller OCI Source", func() {
    ctx := context.Background()
    const appName = "oci-source-app"

    ginkgo.It("should create a Template from an OCI source", func() {
        app := &pipelinesv1alpha1.Application{
            ObjectMeta: metav1.ObjectMeta{Name: appName, Namespace: "default"},
            Spec: pipelinesv1alpha1.ApplicationSpec{
                Source: pipelinesv1alpha1.ApplicationSource{
                    Type: pipelinesv1alpha1.SourceTypeOCI,
                    OCI: &pipelinesv1alpha1.OCISourceSpec{
                        URL: "oci://registry.example.com/charts/mychart",
                        Tag: "1.2.3",
                    },
                },
                Stages: []pipelinesv1alpha1.ApplicationPromotionStage{{Name: "dev", Ring: 1}},
            },
        }
        gomega.Expect(k8sClient.Create(ctx, app)).To(gomega.Succeed())

        var tmpl pipelinesv1alpha1.Template
        gomega.Eventually(func() error {
            return k8sClient.Get(ctx, types.NamespacedName{Name: appName + "-template", Namespace: "default"}, &tmpl)
        }, 10*time.Second, 1*time.Second).Should(gomega.Succeed())

        gomega.Expect(tmpl.Spec.Type).To(gomega.Equal(pipelinesv1alpha1.SourceTypeOCI))
        gomega.Expect(tmpl.Spec.OCI).NotTo(gomega.BeNil())
        gomega.Expect(tmpl.Spec.OCI.URL).To(gomega.Equal("oci://registry.example.com/charts/mychart"))
        gomega.Expect(tmpl.Spec.OCI.Tag).To(gomega.Equal("1.2.3"))
    })
})
```

- [ ] **Step 2: Run the envtest specs**

```bash
go test ./internal/controller/pipelines -run TestControllers -v
```

### Task 12: E2E test with a local OCI registry

**Files:**
- Create: `test/e2e/oci_source_test.go` (if e2e tests exist; otherwise add to existing e2e suite)

- [ ] **Step 1: Push a Helm chart to a local registry**

In the e2e setup:
1. Deploy `registry:2` in the Kind cluster.
2. Package a test chart (`helm package ./test/e2e/fixtures/testchart`).
3. Push it: `helm push testchart-0.1.0.tgz oci://localhost:5000/charts`.

- [ ] **Step 2: Create an Application referencing the OCI chart**

```yaml
apiVersion: pipelines.paprika.io/v1alpha1
kind: Application
metadata:
  name: oci-e2e
  namespace: default
spec:
  source:
    type: oci
    oci:
      url: oci://registry.default.svc.cluster.local:5000/charts/testchart
      tag: 0.1.0
  stages:
    - name: dev
      ring: 1
```

- [ ] **Step 3: Assert health**

Wait for the Application to reach `Healthy` and for the rendered Deployment to exist.

### Task 13: Final verification

- [ ] **Step 1: Run linter**

```bash
make lint
```

Expected: no errors.

- [ ] **Step 2: Run full unit/envtest suite**

```bash
make test
```

Expected: all tests pass.

- [ ] **Step 3: Commit the implementation**

```bash
git add -A
git commit -m "feat(source): add full OCI support to Application sources

- Add structured oci block to ApplicationSource
- Authenticate OCI pulls with dockerconfigjson or username/password Secrets
- Wire Application controller to build OCI TemplateSpec
- Extend proto and UI to display OCI sources
- Add unit, envtest, and e2e coverage"
```

---

## Notes for Implementers

- The design spec is at `/Users/benebsworth/projects/paprika/docs/superpowers/specs/2026-06-16-oci-support-design.md`.
- Work in the worktree at `/Users/benebsworth/projects/paprika/.worktrees/feat-oci-support`.
- Do not modify `config/crd/bases/*.yaml`, `config/rbac/role.yaml`, `**/zz_generated.*.go`, or `PROJECT` by hand; always regenerate via `make`.
- `source.OCISource` currently uses Helm's registry client, which expects a Helm chart tarball. Non-Helm OCI artifacts are out of scope.
- The existing `Image` field on `ApplicationSource` is deprecated but kept for backward compatibility.
- Repository CRD references for OCI (`core.paprika.io Repository` with `type: oci`) are already supported by `internal/repository/resolver.go`; the controller now creates the OCI spec so that resolver can merge credentials.
