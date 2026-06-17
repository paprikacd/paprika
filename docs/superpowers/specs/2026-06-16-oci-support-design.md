# OCI Support Design

## Goal

Enable Paprika Applications and Templates to consume Helm charts from OCI registries (e.g. ECR, GCR, GHCR, Docker Hub, Harbor) using the `oci://` URL scheme, with support for registry authentication.

This brings Paprika closer to ArgoCD parity: users can reference charts published as OCI artifacts instead of traditional HTTP chart repositories or git.

## Context

Several building blocks already exist but are not fully wired together:

- `api/pipelines/v1alpha1/application_types.go` declares `SourceTypeOCI = "oci"` and an `Image` field on `ApplicationSource`, but it lacks the structured OCI fields (`url`, `tag`, `secretRef`) that exist on `TemplateSpec.OCI`.
- `api/pipelines/v1alpha1/template_types.go` already has `OCISourceSpec` with `URL`, `Tag`, `Insecure`, and `SecretRef`.
- `source/oci.go` implements `OCISource.Resolve` using Helm's `registry.Client` to pull charts. It supports `Insecure` and tag/digest resolution, but it does **not** authenticate with private registries.
- `engine/helm_sdk_renderer.go` already resolves OCI sources for Templates (`resolveOCISource`) and downloads OCI charts for Helm repos (`downloadOCIChart`).
- `internal/repository/resolver.go` resolves `core.paprika.io Repository` references of type `oci` and merges them into `TemplateSpec.OCI`.
- `internal/controller/pipelines/application_controller.go` builds a `TemplateSpec` from `Application.Spec.Source`, but the switch statement only handles `git`, `s3`, and `kustomize` — `oci` is missing.
- The API proto and UI render source information for git, s3, helm, and inline, but not oci.

This design fills the gaps without duplicating the OCI pull logic: the existing `source.OCISource` becomes authentication-aware, and the Application controller maps the new Application source fields into the existing Template OCI spec.

## API Changes

### `api/pipelines/v1alpha1/application_types.go`

Introduce a first-class OCI block on `ApplicationSource` that mirrors `OCISourceSpec`:

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

    // OCI registry reference (for type=oci), e.g. oci://registry.example.com/charts/mychart
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
}
```

The existing `Image` field is deprecated and replaced by `OCI`. For backward compatibility, the controller may map `Image` to `OCI.URL` when `Type == oci` and `OCI` is nil.

### `api/pipelines/v1alpha1/template_types.go`

No structural changes. `OCISourceSpec` already has the fields needed. Only add validation markers:

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

### `proto/paprika/v1/api.proto`

Add an `OCISource` message and include it in `ApplicationSource`:

```protobuf
message OCISource {
  string url = 1;
  string tag = 2;
  bool insecure = 3;
  string secret_ref = 4;
}

message ApplicationSource {
  string type = 1;
  string repo_url = 2;
  string revision = 3;
  string path = 4;
  ChartRef chart = 5;
  // S3 source fields
  string bucket = 6;
  string key = 7;
  string region = 8;
  string endpoint = 9;
  // Shared fields
  string secret_ref = 10;
  string poll_interval = 11;
  InlineSource inline = 12;
  // OCI registry source
  OCISource oci = 13;
}
```

## Controller Behavior

### Application controller: build OCI TemplateSpec

Extend `buildTemplateSpec` in `internal/controller/pipelines/application_controller.go`:

```go
func buildTemplateSpec(app *paprikav1.Application) paprikav1.TemplateSpec {
    spec := paprikav1.TemplateSpec{
        Type:      string(app.Spec.Source.Type),
        Chart:     app.Spec.Source.Chart,
        Namespace: app.Namespace,
    }

    switch app.Spec.Source.Type {
    case paprikav1.SourceTypeGit:
        spec.Git = &paprikav1.GitSourceSpec{...}
    case paprikav1.SourceTypeS3:
        spec.S3 = &paprikav1.S3SourceSpec{...}
    case paprikav1.SourceTypeKustomize:
        spec.Kustomize = &paprikav1.KustomizeSourceSpec{...}
    case paprikav1.SourceTypeOCI:
        oci := app.Spec.Source.OCI
        if oci == nil && app.Spec.Source.Image != "" {
            // Backward compatibility: legacy Image field held the full oci:// URL.
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
    }

    return spec
}
```

### Source hash / revision for OCI

`resolveSourceHash` in `application_controller.go` currently skips OCI. Update it so OCI sources are resolved via the Template renderer:

```go
if app.Spec.Source.Type == paprikav1.SourceTypeGit ||
   app.Spec.Source.Type == paprikav1.SourceTypeS3 ||
   app.Spec.Source.Type == paprikav1.SourceTypeKustomize ||
   app.Spec.Source.Type == paprikav1.SourceTypeOCI {
    // existing resolution path
}
```

This enables drift detection and auto-sync for OCI sources when the tag resolves to a new digest.

### Authentication in `source.OCISource`

Extend `OCISource` with a Kubernetes client so it can load the Secret referenced by `SecretRef`:

```go
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

In `Resolve`, after building the registry client options, if `SecretRef` is set:

1. Fetch the Secret from `Namespace`.
2. If `.dockerconfigjson` is present, write it to a temporary `config.json` and use `registry.ClientOptCredentialsFile(path)`.
3. Otherwise read `username` and `password` keys and use `registry.ClientOptBasicAuth(username, password)`.

Helm's `registry.Client` handles token exchange and bearer-token auth for registries like ECR/GCR when given a docker config.

If `Client` is nil, skip authentication and attempt an anonymous pull. This preserves the existing behavior and keeps unit tests simple.

### Repository CRD integration

When `Application.Spec.Source.RepoRef` points to a `Repository` of type `oci`, the existing `internal/repository/resolver.go` already merges the Repository URL and `Insecure` flag into `TemplateSpec.OCI`. The Application controller will now create the OCI spec, and the repository resolver will fill in the repository-level URL/credentials if the inline fields are empty.

The renderer pipeline should therefore:

1. Build the TemplateSpec from Application source.
2. If `RepoRef` is set, run `repository.Resolver.ResolveTemplate` to merge Repository credentials.
3. Pass the resolved spec to `HelmSDKRenderer.ResolveSource` / `Render`.

Today `HelmSDKRenderer` does not accept a repository resolver. The Application controller already constructs the Template directly; the renderer is called later in the Release controller. The simplest approach is to resolve the Repository in `buildTemplateSpec` before persisting the Template, using the controller's own client. This keeps the renderer interface unchanged.

## Safety

- URL validation: `OCISourceSpec.URL` must match `^oci://`. The controller rejects non-OCI URLs early.
- Digest pinning: `Tag` may be a digest (`@sha256:...`). `buildOCIRef` already appends `:` for tags; this design preserves that behavior and documents that digest references should include the `@` prefix in `Tag`.
- Insecure registries: `Insecure` enables `registry.ClientOptPlainHTTP`. This is opt-in and scoped per source.
- Secret scope: credentials are loaded from the Application's namespace, same as git/S3 secrets.
- No leaked credentials: the docker config temporary file is written under `WorkDir` and removed after the pull.

## Status Conditions

No new condition type is required. Existing reconciliation already surfaces template errors as `ApplicationFailed` with the renderer error message. Authentication failures will flow through the same path.

## UI / API Impact

- Add `oci` handling in `SourceInfo` in `ui/src/components/dashboard/application-card.tsx`:
  - Icon: `Container` from lucide-react (or reuse `Package`).
  - Display `source.oci.url` and `source.oci.tag`.
  - Indicate `insecure` and `secretRef` when present.
- Regenerate proto TypeScript clients after extending `ApplicationSource`.
- Map `a.Spec.Source.OCI` in `convertApplication` in `internal/api/server.go`.

## Testing Plan

### Unit tests

- `source/oci_test.go`:
  - Credential loading from dockerconfigjson Secret.
  - Credential loading from username/password Secret.
  - Anonymous pull when no SecretRef is set.
  - Tag and digest reference parsing.
- `internal/controller/pipelines/application_controller_test.go` (or new `application_controller_source_test.go`):
  - `buildTemplateSpec` for `SourceTypeOCI` maps all fields.
  - Backward compatibility with legacy `Image` field.
  - `RepoRef` of type OCI merges repository URL.

### Envtest tests

- Create an Application with `source.type: oci`, `source.oci.url: oci://...`, and a fake registry (or stub the renderer). Assert the generated Template has `spec.oci.url` set and `status.templateRef` is populated.
- Test that `status.sourceHash` changes when the OCI artifact tag resolves to a new digest.

### E2E tests

- Deploy a local registry (e.g. `registry:2`) in Kind, push a Helm chart as an OCI artifact with `helm package && helm push`, then create an Application referencing it. Assert the Application reaches `Healthy`.
- Repeat with an authenticated registry: create a Secret with `dockerconfigjson`, reference it via `source.oci.secretRef`, and assert the pull succeeds.

## Generated Artifacts

Run after API and proto changes:

```bash
make generate manifests
make generate-proto
```

This updates:

- `api/pipelines/v1alpha1/zz_generated.deepcopy.go`
- `config/crd/bases/pipelines.paprika.io_applications.yaml`
- `config/crd/bases/pipelines.paprika.io_templates.yaml` (validation marker only)
- `charts/chart/templates/crd/*.yaml`
- `config/rbac/role.yaml` (no new RBAC required; manager already has Secret and Repository access)
- `proto/paprika/v1/api.proto`
- `internal/api/paprika/v1/api.pb.go`
- `internal/api/paprika/v1/v1connect/api.connect.go`
- `ui/src/gen/paprika/v1/*`

## Open Questions

1. Should we support OCI artifacts that are **not** Helm charts (e.g. plain Kubernetes manifest bundles pushed as OCI images)? Out of scope for this iteration; the current `source.OCISource` assumes Helm chart tarballs.
2. Should `RepoRef` for OCI also support Repository-level `SecretRef` overriding the Application `SecretRef`? This design keeps the Application-level `SecretRef` as the primary value and falls back to Repository credentials via the existing resolver; the exact precedence can be tightened during implementation.
3. Should we add a controller-level cache for OCI credentials to avoid re-reading Secrets on every reconcile? Out of scope; the existing source cache already avoids repeated pulls, and Secret reads are cheap.
